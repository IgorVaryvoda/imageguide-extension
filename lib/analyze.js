/**
 * Resource and usage analysis for one page.
 *
 * Pure functions only. No browser or extension APIs.
 */

import {
  MODERN_FORMAT_RATIO,
  MODERN_FORMAT_TARGET,
  estimateBytes,
  formatFromContentType,
  formatFromUrl
} from './format.js';

/** A source may exceed every required dimension by 25% before it is oversized. */
export const OVERSIZE_TOLERANCE = 1.25;

/** A measured or modelled resource above this size is worth a look on its own. */
export const HEAVY_IMAGE_BYTES = 400 * 1024;

/** Below this display width a responsive source rarely changes delivery materially. */
export const SRCSET_MIN_WIDTH = 200;

/** Missing sizes is material only when the rendered slot is notably below 100vw. */
export const SIZES_MISMATCH_RATIO = 0.8;

const LEGACY_FORMATS = new Set(['jpeg', 'png', 'gif', 'bmp', 'ico']);

export const ISSUES = {
  oversized: {
    scope: 'resource',
    label: 'Oversized',
    hint: 'The source pixels exceed the largest requirement across every recorded usage.',
    guide: 'https://www.imageguide.dev/guides/responsive-images-complete-guide/'
  },
  legacyFormat: {
    scope: 'resource',
    label: 'Legacy format',
    hint: 'A modern format may send the same picture in fewer bytes.',
    guide: 'https://www.imageguide.dev/guides/webp-avif-jpeg-xl-comparison/'
  },
  avifOpportunity: {
    scope: 'resource',
    label: 'AVIF opportunity',
    hint: 'WebP is already modern; AVIF may reduce it further.',
    guide: 'https://www.imageguide.dev/guides/webp-avif-jpeg-xl-comparison/'
  },
  heavy: {
    scope: 'resource',
    label: 'Heavy',
    hint: 'This single resource is a large part of the page weight.',
    guide: 'https://www.imageguide.dev/guides/understanding-image-compression/'
  },
  eagerOffscreen: {
    scope: 'usage',
    label: 'Eager image offscreen now',
    hint: 'This usage is outside the current viewport and is not marked lazy.',
    guide: 'https://www.imageguide.dev/guides/lazy-loading-strategies/'
  },
  lazyVisible: {
    scope: 'usage',
    label: 'Lazy image visible now',
    hint: 'This usage is inside the current viewport and marked lazy. This is not an LCP test.',
    guide: 'https://www.imageguide.dev/guides/lazy-loading-strategies/'
  },
  lazyLcp: {
    scope: 'usage',
    label: 'Lazy-loaded LCP image',
    hint: 'The browser identified this usage as LCP, and it is marked lazy.',
    guide: 'https://www.imageguide.dev/guides/image-optimization-mistakes/'
  },
  layoutShiftSource: {
    scope: 'usage',
    label: 'Layout-shift source',
    hint: 'The browser attributed a layout shift to this element. A shifted node is not always the root cause.',
    guide: 'https://www.imageguide.dev/guides/core-web-vitals-images/'
  },
  noDimensions: {
    scope: 'usage',
    label: 'No dimensions',
    hint: 'This img has no width-and-height pair or CSS aspect-ratio.',
    guide: 'https://www.imageguide.dev/guides/core-web-vitals-images/'
  },
  noAlt: {
    scope: 'usage',
    label: 'Missing alt attribute',
    hint: 'This img has no alt attribute. Empty alt can be correct for decorative images.',
    guide: 'https://www.imageguide.dev/guides/image-alt-text-guide/'
  },
  responsiveOpportunity: {
    scope: 'usage',
    label: 'Responsive-image opportunity',
    hint: 'This oversized raster usage has no srcset. Confirm server negotiation does not vary it.',
    guide: 'https://www.imageguide.dev/guides/responsive-images-complete-guide/'
  },
  sizesMismatch: {
    scope: 'usage',
    label: 'Default sizes mismatch',
    hint: 'This width-descriptor usage omits sizes although its slot is much narrower than the viewport.',
    guide: 'https://www.imageguide.dev/guides/responsive-images-complete-guide/'
  }
};

/** The response format, preferring the observed Content-Type. */
export function formatOf(resource) {
  const fromHeader = formatFromContentType(resource.contentType);
  if (fromHeader !== 'unknown') return fromHeader;
  if (resource.format) return resource.format;
  return formatFromUrl(resource.url);
}

function targetOf(usage) {
  const dpr = Number(usage.dpr) > 0 ? Number(usage.dpr) : 1;
  return {
    targetWidth: Math.round((usage.displayWidth || 0) * dpr),
    targetHeight: Math.round((usage.displayHeight || 0) * dpr)
  };
}

/** Analyze byte and source-pixel facts once for a unique resource. */
export function analyzeResource(resource, usages = []) {
  const format = formatOf(resource);
  const measured = Number(resource.transferBytes) > 0;
  const sourcePixelWidth = Number(resource.sourcePixelWidth) || 0;
  const sourcePixelHeight = Number(resource.sourcePixelHeight) || 0;
  const dimensionsKnown =
    resource.sourceDimensionConfidence !== 'unknown' &&
    sourcePixelWidth > 0 &&
    sourcePixelHeight > 0;

  let primaryUsage = usages[0] || null;
  let primaryNeed = -1;
  let requiredScale = 0;
  let modelWidth = 0;
  let modelHeight = 0;
  for (const usage of usages) {
    const { targetWidth, targetHeight } = targetOf(usage);
    const need = dimensionsKnown
      ? Math.max(targetWidth / sourcePixelWidth, targetHeight / sourcePixelHeight)
      : targetWidth * targetHeight;
    if (need > primaryNeed) {
      primaryNeed = need;
      primaryUsage = usage;
    }
    if (dimensionsKnown) requiredScale = Math.max(requiredScale, need);
    if (targetWidth * targetHeight > modelWidth * modelHeight) {
      modelWidth = targetWidth;
      modelHeight = targetHeight;
    }
  }

  const primaryTarget = primaryUsage ? targetOf(primaryUsage) : { targetWidth: 0, targetHeight: 0 };
  const bytes = measured
    ? Number(resource.transferBytes)
    : estimateBytes(
        dimensionsKnown ? sourcePixelWidth : modelWidth,
        dimensionsKnown ? sourcePixelHeight : modelHeight,
        format
      );

  let pixelRatio = 1;
  let resizeWidth = sourcePixelWidth;
  let resizeHeight = sourcePixelHeight;
  if (
    format !== 'svg' &&
    dimensionsKnown &&
    requiredScale > 0 &&
    requiredScale < 1 / OVERSIZE_TOLERANCE
  ) {
    const scale = Math.min(1, requiredScale);
    pixelRatio = scale ** 2;
    resizeWidth = Math.round(sourcePixelWidth * scale);
    resizeHeight = Math.round(sourcePixelHeight * scale);
  }

  const formatRatio = MODERN_FORMAT_RATIO[format] ?? 1;
  const afterResize = bytes * pixelRatio;
  const optimisedBytes = Math.round(afterResize * formatRatio);
  const savingBytes = Math.max(0, bytes - optimisedBytes);
  const resizeSaving = Math.round(bytes - afterResize);
  const formatSaving = Math.max(0, savingBytes - resizeSaving);

  const issues = [];
  if (pixelRatio < 1) issues.push('oversized');
  if (formatRatio < 1 && LEGACY_FORMATS.has(format)) issues.push('legacyFormat');
  if (formatRatio < 1 && format === 'webp') issues.push('avifOpportunity');
  if (bytes >= HEAVY_IMAGE_BYTES) issues.push('heavy');

  return {
    ...resource,
    format,
    measured,
    bytes,
    measurement: {
      bytes,
      source: measured ? resource.measurementSource || 'unknown' : 'model',
      confidence: measured ? resource.measurementConfidence || 'low' : 'low'
    },
    sourcePixelWidth: dimensionsKnown ? sourcePixelWidth : 0,
    sourcePixelHeight: dimensionsKnown ? sourcePixelHeight : 0,
    sourceDimensionConfidence: dimensionsKnown
      ? resource.sourceDimensionConfidence
      : 'unknown',
    primaryUsageId: primaryUsage?.id || '',
    targetWidth: primaryTarget.targetWidth,
    targetHeight: primaryTarget.targetHeight,
    resizeWidth,
    resizeHeight,
    optimisedBytes,
    savingBytes,
    resizeSaving,
    formatSaving,
    recommendedFormat: MODERN_FORMAT_TARGET[format] ?? 'avif',
    issues
  };
}

/** Analyze markup and viewport facts once for one element-level usage. */
export function analyzeUsage(usage, resource) {
  const { targetWidth, targetHeight } = targetOf(usage);
  const issues = [];
  const usageScale =
    resource.sourcePixelWidth > 0 && resource.sourcePixelHeight > 0
      ? Math.max(
          targetWidth / resource.sourcePixelWidth,
          targetHeight / resource.sourcePixelHeight
        )
      : 1;

  if (usage.kind === 'img') {
    if (!usage.inViewport && usage.loading !== 'lazy') issues.push('eagerOffscreen');
    if (usage.isLcp && usage.loading === 'lazy') issues.push('lazyLcp');
    else if (usage.inViewport && usage.loading === 'lazy') issues.push('lazyVisible');
    if (!usage.hasDimensions) issues.push('noDimensions');
    if (usage.altState === 'missing') issues.push('noAlt');
    if (
      !usage.hasSrcset &&
      resource.format !== 'svg' &&
      usageScale < 1 / OVERSIZE_TOLERANCE &&
      (usage.displayWidth || 0) >= SRCSET_MIN_WIDTH
    ) {
      issues.push('responsiveOpportunity');
    }
    const slotRatio = usage.viewportWidth > 0 ? (usage.displayWidth || 0) / usage.viewportWidth : 1;
    if (usage.usesWidthDescriptors && !usage.hasSizes && slotRatio < SIZES_MISMATCH_RATIO) {
      issues.push('sizesMismatch');
    }
  }

  if (usage.layoutShiftCount > 0) issues.push('layoutShiftSource');

  return { ...usage, targetWidth, targetHeight, issues };
}

/** Turn an avoidable measured-byte ratio into a delivery grade. */
export function gradeFor(ratio) {
  if (ratio <= 0.1) return 'A';
  if (ratio <= 0.25) return 'B';
  if (ratio <= 0.45) return 'C';
  if (ratio <= 0.65) return 'D';
  return 'F';
}

/** Analyze unique resources and their individual usages. */
export function analyzePage(resources, usages = [], pageFacts = {}) {
  const usagesByResource = new Map();
  for (const usage of usages) {
    const list = usagesByResource.get(usage.resourceId) || [];
    list.push(usage);
    usagesByResource.set(usage.resourceId, list);
  }

  const analyzedResources = resources
    .map((resource) => {
      const rawUsages = usagesByResource.get(resource.id) || [];
      const analyzedResource = analyzeResource(resource, rawUsages);
      const analyzedUsages = rawUsages.map((usage) => analyzeUsage(usage, analyzedResource));
      return {
        ...analyzedResource,
        usages: analyzedUsages,
        allIssues: [...new Set([
          ...analyzedResource.issues,
          ...analyzedUsages.flatMap((usage) => usage.issues)
        ])]
      };
    })
    .sort((a, b) => b.savingBytes - a.savingBytes);
  const analyzedUsages = analyzedResources.flatMap((resource) => resource.usages);

  let totalBytes = 0;
  let savingBytes = 0;
  let resizeSaving = 0;
  let formatSaving = 0;
  let measuredResourceCount = 0;
  let measuredBytes = 0;
  let measuredSavingBytes = 0;
  let markupIssueCount = 0;
  const issueStats = {};

  for (const resource of analyzedResources) {
    totalBytes += resource.bytes;
    savingBytes += resource.savingBytes;
    resizeSaving += resource.resizeSaving;
    formatSaving += resource.formatSaving;
    if (resource.measured) {
      measuredResourceCount += 1;
      measuredBytes += resource.bytes;
      measuredSavingBytes += resource.savingBytes;
    }
    for (const issue of resource.issues) {
      const stat = (issueStats[issue] ??= { count: 0, savingBytes: 0, scope: 'resource' });
      stat.count += 1;
      stat.savingBytes +=
        issue === 'oversized'
          ? resource.resizeSaving
          : issue === 'legacyFormat' || issue === 'avifOpportunity'
            ? resource.formatSaving
            : resource.savingBytes;
    }
  }

  for (const usage of analyzedUsages) {
    for (const issue of usage.issues) {
      const stat = (issueStats[issue] ??= { count: 0, savingBytes: 0, scope: 'usage' });
      stat.count += 1;
      markupIssueCount += 1;
    }
  }

  const savingRatio = totalBytes > 0 ? savingBytes / totalBytes : 0;
  const deliverySavingRatio = measuredBytes > 0 ? measuredSavingBytes / measuredBytes : 0;

  return {
    resources: analyzedResources,
    usages: analyzedUsages,
    summary: {
      resourceCount: analyzedResources.length,
      usageCount: analyzedUsages.length,
      measuredResourceCount,
      estimatedResourceCount: analyzedResources.length - measuredResourceCount,
      totalBytes,
      optimisedBytes: totalBytes - savingBytes,
      savingBytes,
      resizeSaving,
      formatSaving,
      savingRatio,
      deliverySavingRatio,
      measuredBytes,
      measuredSavingBytes,
      measuredByteRatio: totalBytes > 0 ? measuredBytes / totalBytes : 0,
      markupIssueCount,
      grade: measuredBytes > 0 ? gradeFor(deliverySavingRatio) : '?',
      vitals: pageFacts.vitals || {
        lcp: null,
        cls: { supported: false, score: 0, totalScore: 0, shiftCount: 0 }
      },
      issueStats
    }
  };
}
