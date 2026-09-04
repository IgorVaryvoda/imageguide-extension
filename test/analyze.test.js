import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzePage,
  analyzeResource,
  analyzeUsage,
  buildLimitationSummary,
  byteProvenanceOf,
  formatOf,
  formatProvenanceOf,
  isCheckedResponseSource,
  CHECKED_RESPONSE_NOTE,
  HEAVY_IMAGE_BYTES
} from '../lib/analyze.js';
import { ESTIMATE_KIND_HEURISTIC, estimateBytes, formatFromContentType, formatFromUrl } from '../lib/format.js';

const baseResource = {
  id: 'r1',
  url: 'https://example.com/hero.jpg',
  transferBytes: 900 * 1024,
  contentType: '',
  measurementSource: 'resource-timing-encoded',
  measurementConfidence: 'high',
  sourcePixelWidth: 2000,
  sourcePixelHeight: 1500,
  sourceDimensionConfidence: 'intrinsic',
  sourceDimensionReason: '',
  isDataUri: false
};

const baseUsage = {
  id: 'u1',
  resourceId: 'r1',
  frameId: 0,
  elementId: '1',
  kind: 'img',
  displayWidth: 500,
  displayHeight: 375,
  dpr: 1,
  viewportWidth: 1280,
  inViewport: true,
  loading: 'eager',
  altState: 'non-empty',
  hasDimensions: true,
  hasSrcset: true,
  hasSizes: true,
  usesWidthDescriptors: false,
  pictureFallbackSelected: false,
  densityCorrectedWidth: 2000,
  densityCorrectedHeight: 1500,
  selectedCandidateDescriptor: ''
};

describe('format detection and byte model', () => {
  it('reads source formats without false aliases', () => {
    assert.equal(formatFromUrl('https://example.com/photo.JPG'), 'jpeg');
    assert.equal(formatFromUrl('https://example.com/photo.jxl'), 'jxl');
    assert.equal(formatFromUrl('https://example.com/photo.heic'), 'heic');
    assert.equal(formatFromUrl('https://example.com/favicon.ico'), 'ico');
    assert.equal(formatFromUrl('data:image/png;base64,AAAA'), 'png');
  });

  it('lets a CDN format parameter and then Content-Type beat the extension', () => {
    assert.equal(formatFromUrl('https://cdn.test/photo.jpg?format=webp'), 'webp');
    assert.equal(formatFromContentType('image/svg+xml'), 'svg');
    assert.equal(
      formatOf({ url: 'https://cdn.test/photo.jpg', contentType: 'image/avif' }),
      'avif'
    );
  });

  it('returns unknown when no source reveals the format', () => {
    assert.equal(formatFromUrl('https://example.com/image'), 'unknown');
    assert.equal(formatFromContentType('text/html'), 'unknown');
  });

  it('scales raster estimates by pixels and keeps SVG flat', () => {
    assert.equal(estimateBytes(1000, 1000, 'jpeg'), estimateBytes(500, 500, 'jpeg') * 4);
    assert.equal(estimateBytes(0, 500, 'jpeg'), 0);
    assert.equal(estimateBytes(64, 64, 'svg'), estimateBytes(4000, 4000, 'svg'));
  });
});

describe('analyzeResource', () => {
  it('analyzes one transfer across all usages and keeps separate opportunities', () => {
    const result = analyzeResource(baseResource, [baseUsage]);

    assert.ok(result.issues.includes('oversized'));
    assert.ok(result.issues.includes('legacyFormat'));
    assert.ok(result.issues.includes('heavy'));
    assert.ok(result.resizeSaving > 0);
    assert.ok(result.formatSaving > 0);
    assert.equal(result.resizeSaving + result.formatSaving, result.savingBytes);
    assert.equal(result.recommendedFormat, 'avif');
  });

  it('uses the most demanding dimension across every usage', () => {
    const resource = {
      ...baseResource,
      sourcePixelWidth: 2000,
      sourcePixelHeight: 1000
    };
    const usages = [
      { ...baseUsage, id: 'u1', displayWidth: 600, displayHeight: 100 },
      { ...baseUsage, id: 'u2', displayWidth: 400, displayHeight: 500 }
    ];
    const result = analyzeResource(resource, usages);

    assert.equal(result.primaryUsageId, 'u2');
    assert.equal(result.resizeWidth, 1000);
    assert.equal(result.resizeHeight, 500);
  });

  it('uses the full browser DPR without a 2x cap', () => {
    const result = analyzeResource(
      { ...baseResource, sourcePixelWidth: 1500, sourcePixelHeight: 1125 },
      [{ ...baseUsage, dpr: 3 }]
    );
    assert.equal(result.targetWidth, 1500);
    assert.ok(!result.issues.includes('oversized'));
  });

  it('makes no exact resize claim when source pixels are unknown', () => {
    const result = analyzeResource(
      {
        ...baseResource,
        transferBytes: 0,
        sourcePixelWidth: 0,
        sourcePixelHeight: 0,
        sourceDimensionConfidence: 'unknown'
      },
      [baseUsage]
    );
    assert.equal(result.measured, false);
    assert.ok(result.bytes > 0);
    assert.equal(result.resizeSaving, 0);
    assert.ok(!result.issues.includes('oversized'));
  });

  it('does not invent provenance for a measured byte count', () => {
    const result = analyzeResource(
      { ...baseResource, measurementSource: '', measurementConfidence: '' },
      [baseUsage]
    );
    assert.deepEqual(result.measurement, {
      bytes: baseResource.transferBytes,
      source: 'unknown',
      confidence: 'low'
    });
  });

  it('preserves source aspect ratio for a cover-like box', () => {
    const result = analyzeResource(
      { ...baseResource, sourcePixelWidth: 2000, sourcePixelHeight: 1000 },
      [{ ...baseUsage, displayWidth: 500, displayHeight: 500 }]
    );
    assert.equal(result.resizeWidth, 1000);
    assert.equal(result.resizeHeight, 500);
  });

  it('treats WebP as modern and AVIF as a separate opportunity', () => {
    const result = analyzeResource(
      { ...baseResource, url: 'https://example.com/hero.webp' },
      [baseUsage]
    );
    assert.ok(!result.issues.includes('legacyFormat'));
    assert.ok(result.issues.includes('avifOpportunity'));
  });

  it('never resizes a vector and includes the heavy threshold', () => {
    const vector = analyzeResource(
      {
        ...baseResource,
        url: 'https://example.com/logo.svg',
        transferBytes: 3000
      },
      [{ ...baseUsage, displayWidth: 40, displayHeight: 30 }]
    );
    assert.ok(!vector.issues.includes('oversized'));
    assert.equal(vector.resizeSaving, 0);

    const heavy = analyzeResource(
      { ...baseResource, transferBytes: HEAVY_IMAGE_BYTES },
      [{ ...baseUsage, displayWidth: 2000, displayHeight: 1500 }]
    );
    assert.ok(heavy.issues.includes('heavy'));
  });
});

describe('analyzeUsage', () => {
  const oversized = analyzeResource(baseResource, [baseUsage]);

  it('reports current viewport loading facts without claiming LCP', () => {
    assert.ok(
      analyzeUsage({ ...baseUsage, loading: 'lazy', inViewport: true }, oversized).issues.includes(
        'lazyVisible'
      )
    );
    assert.ok(
      analyzeUsage({ ...baseUsage, loading: 'eager', inViewport: false }, oversized).issues.includes(
        'eagerOffscreen'
      )
    );
  });

  it('uses browser LCP and layout-shift evidence without overstating causality', () => {
    const result = analyzeUsage(
      { ...baseUsage, loading: 'lazy', isLcp: true, layoutShiftCount: 1 },
      oversized
    );
    assert.ok(result.issues.includes('lazyLcp'));
    assert.ok(!result.issues.includes('lazyVisible'));
    assert.ok(result.issues.includes('layoutShiftSource'));
  });

  it('keeps alt and dimension findings per element', () => {
    const missing = analyzeUsage(
      { ...baseUsage, altState: 'missing', hasDimensions: false, hasSrcset: false },
      oversized
    );
    assert.ok(missing.issues.includes('noAlt'));
    assert.ok(missing.issues.includes('noDimensions'));
    assert.ok(missing.issues.includes('responsiveOpportunity'));

    const decorative = analyzeUsage({ ...baseUsage, altState: 'empty' }, oversized);
    assert.ok(!decorative.issues.includes('noAlt'));
  });

  it('finds a small non-responsive reuse even when another usage needs the full resource', () => {
    const fullUsage = { ...baseUsage, id: 'u-full', displayWidth: 2000, displayHeight: 1500 };
    const shared = analyzeResource(baseResource, [fullUsage, baseUsage]);
    assert.ok(!shared.issues.includes('oversized'));

    const small = analyzeUsage({ ...baseUsage, hasSrcset: false }, shared);
    assert.ok(small.issues.includes('responsiveOpportunity'));
  });

  it('does not apply img markup findings to a background usage', () => {
    const result = analyzeUsage(
      { ...baseUsage, kind: 'background', altState: 'missing', hasDimensions: false },
      oversized
    );
    assert.deepEqual(result.issues, []);
  });

  it('flags a material default-sizes mismatch only for width descriptors', () => {
    const missing = analyzeUsage(
      { ...baseUsage, usesWidthDescriptors: true, hasSizes: false },
      oversized
    );
    assert.ok(missing.issues.includes('sizesMismatch'));

    const fullWidth = analyzeUsage(
      {
        ...baseUsage,
        displayWidth: 1100,
        usesWidthDescriptors: true,
        hasSizes: false
      },
      oversized
    );
    assert.ok(!fullWidth.issues.includes('sizesMismatch'));
  });

  it('does not call a valid picture fallback an issue', () => {
    const result = analyzeUsage({ ...baseUsage, pictureFallbackSelected: true }, oversized);
    assert.ok(!result.issues.includes('unusedSources'));
  });
});

describe('analyzePage', () => {
  it('counts resource findings once and markup findings once per usage', () => {
    const usages = [
      { ...baseUsage, id: 'u1', altState: 'non-empty' },
      { ...baseUsage, id: 'u2', altState: 'missing' },
      { ...baseUsage, id: 'u3', kind: 'background', altState: 'not-applicable' }
    ];
    const report = analyzePage([baseResource], usages);

    assert.equal(report.summary.resourceCount, 1);
    assert.equal(report.summary.usageCount, 3);
    assert.equal(report.summary.totalBytes, baseResource.transferBytes, 'bytes count once');
    assert.equal(report.summary.issueStats.oversized.count, 1);
    assert.equal(report.summary.issueStats.oversized.savingBytes, report.summary.resizeSaving);
    assert.equal(report.summary.issueStats.legacyFormat.savingBytes, report.summary.formatSaving);
    assert.equal(report.summary.issueStats.noAlt.count, 1);
    assert.equal(report.summary.markupIssueCount, 1);
    assert.ok(report.resources[0].allIssues.includes('noAlt'));
  });

  it('retires the delivery grade: null with an explicit reason, never a letter', () => {
    const estimated = {
      ...baseResource,
      id: 'r2',
      url: 'https://example.com/model.png',
      transferBytes: 0
    };
    const report = analyzePage(
      [baseResource, estimated],
      [baseUsage, { ...baseUsage, id: 'u2', resourceId: 'r2' }]
    );

    assert.equal(report.summary.measuredResourceCount, 1);
    assert.equal(report.summary.estimatedResourceCount, 1);
    assert.equal(report.summary.grade, null);
    assert.equal(report.summary.gradeReason, 'uncalibrated-model');
    assert.ok(report.summary.measuredByteRatio > 0 && report.summary.measuredByteRatio < 1);
  });

  it('keeps grade null with a reason when nothing was measured', () => {
    const resource = { ...baseResource, transferBytes: 0 };
    const report = analyzePage([resource], [baseUsage]);
    assert.equal(report.summary.grade, null);
    assert.equal(report.summary.gradeReason, 'uncalibrated-model');
  });

  it('keeps browser vitals separate from delivery evidence', () => {
    const vitals = {
      lcp: { supported: true, time: 2200 },
      cls: { supported: true, score: 0.12, shiftCount: 2 }
    };
    const report = analyzePage([baseResource], [baseUsage], { vitals });
    assert.equal(report.summary.vitals, vitals);
    assert.equal(report.summary.grade, null);
  });

  it('labels every measured legacy format opportunity an estimate without grading it', () => {
    const variants = [
      ['jpeg', 'https://example.com/a.jpg', ''],
      ['png', 'https://example.com/a.png', ''],
      ['webp', 'https://example.com/a.webp', ''],
      ['avif', 'https://example.com/a.avif', '']
    ];
    for (const [format, url] of variants) {
      const resource = {
        ...baseResource,
        id: `r-${format}`,
        url,
        transferBytes: 500 * 1024
      };
      const report = analyzePage(
        [resource],
        [{ ...baseUsage, id: `u-${format}`, resourceId: `r-${format}` }]
      );
      const analyzed = report.resources[0];
      assert.equal(analyzed.format, format);
      assert.equal(report.summary.grade, null);
      assert.equal(report.summary.savingsKind, ESTIMATE_KIND_HEURISTIC);
      if (analyzed.savingBytes > 0) {
        assert.equal(analyzed.savingsKind, ESTIMATE_KIND_HEURISTIC);
        assert.ok(analyzed.estimateNote.length > 0);
      }
    }
    const jpeg = analyzeResource(
      { ...baseResource, url: 'https://example.com/a.jpg', transferBytes: 500 * 1024 },
      [baseUsage]
    );
    assert.ok(jpeg.formatEstimated);
    assert.equal(jpeg.savingsKind, ESTIMATE_KIND_HEURISTIC);
  });

  it('states incomplete coverage for one measured resource among unknowns', () => {
    const unknown = (id) => ({
      ...baseResource,
      id,
      url: `https://example.com/${id}.jpg`,
      transferBytes: 0,
      sourcePixelWidth: 0,
      sourcePixelHeight: 0,
      sourceDimensionConfidence: 'unknown'
    });
    const report = analyzePage(
      [baseResource, unknown('r2'), unknown('r3')],
      [baseUsage, { ...baseUsage, id: 'u2', resourceId: 'r2' }]
    );
    assert.equal(report.summary.measuredResourceCount, 1);
    assert.equal(report.summary.coverage.state, 'partial');
    assert.equal(report.summary.coverage.measuredCount, 1);
    assert.ok(report.summary.coverage.unknownCount > 0);
    assert.ok(report.summary.coverage.note.includes('not a claim'));
  });
});

describe('provenance', () => {
  it('classifies browser, checked, inline and model byte sources separately', () => {
    assert.equal(byteProvenanceOf(baseResource), 'browser-encoded');
    assert.equal(
      byteProvenanceOf({ ...baseResource, measurementSource: 'resource-timing-transfer' }),
      'browser-transfer'
    );
    assert.equal(
      byteProvenanceOf({
        ...baseResource,
        transferBytes: 1200,
        measurementSource: 'content-length'
      }),
      'checked-header'
    );
    assert.equal(
      byteProvenanceOf({ ...baseResource, measurementSource: 'inline', isDataUri: true }),
      'inline'
    );
    assert.equal(byteProvenanceOf({ ...baseResource, transferBytes: 0 }), 'model');
    assert.ok(isCheckedResponseSource('content-length'));
    assert.ok(isCheckedResponseSource('content-range'));
    assert.ok(!isCheckedResponseSource('resource-timing-encoded'));
  });

  it('keeps a URL-inferred format a hint and a checked header labelled', () => {
    assert.equal(formatProvenanceOf({ url: 'https://example.com/a.jpg', contentType: '' }), 'hint');
    assert.equal(formatProvenanceOf({ url: 'https://example.com/image', contentType: '' }), 'unknown');
    assert.equal(formatProvenanceOf(baseResource), 'hint');
    assert.equal(formatProvenanceOf({ ...baseResource, contentType: 'image/jpeg' }), 'observed');
    assert.equal(
      formatProvenanceOf({ ...baseResource, contentType: 'image/webp', measurementSource: 'content-length' }),
      'checked-header'
    );
  });

  it('keeps browser bytes when a checked header conflicts instead of overwriting', () => {
    const conflicted = analyzeResource(
      {
        ...baseResource,
        transferBytes: 900 * 1024,
        measurementSource: 'resource-timing-encoded',
        contentType: 'image/webp'
      },
      [baseUsage]
    );
    assert.equal(conflicted.bytes, 900 * 1024);
    assert.equal(conflicted.byteSource, 'browser-encoded');
    assert.equal(conflicted.format, 'webp');
    assert.equal(conflicted.formatProvenance, 'observed');
    assert.equal(conflicted.measured, true);
  });

  it('marks a checked-header resource with its request-context warning data', () => {
    const checked = analyzeResource(
      {
        ...baseResource,
        transferBytes: 1200,
        contentType: 'image/jpeg',
        measurementSource: 'content-length',
        measurementConfidence: 'medium'
      },
      [baseUsage]
    );
    assert.equal(checked.byteSource, 'checked-header');
    assert.equal(checked.measured, true);
    assert.ok(checked.checkedResponse);
    assert.ok(CHECKED_RESPONSE_NOTE.includes('separate'));
  });

  it('never counts inline payload as network transfer or modelled saving', () => {
    const inline = analyzeResource(
      {
        ...baseResource,
        id: 'r-inline',
        url: 'data:image/png;base64,AAAA',
        transferBytes: 48 * 1024,
        measurementSource: 'inline',
        measurementConfidence: 'medium',
        isDataUri: true
      },
      [baseUsage]
    );
    assert.equal(inline.inline, true);
    assert.equal(inline.byteState, 'inline');
    assert.equal(inline.measured, false);
    assert.equal(inline.savingBytes, 0);
    assert.equal(inline.resizeSaving, 0);
    assert.equal(inline.formatSaving, 0);

    const report = analyzePage(
      [baseResource, { ...baseResource, id: 'r-inline', url: 'data:image/png;base64,AAAA', transferBytes: 48 * 1024, measurementSource: 'inline', isDataUri: true }],
      [baseUsage, { ...baseUsage, id: 'u2', resourceId: 'r-inline' }]
    );
    assert.equal(report.summary.inlineResourceCount, 1);
    assert.equal(report.summary.measuredResourceCount, 1);
    assert.equal(report.summary.totalBytes, baseResource.transferBytes);
    assert.equal(report.summary.inlineBytes, 48 * 1024);
  });

  it('keeps zero and unknown weight distinct from free resources', () => {
    const zero = analyzeResource(
      {
        ...baseResource,
        transferBytes: 0,
        sourcePixelWidth: 0,
        sourcePixelHeight: 0,
        sourceDimensionConfidence: 'unknown'
      },
      []
    );
    assert.equal(zero.measured, false);
    assert.equal(zero.byteState, 'unknown');
    assert.equal(zero.bytes, 0);
    assert.equal(zero.savingBytes, 0);
    assert.ok(!zero.issues.includes('oversized'));
    assert.ok(!zero.issues.includes('heavy'));
  });
});

describe('buildLimitationSummary', () => {
  const cleanPage = {
    truncated: false,
    recordsTruncated: false,
    styleScanTruncated: false,
    timingBufferFull: false,
    unsupported: {},
    frameCount: 1,
    scannedElements: 10,
    skippedResources: 0,
    skippedUsages: 0
  };

  it('returns no entries for a clean fully measured page', () => {
    const report = analyzePage([baseResource], [baseUsage]);
    assert.deepEqual(buildLimitationSummary(cleanPage, report), []);
  });

  it('covers each evidence gap singly with equivalent meaning', () => {
    const report = analyzePage([baseResource], [baseUsage]);
    const truncated = buildLimitationSummary({ ...cleanPage, truncated: true, scannedElements: 8000 }, report);
    assert.equal(truncated.length, 1);
    assert.equal(truncated[0].key, 'element-limit');
    assert.ok(truncated[0].lowerBound);

    const records = buildLimitationSummary(
      { ...cleanPage, recordsTruncated: true, skippedResources: 2, skippedUsages: 5 },
      report
    );
    assert.equal(records[0].key, 'record-limit');
    assert.ok(records[0].message.includes('2 resources and 5 usages'));

    const css = buildLimitationSummary({ ...cleanPage, styleScanTruncated: true }, report);
    assert.equal(css[0].key, 'css-budget');

    const timing = buildLimitationSummary({ ...cleanPage, timingBufferFull: true }, report);
    assert.equal(timing[0].key, 'timing-buffer');

    const canvas = buildLimitationSummary({ ...cleanPage, unsupported: { canvas: 2 } }, report);
    assert.equal(canvas[0].key, 'canvas');
    assert.ok(canvas[0].message.includes('2'));

    const imageSet = buildLimitationSummary(
      { ...cleanPage, unsupported: { imageSetSelection: 3 } },
      report
    );
    assert.equal(imageSet[0].key, 'image-set');

    const frames = buildLimitationSummary({ ...cleanPage, frameCount: 3 }, report);
    assert.equal(frames[0].key, 'frames');
    assert.ok(frames[0].message.includes('3 frames'));
    assert.ok(!frames[0].message.includes('inaccessible-frame'));
  });
  it('flags truncated vitals buffers without inventing counts', () => {
    const vitals = {
      lcp: { supported: true, time: 1000 },
      cls: { supported: true, score: 0.01, shiftCount: 1, entriesTruncated: true }
    };
    const report = analyzePage([baseResource], [baseUsage], { vitals });
    const entries = buildLimitationSummary(cleanPage, report);
    assert.ok(entries.some((entry) => entry.key === 'vitals-truncated'));
  });

  it('combines every limitation while preserving each meaning', () => {
    const estimated = {
      ...baseResource,
      id: 'r2',
      url: 'https://example.com/model.png',
      transferBytes: 0,
      sourcePixelWidth: 0,
      sourcePixelHeight: 0,
      sourceDimensionConfidence: 'unknown'
    };
    const report = analyzePage(
      [baseResource, estimated],
      [baseUsage]
    );
    const entries = buildLimitationSummary(
      {
        ...cleanPage,
        truncated: true,
        scannedElements: 8000,
        recordsTruncated: true,
        skippedResources: 1,
        skippedUsages: 2,
        styleScanTruncated: true,
        timingBufferFull: true,
        unsupported: { canvas: 1, imageSetSelection: 1 },
        frameCount: 2
      },
      report
    );
    const keys = entries.map((entry) => entry.key);
    assert.deepEqual(
      keys,
      ['element-limit', 'record-limit', 'css-budget', 'timing-buffer', 'canvas', 'image-set', 'frames', 'measurement-gaps']
    );
    const gaps = entries.find((entry) => entry.key === 'measurement-gaps');
    assert.ok(gaps.message.includes('1 of 2'));
    assert.ok(gaps.lowerBound);
  });

  it('warns on separately checked headers while keeping their bytes', () => {
    const checked = {
      ...baseResource,
      id: 'r2',
      url: 'https://example.com/checked.jpg',
      transferBytes: 60 * 1024,
      measurementSource: 'content-length',
      measurementConfidence: 'medium'
    };
    const report = analyzePage(
      [checked],
      [{ ...baseUsage, id: 'u2', resourceId: 'r2' }]
    );
    assert.equal(report.summary.checkedResourceCount, 1);
    const entries = buildLimitationSummary(cleanPage, report);
    assert.ok(entries.some((entry) => entry.key === 'checked-headers'));
  });
});
