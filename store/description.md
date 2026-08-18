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
