import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzePage } from '../lib/analyze.js';
import {
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterImages,
  sortImages
} from '../lib/report.js';

const page = {
  pageUrl: 'https://example.com/shop',
  pageTitle: 'Shop',
  viewport: { width: 1280, height: 800, dpr: 2 },
  frameCount: 1,
  truncated: false,
  timingBufferFull: false
};

const source = [
  {
    url: 'https://cdn.test/hero.jpg',
    kind: 'img',
    naturalWidth: 3000,
    naturalHeight: 2000,
    displayWidth: 600,
    displayHeight: 400,
    dpr: 1,
    transferBytes: 900 * 1024,
    inViewport: true,
    loading: 'eager',
    hasAlt: false,
    hasDimensions: true,
    hasSrcset: true,
    hasSizes: true,
    occurrences: 1
  },
  {
    url: 'https://cdn.test/icon.avif',
    kind: 'img',
    naturalWidth: 64,
    naturalHeight: 64,
    displayWidth: 32,
    displayHeight: 32,
    dpr: 2,
    transferBytes: 1200,
    inViewport: true,
    loading: 'eager',
    hasAlt: true,
    hasDimensions: true,
    hasSrcset: true,
    hasSizes: true,
    occurrences: 4
  }
];

const report = analyzePage(source);

describe('fileNameFromUrl', () => {
  it('takes the last path segment', () => {
    assert.equal(fileNameFromUrl('https://cdn.test/a/b/photo.jpg?w=10'), 'photo.jpg');
  });

  it('names a data URI instead of printing it', () => {
    assert.equal(fileNameFromUrl('data:image/png;base64,AAAA'), 'inline data URI');
  });

  it('returns the input when it is not a URL', () => {
    assert.equal(fileNameFromUrl('not a url'), 'not a url');
    assert.equal(fileNameFromUrl(''), '');
  });
});

describe('sortImages', () => {
  it('sorts by saving first', () => {
    assert.equal(sortImages(report.images, 'saving')[0].url, 'https://cdn.test/hero.jpg');
  });

  it('sorts by name', () => {
    assert.equal(sortImages(report.images, 'name')[0].url, 'https://cdn.test/hero.jpg');
  });

  it('leaves the input array untouched', () => {
    const before = [...report.images];
    sortImages(report.images, 'name');
    assert.deepEqual(report.images, before);
  });
});

describe('filterImages', () => {
  it('keeps only the images with an issue', () => {
    const list = filterImages(report.images, 'noAlt', '');
    assert.equal(list.length, 1);
    assert.equal(list[0].url, 'https://cdn.test/hero.jpg');
  });

  it('matches the search term against the URL, ignoring case', () => {
    assert.equal(filterImages(report.images, 'all', 'ICON').length, 1);
    assert.equal(filterImages(report.images, 'all', 'cdn.test').length, 2);
    assert.equal(filterImages(report.images, 'all', 'nothing').length, 0);
  });

  it('applies the filter and the search together', () => {
    assert.equal(filterImages(report.images, 'noAlt', 'icon').length, 0);
  });
});

describe('buildMarkdownReport', () => {
  const markdown = buildMarkdownReport(page, report);

  it('names the page and the grade', () => {
    assert.ok(markdown.startsWith('# Image audit — Shop'));
    assert.ok(markdown.includes('https://example.com/shop'));
    assert.ok(markdown.includes(`Grade **${report.summary.grade}**`));
  });

  it('splits the saving between the resize and the format', () => {
    assert.ok(markdown.includes('Resizing saves'));
    assert.ok(markdown.includes('A modern format saves a further'));
  });

  it('lists each issue with its count', () => {
    assert.ok(markdown.includes('| No alt text | 1 |'));
  });

  it('holds one table row per image', () => {
    assert.ok(markdown.includes('| hero.jpg |'));
    assert.ok(markdown.includes('| icon.avif |'));
  });

  it('warns when the scan stopped early', () => {
    const short = buildMarkdownReport({ ...page, truncated: true }, report);
    assert.ok(short.includes('the scan stopped early'));
  });
});

describe('buildJsonReport', () => {
  const parsed = JSON.parse(buildJsonReport(page, report, '2026-08-17T00:00:00.000Z'));

  it('is valid JSON with a stable shape', () => {
    assert.equal(parsed.tool, 'imageguide-auditor');
    assert.equal(parsed.generatedAt, '2026-08-17T00:00:00.000Z');
    assert.equal(parsed.page.url, 'https://example.com/shop');
    assert.equal(parsed.images.length, 2);
  });

  it('carries the numbers a build step needs', () => {
    const hero = parsed.images.find((image) => image.url.endsWith('hero.jpg'));
    assert.equal(hero.format, 'jpeg');
    assert.equal(hero.recommendedFormat, 'avif');
    assert.ok(hero.savingBytes > 0);
    assert.ok(hero.issues.includes('oversized'));
    assert.equal(parsed.summary.count, 2);
  });

  it('keeps the repeat count of an image used more than once', () => {
    const icon = parsed.images.find((image) => image.url.endsWith('icon.avif'));
    assert.equal(icon.occurrences, 4);
  });
});
