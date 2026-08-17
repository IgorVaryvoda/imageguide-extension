import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeImage,
  analyzePage,
  formatOf,
  gradeFor,
  HEAVY_IMAGE_BYTES
} from '../lib/analyze.js';
import { estimateBytes, formatFromContentType, formatFromUrl, humanBytes } from '../lib/format.js';

const baseImage = {
  url: 'https://example.com/hero.jpg',
  kind: 'img',
  naturalWidth: 2000,
  naturalHeight: 1500,
  displayWidth: 500,
  displayHeight: 375,
  dpr: 1,
  transferBytes: 900 * 1024,
  inViewport: true,
  loading: 'eager',
  hasAlt: true,
  hasDimensions: true,
  hasSrcset: true,
  hasSizes: true,
  usesWidthDescriptors: false,
  usesFallback: false,
  contentType: '',
  occurrences: 1
};

describe('formatFromUrl', () => {
  it('reads the file extension', () => {
    assert.equal(formatFromUrl('https://example.com/a/b/photo.JPG'), 'jpeg');
    assert.equal(formatFromUrl('https://example.com/photo.avif'), 'avif');
    assert.equal(formatFromUrl('https://example.com/logo.svg'), 'svg');
  });

  it('lets a CDN parameter win over the extension', () => {
    assert.equal(formatFromUrl('https://cdn.test/photo.jpg?w=400&format=webp'), 'webp');
    assert.equal(formatFromUrl('https://cdn.test/photo.png?fm=avif'), 'avif');
  });

  it('reads a data URI', () => {
    assert.equal(formatFromUrl('data:image/png;base64,AAAA'), 'png');
  });

  it('returns unknown when it cannot tell', () => {
    assert.equal(formatFromUrl('https://example.com/image'), 'unknown');
    assert.equal(formatFromUrl(''), 'unknown');
  });
});

describe('formatFromContentType', () => {
  it('reads the subtype', () => {
    assert.equal(formatFromContentType('image/webp'), 'webp');
    assert.equal(formatFromContentType('image/jpeg; charset=binary'), 'jpeg');
    assert.equal(formatFromContentType('image/svg+xml'), 'svg');
  });

  it('returns unknown for a missing header', () => {
    assert.equal(formatFromContentType(null), 'unknown');
    assert.equal(formatFromContentType('text/html'), 'unknown');
  });
});

describe('estimateBytes', () => {
  it('scales with the pixel count', () => {
    const small = estimateBytes(500, 500, 'jpeg');
    const large = estimateBytes(1000, 1000, 'jpeg');
    assert.equal(large, small * 4);
  });

  it('returns zero without dimensions', () => {
    assert.equal(estimateBytes(0, 500, 'jpeg'), 0);
  });

  it('gives an SVG a flat size, because its weight is not pixels', () => {
    assert.equal(estimateBytes(64, 64, 'svg'), estimateBytes(4000, 4000, 'svg'));
    assert.ok(estimateBytes(0, 0, 'svg') > 0);
  });
});

describe('formatOf', () => {
  it('lets the Content-Type header beat the file name', () => {
    const image = { url: 'https://cdn.test/photo.jpg', contentType: 'image/avif' };
    assert.equal(formatOf(image), 'avif');
  });

  it('falls back to the URL when no header is known', () => {
    assert.equal(formatOf({ url: 'https://cdn.test/photo.jpg', contentType: '' }), 'jpeg');
  });
});

describe('analyzeImage', () => {
  it('flags an oversized legacy image and estimates the saving', () => {
    const result = analyzeImage(baseImage);
    assert.ok(result.issues.includes('oversized'));
    assert.ok(result.issues.includes('legacyFormat'));
    assert.ok(result.issues.includes('heavy'));
    assert.ok(result.savingBytes > result.bytes * 0.9, 'a 4x oversized JPEG saves nearly everything');
    assert.equal(result.recommendedFormat, 'avif');
  });

  it('leaves a correctly sized AVIF alone', () => {
    const result = analyzeImage({
      ...baseImage,
      url: 'https://example.com/hero.avif',
      naturalWidth: 1000,
      naturalHeight: 750,
      dpr: 2,
      transferBytes: 40 * 1024
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.savingBytes, 0);
  });

  it('respects the device pixel ratio when it sets the target width', () => {
    const oneX = analyzeImage({ ...baseImage, naturalWidth: 1000, naturalHeight: 750, dpr: 1 });
    const twoX = analyzeImage({ ...baseImage, naturalWidth: 1000, naturalHeight: 750, dpr: 2 });
    assert.ok(oneX.issues.includes('oversized'));
    assert.ok(!twoX.issues.includes('oversized'), 'a 1000px source suits a 500px box at 2x');
  });

  it('caps the useful ratio, so a 3x screen does not excuse a huge file', () => {
    const result = analyzeImage({ ...baseImage, dpr: 3, naturalWidth: 1500, naturalHeight: 1125 });
    assert.equal(result.targetWidth, 1000);
  });

  it('flags a lazy hero and an eager image below the fold', () => {
    const lazyHero = analyzeImage({ ...baseImage, loading: 'lazy', inViewport: true });
    assert.ok(lazyHero.issues.includes('lazyHero'));

    const eagerBelow = analyzeImage({ ...baseImage, loading: 'eager', inViewport: false });
    assert.ok(eagerBelow.issues.includes('noLazyLoading'));
  });

  it('reports missing alt text, dimensions, and srcset', () => {
    const result = analyzeImage({
      ...baseImage,
      hasAlt: false,
      hasDimensions: false,
      hasSrcset: false
    });
    assert.ok(result.issues.includes('noAlt'));
    assert.ok(result.issues.includes('noDimensions'));
    assert.ok(result.issues.includes('noSrcset'));
  });

  it('skips the markup checks for a background image', () => {
    const result = analyzeImage({ ...baseImage, kind: 'background', hasAlt: false });
    assert.ok(!result.issues.includes('noAlt'));
  });

  it('falls back to an estimate when the browser hides the size', () => {
    const result = analyzeImage({ ...baseImage, transferBytes: 0 });
    assert.equal(result.measured, false);
    assert.ok(result.bytes > 0);
  });

  it('flags a srcset that uses width descriptors without a sizes attribute', () => {
    const missing = analyzeImage({ ...baseImage, usesWidthDescriptors: true, hasSizes: false });
    assert.ok(missing.issues.includes('noSizes'));

    const present = analyzeImage({ ...baseImage, usesWidthDescriptors: true, hasSizes: true });
    assert.ok(!present.issues.includes('noSizes'));
  });

  it('flags a picture whose sources never matched', () => {
    const result = analyzeImage({ ...baseImage, usesFallback: true });
    assert.ok(result.issues.includes('unusedSources'));
  });

  it('never calls a vector oversized, and never resizes it', () => {
    const result = analyzeImage({
      ...baseImage,
      url: 'https://example.com/logo.svg',
      naturalWidth: 2000,
      naturalHeight: 1500,
      displayWidth: 40,
      displayHeight: 30,
      transferBytes: 3000
    });
    assert.ok(!result.issues.includes('oversized'));
    assert.equal(result.savingBytes, 0);
  });

  it('splits the saving between the resize and the format', () => {
    const result = analyzeImage(baseImage);
    assert.ok(result.resizeSaving > 0, 'a 4x oversized image saves on the resize');
    assert.ok(result.formatSaving > 0, 'a JPEG still saves on the format');
    assert.equal(result.resizeSaving + result.formatSaving, result.savingBytes);
  });

  it('charges no resize saving to an image that already fits', () => {
    const result = analyzeImage({ ...baseImage, naturalWidth: 500, naturalHeight: 375 });
    assert.equal(result.resizeSaving, 0);
    assert.equal(result.formatSaving, result.savingBytes);
  });

  it('calls a file heavy exactly at the threshold', () => {
    const result = analyzeImage({
      ...baseImage,
      naturalWidth: 500,
      naturalHeight: 375,
      transferBytes: HEAVY_IMAGE_BYTES
    });
    assert.ok(result.issues.includes('heavy'));
  });
});

describe('analyzePage', () => {
  it('totals the bytes and sorts the worst offender first', () => {
    const report = analyzePage([
      { ...baseImage, url: 'https://example.com/small.avif', naturalWidth: 100, naturalHeight: 100, displayWidth: 100, displayHeight: 100, transferBytes: 3000 },
      { ...baseImage, url: 'https://example.com/big.jpg' }
    ]);

    assert.equal(report.summary.count, 2);
    assert.equal(report.images[0].url, 'https://example.com/big.jpg');
    assert.equal(report.summary.totalBytes, 900 * 1024 + 3000);
    assert.ok(report.summary.savingRatio > 0.5);
    assert.equal(report.summary.grade, 'F');
    assert.equal(report.summary.issueStats.oversized.count, 1);
  });

  it('counts the avoidable weight behind each weight issue', () => {
    const report = analyzePage([{ ...baseImage }]);
    const { issueStats, savingBytes } = report.summary;

    assert.equal(issueStats.oversized.savingBytes, savingBytes);
    assert.equal(issueStats.legacyFormat.savingBytes, savingBytes);
    // A markup issue costs no bytes, so it carries no saving.
    assert.equal(issueStats.noSrcset, undefined);
  });

  it('gives a markup issue a count but no saving', () => {
    const report = analyzePage([{ ...baseImage, hasAlt: false }]);
    assert.equal(report.summary.issueStats.noAlt.count, 1);
    assert.equal(report.summary.issueStats.noAlt.savingBytes, 0);
  });

  it('totals the saving split across the page', () => {
    const report = analyzePage([{ ...baseImage }, { ...baseImage, url: 'https://example.com/b.jpg' }]);
    const { resizeSaving, formatSaving, savingBytes } = report.summary;
    assert.equal(resizeSaving + formatSaving, savingBytes);
  });

  it('handles an empty page', () => {
    const report = analyzePage([]);
    assert.equal(report.summary.count, 0);
    assert.equal(report.summary.savingRatio, 0);
    assert.equal(report.summary.grade, 'A');
    assert.deepEqual(report.summary.issueStats, {});
  });
});

describe('gradeFor', () => {
  it('maps a saving ratio to a letter', () => {
    assert.equal(gradeFor(0), 'A');
    assert.equal(gradeFor(0.2), 'B');
    assert.equal(gradeFor(0.4), 'C');
    assert.equal(gradeFor(0.6), 'D');
    assert.equal(gradeFor(0.9), 'F');
  });
});

describe('humanBytes', () => {
  it('picks a readable unit', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(512), '512 B');
    assert.equal(humanBytes(2048), '2.0 kB');
    assert.equal(humanBytes(2 * 1024 * 1024), '2.00 MB');
  });
});
