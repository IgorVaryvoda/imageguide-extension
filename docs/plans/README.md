# ImageGuide extension remediation plans

Make audit evidence safe to act on before expanding the feature set.

Baseline: [0.4.0, `df71a126`](https://github.com/IgorVaryvoda/imageguide-extension/commit/df71a12695a5380037ef87090bcd0bd0838f8815), inspected 4 September 2026.
These are implementation plans, not shipped fixes or a production-readiness claim.
This index is the single source of truth for plan status and execution order.

## Work queue

| Order | Plan | Status | Implementation slices | Depends on |
| --- | --- | --- | --- | --- |
| 1 | [Measurement jobs and temporary permissions](01-measurement-lifecycle.md) | Done (working tree; E2E/browser-dialog proof still to run) | 01a: attempts, cancellation and stale-result guards; 01b: permission lifetime proof and recovery | None |
| 2 | [Live evidence and inspection continuity](02-live-audit-continuity.md) | Done (working tree; installed-extension continuity proof still to run) | 02a: observation and stable identity; 02b: incremental rendering and performance | 01a for safe concurrent checks |
| 3 | [Evidence, scoring and report integrity](03-evidence-and-reporting.md) | Done (working tree) | 03a: confidence and grade contract; 03b: export parity and compatibility | 01a measurement result contract |
| 4 | [Action workflow and local verification](04-action-workflow.md) | Done (working tree; E2E handoff proof still to run) | 04a: popup/full-audit handoff and actions | 01, 02, 03 |
| Later | [Baseline comparison experiment](04-action-workflow.md#04b-deferred-baseline-comparison) | Deferred | 04b: explicit, local before/after comparison | Trust release accepted; observed user need |

Implement these as separate reviewable PRs, with regression tests in the same PR as each
behavior change. Work on 02 and 03 may overlap after 01a establishes shared contracts;
coordinate edits to `audit/audit.js` and `popup/popup.js`. Do not combine the entire queue
into a rewrite. Move a row to In progress only when an implementation PR exists, and to
Done only after its acceptance evidence is linked here. Keep deferred work out of the
trust release.

## Evidence and limits

The plans distinguish source-confirmed behavior from a browser failure still to reproduce.
The current code supports the following findings:

| Finding | Source | What still needs execution evidence |
| --- | --- | --- |
| The first 100 unmeasured resources are selected again after failures | `pendingResponseChecks()` in both surfaces; `lib/measure.js` | Installed-extension progress across a failed batch |
| A check applies results to the current audit page after awaiting the network | `audit/audit.js::checkResponseSizes()` | Navigation/rescan races with controlled delayed responses |
| Temporary permission cleanup belongs to the initiating document's `finally` | `extension/measure.js::measureResources()` | Whether a grant remains after popup closure or context termination; this is a risk, not a confirmed leak |
| Live invalidation omits `alt`, shadow-root observation and viewport events | `content/observe.js::observePage()` | Browser cases isolated from unrelated LCP/CLS events |
| Full-audit rendering reconstructs every card and usage row | `audit/audit.js::renderResources()` | Focus/expansion continuity and large-ledger render cost |
| Fixed format ratios drive the letter grade even when only input bytes are measured | `lib/format.js`; `lib/analyze.js` | Model calibration, not another test of the same constants |
| The full-audit handoff carries tab/watch IDs, not checked sizes | `popup/popup.js`; `audit/audit.js` | Document-safe handoff and rejection after navigation |
| Markdown drops limitations preserved by JSON/UI | `lib/report.js::buildMarkdownReport()` | Cross-surface limitation fixtures |

Do not carry unrecorded test claims from the review into implementation sign-off. Reproduce
failures against the implementation branch and retain the fixture, command and result.

## Constraints

Preserve the resource/usage split, dependency-free shipped ES modules, pure `lib/` logic,
explicit user initiation, credential-free checks and zero automatic report transmission.
The [repository notes](../../.Codex/napkin.md) reinforce these constraints.

No framework migration, accounts, server backend, cloud history, telemetry, automatic
conversion/upload, speculative crawling or additional audit-rule catalogue in this work.
A narrowly scoped permission-cleanup worker is allowed only under plan 01b's evidence gate;
it is not authorization for background scanning or a general job system.

## Local gates and release evidence

Use the existing commands in [package.json](../../package.json), locally. GitHub Actions
availability or minutes are not a substitute for these gates and are not a scoring input.

```bash
npm ci
npm test
npm run test:e2e
npm run zip
```

`npm test` already includes static verification, lint and unit tests. `npm run zip` invokes
both test suites through `prezip`; do not remove that protection. Repeated full runs are
not required while iterating, but the packaged release must pass its own gate. Browser
fixtures must trigger the real toolbar action and use the shipped permission model; a
test-only broad host grant cannot prove `activeTab` or permission-dialog behavior.

An implementation PR must identify its base/head commit, commands, browser version and OS,
fixture results, and any blocked/manual checks. Use Passed, Failed or Not run explicitly;
configured tests are not passing tests. Do not increase budgets or skip assertions to make
a regression green. Do not change workflows merely to spend more hosted minutes.

Trust-release acceptance requires all of the following:

- Measurement failures make progress, navigation cannot receive stale results, and real
  browser permission-lifetime cases pass; otherwise ship without optional response checks.
- Live findings update without destroying the inspection state or scanning on every event.
- Summaries and exports distinguish measurements from predictions and retain limitations.
- Handoff preserves valid work without extending access or leaking URLs; actions say what
  they do. Baseline comparison is not a prerequisite.
- Changed runtime behavior is reflected in the README and, where applicable, the
  [privacy policy](../../store/privacy-policy.md), canonical
  [store description](../../store/description.md), and real extension screenshots.

## Implementation evidence (working tree, 2026-09-04)

- Passed: `node scripts/verify.mjs`, `npm run lint`, and unit `node --test`
  across `test/measure.test.js`, `test/collect.test.js`, `test/merge.test.js`,
  `test/observe.test.js`, `test/extension-measure.test.js`, `test/report.test.js`,
  `test/analyze.test.js`, `test/handoff.test.js` — 147 pass, 0 fail, 7 skipped
  (explicit 01b manual permission-lifetime fixtures with recorded steps).
- Changed runtime behavior is reflected in `README.md`, `store/privacy-policy.md`
  and `store/description.md` in the same tree, with recaptured extension
  screenshots (`images/screens/`, `store/screenshot-*.png`).
- Passed: `npm run test:e2e` (5/5) on system Chromium 152 (Arch Linux) via
  `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`: installed-extension proof covers
  audit evidence/usage retention, live refresh on DOM change, viewport/scroll
  behaviour, timing-buffer saturation, scan caps and live HEAD/range/auth/status/
  redirect checks.
- Not run: real permission-dialog lifetime cases (grant/denial/teardown inspected
  from an independent context) and hosted CI. The 7 skipped unit fixtures record
  the manual steps. Until executed, that gate is Not run, not Passed.
- 01b: no background worker or storage journal was added — the lifetime proof
  comes first, and the current architecture retains document-owned cleanup with
  a recorded pending-cleanup block. A retained grant remains an unproven risk,
  not a claimed reproduced leak.
A docs-only plan PR requires link/diff review, not a pretend application test pass. It must
not change runtime files, dependencies, manifest permissions or public availability claims.
