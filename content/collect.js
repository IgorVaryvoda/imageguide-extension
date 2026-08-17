/**
 * The page collector.
 *
 * `collectImages` runs inside the inspected page through chrome.scripting.
 * Chrome serialises the function with `toString()`, so it must not use any
 * value from the surrounding module. Keep every helper inside the body, and
 * pass every constant in as an argument.
 *
 * Chrome runs the function once per frame. `lib/merge.js` joins the results.
 */

export function collectImages(markAttribute, maxElements, timingBufferSize) {
  const dpr = window.devicePixelRatio || 1;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // The browser records the real transfer size of every resource it fetched.
  // Cross-origin responses report 0 unless they send Timing-Allow-Origin.
  // Chrome keeps a limited number of entries, so a busy page loses the rest.
  const resourceEntries = performance.getEntriesByType('resource');
  const timingBufferFull = resourceEntries.length >= timingBufferSize;

  const timings = new Map();
  for (const entry of resourceEntries) {
    const size = entry.encodedBodySize || entry.transferSize || 0;
    // Newer Chrome reports the response type. Older Chrome leaves it undefined.
    const contentType = typeof entry.contentType === 'string' ? entry.contentType : '';
    if (size > 0 || contentType) timings.set(entry.name, { size, contentType });
  }

  const absolute = (url) => {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const lastSegment = (url) => {
    const clean = url.split('?')[0].split('#')[0];
    return clean.slice(clean.lastIndexOf('/') + 1);
  };

  // Walk the light DOM and every open shadow root, in document order.
  const elements = [];
  let truncated = false;
  const roots = [document];
  while (roots.length > 0) {
    const root = roots.shift();
    for (const element of root.querySelectorAll('*')) {
      if (elements.length >= maxElements) {
        truncated = true;
        break;
      }
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    if (truncated) break;
  }

  const records = new Map();
  let nextId = 0;

  const add = (record, element) => {
    if (!record.url) return;
    const existing = records.get(record.url);
    if (!existing) {
      element.setAttribute(markAttribute, record.elementId);
      records.set(record.url, record);
      return;
    }
    // The same file can appear more than once. Keep the largest display box,
    // because that box decides the size the page really needs.
    const existingArea = existing.displayWidth * existing.displayHeight;
    const newArea = record.displayWidth * record.displayHeight;
    if (newArea > existingArea) {
      element.setAttribute(markAttribute, record.elementId);
      records.set(record.url, { ...record, occurrences: existing.occurrences + 1 });
    } else {
      existing.occurrences += 1;
    }
  };

  const baseRecord = (url, element, kind) => {
    const rect = element.getBoundingClientRect();
    const timing = timings.get(url);
    const bytes = url.startsWith('data:')
      ? Math.round((url.length - url.indexOf(',') - 1) * 0.75)
      : (timing && timing.size) || 0;

    nextId += 1;
    return {
      url,
      kind,
      elementId: String(nextId),
      occurrences: 1,
      naturalWidth: 0,
      naturalHeight: 0,
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      dpr,
      transferBytes: bytes,
      contentType: (timing && timing.contentType) || '',
      inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.width > 0,
      loading: '',
      hasAlt: true,
      hasDimensions: true,
      hasSrcset: true,
      hasSizes: true,
      usesWidthDescriptors: false,
      usesFallback: false,
      isDataUri: url.startsWith('data:')
    };
  };

  for (const element of elements) {
    // Drop the mark of an earlier scan, so a stale id never wins a lookup.
    if (element.hasAttribute(markAttribute)) element.removeAttribute(markAttribute);

    const style = getComputedStyle(element);

    // 1. <img> elements, including the source that <picture> resolved to.
    if (element instanceof HTMLImageElement) {
      const url = absolute(element.currentSrc || element.src);
      if (url && !url.startsWith('blob:')) {
        const record = baseRecord(url, element, 'img');
        record.naturalWidth = element.naturalWidth || 0;
        record.naturalHeight = element.naturalHeight || 0;
        record.loading = element.loading || 'eager';
        record.hasAlt = element.hasAttribute('alt') && element.getAttribute('alt').trim() !== '';

        // Width and height attributes give the browser the ratio. So does a
        // CSS aspect-ratio, which computes to something other than `auto`.
        record.hasDimensions = Boolean(
          (element.hasAttribute('width') && element.hasAttribute('height')) ||
            (style.aspectRatio && style.aspectRatio !== 'auto')
        );

        const parent = element.parentElement;
        const sources =
          parent && parent.tagName === 'PICTURE' ? [...parent.querySelectorAll('source')] : [];
        const sourceSrcset = sources.map((source) => source.getAttribute('srcset') || '').join(' ');
        const ownSrcset = element.getAttribute('srcset') || '';
        const everySrcset = `${ownSrcset} ${sourceSrcset}`;

        record.hasSrcset = everySrcset.trim() !== '';
        record.hasSizes =
          element.hasAttribute('sizes') || sources.some((source) => source.hasAttribute('sizes'));
        record.usesWidthDescriptors = /\s\d+w(?:\s*,|\s*$)/.test(` ${everySrcset}`);

        // The <img> src won, so no <source> ever matched. That is usually a
        // media query or a type the browser never accepted.
        const fallback = absolute(element.getAttribute('src') || '');
        record.usesFallback =
          sources.length > 0 &&
          fallback !== '' &&
          !url.startsWith('data:') &&
          url === fallback &&
          !sourceSrcset.includes(lastSegment(url));

        add(record, element);
      }
    }

    // 2. Video posters. They load like images and are often forgotten.
    if (element instanceof HTMLVideoElement && element.hasAttribute('poster')) {
      const url = absolute(element.getAttribute('poster'));
      if (url && !url.startsWith('blob:')) add(baseRecord(url, element, 'poster'), element);
    }

    // 3. CSS background images.
    const background = style.backgroundImage;
    if (background && background !== 'none' && background.includes('url(')) {
      for (const match of background.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
        const url = absolute(match[2]);
        if (!url || url.startsWith('blob:')) continue;
        add(baseRecord(url, element, 'background'), element);
      }
    }
  }

  const list = [...records.values()];

  // Natural size is unknown for backgrounds and posters. Fall back to the
  // display box, so the oversize test stays neutral instead of wrong.
  for (const record of list) {
    if (!record.naturalWidth) record.naturalWidth = Math.round(record.displayWidth * dpr);
    if (!record.naturalHeight) record.naturalHeight = Math.round(record.displayHeight * dpr);
  }

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    viewport: { width: viewportWidth, height: viewportHeight, dpr },
    scannedElements: elements.length,
    truncated,
    timingBufferFull,
    images: list
  };
}
