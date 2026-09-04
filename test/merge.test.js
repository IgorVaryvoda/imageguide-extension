import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeFrames } from '../lib/merge.js';

const resource = (id, url, overrides = {}) => ({
  id,
  url,
  transferBytes: 0,
  contentType: '',
  measurementSource: '',
  measurementConfidence: '',
  sourcePixelWidth: 0,
  sourcePixelHeight: 0,
  sourceDimensionConfidence: 'unknown',
  sourceDimensionReason: '',
  isDataUri: false,
  ...overrides
});

const usage = (id, resourceId, overrides = {}) => ({
  id,
  resourceId,
  elementId: id,
  kind: 'img',
  displayWidth: 100,
  displayHeight: 100,
  ...overrides
});

const frame = (frameId, resources, usages, extra = {}) => ({
  frameId,
  pageUrl: `https://example.com/${frameId}`,
  pageTitle: `Frame ${frameId}`,
  viewport: { width: 1280, height: 800, dpr: 1 },
  truncated: false,
  recordsTruncated: false,
  skippedResources: 0,
  skippedUsages: 0,
  timingBufferFull: false,
  resources,
  usages,
  ...extra
});

describe('mergeFrames', () => {
  it('takes page details from the top frame', () => {
    const page = mergeFrames([
      frame(3, [resource('r1', 'https://cdn.test/a.jpg')], [usage('u1', 'r1')]),
      frame(0, [resource('r1', 'https://cdn.test/b.jpg')], [usage('u1', 'r1')])
    ]);

    assert.equal(page.pageUrl, 'https://example.com/0');
    assert.equal(page.pageTitle, 'Frame 0');
    assert.equal(page.frameCount, 2);
    assert.equal(page.resources.length, 2);
    assert.equal(page.usages.length, 2);
  });

  it('deduplicates resources by URL but retains and remaps every usage', () => {
    const page = mergeFrames([
      frame(
        0,
        [resource('local-a', 'https://cdn.test/a.jpg')],
        [usage('u1', 'local-a', { elementId: 'hero', altState: 'non-empty' })]
      ),
      frame(
        1,
        [resource('local-b', 'https://cdn.test/a.jpg')],
        [usage('u7', 'local-b', { elementId: 'logo', altState: 'missing' })]
      )
    ]);

    assert.equal(page.resources.length, 1);
    assert.equal(page.resources[0].usageCount, 2);
    assert.equal(page.usages.length, 2);
    assert.ok(page.usages.every((item) => item.resourceId === page.resources[0].id));
    assert.deepEqual(page.usages.map((item) => item.frameId), [0, 1]);
    assert.deepEqual(page.usages.map((item) => item.altState), ['non-empty', 'missing']);
  });

  it('preserves resource measurement regardless of frame ordering', () => {
    const measured = resource('r1', 'https://cdn.test/a.jpg', {
      transferBytes: 5000,
      contentType: 'image/webp',
      measurementSource: 'resource-timing-encoded',
      measurementConfidence: 'high'
    });
    const hidden = resource('r1', 'https://cdn.test/a.jpg');

    for (const frames of [
      [frame(0, [measured], [usage('u1', 'r1')]), frame(1, [hidden], [usage('u1', 'r1')])],
      [frame(0, [hidden], [usage('u1', 'r1')]), frame(1, [measured], [usage('u1', 'r1')])]
    ]) {
      const page = mergeFrames(frames);
      assert.equal(page.resources[0].transferBytes, 5000);
      assert.equal(page.resources[0].contentType, 'image/webp');
      assert.equal(page.resources[0].measurementSource, 'resource-timing-encoded');
    }
  });

  it('prefers encoded-body timing over transfer timing', () => {
    const page = mergeFrames([
      frame(
        0,
        [
          resource('r1', 'https://cdn.test/a.jpg', {
            transferBytes: 900,
            measurementSource: 'resource-timing-transfer'
          })
        ],
        [usage('u1', 'r1')]
      ),
      frame(
        1,
        [
          resource('r1', 'https://cdn.test/a.jpg', {
            transferBytes: 800,
            measurementSource: 'resource-timing-encoded'
          })
        ],
        [usage('u1', 'r1')]
      )
    ]);

    assert.equal(page.resources[0].transferBytes, 800);
    assert.equal(page.resources[0].measurementSource, 'resource-timing-encoded');
  });

  it('adopts known source pixels learned in another frame', () => {
    const page = mergeFrames([
      frame(0, [resource('r1', 'https://cdn.test/a.jpg')], [usage('u1', 'r1')]),
      frame(
        1,
        [
          resource('r1', 'https://cdn.test/a.jpg', {
            sourcePixelWidth: 2000,
            sourcePixelHeight: 1200,
            sourceDimensionConfidence: 'descriptor'
          })
        ],
        [usage('u1', 'r1')]
      )
    ]);

    assert.equal(page.resources[0].sourcePixelWidth, 2000);
    assert.equal(page.resources[0].sourceDimensionConfidence, 'descriptor');
  });

  it('marks conflicting source dimensions unknown across frames', () => {
    const known = (width) =>
      resource('r1', 'https://cdn.test/a.jpg', {
        sourcePixelWidth: width,
        sourcePixelHeight: width / 2,
        sourceDimensionConfidence: 'descriptor'
      });
    const page = mergeFrames([
      frame(0, [known(1000)], [usage('u1', 'r1')]),
      frame(1, [known(2000)], [usage('u1', 'r1')])
    ]);

    assert.equal(page.resources[0].sourcePixelWidth, 0);
    assert.equal(page.resources[0].sourceDimensionConfidence, 'unknown');
    assert.equal(page.resources[0].sourceDimensionReason, 'conflict');
  });

  it('combines warning flags and skipped-record counters', () => {
    const page = mergeFrames([
      frame(0, [resource('r1', 'https://cdn.test/a.jpg')], [usage('u1', 'r1')]),
      frame(
        1,
        [resource('r1', 'https://cdn.test/b.jpg')],
        [usage('u1', 'r1')],
        {
          truncated: true,
          recordsTruncated: true,
          timingBufferFull: true,
          skippedResources: 2,
          skippedUsages: 3,
          styleScanTruncated: true,
          scannedElements: 20,
          scanDurationMs: 12,
          unsupported: { canvas: 2 },
          watch: { mutationCount: 4, lastMutationTime: 100, documentToken: 'child' }
        }
      )
    ]);

    assert.equal(page.truncated, true);
    assert.equal(page.recordsTruncated, true);
    assert.equal(page.timingBufferFull, true);
    assert.equal(page.skippedResources, 2);
    assert.equal(page.skippedUsages, 3);
    assert.equal(page.styleScanTruncated, true);
    assert.equal(page.scannedElements, 20);
    assert.equal(page.scanDurationMs, 12);
    assert.equal(page.unsupported.canvas, 2);
    assert.equal(page.dynamicMutationCount, 4);
  });

  it('takes document and vitals evidence from the top frame', () => {
    const vitals = {
      lcp: { supported: true, time: 1900 },
      cls: { supported: true, score: 0.02, shiftCount: 1 }
    };
    const page = mergeFrames([
      frame(
        0,
        [resource('r1', 'https://cdn.test/a.jpg')],
        [usage('u1', 'r1')],
        { watch: { documentToken: 'top' }, vitals }
      )
    ]);
    assert.equal(page.documentToken, 'top');
    assert.equal(page.vitals, vitals);
  });

  it('applies independent resource and usage caps across frames', () => {
    const frames = [
      frame(0, [resource('r1', 'https://cdn.test/a.jpg')], [usage('u1', 'r1')]),
      frame(1, [resource('r1', 'https://cdn.test/b.jpg')], [usage('u1', 'r1')])
    ];
    const resourceLimited = mergeFrames(frames, 1, 10);
    assert.equal(resourceLimited.resources.length, 1);
    assert.equal(resourceLimited.usages.length, 1);
    assert.equal(resourceLimited.skippedResources, 1);
    assert.equal(resourceLimited.skippedUsages, 1);

    const usageLimited = mergeFrames(frames, 10, 1);
    assert.equal(usageLimited.resources.length, 1, 'an orphan resource is pruned');
    assert.equal(usageLimited.usages.length, 1);
    assert.equal(usageLimited.skippedUsages, 1);
  });

  it('caps the final serialized page payload', () => {
    const frames = Array.from({ length: 20 }, (unused, index) =>
      frame(
        index,
        [resource('r1', `https://cdn.test/${index}.jpg`)],
        [usage('u1', 'r1', { selectedCandidateDescriptor: 'x'.repeat(300) })]
      )
    );
    const page = mergeFrames(frames, 100, 100, 1_000_000, 1800);
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).length <= 1800);
    assert.equal(page.recordsTruncated, true);
    assert.ok(page.skippedUsages > 0);
  });

  it('ignores failed frames and returns empty lists when none work', () => {
    const good = frame(
      0,
      [resource('r1', 'https://cdn.test/a.jpg')],
      [usage('u1', 'r1')]
    );
    assert.equal(mergeFrames([null, undefined, good]).frameCount, 1);

    const empty = mergeFrames([null]);
    assert.deepEqual(empty.resources, []);
    assert.deepEqual(empty.usages, []);
    assert.equal(empty.pageUrl, '');
  });

  it('agrees with the shared source-precedence helper on every ordering', async () => {
    const { shouldApplyMeasurement } = await import('../lib/measure.js');
    const sources = [
      'resource-timing-encoded',
      'resource-timing-transfer',
      'inline',
      'content-length',
      'content-range',
      ''
    ];
    for (const first of sources) {
      for (const second of sources) {
        for (const order of [[first, second], [second, first]]) {
          const [earlier, later] = order;
          const page = mergeFrames([
            frame(
              0,
              [
                resource('r1', 'https://cdn.test/a.jpg', {
                  transferBytes: 800,
                  measurementSource: earlier,
                  measurementConfidence: 'high'
                })
              ],
              [usage('u1', 'r1')]
            ),
            frame(
              1,
              [
                resource('r1', 'https://cdn.test/a.jpg', {
                  transferBytes: 900,
                  measurementSource: later,
                  measurementConfidence: 'high'
                })
              ],
              [usage('u1', 'r1')]
            )
          ]);
          const merged = page.resources[0];
          const expected = shouldApplyMeasurement(
            { transferBytes: 800, measurementSource: earlier },
            { transferBytes: 900, measurementSource: later }
          )
            ? { bytes: 900, source: later }
            : { bytes: 800, source: earlier };
          assert.equal(merged.transferBytes, expected.bytes, `${earlier} vs ${later}`);
          assert.equal(merged.measurementSource, expected.source, `${earlier} vs ${later}`);
        }
      }
    }
  });

  it('keeps a rescan HEAD result from overwriting proven format evidence', () => {
    const page = mergeFrames([
      frame(
        0,
        [
          resource('r1', 'https://cdn.test/a.jpg', {
            transferBytes: 0,
            measurementSource: '',
            contentType: 'image/jpeg'
          })
        ],
        [usage('u1', 'r1')]
      ),
      frame(
        1,
        [
          resource('r1', 'https://cdn.test/a.jpg', {
            transferBytes: 1200,
            measurementSource: 'content-length',
            measurementConfidence: 'medium',
            contentType: 'image/png'
          })
        ],
        [usage('u1', 'r1')]
      )
    ]);
    const merged = page.resources[0];
    assert.equal(merged.transferBytes, 1200);
    assert.equal(merged.measurementSource, 'content-length');
    assert.equal(
      merged.contentType,
      'image/jpeg',
      'a HEAD response does not prove the page loaded that variant'
    );
  });

  it('lets late resource-timing evidence beat an earlier HEAD result', () => {
    const head = resource('r1', 'https://cdn.test/a.jpg', {
      transferBytes: 1200,
      measurementSource: 'content-length',
      measurementConfidence: 'medium'
    });
    const timing = resource('r1', 'https://cdn.test/a.jpg', {
      transferBytes: 900,
      measurementSource: 'resource-timing-encoded',
      measurementConfidence: 'high'
    });
    const page = mergeFrames([
      frame(0, [head], [usage('u1', 'r1')]),
      frame(1, [timing], [usage('u1', 'r1')])
    ]);
    assert.equal(page.resources[0].transferBytes, 900);
    assert.equal(page.resources[0].measurementSource, 'resource-timing-encoded');
  });
});
