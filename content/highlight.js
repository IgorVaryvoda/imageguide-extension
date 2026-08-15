/**
 * Scroll to an image in the page and outline it for a moment.
 *
 * Like `collectImages`, Chrome serialises this function, so it must stay
 * self-contained.
 */

export function highlightImage(url) {
  const OUTLINE_ID = 'imageguide-auditor-outline';
  const DURATION_MS = 2600;

  const matches = (candidate) => {
    if (!candidate) return false;
    try {
      return new URL(candidate, document.baseURI).href === url;
    } catch {
      return false;
    }
  };

  let target = null;

  for (const element of document.images) {
    if (matches(element.currentSrc || element.src)) {
      target = element;
      break;
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

  if (!target) {
    for (const element of document.querySelectorAll('*')) {
      const background = getComputedStyle(element).backgroundImage;
      if (background && background.includes('url(') && background.includes(url.split('/').pop())) {
        target = element;
        break;
      }
    }
  }

  if (!target) return false;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });

  document.getElementById(OUTLINE_ID)?.remove();

  const rect = target.getBoundingClientRect();
  const outline = document.createElement('div');
  outline.id = OUTLINE_ID;
  outline.style.cssText = [
    'position:absolute',
    `top:${rect.top + window.scrollY - 3}px`,
    `left:${rect.left + window.scrollX - 3}px`,
    `width:${rect.width + 6}px`,
    `height:${rect.height + 6}px`,
    'border:3px solid #3b82f6',
    'border-radius:6px',
    'box-shadow:0 0 0 9999px rgba(15,23,42,.35)',
    'pointer-events:none',
    'z-index:2147483647',
    'transition:opacity .3s ease'
  ].join(';');

  document.body.appendChild(outline);
  setTimeout(() => {
    outline.style.opacity = '0';
    setTimeout(() => outline.remove(), 320);
  }, DURATION_MS);

  return true;
}
