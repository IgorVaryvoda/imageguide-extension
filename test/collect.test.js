import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { MARK_ATTRIBUTE, MAX_ELEMENTS_SCANNED, RESOURCE_TIMING_BUFFER } from '../lib/constants.js';
import { collectImages } from '../content/collect.js';
import { FakeElement, FakeImage, FakeVideo, installDom } from './helpers/dom.js';

let restore = () => {};
afterEach(() => restore());

/**
 * Build a page, run the collector over it, and return the result.
 *
 * @param {object} options passed to installDom
 * @param {number} [maxElements]
 * @returns {object}
 */
function scan(options, maxElements = MAX_ELEMENTS_SCANNED) {
  restore = installDom(options);
  return collectImages(MARK_ATTRIBUTE, maxElements, RESOURCE_TIMING_BUFFER);
}

const body = (...children) => new FakeElement('body', { children });

describe('collectImages', () => {
  it('records an img with its natural size and its box', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/hero.jpg', alt: 'A hero', width: '600', height: '400' },
          naturalWidth: 2400,
          naturalHeight: 1600,
          rect: { top: 0, bottom: 400, width: 600, height: 400 }
        })
      )
    });

    assert.equal(result.images.length, 1);
    const image = result.images[0];
    assert.equal(image.url, 'https://example.com/hero.jpg');
    assert.equal(image.kind, 'img');
    assert.equal(image.naturalWidth, 2400);
    assert.equal(image.displayWidth, 600);
    assert.equal(image.hasAlt, true);
    assert.equal(image.hasDimensions, true);
    assert.equal(image.inViewport, true);
  });

  it('reads a CSS aspect-ratio as a dimension, and an empty alt as none', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/a.jpg', alt: '   ' },
          style: { aspectRatio: '16 / 9' }
        })
      )
    });

    assert.equal(result.images[0].hasDimensions, true);
    assert.equal(result.images[0].hasAlt, false);
  });

  it('calls an img without a ratio undimensioned', () => {
    const result = scan({ body: body(new FakeImage({ attributes: { src: '/a.jpg' } })) });
    assert.equal(result.images[0].hasDimensions, false);
  });

  it('reads the srcset of a picture source, not only of the img', () => {
    const image = new FakeImage({ attributes: { src: '/a.jpg' }, currentSrc: '/wide.jpg' });
    const picture = new FakeElement('picture', {
      children: [
        new FakeElement('source', { attributes: { srcset: '/wide.jpg 800w', sizes: '50vw' } }),
        image
      ]
    });

    const result = scan({ body: body(picture) });
    assert.equal(result.images[0].hasSrcset, true);
    assert.equal(result.images[0].hasSizes, true);
    assert.equal(result.images[0].usesWidthDescriptors, true);
    assert.equal(result.images[0].usesFallback, false);
  });

  it('flags a picture that fell back to the img', () => {
    const image = new FakeImage({ attributes: { src: '/fallback.jpg' } });
    const picture = new FakeElement('picture', {
      children: [
        new FakeElement('source', {
          attributes: { srcset: '/wide.avif', type: 'image/avif', media: '(min-width: 4000px)' }
        }),
        image
      ]
    });

    const result = scan({ body: body(picture) });
    assert.equal(result.images[0].usesFallback, true);
  });

  it('flags a width descriptor srcset with no sizes attribute', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg', srcset: '/a.jpg 400w, /b.jpg 800w' } }))
    });

    assert.equal(result.images[0].usesWidthDescriptors, true);
    assert.equal(result.images[0].hasSizes, false);
  });

  it('leaves a density srcset out of the sizes rule', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg', srcset: '/a.jpg 1x, /b.jpg 2x' } }))
    });

    assert.equal(result.images[0].hasSrcset, true);
    assert.equal(result.images[0].usesWidthDescriptors, false);
  });

  it('takes the transfer size and the type from the resource timings', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      resources: [
        { name: 'https://example.com/a.jpg', encodedBodySize: 51200, contentType: 'image/avif' }
      ]
    });

    assert.equal(result.images[0].transferBytes, 51200);
    assert.equal(result.images[0].contentType, 'image/avif');
  });

  it('warns when Chrome ran out of timing entries', () => {
    const resources = Array.from({ length: RESOURCE_TIMING_BUFFER }, (unused, index) => ({
      name: `https://example.com/${index}.jpg`,
      encodedBodySize: 10
    }));

    const full = scan({ body: body(new FakeImage({ attributes: { src: '/a.jpg' } })), resources });
    assert.equal(full.timingBufferFull, true);
    restore();

    const room = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      resources: resources.slice(0, 10)
    });
    assert.equal(room.timingBufferFull, false);
  });

  it('collects a CSS background and a video poster', () => {
    const result = scan({
      body: body(
        new FakeElement('div', { style: { backgroundImage: 'url("/bg.png")' } }),
        new FakeVideo({ attributes: { poster: '/poster.jpg' } })
      )
    });

    const kinds = result.images.map((image) => image.kind).sort();
    assert.deepEqual(kinds, ['background', 'poster']);
  });

  it('reads every url of a multiple background', () => {
    const result = scan({
      body: body(
        new FakeElement('div', { style: { backgroundImage: 'url(/one.png), url("/two.png")' } })
      )
    });

    assert.deepEqual(
      result.images.map((image) => image.url).sort(),
      ['https://example.com/one.png', 'https://example.com/two.png']
    );
  });

  it('keeps one record per URL and counts the repeats', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/a.jpg' },
          rect: { top: 0, bottom: 50, width: 50, height: 50 }
        }),
        new FakeImage({
          attributes: { src: '/a.jpg' },
          rect: { top: 0, bottom: 400, width: 600, height: 400 }
        })
      )
    });

    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].occurrences, 2);
    assert.equal(result.images[0].displayWidth, 600, 'the largest box wins');
  });

  it('marks the element it recorded, so the highlighter finds it again', () => {
    const image = new FakeImage({ attributes: { src: '/a.jpg' } });
    const result = scan({ body: body(image) });

    assert.equal(image.getAttribute(MARK_ATTRIBUTE), result.images[0].elementId);
  });

  it('drops the mark of an earlier scan', () => {
    const stale = new FakeElement('div', { attributes: { [MARK_ATTRIBUTE]: '99' } });
    scan({ body: body(stale) });

    assert.equal(stale.hasAttribute(MARK_ATTRIBUTE), false);
  });

  it('reaches into an open shadow root', () => {
    const host = new FakeElement('my-card');
    host.attachShadow(new FakeImage({ attributes: { src: '/shadow.jpg' } }));

    const result = scan({ body: body(host) });
    assert.equal(result.images[0].url, 'https://example.com/shadow.jpg');
  });

  it('skips a blob URL, which no audit can act on', () => {
    const result = scan({
      body: body(
        new FakeImage({ attributes: { src: 'blob:https://example.com/abc' }, currentSrc: 'blob:x' })
      )
    });

    assert.deepEqual(result.images, []);
  });

  it('sizes a data URI from its own payload', () => {
    const payload = 'A'.repeat(400);
    const result = scan({
      body: body(new FakeImage({ attributes: { src: `data:image/png;base64,${payload}` } }))
    });

    assert.equal(result.images[0].isDataUri, true);
    assert.equal(result.images[0].transferBytes, 300);
  });

  it('gives a background a natural size, so the oversize test stays neutral', () => {
    const result = scan({
      body: body(
        new FakeElement('div', {
          style: { backgroundImage: 'url(/bg.png)' },
          rect: { top: 0, bottom: 200, width: 300, height: 200 }
        })
      ),
      viewport: { dpr: 2 }
    });

    assert.equal(result.images[0].naturalWidth, 600);
    assert.equal(result.images[0].naturalHeight, 400);
  });

  it('stops at the element budget and says so', () => {
    const many = Array.from({ length: 20 }, () => new FakeElement('div'));
    const result = scan({ body: body(...many) }, 5);

    assert.equal(result.truncated, true);
    assert.equal(result.scannedElements, 5);
  });

  it('reports the page details a report needs', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      title: 'Shop',
      url: 'https://example.com/shop',
      viewport: { width: 375, height: 667, dpr: 3 }
    });

    assert.equal(result.pageTitle, 'Shop');
    assert.equal(result.pageUrl, 'https://example.com/shop');
    assert.deepEqual(result.viewport, { width: 375, height: 667, dpr: 3 });
    assert.equal(result.truncated, false);
  });
});
