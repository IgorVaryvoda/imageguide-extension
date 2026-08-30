ImageGuide inspects common image resources on the page you are viewing and ranks the delivery work worth investigating.

Click the icon to see three separate results:

• Delivery efficiency — a grade based only on resources whose size the browser reported or you checked.
• Markup findings — cautious checks for missing alt attributes, missing dimensions, current viewport loading state, and responsive-image opportunities.
• Confidence — the share of modelled image weight backed by measured resource sizes.

WHAT IT REPORTS

• Source format from Content-Type, a CDN parameter, or the file extension.
• Resource Timing encoded-body or transfer size, with provenance in JSON.
• Optional validated Content-Length or Content-Range response sizes.
• Raw source pixels for plain images and exactly matched w/x candidates. Uncertain matches remain unknown.
• Estimated resize and format opportunities. These are models, not promised final weights.

WHAT IT FLAGS

• Oversized — known source pixels substantially exceed the rendered need.
• Legacy format — JPEG, PNG, GIF, BMP, or ICO may benefit from a newer format.
• AVIF opportunity — WebP is modern already, but AVIF may reduce it further.
• Heavy — one resource is at least 400 kB.
• Eager image offscreen now — the image is outside the viewport at scan time and is not lazy.
• Lazy image visible now — the image is inside the viewport at scan time and is lazy. This is not an LCP test.
• Lazy-loaded LCP image — the browser identified this usage as LCP, and it is marked lazy.
• Layout-shift source — the browser attributed a shift to this element; the shifted node is not necessarily the cause.
• No dimensions — no width and height attributes and no CSS aspect-ratio.
• Missing alt attribute — alt="" remains valid for decorative images.
• Responsive-image opportunity — a confirmed oversized raster has no srcset.
• Default sizes mismatch — a width-descriptor srcset omits sizes while its slot is notably narrower than the viewport.

WHAT IT SCANS

ImageGuide scans img elements and selected picture/srcset candidates; computed CSS backgrounds, masks, borders, content URLs, image-set candidates, and pseudo-elements; video posters; SVG image elements; open shadow roots; and reachable frames. A persistent full-audit tab watches relevant DOM changes and refreshes the evidence. Canvas elements are counted and disclosed, but canvas/WebGL pixels cannot be mapped back to source requests. Closed shadow roots, inaccessible frames, and uncertain typed image-set selections remain unknown. Repeated URLs share one resource row, with every recorded element usage and its markup findings grouped underneath. Element, resource, usage, URL-length, scan-time, and 4 MB serialized-payload limits keep hostile or unusually large pages bounded; the interface warns when totals are incomplete.

HOW YOU USE IT

Use the popup for an instant summary, or open the persistent full audit for grouped usage evidence, buffered LCP and CLS facts, live page watching, and more room to investigate. Filter to one finding. Search a file name or URL. Sort by opportunity, response size, resize opportunity, or name. Click a resource or grouped usage to scroll to that element in the page. Copy an image URL, open the ImageGuide converter without sending that URL, or copy the audit as escaped Markdown or versioned JSON.

ABOUT THE NUMBERS

Resource Timing may expose encodedBodySize or transferSize; ImageGuide records which one it used. Cross-origin responses often hide both. In that case, ImageGuide labels a low-confidence model.

Press "Check response sizes" to request temporary access only to the relevant image origins. Each click checks at most 100 resources with up to six concurrent requests and an eight-second timeout. ImageGuide accepts only a successful image HEAD response or a validated 206 image range response, cancels response bodies, omits credentials, and removes permissions granted for that check. These response sizes may still differ from the page's original negotiated request.

PRIVACY

No audit report is automatically transmitted to ImageGuide, and the interface does not load remote thumbnails. Optional response-size checks make the requests described above. User-clicked links open ImageGuide pages, but the converter link does not contain the audited image URL. There is no account or analytics. Only the last filter and sort choice are stored locally.

OPEN SOURCE

MIT licensed. https://github.com/IgorVaryvoda/imageguide-extension

The browser companion to https://www.imageguide.dev
