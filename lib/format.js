/**
 * Format detection and byte estimation.
 *
 * Pure functions only. No browser or extension APIs.
 * The unit tests in test/analyze.test.js import this file directly.
 */

/** Bytes per pixel, measured as a rough median across common web photography. */
export const BYTES_PER_PIXEL = {
  jpeg: 0.25,
  png: 0.9,
  gif: 0.5,
  webp: 0.15,
  avif: 0.1,
  bmp: 3.0,
  unknown: 0.25
};

/**
 * Formats whose weight has nothing to do with the pixel count.
 * An SVG is text. Its size follows the path data, not the display box.
 */
export const FLAT_ESTIMATE_BYTES = {
  svg: 4 * 1024
};

/** Share of the bytes that survive a conversion to the modern format. */
export const MODERN_FORMAT_RATIO = {
  jpeg: 0.5, // to AVIF
  png: 0.4, // to WebP lossless, or AVIF when the image is photographic
  gif: 0.15, // to animated WebP, or to a video
  bmp: 0.1,
  webp: 0.75, // to AVIF
  avif: 1,
  svg: 1,
  unknown: 1
};

/** The format we recommend for each source format. */
export const MODERN_FORMAT_TARGET = {
  jpeg: 'avif',
  png: 'webp',
  gif: 'webp',
  bmp: 'avif',
  webp: 'avif',
  avif: 'avif',
  svg: 'svg',
  unknown: 'avif'
};

const EXTENSION_MAP = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  png: 'png',
  apng: 'png',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
  svg: 'svg',
  'svg+xml': 'svg',
  bmp: 'bmp',
  ico: 'bmp',
  'x-icon': 'bmp',
  'vnd.microsoft.icon': 'bmp',
  heic: 'avif',
  heif: 'avif',
  jxl: 'avif'
};

/**
 * Read the format from a URL.
 * It checks the path extension first, then a `format=` style query parameter,
 * because CDNs often serve a modern format from a legacy file name.
 *
 * @param {string} url
 * @returns {string} one of the keys of BYTES_PER_PIXEL
 */
export function formatFromUrl(url) {
  if (!url) return 'unknown';

  if (url.startsWith('data:')) {
    const match = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
    if (!match) return 'unknown';
    return EXTENSION_MAP[match[1].toLowerCase()] || 'unknown';
  }

  let path = url;
  let query = '';
  const queryStart = url.indexOf('?');
  if (queryStart !== -1) {
    path = url.slice(0, queryStart);
    query = url.slice(queryStart + 1).toLowerCase();
  }

  // A CDN parameter beats the file extension, because it decides the response.
  const paramMatch = /(?:^|&)(?:format|fm|f|output|out)=([a-z0-9]+)/.exec(query);
  if (paramMatch && EXTENSION_MAP[paramMatch[1]]) {
    return EXTENSION_MAP[paramMatch[1]];
  }

  const extensionMatch = /\.([a-z0-9]+)$/i.exec(path);
  if (extensionMatch) {
    const format = EXTENSION_MAP[extensionMatch[1].toLowerCase()];
    if (format) return format;
  }

  return 'unknown';
}

/**
 * Read the format from a Content-Type header.
 *
 * @param {string|null} contentType
 * @returns {string}
 */
export function formatFromContentType(contentType) {
  if (!contentType) return 'unknown';
  const match = /image\/([a-z0-9.+-]+)/i.exec(contentType);
  if (!match) return 'unknown';
  return EXTENSION_MAP[match[1].toLowerCase()] || 'unknown';
}

/**
 * Estimate the encoded size of an image when the browser did not report it.
 * Cross-origin responses hide their size unless they send Timing-Allow-Origin.
 *
 * @param {number} width natural width in pixels
 * @param {number} height natural height in pixels
 * @param {string} format
 * @returns {number} bytes
 */
export function estimateBytes(width, height, format) {
  const flat = FLAT_ESTIMATE_BYTES[format];
  if (flat) return flat;
  if (!width || !height) return 0;
  const perPixel = BYTES_PER_PIXEL[format] ?? BYTES_PER_PIXEL.unknown;
  return Math.round(width * height * perPixel);
}

/**
 * Format a byte count for the popup.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function humanBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
