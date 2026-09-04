/**
 * Resource and usage analysis for one page.
 *
 * Pure functions only. No browser or extension APIs.
 */

import {
  ESTIMATE_KIND_HEURISTIC,
  ESTIMATE_NOTE,
  MODERN_FORMAT_RATIO,
  MODERN_FORMAT_TARGET,
  estimateBytes,
  formatFromContentType,
  formatFromUrl
} from './format.js';

/**
 * Separate HEAD/range response checks use a different request context from the
 * page's original response (no credentials, no redirects followed the same
 * way). Their bytes stay labelled so the UI can keep the warning attached.
 */
export const CHECKED_RESPONSE_NOTE =
  'Checked with a separate HEAD/range request; headers may differ from the page\u2019s original response.';

/** Measurement sources that come from a separate header check, not page traffic. */
export function isCheckedResponseSource(source) {
  return source === 'content-length' || source === 'content-range';
}

/**
 * Classify where a resource's input bytes come from. Inline payloads are their
 * own class: they ride inside the document, never as an independent transfer.
 *
 * @param {object} resource
 * @returns {'browser-encoded'|'browser-transfer'|'checked-header'|'observed'|'inline'|'model'}
 */
export function byteProvenanceOf(resource) {
  if (resource.isDataUri || resource.measurementSource === 'inline') return 'inline';
  if (Number(resource.transferBytes) > 0) {
    if (resource.measurementSource === 'resource-timing-encoded') return 'browser-encoded';
    if (resource.measurementSource === 'resource-timing-transfer') return 'browser-transfer';
    if (isCheckedResponseSource(resource.measurementSource)) return 'checked-header';
    return 'observed';
  }
  return 'model';
}

/**
 * Classify how a resource's format was detected. A format read from the URL
 * stays a hint; only a parsed response Content-Type counts as observed, and a
 * checked header keeps its separate-request warning.
 *
 * @param {object} resource
 * @returns {'observed'|'checked-header'|'hint'|'unknown'}
 */
export function formatProvenanceOf(resource) {
  if (formatFromContentType(resource.contentType) !== 'unknown') {
    return isCheckedResponseSource(resource.measurementSource) ? 'checked-header' : 'observed';
  }
  if (resource.format && resource.format !== 'unknown') return 'hint';
  return formatFromUrl(resource.url) !== 'unknown' ? 'hint' : 'unknown';
}

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
  const byteSource = byteProvenanceOf(resource);
  const formatProvenance = formatProvenanceOf(resource);
  const inline = byteSource === 'inline';
  const checkedResponse = byteSource === 'checked-header' || formatProvenance === 'checked-header';
  const measured = byteSource !== 'inline' && byteSource !== 'model';
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
    : inline
      ? Number(resource.transferBytes) || 0
      : estimateBytes(
        dimensionsKnown ? sourcePixelWidth : modelWidth,
        dimensionsKnown ? sourcePixelHeight : modelHeight,
        format
      );
  const bytesEstimated = !measured && !inline;
  // Zero and unknown stay distinct: bytes of 0 without transfer evidence is
  // unknown weight, never a free resource. Inline payload is document weight,
  // never an independent network transfer.
  const byteState = measured ? 'measured' : inline ? 'inline' : bytes > 0 ? 'estimated' : 'unknown';

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

  // Every saving below is model arithmetic on the input bytes above, including
  // when those inputs were measured. A measured input never turns a predicted
  // conversion into a measured saving.
  const formatRatio = MODERN_FORMAT_RATIO[format] ?? 1;
  const afterResize = bytes * pixelRatio;
  const optimisedBytes = inline ? bytes : Math.round(afterResize * formatRatio);
  const savingBytes = inline ? 0 : Math.max(0, bytes - optimisedBytes);
  const resizeSaving = inline ? 0 : Math.round(bytes - afterResize);
  const formatSaving = inline ? 0 : Math.max(0, savingBytes - resizeSaving);

  const issues = [];
  if (pixelRatio < 1) issues.push('oversized');
  if (formatRatio < 1 && LEGACY_FORMATS.has(format)) issues.push('legacyFormat');
  if (formatRatio < 1 && format === 'webp') issues.push('avifOpportunity');
  if (!inline && bytes >= HEAVY_IMAGE_BYTES) issues.push('heavy');

  return {
    ...resource,
    format,
    formatProvenance,
    byteSource,
    byteState,
    bytesEstimated,
    inline,
    checkedResponse,
    measured,
    bytes,
    measurement: {
      bytes,
      source: measured ? resource.measurementSource || 'unknown' : inline ? 'inline' : 'model',
      confidence: measured || inline ? resource.measurementConfidence || 'low' : 'low'
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
    savingsKind: savingBytes > 0 ? ESTIMATE_KIND_HEURISTIC : 'none',
    resizeEstimated: resizeSaving > 0,
    formatEstimated: formatSaving > 0,
    estimateNote: savingBytes > 0 ? ESTIMATE_NOTE : '',
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

/**
 * Calibration-only reference for the retired A–F delivery grade.
 *
 * Deliberately unexported: returning a prominent grade requires a calibration
 * corpus first, so no UI import path may exist. Kept here so a future
 * calibration can compare thresholds against labelled data instead of
 * reinventing them.
 */
function gradeForRatio(ratio) {
  if (ratio <= 0.1) return 'A';
  if (ratio <= 0.25) return 'B';
  if (ratio <= 0.45) return 'C';
  if (ratio <= 0.65) return 'D';
  return 'F';
}

// Reference the calibration table so it survives refactors without surfacing.
void gradeForRatio;

/**
 * Build one normalized limitation/evidence summary for a page.
 *
 * Consumed by the popup, the audit view, Markdown and JSON alike so every
 * surface carries the same material warnings with equivalent meaning. Each
 * entry names its evidence source; unknown stays unknown — counts the
 * collector cannot establish (such as inaccessible frames) are never invented.
 *
 * @param {object} page merged page record (content/collect.js via lib/merge.js)
 * @param {object} report analyzePage() result for that page
 * @returns {{key:string, message:string, lowerBound:boolean}[]}
 */
export function buildLimitationSummary(page = {}, report = {}) {
  const summary = report.summary || {};
  const limitations = [];
  const scanned = Number(page.scannedElements) || 0;

  if (page.truncated) {
    limitations.push({
      key: 'element-limit',
      message:
        `The element scan stopped early after ${scanned} elements. ` +
        'Totals are a lower bound; some images may be missing.',
      lowerBound: true
    });
  }
  if (page.recordsTruncated) {
    limitations.push({
      key: 'record-limit',
      message:
        `${Number(page.skippedResources) || 0} resources and ` +
        `${Number(page.skippedUsages) || 0} usages exceeded record or payload limits. ` +
        'Totals are a lower bound.',
      lowerBound: true
    });
  }
  if (page.styleScanTruncated) {
    limitations.push({
      key: 'css-budget',
      message:
        'The CSS and pseudo-element scan hit its time budget; ' +
        'some background images may be missing while semantic images remain covered.',
      lowerBound: true
    });
  }
  if (page.timingBufferFull) {
    limitations.push({
      key: 'timing-buffer',
      message:
        'The Resource Timing buffer may be saturated; ' +
        'some response sizes stay modelled even though the images were observed.',
      lowerBound: false
    });
  }
  if (Number(page.unsupported?.canvas) > 0) {
    limitations.push({
      key: 'canvas',
      message:
        `${Number(page.unsupported.canvas)} canvas element(s) were counted but cannot be ` +
        'mapped back to source requests, so they carry no byte weight.',
      lowerBound: false
    });
  }
  if (Number(page.unsupported?.imageSetSelection) > 0) {
    limitations.push({
      key: 'image-set',
      message:
        `${Number(page.unsupported.imageSetSelection)} typed image-set selection(s) had no ` +
        'browser timing match; the served candidate remains unknown.',
      lowerBound: false
    });
  }
  if (Number(page.frameCount) > 1) {
    limitations.push({
      key: 'frames',
      message:
        `Evidence was merged across ${Number(page.frameCount)} frames; ` +
        'browser vitals below are top-frame observations. ' +
        'The extent of omissions from frames that could not be read is unknown.',
      lowerBound: false
    });
  }
  const estimatedCount = Number(summary.estimatedResourceCount) || 0;
  const unknownCount = Number(summary.unknownResourceCount) || 0;
  const measuredCount = Number(summary.measuredResourceCount) || 0;
  const resourceCount = Number(summary.resourceCount) || 0;
  if (resourceCount > 0 && (estimatedCount > 0 || unknownCount > 0)) {
    limitations.push({
      key: 'measurement-gaps',
      message:
        `${measuredCount} of ${resourceCount} resource sizes were measured; ` +
        `${estimatedCount} use the byte model and ${unknownCount} have unknown weight. ` +
        'Opportunities are estimates, and totals understate any unknown weight.',
      lowerBound: unknownCount > 0
    });
  }
  if (Number(summary.checkedResourceCount) > 0) {
    limitations.push({
      key: 'checked-headers',
      message:
        `${Number(summary.checkedResourceCount)} resource size(s) come from separately ` +
        'checked response headers. ' +
        CHECKED_RESPONSE_NOTE,
      lowerBound: false
    });
  }
  if (summary.vitals?.cls?.entriesTruncated) {
    limitations.push({
      key: 'vitals-truncated',
      message:
        'The browser vitals buffer was truncated; layout-shift observations are incomplete.',
      lowerBound: false
    });
  }
  return limitations;
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

  // Network totals count each unique resource's transfer bytes once. Inline
  // payloads ride inside the document and are reported separately instead.
  let totalBytes = 0;
  let savingBytes = 0;
  let resizeSaving = 0;
  let formatSaving = 0;
  let measuredResourceCount = 0;
  let checkedResourceCount = 0;
  let inlineResourceCount = 0;
  let unknownResourceCount = 0;
  let estimatedResourceCount = 0;
  let measuredBytes = 0;
  let measuredSavingBytes = 0;
  let inlineBytes = 0;
  let markupIssueCount = 0;
  const issueStats = {};

  for (const resource of analyzedResources) {
    if (resource.inline) {
      inlineResourceCount += 1;
      inlineBytes += resource.bytes;
    } else {
      totalBytes += resource.bytes;
      savingBytes += resource.savingBytes;
      resizeSaving += resource.resizeSaving;
      formatSaving += resource.formatSaving;
    }
    if (resource.measured) {
      measuredResourceCount += 1;
      measuredBytes += resource.bytes;
      measuredSavingBytes += resource.savingBytes;
      if (resource.checkedResponse) checkedResourceCount += 1;
    } else if (resource.inline) {
      // Reported via inlineBytes, never as network transfer.
    } else if (resource.byteState === 'unknown') {
      unknownResourceCount += 1;
    } else {
      estimatedResourceCount += 1;
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
  const networkCount = analyzedResources.length - inlineResourceCount;

  return {
    resources: analyzedResources,
    usages: analyzedUsages,
    summary: {
      resourceCount: analyzedResources.length,
      usageCount: analyzedUsages.length,
      measuredResourceCount,
      checkedResourceCount,
      estimatedResourceCount,
      inlineResourceCount,
      unknownResourceCount,
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
      inlineBytes,
      coverage: {
        state:
          networkCount === 0
            ? 'none'
            : measuredResourceCount >= networkCount
              ? 'full'
              : measuredResourceCount > 0
                ? 'partial'
                : 'none',
        measuredCount: measuredResourceCount,
        checkedCount: checkedResourceCount,
        estimatedCount: estimatedResourceCount,
        inlineCount: inlineResourceCount,
        unknownCount: unknownResourceCount,
        measuredByteShare: totalBytes > 0 ? measuredBytes / totalBytes : 0,
        note:
          'Byte-weight coverage is the share of modelled weight with measured inputs, ' +
          'not a claim about the unknown true page weight.'
      },
      savingsKind: savingBytes > 0 ? ESTIMATE_KIND_HEURISTIC : 'none',
      savingsNote: savingBytes > 0 ? ESTIMATE_NOTE : '',
      markupIssueCount,
      // The A–F delivery grade is retired for the trust release: fixed-ratio
      // model arithmetic is not calibrated evidence. Never omit or repurpose
      // this field silently; a future calibrated score needs a new schema.
      grade: null,
      gradeReason: 'uncalibrated-model',
      vitals: pageFacts.vitals || {
        lcp: null,
        cls: { supported: false, score: 0, totalScore: 0, shiftCount: 0 }
      },
      issueStats
    }
  };
}
