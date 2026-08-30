# ImageGuide — Image Auditor

![ImageGuide Image Auditor](store/promo-small-440x280.png)

**[Add to Chrome](https://chromewebstore.google.com/detail/hinifcidioledficgenmdncpkifnngap)** — free on the Chrome Web Store.

A Chrome extension that inspects common image resources on the open page. It separates
browser-observed response sizes, estimated delivery opportunities, and markup findings.

It is the browser companion to [imageguide.dev](https://www.imageguide.dev).

## What it reports

For each resource the popup shows:

- The source format, read from `Content-Type`, a CDN parameter, or the file extension.
- The encoded-body or transfer size reported by Resource Timing, with its provenance.
- A validated `Content-Length` or `Content-Range` response size after an optional user action.
- Raw source pixels from plain `src` images and exactly matched `w` or `x` candidates.
  Unmatched, redirected, or conflicting candidates remain unknown.
- A modelled resize and format opportunity, labelled as an estimate.
- Every element-level usage grouped under its shared resource.

It flags these problems:

| Issue | Meaning |
| --- | --- |
| Oversized | The source is more than 1.25× the pixels the layout needs. |
| Legacy format | JPEG, PNG, GIF, BMP, or ICO, where a newer format may be smaller. |
| AVIF opportunity | WebP is modern already; AVIF may reduce it further. |
| Heavy | The single file is 400 kB or more. |
| Eager image offscreen now | The image is outside the viewport at scan time and is not lazy. |
| Lazy image visible now | The image is inside the viewport at scan time and is lazy. This is not an LCP test. |
| Lazy-loaded LCP image | The browser identified this usage as LCP, and it is marked lazy. |
| Layout-shift source | The browser attributed a shift to this element; the shifted node is not necessarily the cause. |
| No dimensions | The `<img>` has no `width` and `height` and no CSS `aspect-ratio`. |
| Missing alt attribute | The `<img>` has no `alt` attribute. `alt=""` is allowed for decorative images. |
| Responsive-image opportunity | A confirmed oversized raster has no `srcset`; verify server negotiation too. |
| Default sizes mismatch | A width-descriptor `srcset` omits `sizes` while its slot is notably narrower than the viewport. |

The delivery grade uses measured resources only. Markup findings are counted separately,
and the popup states what share of the modelled image weight was measured.

## What it scans

- `<img>` elements, including the exact candidate selected from `<picture>` and `srcset`
  when it can be matched confidently.
- Computed `background-image`, `mask-image`, `border-image-source`, and `content: url()`
  values on elements and `::before` / `::after` pseudo-elements.
- The browser-selected `image-set()` resource when Resource Timing identifies it, with a
  density fallback only when type negotiation is not involved.
- `<video poster>` and SVG `<image>` resources.
- Every open shadow root and reachable frame. `lib/merge.js` joins frame evidence.
- Relevant DOM changes while the persistent full audit is open. The popup remains an
  instant point-in-time summary.

Canvas elements are counted and disclosed, but canvas/WebGL pixels cannot be mapped back to
their source requests. Closed shadow roots, inaccessible frames, and typed `image-set()`
selections without a timing match remain unknown. Repeated URLs share one resource row, with
every recorded usage and its markup findings grouped underneath.

The scan stops after 8000 elements, 2000 resources, or 8000 usages. Individual URLs are
limited to 4096 characters, and serialized URL text is capped at 1,000,000 characters. The
serialized page result is also capped at 4 MB. The interface says when a limit is reached
because the totals are then a lower bound.

## Use it

| Control | What it does |
| --- | --- |
| Filter chips | Show resources with that resource- or usage-level finding. |
| Search box | Match a file name or a URL. |
| Sort | Order by opportunity, response size, resize opportunity, or name. |
| Resource or usage | Scroll to that element in the page and outline it. |
| Copy | Copy the image URL. |
| Convert | Open the ImageGuide converter without sending the audited image URL. |
| Copy report | Copy a Markdown report for a pull request or a ticket. |
| JSON | Copy a JSON report for a build step. |
| Open full audit | Keep a persistent resource ledger open with usage evidence, LCP, CLS, and live page watching. |

The popup remembers the filter and the sort between sessions.

## Install from source

The store version and this repository are the same code. Load it yourself to
develop, or to read every line first.

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open any page and click the extension icon.

The extension needs no build step. It is plain ES modules.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the images of the page you are on, only after you click the icon. |
| `scripting` | Inject the packaged observer, collector, and highlighter into that page. |
| `storage` | Keep your filter and sort choice between sessions. |
| `*://*/*` (optional) | Check response-size headers for cross-origin images. |

The host permission is **optional**. Chrome asks for it only when you press
**Check response sizes**. Without it, the extension models the size of any image that hides
its Resource Timing fields. Permissions granted for one check are removed afterwards;
origins that were already granted remain granted.

No audit report is automatically transmitted to ImageGuide, and the popup does not load
remote thumbnails. The optional response-size check makes `HEAD` and, when necessary,
validated one-byte range requests with credentials omitted. User-clicked links open
ImageGuide pages. See [the policy source](store/privacy-policy.md) for the exact disclosure.

## Why some sizes are estimates

The browser may expose `encodedBodySize` or `transferSize` through
`PerformanceResourceTiming`. They are different measurements, so the JSON report records
which one was used. A cross-origin response normally hides both without a
`Timing-Allow-Origin` header. The extension then uses a low-confidence model and labels it.

Exactly 250 Resource Timing entries is only a warning that the default buffer may have
filled. A page can resize or clear that buffer, so the popup does not claim certainty.

Press **Check response sizes** to try a validated image `Content-Length`, then a `206`
`Content-Range` fallback. Six workers run at once, each check times out, and response bodies
are cancelled. One click checks at most 100 resources. These checks omit credentials and may
not reproduce the request context or variant that the page originally loaded.

## Layout

```
manifest.json          Manifest V3, no background worker
lib/constants.js       Values the popup passes to the injected functions
lib/format.js          Format detection and byte estimation (pure)
lib/analyze.js         Issue rules, saving model, page grade (pure)
lib/merge.js           Joins the frame results into one page (pure)
lib/measure.js         Validates and bounds optional response-size checks
lib/report.js          Sort, filter, Markdown, and JSON output (pure)
content/collect.js     Runs in the page, gathers resources and every supported usage
content/observe.js     Buffers LCP, layout shifts, and relevant page mutations
content/highlight.js   Runs in the page, scrolls to and outlines one image
extension/             Shared tab orchestration and temporary permission handling
popup/                 Instant summary and compact resource list
audit/                 Persistent full-audit tab and live evidence ledger
test/                  Unit and real-Chromium fixture tests
scripts/verify.mjs     Static checks Chrome only reports at run time
scripts/               Asset building and Web Store packaging
images/                Master art, at the size it was drawn
icons/                 The extension icons, built from images/icon-master.png
store/                 Web Store and social art, at the exact sizes each needs
```

`lib/` holds no extension API calls, and the injected collectors hold none either, so the
rules are testable in plain Node.

## Test

```bash
npm test
```

`npm test` runs three stages:

1. `npm run verify` — a static pass over the manifest and the popup. It fails when a
   referenced file is missing, when an import does not resolve, when a page holds an inline
   script, when the manifest and the code disagree about a permission, or when an injected
   function directly reads an imported or module-constant name. It also asks Node to parse
   every shipped module.
2. ESLint `no-undef` across shipped, script, and test code.
3. Unit tests for selected candidates, CSS sources, browser evidence, resource/usage
   analysis, response validation and concurrency, frame merging, and reports.

Run the installed extension against the Chromium fixtures too:

```bash
npm run test:e2e
```

The E2E suite uses Puppeteer only as a development dependency. It triggers the real toolbar
action and covers popup lifecycle, the persistent audit tab, `activeTab` handoff, dynamic
pages, LCP/CLS, scrolling, throttled networking, 250+ timing entries, response edge cases,
and the 8,000-element performance and payload budgets. CI runs it on Linux, macOS, and
Windows, plus both Chrome for Testing and stable Chrome on Linux.

`test/helpers/dom.js` is a DOM small enough to run the collector in plain Node. It supplies
only what `collectImages` reads, so a new DOM call in the collector fails there first. The
shipped extension keeps no runtime dependencies.

## Package

```bash
npm run zip
```

Tests run first through the `prezip` script. A green run writes
`dist/imageguide-extension-<version>.zip`, ready for the Chrome Web Store. The ZIP holds the
manifest, icons, and five shipped code directories. It holds no tests, dependencies, or store art.

## Art

```bash
npm run assets
```

It reads the masters in `images/` and writes every derived size:

| Output | Size | Use |
| --- | --- | --- |
| `icons/icon16.png` | 16×16 | The toolbar |
| `icons/icon48.png` | 48×48 | The extensions page |
| `icons/icon128.png` | 128×128 | The manifest and the store icon |
| `store/promo-small-440x280.png` | 440×280 | The Web Store listing tile |
| `store/promo-marquee-1400x560.png` | 1400×560 | The Web Store marquee |
| `store/social-card-1200x630.png` | 1200×630 | Link previews for imageguide.dev |

Edit a master in `images/`, run the script, and every size follows.

## Store screenshots

```bash
npm run screenshots
```

It reads four popup captures and one full-audit capture in `images/screens/`, then writes the
five 1280×800 store images. They come from the real extension auditing the checked-in
browser-grade fixture in Chromium. Nothing in the interfaces is drawn or mocked.

To take a fresh set of captures:

```bash
IMAGEGUIDE_CAPTURE_DIR=images/screens npm run test:e2e
npm run screenshots
```

The captions live at the top of `scripts/make-store-screenshots.mjs`.

## Accuracy of the saving model

The opportunity is a model, not a promised final weight. It combines two factors, and the
popup shows each one on its own line:

1. **Resize.** Bytes fall with the pixel count. The model uses the browser's current DPR and
   preserves the source aspect ratio conservatively. A vector never resizes. Exact `w` and
   `x` matches recover raw source pixels; an uncertain match gets no resize claim.
2. **Format.** A fixed ratio per format: JPEG to AVIF at 0.5, PNG to WebP at 0.4, GIF to
   WebP at 0.15, and WebP to AVIF at 0.75. WebP is labelled as an AVIF opportunity, not a
   legacy format.

The ratios sit in `lib/format.js`. Change them there if your own measurements differ.

## Licence

MIT. See [LICENSE](LICENSE).
