/**
 * The page collector.
 *
 * `collectImages` runs inside the inspected page through chrome.scripting.
 * Chrome serialises the function with `toString()`, so it must not use any
 * value from the surrounding module. Keep every helper inside the body.
 */

export function collectImages() {
  const MAX_ELEMENTS_SCANNED = 6000;

  const dpr = window.devicePixelRatio || 1;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // The browser records the real transfer size of every resource it fetched.
  // Cross-origin responses report 0 unless they send Timing-Allow-Origin.
  const timings = new Map();
  for (const entry of performance.getEntriesByType('resource')) {
    const size = entry.encodedBodySize || entry.transferSize || 0;
    if (size > 0) timings.set(entry.name, size);
  }

  const absolute = (url) => {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const records = new Map();

  const add = (record) => {
    if (!record.url) return;
    const existing = records.get(record.url);
    if (!existing) {
      records.set(record.url, record);
      return;
    }
    // The same file can appear more than once. Keep the largest display box,
    // because that box decides the size the page really needs.
    const existingArea = existing.displayWidth * existing.displayHeight;
    const newArea = record.displayWidth * record.displayHeight;
    if (newArea > existingArea) {
      records.set(record.url, { ...record, occurrences: existing.occurrences + 1 });
    } else {
      existing.occurrences += 1;
    }
  };

  const baseRecord = (url, element, kind) => {
    const rect = element ? element.getBoundingClientRect() : { top: 0, bottom: 0, width: 0, height: 0 };
    const bytes = url.startsWith('data:')
      ? Math.round((url.length - url.indexOf(',') - 1) * 0.75)
      : timings.get(url) || 0;

    return {
      url,
      kind,
      occurrences: 1,
      naturalWidth: 0,
      naturalHeight: 0,
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      dpr,
      transferBytes: bytes,
      inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.width > 0,
      loading: '',
      hasAlt: true,
      hasDimensions: true,
      hasSrcset: true,
      isDataUri: url.startsWith('data:')
    };
  };

  // 1. <img> elements, including the source that <picture> resolved to.
  for (const element of document.images) {
    const url = absolute(element.currentSrc || element.src);
    if (!url || url.startsWith('blob:')) continue;

    const record = baseRecord(url, element, 'img');
    record.naturalWidth = element.naturalWidth || 0;
    record.naturalHeight = element.naturalHeight || 0;
    record.loading = element.loading || 'eager';
    record.hasAlt = element.hasAttribute('alt') && element.getAttribute('alt').trim() !== '';
    record.hasDimensions =
      (element.hasAttribute('width') && element.hasAttribute('height')) ||
      (element.style.aspectRatio !== '' && element.style.aspectRatio !== undefined);
    record.hasSrcset =
      element.hasAttribute('srcset') ||
      (element.parentElement?.tagName === 'PICTURE' &&
        element.parentElement.querySelector('source[srcset]') !== null);
    add(record);
  }

  // 2. CSS background images.
  const elements = document.querySelectorAll('*');
  const scanLimit = Math.min(elements.length, MAX_ELEMENTS_SCANNED);
  for (let index = 0; index < scanLimit; index += 1) {
    const element = elements[index];
    const background = getComputedStyle(element).backgroundImage;
    if (!background || background === 'none' || !background.includes('url(')) continue;

    for (const match of background.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      const url = absolute(match[2]);
      if (!url || url.startsWith('blob:')) continue;
      const record = baseRecord(url, element, 'background');
      record.hasAlt = true;
      record.hasDimensions = true;
      record.hasSrcset = true;
      add(record);
    }
  }

  // 3. Video posters. They load like images and are often forgotten.
  for (const element of document.querySelectorAll('video[poster]')) {
    const url = absolute(element.getAttribute('poster'));
    if (!url) continue;
    add(baseRecord(url, element, 'poster'));
  }

  const list = [...records.values()];

  // Natural size is unknown for backgrounds and posters. Fall back to the
  // display box, so the oversize test stays neutral instead of wrong.
  for (const record of list) {
    if (!record.naturalWidth) record.naturalWidth = record.displayWidth * dpr;
    if (!record.naturalHeight) record.naturalHeight = record.displayHeight * dpr;
  }

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    viewport: { width: viewportWidth, height: viewportHeight, dpr },
    scannedElements: scanLimit,
    truncated: elements.length > MAX_ELEMENTS_SCANNED,
    images: list
  };
}
