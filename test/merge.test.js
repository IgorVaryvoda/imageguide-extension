import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeFrames } from '../lib/merge.js';

const frame = (frameId, images, extra = {}) => ({
  frameId,
  pageUrl: `https://example.com/${frameId}`,
  pageTitle: `Frame ${frameId}`,
  viewport: { width: 1280, height: 800, dpr: 1 },
  truncated: false,
  timingBufferFull: false,
  images,
  ...extra
});

const image = (url, overrides = {}) => ({
  url,
  kind: 'img',
  elementId: '1',
  occurrences: 1,
  displayWidth: 100,
  displayHeight: 100,
  transferBytes: 0,
  contentType: '',
  ...overrides
});

describe('mergeFrames', () => {
  it('takes the page details from the top frame', () => {
    const page = mergeFrames([
      frame(3, [image('https://cdn.test/a.jpg')]),
      frame(0, [image('https://cdn.test/b.jpg')])
    ]);

    assert.equal(page.pageUrl, 'https://example.com/0');
    assert.equal(page.pageTitle, 'Frame 0');
    assert.equal(page.frameCount, 2);
    assert.equal(page.images.length, 2);
  });

  it('keeps one record per URL and sums the occurrences', () => {
    const page = mergeFrames([
      frame(0, [image('https://cdn.test/a.jpg', { occurrences: 2 })]),
      frame(1, [image('https://cdn.test/a.jpg', { occurrences: 3 })])
    ]);

    assert.equal(page.images.length, 1);
    assert.equal(page.images[0].occurrences, 5);
  });

  it('keeps the largest display box, because that box sets the need', () => {
    const page = mergeFrames([
      frame(0, [image('https://cdn.test/a.jpg', { displayWidth: 100, displayHeight: 100 })]),
      frame(1, [
        image('https://cdn.test/a.jpg', { displayWidth: 800, displayHeight: 600, elementId: '7' })
      ])
    ]);

    assert.equal(page.images[0].displayWidth, 800);
    assert.equal(page.images[0].frameId, 1);
    assert.equal(page.images[0].elementId, '7');
  });

  it('borrows a size that one frame measured and another did not', () => {
    const page = mergeFrames([
      frame(0, [
        image('https://cdn.test/a.jpg', {
          displayWidth: 800,
          displayHeight: 600,
          transferBytes: 0
        })
      ]),
      frame(1, [image('https://cdn.test/a.jpg', { transferBytes: 5000, contentType: 'image/webp' })])
    ]);

    assert.equal(page.images[0].transferBytes, 5000);
    assert.equal(page.images[0].contentType, 'image/webp');
  });

  it('raises a warning flag when any frame raised it', () => {
    const page = mergeFrames([
      frame(0, [image('https://cdn.test/a.jpg')]),
      frame(1, [image('https://cdn.test/b.jpg')], { truncated: true, timingBufferFull: true })
    ]);

    assert.equal(page.truncated, true);
    assert.equal(page.timingBufferFull, true);
  });

  it('ignores a frame that returned nothing', () => {
    const page = mergeFrames([null, undefined, frame(0, [image('https://cdn.test/a.jpg')])]);
    assert.equal(page.frameCount, 1);
    assert.equal(page.images.length, 1);
  });

  it('survives a scan where every frame failed', () => {
    const page = mergeFrames([null]);
    assert.deepEqual(page.images, []);
    assert.equal(page.pageUrl, '');
  });
});
