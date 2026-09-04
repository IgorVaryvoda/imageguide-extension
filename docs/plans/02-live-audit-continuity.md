# 02 — Live evidence and inspection continuity

Execution status and dependencies: [plan index](README.md).

## Outcome and evidence

Relevant page changes refresh the findings without collapsing the evidence being read,
losing keyboard focus, or repeatedly walking the entire page for a scroll event.

[observePage()](../../content/observe.js) omits `alt`, attaches its mutation observer to the
document rather than open shadow roots, and has no viewport/load invalidation.
[renderResources()](../../audit/audit.js) rebuilds all cards and usage children, including
collapsed details. [Collection](../../content/collect.js) assigns scan-local IDs and marks,
so using `r1`, `u1` or the current mark as a stable UI key is incorrect.

## 02a — Observation and document-scoped identity

1. Add relevant attribute invalidation, starting with `alt`; cover all markup inputs read
   by the analyzer. Observe discovered open shadow roots as separate roots and register
   newly discovered ones during bounded rescans. Disconnect roots that leave the document.
   Preserve the documented inability to inspect closed roots.
2. Distinguish cheap viewport dirtiness from resource/markup/style dirtiness. Listen for
   scroll (including nested scrollers), resize/DPR changes, image load/error and existing
   browser performance evidence. Coalesce signals and allow only one scan/update in flight.
   Use a proposed 250 ms trailing debounce and 1200 ms maximum scheduling wait while the
   audit is visible; verify against the fixture rather than assuming exact timer delivery.
3. Refresh viewport facts against known live nodes without reparsing all CSS sources.
   Resource selection/load or layout changes require dimension/candidate revalidation;
   do not retain cached geometry merely because the URL is unchanged. If cheap updates
   cannot resolve validity, schedule one bounded full scan, not one scan per event.
4. Keep root observation and dirty generation document-scoped. Attaching a shadow root to
   an existing host without a light-DOM mutation needs explicit coverage: perform bounded
   root discovery on audit focus/manual rescan and disclose that limitation. Do not patch
   page prototypes or promise complete CSSOM/animation observation. Always retain Rescan.
5. Separate auditor-owned overlay nodes from inspected page nodes when suppressing
   mutations. The current broad mark check can ignore removal of a real inspected node.
   A marked image being removed/moved must invalidate the ledger; drawing its outline must
   not start a self-refresh loop.
6. Establish stable internal keys: tab/document/frame-document identity plus resource URL;
   usages additionally need a per-document weak element identity, kind and CSS property.
   Preserve sequential report IDs as serialization labels if useful, not cache keys.
   Reset on document replacement, guard highlight against stale frame documents, and prune
   detached-node references. Multiple audits must not stop each other's watcher ownership.
7. Pause/pagehide/lease expiry must remove listeners and observers as well as timers.
   Pause while hidden; resume with a fresh revision/scan. On restored access or navigation,
   discard stale identities before rendering. Loss of `activeTab` gets a clear recovery
   action, never an automatic request for broader host access.

Existing collector limits still apply. The CSS time budget is not a proven hard wall-time
bound for semantic scanning or rendering; measure these stages separately and keep accurate
truncation warnings. Do not claim an end-to-end bound from one internal timer.

## 02b — Keep inspection state and bound rendering

Maintain expanded resource keys, the active resource/usage and focus intent separately
from rendered nodes. Update cards by stable key, avoid replacing the focused control, and
restore selection/scroll position after an accepted update. If a selected item disappears,
announce that and move focus to a predictable neighboring result or the results heading.
Do not jump back to the start of the ledger.

Build usage rows only on expansion. Initially mount at most 100 resource cards, with an
explicit Show more action that adds at most 100 more. Search, sort, counts and exports must
still operate on the complete bounded dataset. Label displayed/total counts and avoid a
silent rendering cap. Add virtualization only if measurements show this simpler approach
fails; no framework migration is needed.

Honor reduced motion, maintain native keyboard interaction and use a restrained live
status region for update/error summaries, not announcements for every mutation.

## Regression gates

Extend [observer tests](../../test/observe.test.js),
[collector tests](../../test/collect.test.js) and [browser tests](../../test/e2e/extension.test.mjs).

| Case | Required assertion |
| --- | --- |
| Add, remove or empty `alt` | Finding updates; empty decorative alt stays valid |
| Add/remove/change media inside an existing or newly discovered open root | Evidence updates; detached roots release observers |
| Remove a previously inspected, marked image | It disappears without relying on unrelated events |
| Scroll only, including a nested scroller | Current-viewport findings update without a full CSS scan per event |
| Resize/DPR change or late image load | Target dimensions and selected candidate revalidate |
| Expand a usage group and focus its button, then mutate another image | Group stays open; focus and scroll remain stable |
| Filter/sort while a refresh is pending | Latest controls win; old render work cannot replace newer state |
| Pause/resume, background/foreground, close/reopen, two audit windows | No listener leaks, duplicate watchers, or one owner stopping another |
| Same tab navigates, including child-frame replacement | No old highlight target or old resource identity is reused |
| 2000 resources / 8000 usages ledger | Initial mount obeys the cap; collapsed groups create no usage rows; all results remain accessible |

Isolate observer fixtures from unrelated LCP/CLS signals so an incidental event cannot
make a missing invalidation test pass. Keep the existing 8000-element / 2000 ms fixture
assertion and its 1.5 MB report check; do not raise them. Add render metrics separately:
on a fixed local browser/viewport, target p95 filter/update completion under 200 ms and no
regression in input responsiveness. These are proposed targets, not measured baselines;
record hardware, browser, sample count and before/after numbers. If the target is missed,
reduce work before increasing a budget.

Run the [local gates](README.md#local-gates-and-release-evidence), plus keyboard and
light/dark-mode smoke checks on the real extension. The popup remains a point-in-time
summary; live guarantees apply to the active full audit only.
