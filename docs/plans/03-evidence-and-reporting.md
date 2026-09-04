# 03 — Evidence, scoring and report integrity

Execution status and dependencies: [plan index](README.md).

## Outcome and evidence

A measured input never turns an untested conversion prediction into a measured saving.
Copied reports must retain the same caveats as the interface.

[Format ratios](../../lib/format.js) and [grade thresholds](../../lib/analyze.js) currently
assign a correctly sized, measured JPEG a D from the assumed 50% conversion saving; PNG
also gets D, WebP gets B, AVIF gets A. This is deterministic model arithmetic, not evidence
that one file is poorly optimized or that another needs no work. One measured resource is
also enough to produce the page's grade.

[Markdown reporting](../../lib/report.js) omits CSS-scan truncation and other limitations
that JSON/UI retain. Its resource table uses filenames, which cannot disambiguate two
same-named files at different paths. Issue opportunity rows also overlap: the Heavy row
must not be summed with resize/format rows as independent savings.

## 03a — Confidence and summary contract

1. Remove the prominent A–F delivery grade from both surfaces for the trust release.
   Lead with estimated opportunity, measured/checked/unknown resource counts and concrete
   findings. Do not replace the grade with an arbitrary coverage threshold or silently
   redefine the letters as a new score. Returning a grade later requires calibration.
2. Preserve separate provenance for input bytes, source dimensions, format detection and
   opportunity estimation. Distinguish browser-observed encoded/transfer sizes, separately
   checked response headers, inline content and model-only bytes. Header checks retain
   their request-context warning; format inferred from a URL remains a hint, not an
   observed response type. Inline bytes are not an independent network transfer.
3. Keep resize and format predictions as estimates even with known input bytes. Unknown
   source dimensions cannot produce a definite resize recommendation. Preserve aspect
   ratio, DPR, the largest recorded resource requirement, SVG exclusions, and per-usage
   findings. No simplistic pixel-count model should overwrite browser evidence.
4. Show count-based coverage directly. Retain byte-weight coverage only as the share of
   modelled weight with measured inputs, not a claim about the unknown true page weight.
   Display zero/unknown distinctly. Do not present an unmeasured zero as a free resource.
5. Keep fixed conversion ratios as explicitly labelled heuristics for prioritization,
   not promises of quality-equivalent results. Do not invent numerical confidence ranges
   without a calibration dataset. Make the distinction visible in rows and summaries,
   rather than hiding it solely in a tooltip.

## 03b — Reports, compatibility and limitations

Create one normalized limitation/evidence summary consumed by popup, audit, Markdown and
JSON. Cover element/record/payload limits, CSS budget exhaustion, possible timing-buffer
saturation, unsupported canvas/image-set cases, partial frame coverage when known,
measurement failures, and truncated browser-vitals buffers. Preserve an explicit unknown
coverage state where the current collector cannot establish the extent of omissions;
never invent an inaccessible-frame count from the number of returned frames.

Keep top-frame browser vitals labelled as such when frame evidence is merged. LCP/CLS
observations from this audit are not a field-performance result. A shifted node is not
necessarily the cause, and an offscreen-now image is not proof it was initially offscreen.

Markdown needs the same material warnings as JSON and the UI. Give each listed resource a
report-local ID and an unambiguous, escaped full URL reference; usage rows point to that ID.
Keep row caps and omitted-count warnings. Explain that finding categories overlap and
only the resource-deduplicated total is additive. Escape page-controlled text everywhere.

For the grade removal, advance `REPORT_SCHEMA_VERSION` and emit `grade: null` with an
explicit reason such as `uncalibrated-model`, rather than omitting or repurposing an old
field silently. Add old/new schema fixtures and document the change for downstream readers.
Advance `SAVING_MODEL_VERSION` only when saving formulas/coefficients change, not merely
for presentation changes. Future comparison code must reject unsupported schemas and
separate model changes from site changes.

## Regression gates

Extend [analysis tests](../../test/analyze.test.js),
[merge tests](../../test/merge.test.js), [report tests](../../test/report.test.js) and
[browser fixtures](../../test/e2e/extension.test.mjs).

| Fixture | Required assertion |
| --- | --- |
| Correctly sized measured JPEG/PNG/WebP/AVIF | Model opportunities remain labelled estimates; no authoritative grade appears |
| One measured resource among many unknowns | Coverage states the incomplete evidence, not a page-wide success |
| HEAD format/size differs from original browser evidence | Provenances stay separate; stronger page evidence is not overwritten |
| Shared resource with several differently sized usages | Bytes counted once; largest required target governs the shared resize |
| Unknown dimensions, SVG, inline resource, zero-byte/unknown cases | No false resize, invented transfer weight or false certainty |
| Every supported limitation, singly and combined | UI, Markdown and JSON preserve equivalent meaning and lower-bound warnings |
| Same filename at two URLs; hostile Markdown text | Resources remain distinguishable and output stays escaped |
| A resource is heavy, oversized and legacy format | Overlapping categories do not inflate the deduplicated opportunity total |
| Schema transition | New grade semantics are explicit; unsupported historical input fails clearly |

Run the [local gates](README.md#local-gates-and-release-evidence). Update public copy and
captures with the implementation, not in this planning PR.

## Deferred calibration

A later corpus should include photographs, flat graphics, transparency, animation, tiny
files and already optimized modern formats. Record actual input/output bytes, settings,
quality constraints and failures. Publish the corpus methodology before introducing a
score or ranges. Actual conversion remains an explicit user action; this plan does not
add encoders, upload content or train a model.
