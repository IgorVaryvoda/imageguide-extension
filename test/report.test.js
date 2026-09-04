import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzePage } from '../lib/analyze.js';
import {
  assertSupportedSchema,
  buildJsonReport,
  buildMarkdownReport,
  escapeMarkdown,
  fileNameFromUrl,
  filterResources,
  sortResources
} from '../lib/report.js';

const page = {
  pageUrl: 'https://example.com/shop',
  pageTitle: 'Shop',
  viewport: { width: 1280, height: 800, dpr: 2 },
  frameCount: 1,
  truncated: false,
  recordsTruncated: false,
  skippedResources: 0,
  skippedUsages: 0,
  timingBufferFull: false,
  scannedElements: 12,
  scanDurationMs: 4.5,
  dynamicMutationCount: 2,
  unsupported: { canvas: 1 },
  vitals: {
    lcp: { supported: true, time: 2100, tagName: 'img', url: 'https://cdn.test/hero.jpg' },
    cls: { supported: true, score: 0.03, shiftCount: 1 }
  }
};

const resources = [
  {
    id: 'r1',
    url: 'https://cdn.test/hero.jpg',
    transferBytes: 900 * 1024,
    contentType: '',
    measurementSource: 'resource-timing-encoded',
    measurementConfidence: 'high',
    sourcePixelWidth: 3000,
    sourcePixelHeight: 2000,
    sourceDimensionConfidence: 'descriptor',
    sourceDimensionReason: '',
    isDataUri: false
  },
  {
    id: 'r2',
    url: 'https://cdn.test/icon.avif',
    transferBytes: 1200,
    contentType: 'image/avif',
    measurementSource: 'content-length',
    measurementConfidence: 'medium',
    sourcePixelWidth: 64,
    sourcePixelHeight: 64,
    sourceDimensionConfidence: 'intrinsic',
    sourceDimensionReason: '',
    isDataUri: false
  }
];

const usage = (id, resourceId, overrides = {}) => ({
  id,
  resourceId,
  frameId: 0,
  elementId: id,
  kind: 'img',
  displayWidth: resourceId === 'r1' ? 600 : 32,
  displayHeight: resourceId === 'r1' ? 400 : 32,
  dpr: resourceId === 'r1' ? 1 : 2,
  viewportWidth: 1280,
  inViewport: true,
  loading: 'eager',
  altState: 'non-empty',
  hasDimensions: true,
  hasSrcset: true,
  hasSizes: true,
  usesWidthDescriptors: false,
  pictureFallbackSelected: false,
  densityCorrectedWidth: 0,
  densityCorrectedHeight: 0,
  selectedCandidateDescriptor: '',
  sourceDimensionConfidence: 'intrinsic',
  ...overrides
});

const usages = [
  usage('u1', 'r1'),
  usage('u2', 'r1', { altState: 'missing', hasDimensions: false }),
  usage('u3', 'r2')
];
const report = analyzePage(resources, usages, page);

describe('fileNameFromUrl', () => {
  it('returns a short safe label', () => {
    assert.equal(fileNameFromUrl('https://cdn.test/a/b/photo.jpg?w=10'), 'photo.jpg');
    assert.equal(fileNameFromUrl('data:image/png;base64,AAAA'), 'inline data URI');
    assert.equal(fileNameFromUrl('not a url'), 'not a url');
  });
});

describe('sortResources', () => {
  it('sorts without mutating the input', () => {
    const before = [...report.resources];
    assert.equal(sortResources(report.resources, 'saving')[0].id, 'r1');
    assert.equal(sortResources(report.resources, 'name')[0].id, 'r1');
    assert.deepEqual(report.resources, before);
  });
});

describe('filterResources', () => {
  it('keeps a resource when any child usage has the finding', () => {
    const matched = filterResources(report.resources, 'noAlt', '');
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, 'r1');
  });

  it('combines issue and URL search filters', () => {
    assert.equal(filterResources(report.resources, 'all', 'ICON').length, 1);
    assert.equal(filterResources(report.resources, 'noAlt', 'icon').length, 0);
  });
});

describe('buildMarkdownReport', () => {
  const markdown = buildMarkdownReport(page, report);

  it('separates resources, usages, delivery, and markup without a grade', () => {
    assert.ok(markdown.startsWith('# Image delivery audit — Shop'));
    assert.ok(markdown.includes('Delivery grade: none (uncalibrated model'));
    assert.ok(!markdown.includes('Delivery grade **'));
    assert.equal(report.summary.grade, null);
    assert.equal(report.summary.gradeReason, 'uncalibrated-model');
    assert.ok(markdown.includes('2 resources across 3 usages'));
    assert.ok(markdown.includes('heuristic estimate, not a measured saving'));
    assert.ok(markdown.includes('## Resources'));
    assert.ok(markdown.includes('## Usages'));
    assert.ok(markdown.includes('Observed LCP: 2.10 s'));
    assert.ok(markdown.includes('Observed CLS: 0.030'));
    assert.ok(markdown.includes('| Missing alt attribute | usage | 1 |'));
    assert.ok(markdown.includes('(est.)'));
  });

  it('lists a repeated resource once with its ID and each usage separately', () => {
    assert.equal(markdown.match(/\| r1 \| https:\/\/cdn\.test\/hero\.jpg \|/g)?.length, 1);
    assert.ok(markdown.includes('| r1 | img f0\\#u1 |'));
    assert.ok(markdown.includes('| r1 | img f0\\#u2 |'));
  });

  it('keeps same-named files at different URLs distinguishable', () => {
    const sameName = [
      { ...resources[0], id: 'ra', url: 'https://cdn.test/a/hero.jpg' },
      { ...resources[0], id: 'rb', url: 'https://cdn.test/b/hero.jpg' }
    ];
    const sameReport = analyzePage(sameName, [
      usage('u1', 'ra'),
      usage('u2', 'rb')
    ]);
    const output = buildMarkdownReport(page, sameReport);
    assert.ok(output.includes('| ra | https://cdn.test/a/hero.jpg |'));
    assert.ok(output.includes('| rb | https://cdn.test/b/hero.jpg |'));
    assert.ok(output.includes('| ra | img f0\\#u1 |'));
    assert.ok(output.includes('| rb | img f0\\#u2 |'));
  });

  it('warns with the shared limitation summary instead of a subset', () => {
    const warnPage = {
      ...page,
      truncated: true,
      recordsTruncated: true,
      skippedResources: 2,
      skippedUsages: 5
    };
    const short = buildMarkdownReport(warnPage, report);
    assert.ok(short.includes('## Limitations & evidence'));
    assert.ok(short.includes('element scan stopped early'));
    assert.ok(short.includes('2 resources and 5 usages'));
    const parsedWarn = JSON.parse(buildJsonReport(warnPage, report, '2026-08-30T00:00:00.000Z'));
    for (const limitation of parsedWarn.limitations) {
      assert.ok(short.includes(escapeMarkdown(limitation.message)), `markdown omits: ${limitation.key}`);
    }
  });

  it('labels vitals top-frame and disclaims field performance on multi-frame pages', () => {
    const framed = buildMarkdownReport({ ...page, frameCount: 3 }, report);
    assert.ok(framed.includes('Observed LCP (top frame):'));
    assert.ok(framed.includes('not field performance'));
  });
  it('labels finding rows estimates and disclaims overlap', () => {
    assert.ok(markdown.includes('Only the resource-deduplicated estimated total above is additive'));
    assert.ok(markdown.includes('do not sum the rows below'));
    const findingRows = markdown
      .split('\n')
      .filter((line) => /^\| (Oversized|Legacy format|Heavy|AVIF opportunity) \|/.test(line));
    assert.ok(findingRows.length > 1);
    for (const row of findingRows) {
      assert.ok(row.includes('(est.)'), `row hides its estimate status: ${row}`);
    }
  });

  it('does not inflate the total when a resource is heavy, oversized and legacy', () => {
    const hero = report.resources.find((resource) => resource.id === 'r1');
    assert.ok(hero.issues.includes('heavy'));
    assert.ok(hero.issues.includes('oversized'));
    assert.ok(hero.issues.includes('legacyFormat'));
    assert.equal(hero.resizeSaving + hero.formatSaving, hero.savingBytes);
    const total = report.resources.reduce((sum, resource) => sum + resource.savingBytes, 0);
    assert.equal(report.summary.savingBytes, total);
  });

  it('escapes page-controlled Markdown and table delimiters', () => {
    const hostilePage = {
      ...page,
      pageTitle: 'Shop | [click](https://evil.test)\n# heading',
      pageUrl: 'https://example.com/a|b'
    };
    const hostileResources = [
      { ...resources[0], id: 'r1', url: 'https://cdn.test/a|b](evil.jpg' }
    ];
    const hostile = analyzePage(hostileResources, [usage('u1', 'r1')]);
    const output = buildMarkdownReport(hostilePage, hostile);

    assert.ok(output.includes('Shop \\| \\[click\\]\\(https://evil.test\\) \\# heading'));
    assert.ok(output.includes('https://example.com/a\\|b'));
    assert.ok(output.includes('https://cdn.test/a\\|b\\]\\(evil.jpg'));
    assert.ok(!output.includes('\n# heading'));
    assert.ok(!output.includes('[click](https://evil.test)'));
  });
});

describe('buildJsonReport', () => {
  const parsed = JSON.parse(buildJsonReport(page, report, '2026-08-30T00:00:00.000Z'));

  it('exports the versioned resource and usage schema', () => {
    assert.equal(parsed.tool, 'imageguide-auditor');
    assert.equal(parsed.schemaVersion, 4);
    assert.equal(parsed.modelVersion, '2026-08-30-v3');
    assert.equal(parsed.generatedAt, '2026-08-30T00:00:00.000Z');
    assert.equal(parsed.resources.length, 2);
    assert.equal(parsed.usages.length, 3);
    assert.equal(parsed.summary.resourceCount, 2);
    assert.equal(parsed.summary.usageCount, 3);
    assert.equal(parsed.summary.grade, null);
    assert.equal(parsed.summary.gradeReason, 'uncalibrated-model');
    assert.equal(parsed.page.vitals.lcp.time, 2100);
    assert.equal(parsed.page.unsupported.canvas, 1);
    assert.equal(parsed.page.vitalsScope, 'single-frame');
  });

  it('keeps measurement provenance on resources and markup on usages', () => {
    const hero = parsed.resources.find((resource) => resource.id === 'r1');
    const missingAlt = parsed.usages.find((item) => item.id === 'u2');
    assert.equal(hero.measurement.source, 'resource-timing-encoded');
    assert.equal(hero.byteSource, 'browser-encoded');
    assert.equal(hero.byteState, 'measured');
    assert.equal(hero.sourceDimensionConfidence, 'descriptor');
    assert.equal(hero.savingsKind, 'heuristic-estimate');
    assert.ok(hero.issues.includes('oversized'));
    assert.ok(missingAlt.issues.includes('noAlt'));
    assert.equal(missingAlt.resourceId, hero.id);
  });

  it('shares the normalized limitation summary with Markdown and the UI', () => {
    assert.ok(Array.isArray(parsed.limitations));
    assert.ok(parsed.limitations.length > 0);
    const markdown = buildMarkdownReport(page, report);
    for (const limitation of parsed.limitations) {
      assert.ok(limitation.key.length > 0);
      assert.ok(markdown.includes(escapeMarkdown(limitation.message)), `markdown omits: ${limitation.key}`);
    }
  });
});

describe('assertSupportedSchema', () => {
  const oldReport = {
    tool: 'imageguide-auditor',
    schemaVersion: 3,
    modelVersion: '2026-08-30-v3',
    summary: { grade: 'D', savingBytes: 100 }
  };
  const newReport = JSON.parse(buildJsonReport(page, report, '2026-08-30T00:00:00.000Z'));

  it('accepts the current schema and rejects the retired graded schema', () => {
    assert.equal(assertSupportedSchema(newReport), 4);
    assert.equal(assertSupportedSchema(4), 4);
    assert.throws(() => assertSupportedSchema(oldReport), /schema v3/i);
    assert.throws(() => assertSupportedSchema({ schemaVersion: 2 }), /unsupported report schema/i);
    assert.throws(() => assertSupportedSchema({}), /unsupported report schema/i);
  });
});
