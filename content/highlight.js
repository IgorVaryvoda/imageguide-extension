/**
 * Scroll to an image in the page and outline it for a moment.
 *
 * Like `collectImages`, Chrome serialises this function, so it must stay
 * self-contained. The collector marks each element it records, so the lookup
 * is exact. The URL search stays as a fallback for a page that changed since
 * the scan.
 */

export function highlightImage(markAttribute, elementId, url) {
  const DURATION_MS = 2600;

  // Search the light DOM and every open shadow root.
  const findIn = (root, selector) => {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        const nested = findIn(element.shadowRoot, selector);
        if (nested) return nested;
      }
    }
    return null;
  };

  const matches = (candidate) => {
    if (!candidate) return false;
    try {
      return new URL(candidate, document.baseURI).href === url;
    } catch {
      return false;
    }
  };

  let target = findIn(document, `[${markAttribute}="${CSS.escape(elementId)}"]`);

  if (!target) {
    for (const element of document.images) {
      if (matches(element.currentSrc || element.src)) {
        target = element;
        break;
      }
    }
  }

  if (!target) {
    for (const element of document.querySelectorAll('video[poster]')) {
      if (matches(element.getAttribute('poster'))) {
        target = element;
        break;
      }
    }
  }

  if (!target) return false;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const outline = document.createElement('div');
  outline.setAttribute(markAttribute, 'outline');
  outline.style.cssText = [
    'position:fixed',
    'border:3px solid #3b82f6',
    'border-radius:6px',
    'box-shadow:0 0 0 9999px rgba(15,23,42,.35)',
    'pointer-events:none',
    'z-index:2147483647',
    'transition:opacity .3s ease'
  ].join(';');
  document.body.appendChild(outline);

  // A smooth scroll moves the box for a few frames, and a fixed or sticky
  // element never stops moving. Track the box until the outline fades.
  const place = () => {
    const rect = target.getBoundingClientRect();
    outline.style.top = `${rect.top - 3}px`;
    outline.style.left = `${rect.left - 3}px`;
    outline.style.width = `${rect.width + 6}px`;
    outline.style.height = `${rect.height + 6}px`;
  };

  place();
  const timer = setInterval(place, 100);

  setTimeout(() => {
    clearInterval(timer);
    outline.style.opacity = '0';
    setTimeout(() => outline.remove(), 320);
  }, DURATION_MS);

  return true;
}
