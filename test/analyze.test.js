import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzePage,
  analyzeResource,
  analyzeUsage,
  formatOf,
  gradeFor,
  HEAVY_IMAGE_BYTES
} from '../lib/analyze.js';
import { estimateBytes, formatFromContentType, formatFromUrl } from '../lib/format.js';

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

  it('bases the grade on measured resources and reports model coverage separately', () => {
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
    assert.notEqual(report.summary.grade, '?');
    assert.ok(report.summary.measuredByteRatio > 0 && report.summary.measuredByteRatio < 1);
  });

  it('uses an unavailable grade when nothing was measured', () => {
    const resource = { ...baseResource, transferBytes: 0 };
    const report = analyzePage([resource], [baseUsage]);
    assert.equal(report.summary.grade, '?');
    assert.equal(gradeFor(0.1), 'A');
    assert.equal(gradeFor(0.7), 'F');
  });

  it('keeps browser vitals separate from the delivery grade', () => {
    const vitals = {
      lcp: { supported: true, time: 2200 },
      cls: { supported: true, score: 0.12, shiftCount: 2 }
    };
    const report = analyzePage([baseResource], [baseUsage], { vitals });
    assert.equal(report.summary.vitals, vitals);
    assert.notEqual(report.summary.grade, '?');
  });
});
