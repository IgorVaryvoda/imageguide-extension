/**
 * Scoring for one collected image, and for the page as a whole.
 *
 * Pure functions only. No browser or extension APIs.
 */

import {
  MODERN_FORMAT_RATIO,
  MODERN_FORMAT_TARGET,
  estimateBytes,
  formatFromUrl
} from './format.js';

/** The highest device pixel ratio we ask a source image to serve. */
export const MAX_USEFUL_DPR = 2;

/** An image may exceed its target width by this factor before we call it oversized. */
export const OVERSIZE_TOLERANCE = 1.25;

/** An image above this transfer size is worth a look on its own. */
export const HEAVY_IMAGE_BYTES = 400 * 1024;

export const ISSUES = {
  oversized: {
    label: 'Oversized',
    hint: 'The source image is much larger than the box that shows it.',
    guide: 'https://www.imageguide.dev/guides/responsive-images'
  },
  legacyFormat: {
    label: 'Legacy format',
    hint: 'A modern format sends the same picture in fewer bytes.',
    guide: 'https://www.imageguide.dev/guides/webp-vs-avif'
  },
  heavy: {
    label: 'Heavy',
    hint: 'This single file is a large part of the page weight.',
    guide: 'https://www.imageguide.dev/guides/image-compression'
  },
  noLazyLoading: {
    label: 'No lazy loading',
    hint: 'The image starts below the fold but the browser loads it at once.',
    guide: 'https://www.imageguide.dev/guides/lazy-loading'
  },
  lazyHero: {
    label: 'Lazy hero',
    hint: 'The image is visible at load. Lazy loading delays the LCP.',
    guide: 'https://www.imageguide.dev/guides/lazy-loading'
  },
  noDimensions: {
    label: 'No dimensions',
    hint: 'Without width and height the layout shifts while the image loads.',
    guide: 'https://www.imageguide.dev/guides/cumulative-layout-shift'
  },
  noAlt: {
    label: 'No alt text',
    hint: 'Screen readers and search engines cannot read this image.',
    guide: 'https://www.imageguide.dev/guides/image-seo'
  },
  noSrcset: {
    label: 'No srcset',
    hint: 'Every device downloads the same file, whatever its screen.',
    guide: 'https://www.imageguide.dev/guides/responsive-images'
  }
};

/**
 * Score a single collected image.
 *
 * @param {object} image a record produced by content/collect.js
 * @returns {object} the image, plus format, bytes, savings, and issues
 */
export function analyzeImage(image) {
  const format = image.format || formatFromUrl(image.url);

  const measured = Number(image.transferBytes) > 0;
  const bytes = measured
    ? Number(image.transferBytes)
    : estimateBytes(image.naturalWidth, image.naturalHeight, format);

  const targetWidth = Math.round((image.displayWidth || 0) * Math.min(image.dpr || 1, MAX_USEFUL_DPR));
  const targetHeight = Math.round((image.displayHeight || 0) * Math.min(image.dpr || 1, MAX_USEFUL_DPR));

  const naturalPixels = (image.naturalWidth || 0) * (image.naturalHeight || 0);
  const targetPixels = targetWidth * targetHeight;

  // Resizing saves bytes in proportion to the pixels we drop.
  let pixelRatio = 1;
  if (naturalPixels > 0 && targetPixels > 0 && naturalPixels > targetPixels * OVERSIZE_TOLERANCE) {
    pixelRatio = targetPixels / naturalPixels;
  }

  const formatRatio = MODERN_FORMAT_RATIO[format] ?? 1;
  const optimisedBytes = Math.round(bytes * pixelRatio * formatRatio);
  const savingBytes = Math.max(0, bytes - optimisedBytes);

  const issues = [];
  if (pixelRatio < 1) issues.push('oversized');
  if (formatRatio < 1) issues.push('legacyFormat');
  if (bytes >= HEAVY_IMAGE_BYTES) issues.push('heavy');
  if (image.kind === 'img') {
    if (!image.inViewport && image.loading !== 'lazy') issues.push('noLazyLoading');
    if (image.inViewport && image.loading === 'lazy') issues.push('lazyHero');
    if (!image.hasDimensions) issues.push('noDimensions');
    if (!image.hasAlt) issues.push('noAlt');
    if (!image.hasSrcset && (image.displayWidth || 0) >= 200) issues.push('noSrcset');
  }

  return {
    ...image,
    format,
    measured,
    bytes,
    targetWidth,
    targetHeight,
    optimisedBytes,
    savingBytes,
    recommendedFormat: MODERN_FORMAT_TARGET[format] ?? 'avif',
    issues
  };
}

/**
 * Turn a saving ratio into a letter grade.
 *
 * @param {number} ratio saved bytes divided by total bytes
 * @returns {string}
 */
export function gradeFor(ratio) {
  if (ratio <= 0.1) return 'A';
  if (ratio <= 0.25) return 'B';
  if (ratio <= 0.45) return 'C';
  if (ratio <= 0.65) return 'D';
  return 'F';
}

/**
 * Score a whole page.
 *
 * @param {object[]} images records produced by content/collect.js
 * @returns {{images: object[], summary: object}}
 */
export function analyzePage(images) {
  const analyzed = images.map(analyzeImage).sort((a, b) => b.savingBytes - a.savingBytes);

  const totalBytes = analyzed.reduce((sum, image) => sum + image.bytes, 0);
  const savingBytes = analyzed.reduce((sum, image) => sum + image.savingBytes, 0);
  const measuredCount = analyzed.filter((image) => image.measured).length;

  const issueCounts = {};
  for (const image of analyzed) {
    for (const issue of image.issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }

  const ratio = totalBytes > 0 ? savingBytes / totalBytes : 0;

  return {
    images: analyzed,
    summary: {
      count: analyzed.length,
      measuredCount,
      estimatedCount: analyzed.length - measuredCount,
      totalBytes,
      optimisedBytes: totalBytes - savingBytes,
      savingBytes,
      savingRatio: ratio,
      grade: gradeFor(ratio),
      issueCounts
    }
  };
}
