# Chrome Web Store listing

Copy each block into the matching field at
https://chrome.google.com/webstore/devconsole.

Every asset named here sits in this directory or in `icons/`.

## Package

`dist/imageguide-extension-0.2.0.zip` — build it with `npm run zip`.

## Product details

### Name (45 characters maximum)

```
ImageGuide — Image Auditor
```

### Summary (132 characters maximum)

```
Audit every image on a page. See format, weight, wasted pixels, and the saving from WebP or AVIF.
```

### Detailed description

Also in `store/description.txt`, ready to select all and paste.

```
ImageGuide audits every image on the page you are looking at, and tells you what each one costs.

Click the icon. In under a second you get a letter grade from A to F, the total image weight, and the weight you could avoid.

WHAT IT MEASURES

• The format, read from the Content-Type header, the CDN parameter, or the file extension.
• The transfer size, taken from the browser's own Resource Timing record. Not a guess.
• The natural size against the box that shows it, so you see the wasted pixels.
• The size after a resize and a conversion to a modern format, split into the two savings so you know which one to chase.

WHAT IT FLAGS

• Oversized — the source is far larger than the box that shows it.
• Legacy format — the file uses an older encoding, and a newer one would send the same picture in fewer bytes.
• Heavy — one file is a large part of the page weight.
• No lazy loading — the image starts below the fold and still loads at once.
• Lazy hero — the image is visible at load, so loading="lazy" delays the LCP.
• No dimensions — no width and height and no CSS aspect-ratio, so the layout shifts.
• No alt text — screen readers and search engines cannot read it.
• No srcset — one file goes to every screen size.
• No sizes — the srcset uses width descriptors, so the browser assumes the full viewport width.
• Unused sources — a picture element fell back to its img, so no source ever matched.

WHAT IT SCANS

Every img, including the file that picture resolved to. Every CSS background image. Every video poster. Every open shadow root. Every frame it can reach.

HOW YOU USE IT

Filter to one problem. Search a file name or URL. Sort by saving, size, wasted pixels, or name. Click a name to scroll to that image in the page and outline it. Copy an image URL, or open it in the ImageGuide converter. Copy the whole audit as Markdown for a pull request, or as JSON for a build step.

The popup remembers your filter and sort.

ABOUT THE NUMBERS

The transfer size is a measurement, not an estimate, wherever the browser reports it. A cross-origin response only reveals its size when it sends a Timing-Allow-Origin header. Where that header is missing, ImageGuide estimates from the pixel count and the format, and labels the number "est." Press "Measure the real sizes" to replace those estimates with real Content-Length values. ImageGuide asks for access only to the origins that serve the unmeasured files, and only when you press the button.

The saving is a model, not a promise. It combines the pixels you can drop with a fixed compression ratio per format. Treat it as a ranked list of what to fix first.

PRIVACY

ImageGuide sends nothing anywhere. There is no server, no account, and no analytics. Every measurement stays in the popup and disappears when you close it. There is no background process.

OPEN SOURCE

MIT licensed. https://github.com/IgorVaryvoda/imageguide-extension

The browser companion to https://www.imageguide.dev
```

### Category

`Developer Tools`

### Language

`English (United States)`

## Graphic assets

| Field | File |
| --- | --- |
| Store icon | `icons/icon128.png` |
| Screenshot 1 | `store/screenshot-1-summary.png` |
| Screenshot 2 | `store/screenshot-2-list.png` |
| Screenshot 3 | `store/screenshot-3-filter.png` |
| Screenshot 4 | `store/screenshot-4-search.png` |
| Screenshot 5 | `store/screenshot-5-actions.png` |
| Small promo tile | `store/promo-small-440x280.png` |
| Marquee promo tile | `store/promo-marquee-1400x560.png` |

## Privacy practices

### Single purpose

```
ImageGuide audits the images on the page the user is viewing. It reports the format, the transfer size, the wasted pixels, and the saving available from a modern image format. That is its only function.
```

### Permission justifications

**activeTab**

```
The extension reads the images of the page only after the user clicks the toolbar icon. activeTab grants access to that one tab, for that one visit, and nothing more.
```

**scripting**

```
The extension injects two functions into the page. The first gathers a record of every image: its URL, its natural size, the box that shows it, and the transfer size the browser recorded. The second scrolls to one image and outlines it when the user clicks its name in the popup. No code is fetched from a remote source.
```

**storage**

```
The extension stores two values: the issue filter and the sort order the user last chose, so the popup opens the same way next time. Nothing else is stored.
```

**Host permission (`*://*/*`, optional)**

```
This permission is optional and is never requested at install time. A cross-origin image hides its transfer size unless the server sends a Timing-Allow-Origin header. When the user presses "Measure the real sizes", the extension requests access only to the specific origins that serve those images, then reads the Content-Length header of each one. The user can decline, and the extension continues with estimates.
```

### Remote code use

Select **No, I am not using remote code**. Then paste this justification:

```
The extension uses no remote code. Every line it runs ships inside the package: two injected functions in content/, the scoring rules in lib/, and the popup in popup/. There is no eval, no new Function, no string-to-code execution, and no script loaded from any URL. The extension has no background service worker and declares no content_security_policy override.

chrome.scripting.executeScript is called with a `func` reference to a function defined in the package, never with a `files` entry pointing outside it and never with injected source text. Chrome serialises that local function and runs a copy in the page.

The only remote data the extension touches is image bytes: thumbnails in the popup load from the same image addresses the page already used, and the optional size check reads response headers. Neither is executed as code.
```

### Data usage

Tick **nothing**. Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```
https://www.imageguide.dev/privacy
```

That page must exist before you submit. It needs one line: the extension collects,
stores, and transmits no user data.

## Distribution

- Visibility: **Public**
- Regions: **All regions**
- Pricing: **Free**
