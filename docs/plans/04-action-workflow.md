# 04 — Action workflow and local verification

Execution status and dependencies: [plan index](README.md).

## Outcome and evidence

The popup answers what matters; the full audit preserves the evidence and supports the
next action. The user should not lose completed work by opening the detailed view.

The [popup footer](../../popup/popup.html) holds Open full audit after a list that can show
200 resources. [Its handoff](../../popup/popup.js) sends tab/watch IDs but not checked
measurements. Both surfaces open a generic converter without the audited URL; preserve
that privacy property while making the action label match its behavior.

## 04a — Trust-release workflow

Move Open full audit to the header or a sticky action area, including narrow/zoomed popup
layouts. Keep the popup list bounded and point to the full ledger instead of adding more
summary controls. Make the leading findings actionable: show the observed evidence,
proposed change and relevant qualification. For a shared resource, distinguish a per-usage
suggestion from changing the source used by every recorded placement.

Use a one-shot, extension-internal handoff. Transfer only completed, validated measurement
records, their provenance, attempt outcomes and useful UI state, associated with exact
tab/document/frame identities and creation time. Never put audited URLs or reports in a
navigation query string. Do not attach broad host permissions to make handoff convenient.

Prefer an explicit message/acknowledgment while the popup remains open. If reliable popup
lifecycle requires a bounded `chrome.storage.session` handoff, use a random one-use token,
a short proposed 60-second expiry and an aggregate serialized cap no larger than the
existing 4 MB page payload budget. Restrict access to trusted extension contexts, consume
and delete on success, and purge expired items on access/startup. Quota/failure must fall
back to a fresh scan with an explanation, never crash the audit. Do not use local/sync
storage for reports or silently create history.

The receiving audit must first verify current document identity and access, then reconcile
with fresh browser evidence. A new document, stale/consumed token, model/schema mismatch
or changed candidate invalidates the handoff. Stronger new evidence wins. Starting an
audit must not auto-request permission or restart an unfinished network check.

The current [privacy policy](../../store/privacy-policy.md) says audit results are not
written to extension storage. Any session-storage handoff or cleanup journal introduced
by these plans must update the exact storage/retention disclosure with that implementation;
do not leave the old blanket claim in place. No automatic transmission to ImageGuide.

Rename Convert / Convert to FORMAT to Open converter, explain that the audited image is
not transferred, and retain Copy URL. Do not auto-fetch thumbnails or upload the file.
A consent-based selected-image transfer is a separate future integration, not this release.

## Acceptance and local gates

Extend [real-extension tests](../../test/e2e/extension.test.mjs) and the relevant shared
controller tests from plans 01/03.

| Case | Required assertion |
| --- | --- |
| Long popup and keyboard-only navigation | Full audit remains reachable without scrolling through the entire resource list |
| Successful checks followed by Open full audit | Valid measurements and provenance survive; no duplicate HEAD/range request |
| Navigation/reload between handoff preparation and receipt | Old measurements and UI identities are rejected |
| Popup closes early, expired/reused token or storage failure | Fresh scan works with an explanation; no leaked history or unhandled error |
| New browser evidence conflicts with carried header checks | Stronger current evidence wins and context warnings remain |
| Converter click | Generic converter opens; URL contains neither audited URL nor report |
| Two resources with one filename | Copied report identifies the correct resource and usage |
| Same workflow without optional host grants | Passive scan and detailed audit still work under the real toolbar grant |

Run the [local gates](README.md#local-gates-and-release-evidence), verify light/dark,
keyboard focus, 200% zoom and status feedback, and capture the actual updated extension.
Do not redraw marketing screenshots to claim a workflow that is not implemented.

## 04b: deferred baseline comparison

Do not begin this slice until the trust release is accepted and observed user sessions
show that before/after verification is worth building. It is not required for 04a.

The first experiment is one explicitly captured baseline in the open audit session, not a
history service. Offer Capture baseline, Rescan and Compare. Keep it in memory, discard it
when the audit closes, and provide Clear baseline. No account, cloud sync, automatic
capture or additional persistent permission.

Record page identity, timestamp, viewport, DPR, resource/usage evidence, coverage,
measurement provenance, schema and model version. A rescan after navigation is a new
snapshot: only explicit comparison may relate it to the baseline; do not reuse plan 01's
measurement cache across documents.

Compare resource identities conservatively and never join on `r1`/`u1` or filename. Treat
URL changes, unavailable evidence and ambiguous usage matches as changed/unknown, not
resolved. Report a finding as resolved only when its corresponding usage was re-observed
with adequate evidence; disappearance behind a scan cap is not a fix. Cross-navigation
usage matching must disclose ambiguity rather than requiring a speculative selector engine.

A byte reduction is measured only when both sides have compatible, measured evidence.
Viewport/DPR, coverage, response variant, source provenance or model-version differences
make affected comparisons non-comparable or explicitly qualified. Do not subtract two
conversion estimates and call that achieved savings. LCP/CLS deltas from two ad hoc loads
are observations, not proof of a performance improvement.

Before expanding this experiment, observe roughly ten developer/agency sessions. Record
whether a real issue was identified, understood, fixed and verified; note false positives
and confusion. This is qualitative discovery, not a statistically powered metric target.
Use voluntary feedback, not background browsing analytics. Stop and revise the workflow
if users cannot understand or verify the recommendation; do not compensate by adding rules.
