# ImageGuide — Image Auditor

![ImageGuide Image Auditor](store/promo-small-440x280.png)

A Chrome extension that audits every image on the open page. It shows the format, the real
weight, the wasted pixels, and the saving you get from WebP or AVIF.

It is the browser companion to [imageguide.dev](https://www.imageguide.dev).

## What it reports

For each image the popup shows:

- The format, read from the `Content-Type` header, the CDN parameter, or the file extension.
- The transfer size, taken from the browser Resource Timing data.
- The natural size against the box that shows it, so you see the wasted pixels.
- The estimated size after a resize and a conversion to a modern format.
- The number of times the page uses the same file.

It flags these problems:

| Issue | Meaning |
| --- | --- |
| Oversized | The source is more than 1.25× the pixels the layout needs. |
| Legacy format | JPEG, PNG, GIF, or BMP, where AVIF or WebP is smaller. |
| Heavy | The single file is 400 kB or more. |
| No lazy loading | The image starts below the fold and still loads at once. |
| Lazy hero | The image is visible at load, so `loading="lazy"` delays the LCP. |
| No dimensions | The `<img>` has no `width` and `height` and no CSS `aspect-ratio`. |
| No alt text | The image has no alt attribute, or an empty one. |
| No srcset | One file goes to every screen size. |
| No sizes | The `srcset` uses `w` descriptors, so the browser assumes the full viewport width. |
| Unused sources | A `<picture>` fell back to its `<img>`, so no `<source>` ever matched. |

The page gets a letter grade from A to F. The grade comes from the share of the image
weight that is avoidable.

## What it scans

- Every `<img>`, including the source that `<picture>` resolved to.
- Every CSS background image, including a multiple background.
- Every `<video poster>`.
- Every open shadow root.
- Every frame the extension can reach. `lib/merge.js` joins the frame results into one page.

The scan stops after 8000 elements. The popup says so when it does, because the totals are
then a lower bound.

## Use it

| Control | What it does |
| --- | --- |
| Filter chips | Show only the images with one issue. The tooltip gives the avoidable weight. |
| Search box | Match a file name or a URL. |
| Sort | Order by saving, size, wasted pixels, or name. |
| Image name | Scroll to the image in the page and outline it. |
| Copy | Copy the image URL. |
| Convert | Open the image in the ImageGuide converter. |
| Copy report | Copy a Markdown report for a pull request or a ticket. |
| JSON | Copy a JSON report for a build step. |

The popup remembers the filter and the sort between sessions.

## Install for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open any page and click the extension icon.

The extension needs no build step. It is plain ES modules.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the images of the page you are on, only after you click the icon. |
| `scripting` | Inject the collector and the highlighter into that page. |
| `storage` | Keep your filter and sort choice between sessions. |
| `*://*/*` (optional) | Measure the exact size of cross-origin images. |

The host permission is **optional**. Chrome asks for it only when you press
**Measure the real sizes**. Without it, the extension estimates the size of any image that
hides its `Timing-Allow-Origin` header.

The extension sends no data anywhere. Every measurement stays in the popup.

## Why some sizes are estimates

The browser reports the real transfer size through `PerformanceResourceTiming`. A
cross-origin response only exposes that number when it sends a `Timing-Allow-Origin`
header. Most CDNs do not. For those files the extension estimates the size from the pixel
count and the format, then labels the number `(est.)`.

Chrome also keeps only 250 timing entries per document. A page that loads more resources
than that loses the rest. The popup says so, and a reload gives you a clean measurement.

Press **Measure the real sizes** to replace the estimates with `Content-Length` values.
The extension asks for host access first, and it asks only for the origins that serve the
unmeasured images.

## Layout

```
manifest.json          Manifest V3, no background worker
lib/constants.js       Values the popup passes to the injected functions
lib/format.js          Format detection and byte estimation (pure)
lib/analyze.js         Issue rules, saving model, page grade (pure)
lib/merge.js           Joins the frame results into one page (pure)
lib/report.js          Sort, filter, Markdown, and JSON output (pure)
content/collect.js     Runs in the page, gathers every image record
content/highlight.js   Runs in the page, scrolls to and outlines one image
popup/                 The whole user interface
test/                  Unit tests, plus a small DOM stub for the collector
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

`npm test` runs two stages:

1. `npm run verify` — a static pass over the manifest and the popup. It fails when a
   referenced file is missing, when an import does not resolve, when a page holds an inline
   script, when the manifest and the code disagree about a permission, or when an injected
   function reads a module-scope name. Chrome only reports that last one at run time, as a
   `ReferenceError` inside the page.
2. The unit tests — format detection, the saving model, the issue rules, the grade, the
   frame merge, the reports, and the collector itself.

`test/helpers/dom.js` is a DOM small enough to run the collector in plain Node. It supplies
only what `collectImages` reads, so a new DOM call in the collector fails there first. The
project keeps no dependencies.

## Package

```bash
npm run zip
```

It writes `dist/imageguide-extension-<version>.zip`, ready for the Chrome Web Store. The
zip holds the manifest, the icons, and the three code directories. It holds no art.

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

It reads the popup captures in `images/screens/` and frames each one on the 1280×800
canvas the Web Store asks for. The captures are the real extension, running against a real
page. Nothing in them is drawn or mocked.

To take a fresh set of captures:

1. Copy the extension to a scratch directory and add `"host_permissions": ["*://*/*"]` to
   the copy. The popup needs that to run as a background tab. The interface is the same
   either way.
2. Start Chromium with the copy and a debugging port:
   ```bash
   chromium --user-data-dir=/tmp/ig-profile --load-extension=/tmp/ig-ext \
            --remote-debugging-port=9222 --no-first-run
   ```
3. Open an image-heavy page in the first tab.
4. Open `chrome-extension://<id>/popup/popup.html` in a second tab, put the first tab in
   front, then reload the popup from inside it. The popup then audits the page tab, as it
   does in use.
5. Set the popup viewport to 436×600 at a device pixel ratio of 2, and capture with
   `Page.captureScreenshot`.
6. Save the five states to `images/screens/` as `01-summary.png` through `05-actions.png`,
   then run `npm run screenshots`.

The captions live at the top of `scripts/make-store-screenshots.mjs`.

## Accuracy of the saving model

The saving is an estimate, not a measurement. It combines two factors, and the popup shows
each one on its own line:

1. **Resize.** Bytes fall with the pixel count, capped at a 2× device pixel ratio. A vector
   never resizes, because its weight is text, not pixels.
2. **Format.** A fixed ratio per format: JPEG to AVIF at 0.5, PNG to WebP at 0.4, GIF to
   WebP at 0.15.

The ratios sit in `lib/format.js`. Change them there if your own measurements differ.

## Roadmap

- Read `Content-Type` for every image on the first scan, not only when Chrome reports it.
- Watch the page for images that load after the scan.
- A CI runner that takes the JSON report and fails a build over a budget.

## Licence

MIT. See [LICENSE](LICENSE).
