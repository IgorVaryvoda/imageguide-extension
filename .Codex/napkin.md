# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-08-30 | self | Markdown-escape test expected escaped brackets but not the newly escaped parentheses | Assert the complete sanitizer output whenever the escaped character set changes |
| 2026-08-30 | self | A broad README patch used stale exact context and failed | Re-read the target section and apply smaller exact hunks after earlier edits |
| 2026-08-30 | self | Used shell `||` fallbacks while probing browser tools | Run independent probes through parallel tool calls; do not chain shell commands |
| 2026-08-30 | environment | Opening the popup as a normal Chromium tab does not create the toolbar-click activeTab grant | For CDP smoke tests, use the README scratch copy with temporary host_permissions; never change the shipped manifest |
| 2026-08-30 | self | Browser smoke assertions passed but temp cleanup raced Chromium shutdown | Await the browser exit before removing its generated profile, with bounded rm retries |
| 2026-08-30 | self | Store capture assumed Wikipedia would still produce an Oversized filter | Responsive Wikipedia images now correctly have unknown source pixels; capture a filter that current evidence supports |
| 2026-08-30 | self | Tried to delete and add the same path in one apply_patch operation | Use separate delete and add patches for a whole-file replacement |
| 2026-08-30 | self | Usage-table test forgot that Markdown escaping also covers the element-ID hash | Assert escaped usage labels in copied Markdown |
| 2026-08-30 | environment | Repeated CDP Page.captureScreenshot calls can stall in headless Chromium | Put a short timeout around each capture and retry a fresh CDP connection |
| 2026-08-30 | self | Combined apply_patch had a stray hunk marker before the next file header | End one file hunk cleanly before starting another Update File block |
| 2026-08-30 | environment | Puppeteer 25 returned from `launch({ enableExtensions: [...] })` before the unpacked extension appeared | Poll `browser.extensions()` after launch before triggering the action |
| 2026-08-30 | self | The fake DOM uppercased SVG `image`, but Chromium preserves the lowercase SVG tag name | Match SVG elements by `localName` and keep browser coverage for namespace behavior |
| 2026-08-30 | self | An E2E failure left an old audit tab that the next test reused by path | Close fixture and extension pages after every browser test |
| 2026-08-30 | environment | `setViewport()` on a Puppeteer extension page hit an internal private-field error | Launch at the largest capture viewport and use screenshot clips for popup assets |
| 2026-08-30 | self | Audit `.state { display: grid }` overrode the visual effect of the `hidden` attribute | Add a global `[hidden] { display: none !important }` rule and inspect generated captures |
| 2026-08-30 | environment | `apply_patch` cannot delete a binary PNG because it must decode the file as UTF-8 | Use an explicit validated removal only for generated binary artifacts |
| 2026-08-30 | environment | Raw CDP metrics override is also unsupported on the special extension-popup target | Capture only the real visible popup viewport, then pad the generated store card |
| 2026-08-30 | self | ImageMagick padded a popup by repeating edge pixels because the background was applied too late | Set the background before `-extent` and inspect the composed store image |

## User Preferences
- Preserve the dependency-free browser-extension architecture; fix correctness at the data and semantics layer.

## Patterns That Work
- Real Chromium smoke: load a temporary copy with test-only host permissions, keep the shipped manifest unchanged, activate the fixture tab, then reload the popup target through CDP.
- Keep public claims in `store/description.md` and reference that single paste-ready source from `store/LISTING.md`.

## Patterns That Don't Work
- (accumulate here)

## Domain Notes
- Audit claims must distinguish browser-observed facts from estimates.
