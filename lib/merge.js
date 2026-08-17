/**
 * Join the collector results of every frame into one page record.
 *
 * Pure functions only. No browser or extension APIs.
 */

/**
 * The area of the box that shows an image.
 *
 * @param {object} record
 * @returns {number}
 */
function area(record) {
  return (record.displayWidth || 0) * (record.displayHeight || 0);
}

/**
 * Merge the frame results of one scan.
 *
 * The same file often appears in more than one frame, and more than once in a
 * frame. We keep one record per URL, and we keep the largest display box,
 * because that box decides the size the page really needs.
 *
 * @param {object[]} frames results of content/collect.js, one per frame
 * @returns {object} a page record with a single image list
 */
export function mergeFrames(frames) {
  const usable = frames.filter((frame) => frame && Array.isArray(frame.images));
  const top = usable.find((frame) => frame.frameId === 0) ?? usable[0] ?? {};

  /** @type {Map<string, object>} */
  const byUrl = new Map();

  for (const frame of usable) {
    for (const image of frame.images) {
      if (!image.url) continue;
      const record = { ...image, frameId: frame.frameId ?? 0 };
      const existing = byUrl.get(record.url);

      if (!existing) {
        byUrl.set(record.url, record);
        continue;
      }

      const occurrences = (existing.occurrences || 1) + (record.occurrences || 1);
      if (area(record) > area(existing)) {
        byUrl.set(record.url, { ...record, occurrences });
      } else {
        existing.occurrences = occurrences;
        // A cross-origin frame may hide a size that another frame reports.
        if (!existing.transferBytes && record.transferBytes) {
          existing.transferBytes = record.transferBytes;
        }
        if (!existing.contentType && record.contentType) {
          existing.contentType = record.contentType;
        }
      }
    }
  }

  return {
    pageUrl: top.pageUrl || '',
    pageTitle: top.pageTitle || '',
    viewport: top.viewport || { width: 0, height: 0, dpr: 1 },
    frameCount: usable.length,
    truncated: usable.some((frame) => frame.truncated),
    timingBufferFull: usable.some((frame) => frame.timingBufferFull),
    images: [...byUrl.values()]
  };
}
