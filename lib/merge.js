/**
 * Join the collector results of every frame into one page record.
 *
 * Pure functions only. No browser or extension APIs.
 */

import {
  MAX_RESOURCE_RECORDS,
  MAX_SERIALIZED_PAYLOAD_BYTES,
  MAX_SERIALIZED_URL_CHARS,
  MAX_USAGE_RECORDS
} from './constants.js';

const SOURCE_RANK = {
  'resource-timing-encoded': 5,
  'resource-timing-transfer': 4,
  inline: 3,
  'content-length': 2,
  'content-range': 2
};

function mergeResourceFacts(target, incoming) {
  const targetRank = SOURCE_RANK[target.measurementSource] || 0;
  const incomingRank = SOURCE_RANK[incoming.measurementSource] || 0;
  if (
    incoming.transferBytes > 0 &&
    (!target.transferBytes || incomingRank > targetRank)
  ) {
    target.transferBytes = incoming.transferBytes;
    target.measurementSource = incoming.measurementSource;
    target.measurementConfidence = incoming.measurementConfidence;
  }
  if (!target.contentType && incoming.contentType) target.contentType = incoming.contentType;

  if (target.sourceDimensionReason === 'conflict') return;
  if (incoming.sourceDimensionReason === 'conflict') {
    target.sourcePixelWidth = 0;
    target.sourcePixelHeight = 0;
    target.sourceDimensionConfidence = 'unknown';
    target.sourceDimensionReason = 'conflict';
    return;
  }
  if (!incoming.sourcePixelWidth || !incoming.sourcePixelHeight) return;
  if (!target.sourcePixelWidth) {
    target.sourcePixelWidth = incoming.sourcePixelWidth;
    target.sourcePixelHeight = incoming.sourcePixelHeight;
    target.sourceDimensionConfidence = incoming.sourceDimensionConfidence;
    return;
  }
  if (
    target.sourcePixelWidth !== incoming.sourcePixelWidth ||
    target.sourcePixelHeight !== incoming.sourcePixelHeight
  ) {
    target.sourcePixelWidth = 0;
    target.sourcePixelHeight = 0;
    target.sourceDimensionConfidence = 'unknown';
    target.sourceDimensionReason = 'conflict';
  } else if (incoming.sourceDimensionConfidence === 'descriptor') {
    target.sourceDimensionConfidence = 'descriptor';
  }
}

/**
 * Merge the frame results of one scan.
 *
 * Resources are deduplicated by URL. Usages are retained one per discovered
 * element/resource pairing, so markup findings never disappear behind a
 * larger use of the same file.
 *
 * @param {object[]} frames results of content/collect.js, one per frame
 * @returns {object} a page record with resource and usage lists
 */
export function mergeFrames(
  frames,
  maxResources = MAX_RESOURCE_RECORDS,
  maxUsages = MAX_USAGE_RECORDS,
  maxSerializedUrlChars = MAX_SERIALIZED_URL_CHARS,
  maxSerializedPayloadBytes = MAX_SERIALIZED_PAYLOAD_BYTES
) {
  const usable = frames.filter(
    (frame) => frame && Array.isArray(frame.resources) && Array.isArray(frame.usages)
  );
  const top = usable.find((frame) => frame.frameId === 0) ?? usable[0] ?? {};
  let recordsTruncated = usable.some((frame) => frame.recordsTruncated);
  let skippedResources = usable.reduce(
    (total, frame) => total + (frame.skippedResources || 0),
    0
  );
  let skippedUsages = usable.reduce((total, frame) => total + (frame.skippedUsages || 0), 0);
  let serializedUrlChars = 0;
  const unsupported = {};
  for (const frame of usable) {
    for (const [kind, count] of Object.entries(frame.unsupported || {})) {
      unsupported[kind] = (unsupported[kind] || 0) + (Number(count) || 0);
    }
  }

  const byUrl = new Map();
  const frameMaps = new Map();

  for (const frame of usable) {
    const localIds = new Map();
    frameMaps.set(frame, localIds);
    for (const incoming of frame.resources) {
      if (!incoming.url) continue;
      const existing = byUrl.get(incoming.url);
      if (existing) {
        mergeResourceFacts(existing, incoming);
        localIds.set(incoming.id, existing.id);
        continue;
      }
      if (
        byUrl.size >= maxResources ||
        serializedUrlChars + incoming.url.length > maxSerializedUrlChars
      ) {
        recordsTruncated = true;
        skippedResources += 1;
        continue;
      }
      const resource = { ...incoming, id: `r${byUrl.size + 1}` };
      byUrl.set(resource.url, resource);
      localIds.set(incoming.id, resource.id);
      serializedUrlChars += resource.url.length;
    }
  }

  let usages = [];
  const usedResourceIds = new Set();
  const usageCounts = new Map();
  for (const frame of usable) {
    const localIds = frameMaps.get(frame);
    for (const incoming of frame.usages) {
      const resourceId = localIds.get(incoming.resourceId);
      if (!resourceId) {
        skippedUsages += 1;
        recordsTruncated = true;
        continue;
      }
      if (usages.length >= maxUsages) {
        skippedUsages += 1;
        recordsTruncated = true;
        continue;
      }
      usages.push({
        ...incoming,
        id: `u${usages.length + 1}`,
        resourceId,
        frameId: frame.frameId ?? 0
      });
      usedResourceIds.add(resourceId);
      usageCounts.set(resourceId, (usageCounts.get(resourceId) || 0) + 1);
    }
  }

  let resources = [...byUrl.values()]
    .filter((resource) => usedResourceIds.has(resource.id))
    .map((resource) => ({
      ...resource,
      usageCount: usageCounts.get(resource.id) || 0
    }));

  const page = {
    pageUrl: top.pageUrl || '',
    pageTitle: top.pageTitle || '',
    viewport: top.viewport || { width: 0, height: 0, dpr: 1 },
    frameCount: usable.length,
    scannedElements: usable.reduce((total, frame) => total + (frame.scannedElements || 0), 0),
    scanDurationMs: usable.reduce((total, frame) => total + (frame.scanDurationMs || 0), 0),
    truncated: usable.some((frame) => frame.truncated),
    styleScanTruncated: usable.some((frame) => frame.styleScanTruncated),
    recordsTruncated,
    skippedResources,
    skippedUsages,
    timingBufferFull: usable.some((frame) => frame.timingBufferFull),
    unsupported,
    dynamicMutationCount: usable.reduce(
      (total, frame) => total + (frame.watch?.mutationCount || 0),
      0
    ),
    lastMutationTime: Math.max(...usable.map((frame) => frame.watch?.lastMutationTime || 0), 0),
    documentToken: top.watch?.documentToken || '',
    vitals: top.vitals || {
      lcp: null,
      cls: { supported: false, score: 0, totalScore: 0, shiftCount: 0 }
    },
    resources,
    usages
  };

  const payloadBytes = () => new TextEncoder().encode(JSON.stringify(page)).length;
  while (payloadBytes() > maxSerializedPayloadBytes && usages.length) {
    const size = payloadBytes();
    const keep = Math.min(
      usages.length - 1,
      Math.floor(usages.length * (maxSerializedPayloadBytes / size) * 0.9)
    );
    const removed = usages.splice(Math.max(0, keep));
    skippedUsages += removed.length;
    const counts = new Map();
    for (const item of usages) counts.set(item.resourceId, (counts.get(item.resourceId) || 0) + 1);
    const resourceCount = resources.length;
    resources = resources
      .filter((resource) => counts.has(resource.id))
      .map((resource) => ({ ...resource, usageCount: counts.get(resource.id) }));
    skippedResources += resourceCount - resources.length;
    recordsTruncated = true;
    Object.assign(page, {
      resources,
      usages,
      skippedResources,
      skippedUsages,
      recordsTruncated
    });
  }
  return page;
}
