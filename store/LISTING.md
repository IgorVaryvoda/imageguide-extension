# Chrome Web Store listing

Copy each block into the matching field at
https://chrome.google.com/webstore/devconsole.

## Package

`dist/imageguide-extension-0.4.0.zip` — build it with `npm run zip`.

## Product details

### Name

```
ImageGuide — Image Auditor
```

### Summary

```
Inspect common page images. Separate measured response sizes, estimated delivery opportunities, and markup findings.
```

### Detailed description

Paste the complete contents of [`description.md`](description.md). Keeping the paste-ready
copy in one file prevents the listing and repository from drifting apart.

### Category and language

- Category: **Developer Tools**
- Language: **English (United States)**

## Graphic assets

| Field | File |
| --- | --- |
| Store icon | `icons/icon128.png` |
| Screenshot 1 | `store/screenshot-1-summary.png` |
| Screenshot 2 | `store/screenshot-2-list.png` |
| Screenshot 3 | `store/screenshot-3-filter.png` |
| Screenshot 4 | `store/screenshot-4-search.png` |
| Screenshot 5 (full audit) | `store/screenshot-5-actions.png` |
| Small promo tile | `store/promo-small-440x280.png` |
| Marquee promo tile | `store/promo-marquee-1400x560.png` |

The five screenshots were refreshed from the 0.4.0 extension in Chromium against the
checked-in browser-grade fixture. Four show the popup and one shows the persistent full
audit. The interface, browser-selected candidates, LCP, and CLS evidence are real; nothing
is mocked.

## Privacy practices

### Single purpose

```
ImageGuide inspects common image resources on the page the user is viewing. It reports observed response sizes, estimated delivery opportunities, and markup findings. That is its only function.
```

### Permission justifications

**activeTab**

```
The extension reads supported image usage on the current page only after the user opens the popup. activeTab grants temporary access to that tab for the user-initiated popup and persistent full audit, until the tab navigates or closes.
```

**scripting**

```
The extension injects three packaged functions. The observer buffers browser LCP, layout-shift, and relevant DOM-mutation evidence. The collector records supported image URLs, browser-observed size data, known source dimensions, rendered boxes, and markup state. The highlighter scrolls to a selected resource and draws a temporary outline. No code is fetched remotely.
```

**storage**

```
The extension stores only the last finding filter and sort choice in Chrome local extension storage.
```

**Host permission (`*://*/*`, optional)**

```
This permission is optional and is never requested at install time. If the user selects "Check response sizes", the extension requests only the origins of resources whose size is hidden. Each click checks at most 100 resources, with no more than six credential-free requests at once. It validates image status and MIME headers, applies a timeout, cancels response bodies, and removes origins granted for that check. Origins already granted before the check are preserved. The user can decline and keep modelled values.
```

### Remote code use

Select **No, I am not using remote code**, then paste:

```
Every executable line ships in the extension package. There is no eval, new Function, string-to-code execution, remotely hosted script, or background service worker. chrome.scripting.executeScript receives packaged function references, never remote source text.

Remote image URLs are data, not code. The interface does not load remote thumbnails. The optional response-size action reads validated response headers and cancels response bodies.
```

### Data usage

The extension developer receives no audit data, so tick no collected-data categories. The
external policy still discloses optional response checks, ordinary network metadata,
user-clicked links, and local settings. Re-check the Web Store questionnaire wording before
each submission.

### Privacy policy URL

```
https://www.imageguide.dev/privacy
```

[`privacy-policy.md`](privacy-policy.md) is the source copy. Publish that content at the URL
above before submitting 0.4.0; repository edits alone do not update the live policy.

## Distribution

- Visibility: **Public**
- Regions: **All regions**
- Pricing: **Free**
