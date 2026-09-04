# 01 — Measurement jobs and temporary permissions

Execution status and dependencies: [plan index](README.md).

## Outcome and evidence

A response check has one owner, a finite set of attempts, visible outcomes and an explicit
end. It cannot write into a different document or silently leave newly requested access.

Read [the response pool](../../lib/measure.js), [permission handling](../../extension/measure.js),
[popup orchestration](../../popup/popup.js), [audit orchestration](../../audit/audit.js), and
[frame merging](../../lib/merge.js).

Both `pendingResponseChecks()` implementations take the first 100 unmeasured resources.
A null result never records an attempt, so permanently failing resources can monopolize
subsequent batches. The audit's completion handler looks up resources in `state.page`
after awaiting results; it has no originating-document guard. Permission cleanup is in
`measureResources()`'s `finally`; abrupt context loss remains an unproven cleanup risk.

## 01a — Attempts, ownership and cancellation

Use a small shared controller and pure transition helpers, not a state-machine dependency.
Keep the public response validation rules and existing concurrency/time limits.

1. Give each check an immutable job ID, target tab, top-document identity, relevant frame
   document identities, scan revision, and captured candidate set. Use Chrome document IDs
   where available, with the existing `performance.timeOrigin` token as a fallback. A tab
   ID, URL, `r1` or `u1` alone is not a document/resource identity.
2. Separate attempt status from evidence: `unattempted`, `running`, `measured`,
   `unavailable`, `permission-denied`, and `cancelled`. Keep a reason for unavailable results
   (timeout, unsupported scheme, invalid response or request failure where distinguishable).
   Do not infer an HTTP status from an opaque fetch failure. A later stronger browser
   measurement may resolve a previously unavailable resource.
3. Check only eligible HTTP(S) candidates that have not been attempted in this document.
   Preserve the 100-resource cap. Show checked, unavailable and remaining counts. Retry
   failed/denied resources only after an explicit retry action, with its own bounded batch;
   no automatic prompt loop. Unsupported/data/blob resources must not occupy that queue.
4. Add caller cancellation to the pool and request helper. Abort active requests, stop
   dequeuing new candidates and settle every started operation. Preserve valid completed
   measurements and mark remaining work honestly. Keep six concurrent checks, the current
   per-resource timeout, omitted credentials, redirect rejection and body cancellation.
5. Permit one active check per audit session. Disable duplicate starts in both surfaces.
   Navigation or rescan invalidates the current job; abort it and discard late results.
   Viewport-only updates may retain it only if they do not change candidate identity or
   revision. Correctness takes priority over salvaging a nearly completed stale batch.
6. Apply a completion only after the job/document/revision still match and the resource
   remains in the captured candidate set. Do not overwrite a stronger browser measurement.
   Extract the existing source-precedence rule into a shared pure helper so rescan, frame
   merge and optional-check application cannot disagree. Keep byte provenance and format
   provenance separate: a new HEAD response does not prove the page loaded that variant.
7. Version permission-snapshot preparation in both surfaces. Ignore stale completions,
   invalidate snapshots on candidate/permission changes, and surface denial, cancellation
   and failure instead of silently resetting the button. Handle all rejected promises.

Document-scoped attempt/results state remains in memory until the handoff in plan 04a.
Do not create a browsing history or write image URLs into durable cleanup records.

## 01b — Prove and enforce the permission lifetime

This slice must start with real browser tests, not an assumption that a leak exists.
Chrome [closes a popup when focus leaves it](https://developer.chrome.com/docs/extensions/develop/ui/add-popup).
[Permission requests need a user gesture](https://developer.chrome.com/docs/extensions/reference/api/permissions).
These facts make document-owned cleanup insufficient evidence by itself.

Exercise grant, denial, removal failure, closing the popup during a slow request, closing
an audit, navigating the target, and terminating the extension context. Inspect permissions
from a surviving independent extension context; an absent UI is not proof of cleanup.
Include a pre-existing exact-origin grant and a broader covering grant.

If teardown leaves access or cannot be bounded/recovered, add only the minimum MV3 cleanup
coordinator necessary for the temporary-access contract:

- Serialize permission leases extension-wide; another popup/audit must attach to the
  existing owner or show a busy state, not independently grant/revoke the same origin.
  Keep network work explicit and bounded; never replay it automatically after restart.
- Before enabling the final permission-confirmation button, prepare an immutable lease
  with exact requested patterns and the pre-existing grant snapshot. Persist only cleanup
  metadata (lease ID, patterns, prior grants, phase and expiry), never page/image URLs,
  reports or credentials. Validate sender and lease identity on coordinator messages.
- Call `permissions.request()` directly from the user gesture against that prepared lease.
  Do not assume a gesture survives arbitrary awaits or message hops. Expired/stale leases
  require preparing again and another explicit click. Handle a grant arriving after the
  requesting surface closes by reconciling permission events against the pending journal.
- Release on completion/cancel/owner loss; use a recovery alarm and startup/worker-wake
  reconciliation for abandoned leases. Check actual removal success. Retain unresolved
  cleanup metadata, block new checks, and show an actionable warning on failure. Remove
  only access attributable to this lease; never broadly clear host permissions or remove
  a covering pre-existing/user grant. Ambiguous external permission changes require
  reconciliation rather than guessing ownership.
- A worker can terminate too. Recover from persisted phase information, not globals or a
  `setTimeout` alone. Reconcile before accepting new work. Choose recovery scheduling
  compatible with the declared minimum Chrome version; do not silently require newer APIs.
- Delete the journal after confirmed cleanup. During browser shutdown/extension disablement
  no JavaScript can promise instant removal: state the actual recovery behavior in the
  policy and test the next enabled startup. This is a disclosed recovery limit, not a claim
  of instantaneous cleanup under every crash condition.

[Chrome's worker lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
is the basis for termination/recovery tests, not a reason to keep a worker alive forever.

If the current architecture passes the lifetime tests, retain it and record the evidence;
do not add a worker speculatively. If the chosen design cannot pass, remove/disable optional
checks for the release, keep passive auditing usable, and update the UI/docs accordingly.
Do not silently change temporary permissions into permanent grants. A new coordinator must
ship with its manifest, static-verifier, packaging and privacy-policy changes in the same
implementation PR; the present plan PR changes none of them.

## Regression gates

Extend [measurement unit tests](../../test/measure.test.js),
[permission tests](../../test/extension-measure.test.js) and
[real-extension fixtures](../../test/e2e/extension.test.mjs).

| Case | Required assertion |
| --- | --- |
| 101+ candidates; first 100 always fail | A subsequent new-candidate batch reaches candidate 101; retry does not reset progress |
| Denial or permission error | No network checks start; outcome is visible and retry requires user action |
| Cancel while six requests are blocked | All active signals abort, no next candidate starts, no late UI mutation |
| Navigate A to B with the same image URL | A's delayed size cannot appear in B, including reload at the same page URL |
| Rescan learns Resource Timing before a HEAD result resolves | The stronger measurement and its provenance survive |
| Candidates change during permission preparation | A stale snapshot cannot enable or authorize the new candidate set |
| Two surfaces start checks for a shared origin | No duplicate owner, premature revocation, or inherited temporary grant treated as permanent |
| Close/terminate owner after granting access | Independent permission inspection proves cleanup or the documented recovery path |
| Existing exact/wildcard grants and cleanup errors | Existing grants survive; failed cleanup remains recorded and blocks another lease |
| Worker restart, when introduced | Journal reconciles; requests do not restart silently; packaged extension includes the worker |

Run the [local gates](README.md#local-gates-and-release-evidence). Permission-dialog and
termination scenarios need installed-extension evidence; mocked Chrome APIs or a Node HTTP
test are not substitutes. If browser automation cannot drive a dialog, record the manual
steps and result. Until executed, that release gate is Not run, not Passed.
