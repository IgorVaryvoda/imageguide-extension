# ImageGuide — Image Auditor

A Chrome extension that audits every image on the open page. It shows the format, the real
weight, the wasted pixels, and the saving you get from WebP or AVIF.

It is the browser companion to [imageguide.dev](https://www.imageguide.dev).

## What it reports

For each image the popup shows:

- The format, read from the file extension, the CDN parameter, or the `Content-Type` header.
- The transfer size, taken from the browser Resource Timing data.
- The natural size against the box that shows it, so you see the wasted pixels.
- The estimated size after a resize and a conversion to a modern format.

It flags these problems:

| Issue | Meaning |
| --- | --- |
| Oversized | The source is more than 1.25× the pixels the layout needs. |
| Legacy format | JPEG, PNG, GIF, or BMP, where AVIF or WebP is smaller. |
| Heavy | The single file is 400 kB or more. |
| No lazy loading | The image starts below the fold and still loads at once. |
| Lazy hero | The image is visible at load, so `loading="lazy"` delays the LCP. |
| No dimensions | The `<img>` has no `width` and `height`, so the layout shifts. |
| No alt text | The image has no alt attribute, or an empty one. |
| No srcset | One file goes to every screen size. |

The page gets a letter grade from A to F. The grade comes from the share of the image
weight that is avoidable.

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
| `storage` | Keep your filter choice between sessions. |
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

Press **Measure the real sizes** to replace the estimates with `Content-Length` values.
The extension asks for host access first, and it asks only for the origins that serve the
unmeasured images.

## Layout

```
manifest.json          Manifest V3, no background worker
lib/format.js          Format detection and byte estimation (pure)
lib/analyze.js         Issue rules, saving model, page grade (pure)
content/collect.js     Runs in the page, gathers every image record
content/highlight.js   Runs in the page, scrolls to and outlines one image
popup/                 The whole user interface
test/                  Unit tests for the pure logic
scripts/verify.mjs     Static checks Chrome only reports at run time
scripts/               Icon drawing and Web Store packaging
```

`lib/` and the injected collectors hold no extension API calls, so the rules are testable
in plain Node.

## Test

```bash
npm test
```

`npm test` runs two stages:

1. `npm run verify` — a static pass over the manifest and the popup. It fails when a
   referenced file is missing, when a page holds an inline script, or when an injected
   function reads a module-scope name. Chrome only reports that last one at run time, as a
   `ReferenceError` inside the page.
2. The unit tests — format detection, the saving model, the issue rules, and the grade.

## Package

```bash
npm run zip
```

It writes `dist/imageguide-extension-<version>.zip`, ready for the Chrome Web Store.

## Accuracy of the saving model

The saving is an estimate, not a measurement. It combines two factors:

1. **Resize.** Bytes fall with the pixel count, capped at a 2× device pixel ratio.
2. **Format.** A fixed ratio per format: JPEG to AVIF at 0.5, PNG to WebP at 0.4, GIF to
   WebP at 0.15.

The ratios sit in `lib/format.js`. Change them there if your own measurements differ.

## Roadmap

- Read the real `Content-Type` during the first scan, not only on demand.
- Detect `<picture>` sources that never match, a common responsive bug.
- Export the report as JSON for CI.
- A one-click link that opens the image in the ImageGuide converter.

## Licence

MIT. See [LICENSE](LICENSE).
