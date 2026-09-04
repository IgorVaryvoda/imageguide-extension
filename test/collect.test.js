import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MAX_ELEMENTS_SCANNED,
  MAX_RESOURCE_RECORDS,
  MAX_SCAN_DURATION_MS,
  MAX_SERIALIZED_PAYLOAD_BYTES,
  MAX_SERIALIZED_URL_CHARS,
  MAX_USAGE_RECORDS,
  MAX_URL_LENGTH,
  RESOURCE_TIMING_BUFFER
} from '../lib/constants.js';
import { collectImages } from '../content/collect.js';
import { FakeElement, FakeImage, FakeVideo, installDom } from './helpers/dom.js';

let restore = () => {};
afterEach(() => restore());

const MARK_ATTRIBUTE = 'data-imageguide-auditor-test';
const body = (...children) => new FakeElement('body', { children });

function scan(options, limits = {}) {
  restore = installDom(options);
  const watchKey = limits.watchKey || '';
  if (watchKey) globalThis[watchKey] = limits.watchState;
  const result = collectImages(
    MARK_ATTRIBUTE,
    limits.previousMarkAttribute || '',
    limits.maxElements ?? MAX_ELEMENTS_SCANNED,
    limits.maxResources ?? MAX_RESOURCE_RECORDS,
    limits.maxUsages ?? MAX_USAGE_RECORDS,
    limits.maxUrlLength ?? MAX_URL_LENGTH,
    limits.maxSerializedUrlChars ?? MAX_SERIALIZED_URL_CHARS,
    limits.maxSerializedPayloadBytes ?? MAX_SERIALIZED_PAYLOAD_BYTES,
    RESOURCE_TIMING_BUFFER,
    limits.maxScanDurationMs ?? MAX_SCAN_DURATION_MS,
    watchKey
  );
  if (watchKey) delete globalThis[watchKey];
  return result;
}

describe('collectImages', () => {
  it('separates one plain resource from its element usage', () => {
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

    assert.equal(result.resources.length, 1);
    assert.equal(result.usages.length, 1);
    assert.equal(result.usages[0].resourceId, result.resources[0].id);
    assert.equal(result.resources[0].sourcePixelWidth, 2400);
    assert.equal(result.resources[0].sourceDimensionConfidence, 'intrinsic');
    assert.equal(result.usages[0].displayWidth, 600);
    assert.equal(result.usages[0].altState, 'non-empty');
    assert.equal(result.usages[0].hasDimensions, true);
    assert.equal(result.usages[0].inViewport, true);
  });

  it('preserves decorative alt and CSS aspect-ratio per usage', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/a.jpg', alt: '   ' },
          style: { aspectRatio: '16 / 9' }
        })
      )
    });

    assert.equal(result.usages[0].hasDimensions, true);
    assert.equal(result.usages[0].altState, 'empty');
  });

  it('keeps every usage when one URL has different markup contexts', () => {
    const missing = new FakeImage({ attributes: { src: '/shared.jpg' } });
    const labelled = new FakeImage({
      attributes: { src: '/shared.jpg', alt: 'Logo', width: '100', height: '50' }
    });
    const background = new FakeElement('div', {
      style: { backgroundImage: 'url(/shared.jpg)' }
    });
    const result = scan({ body: body(missing, labelled, background) });

    assert.equal(result.resources.length, 1);
    assert.equal(result.usages.length, 3);
    assert.deepEqual(
      result.usages.map((usage) => usage.kind),
      ['img', 'img', 'background']
    );
    assert.deepEqual(
      result.usages.slice(0, 2).map((usage) => usage.altState),
      ['missing', 'non-empty']
    );
  });

  it('recovers raw width from an exact w-descriptor candidate', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: {
            src: '/hero.jpg',
            srcset: '/hero-1000.jpg 1000w, /hero-2000.jpg 2000w'
          },
          currentSrc: '/hero-2000.jpg',
          naturalWidth: 500,
          naturalHeight: 300
        })
      )
    });

    assert.equal(result.resources[0].sourcePixelWidth, 2000);
    assert.equal(result.resources[0].sourcePixelHeight, 1200);
    assert.equal(result.resources[0].sourceDimensionConfidence, 'descriptor');
    assert.equal(result.usages[0].densityCorrectedWidth, 500);
    assert.equal(result.usages[0].selectedCandidateDescriptor, '2000w');
  });

  it('recovers approximate raw pixels from an exact x-descriptor candidate', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/hero.jpg', srcset: '/hero.jpg 1x, /hero@2x.jpg 2x' },
          currentSrc: '/hero@2x.jpg',
          naturalWidth: 500,
          naturalHeight: 300
        })
      )
    });

    assert.equal(result.resources[0].sourcePixelWidth, 1000);
    assert.equal(result.resources[0].sourcePixelHeight, 600);
    assert.equal(result.usages[0].selectedCandidateDescriptor, '2x');
  });

  it('does not split a data URL at its internal comma', () => {
    const dataUrl = 'data:image/svg+xml,%3Csvg%3E';
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/fallback.png', srcset: `${dataUrl} 2x, /fallback.png 1x` },
          currentSrc: dataUrl,
          naturalWidth: 20,
          naturalHeight: 10
        })
      )
    });

    assert.equal(result.resources[0].url, dataUrl);
    assert.equal(result.resources[0].transferBytes, 5);
    assert.equal(result.resources[0].sourcePixelWidth, 40);
    assert.equal(result.usages[0].selectedCandidateDescriptor, '2x');
  });

  it('uses the matching picture source and its sizes attribute', () => {
    const image = new FakeImage({
      attributes: { src: '/fallback.jpg' },
      currentSrc: '/desktop.jpg',
      naturalWidth: 800,
      naturalHeight: 400
    });
    const picture = new FakeElement('picture', {
      children: [
        new FakeElement('source', {
          attributes: { media: '(max-width: 600px)', srcset: '/mobile.jpg 800w' }
        }),
        new FakeElement('source', {
          attributes: {
            media: '(min-width: 601px)',
            srcset: '/desktop.jpg 1600w',
            sizes: '50vw'
          }
        }),
        image
      ]
    });
    const result = scan({
      body: body(picture),
      media: { '(max-width: 600px)': false, '(min-width: 601px)': true }
    });

    assert.equal(result.resources[0].sourcePixelWidth, 1600);
    assert.equal(result.usages[0].hasSizes, true);
    assert.equal(result.usages[0].usesWidthDescriptors, true);
    assert.equal(result.usages[0].pictureFallbackSelected, false);
  });

  it('treats an expected picture fallback as intrinsic', () => {
    const image = new FakeImage({
      attributes: { src: '/fallback.jpg' },
      naturalWidth: 1200,
      naturalHeight: 800
    });
    const picture = new FakeElement('picture', {
      children: [
        new FakeElement('source', {
          attributes: { media: '(min-width: 4000px)', srcset: '/wide.avif 2000w' }
        }),
        image
      ]
    });
    const result = scan({ body: body(picture) });

    assert.equal(result.usages[0].pictureFallbackSelected, true);
    assert.equal(result.resources[0].sourcePixelWidth, 1200);
    assert.equal(result.resources[0].sourceDimensionConfidence, 'intrinsic');
  });

  it('leaves source pixels unknown when currentSrc cannot be matched', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/fallback.jpg', srcset: '/candidate.jpg 2x' },
          currentSrc: '/redirected.jpg',
          naturalWidth: 500,
          naturalHeight: 300
        })
      )
    });

    assert.equal(result.resources[0].sourcePixelWidth, 0);
    assert.equal(result.resources[0].sourceDimensionConfidence, 'unknown');
  });

  it('drops conflicting source dimensions instead of choosing one usage', () => {
    const result = scan({
      body: body(
        new FakeImage({ attributes: { src: '/a.jpg' }, naturalWidth: 100, naturalHeight: 50 }),
        new FakeImage({
          attributes: { src: '/fallback.jpg', srcset: '/a.jpg 2x' },
          currentSrc: '/a.jpg',
          naturalWidth: 100,
          naturalHeight: 50
        })
      )
    });

    assert.equal(result.resources[0].sourcePixelWidth, 0);
    assert.equal(result.resources[0].sourceDimensionConfidence, 'unknown');
    assert.equal(result.resources[0].sourceDimensionReason, 'conflict');
  });

  it('marks every recorded element for per-usage highlighting', () => {
    const first = new FakeImage({ attributes: { src: '/a.jpg' } });
    const second = new FakeImage({ attributes: { src: '/a.jpg' } });
    const result = scan({ body: body(first, second) });

    assert.equal(first.getAttribute(MARK_ATTRIBUTE), result.usages[0].elementId);
    assert.equal(second.getAttribute(MARK_ATTRIBUTE), result.usages[1].elementId);
    assert.notEqual(result.usages[0].elementId, result.usages[1].elementId);
  });

  it('removes only the known marker from the preceding scan', () => {
    const previous = 'data-imageguide-auditor-previous';
    const stale = new FakeElement('div', {
      attributes: { [previous]: '99', 'data-imageguide-id': 'page-owned' }
    });
    scan({ body: body(stale) }, { previousMarkAttribute: previous });

    assert.equal(stale.hasAttribute(previous), false);
    assert.equal(stale.getAttribute('data-imageguide-id'), 'page-owned');
  });

  it('takes encoded bytes and content type from Resource Timing', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      resources: [
        { name: 'https://example.com/a.jpg', encodedBodySize: 51200, contentType: 'image/avif' }
      ]
    });

    assert.equal(result.resources[0].transferBytes, 51200);
    assert.equal(result.resources[0].contentType, 'image/avif');
    assert.equal(result.resources[0].measurementSource, 'resource-timing-encoded');
  });

  it('prefers encoded-body data when duplicate timing entries disagree', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      resources: [
        { name: 'https://example.com/a.jpg', transferSize: 900 },
        { name: 'https://example.com/a.jpg', encodedBodySize: 800 }
      ]
    });

    assert.equal(result.resources[0].transferBytes, 800);
    assert.equal(result.resources[0].measurementSource, 'resource-timing-encoded');
  });

  it('warns heuristically at the default timing-buffer size', () => {
    const resources = Array.from({ length: RESOURCE_TIMING_BUFFER }, (unused, index) => ({
      name: `https://example.com/${index}.jpg`,
      encodedBodySize: 10
    }));
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      resources
    });
    assert.equal(result.timingBufferFull, true);
  });

  it('collects video posters and every CSS background URL', () => {
    const result = scan({
      body: body(
        new FakeVideo({ attributes: { poster: '/poster.jpg' } }),
        new FakeElement('div', {
          style: { backgroundImage: 'url(/one.png), url("/two.png")' }
        })
      )
    });

    assert.deepEqual(
      result.resources.map((resource) => resource.url).sort(),
      [
        'https://example.com/one.png',
        'https://example.com/poster.jpg',
        'https://example.com/two.png'
      ]
    );
    assert.deepEqual(
      result.usages.map((usage) => usage.kind).sort(),
      ['background', 'background', 'poster']
    );
  });

  it('parses escaped CSS URLs and covered image properties on elements and pseudos', () => {
    const result = scan({
      body: body(
        new FakeElement('div', {
          style: {
            backgroundImage: 'url("/hero\\2e jpg")',
            webkitMaskImage: 'url(/mask.svg)',
            borderImageSource: 'url("/frame.png")',
            content: 'url("/generated.png")'
          },
          pseudoStyles: {
            '::before': { backgroundImage: 'url("/before.webp")' },
            '::after': { maskImage: 'url("/after.svg")' }
          }
        })
      )
    });

    assert.deepEqual(
      result.resources.map((resource) => resource.url).sort(),
      [
        'https://example.com/after.svg',
        'https://example.com/before.webp',
        'https://example.com/frame.png',
        'https://example.com/generated.png',
        'https://example.com/hero.jpg',
        'https://example.com/mask.svg'
      ]
    );
    assert.deepEqual(
      result.usages.map((usage) => [usage.kind, usage.cssProperty]),
      [
        ['background', 'background-image'],
        ['mask', 'mask-image'],
        ['border', 'border-image-source'],
        ['generated-content', 'content'],
        ['pseudo-before', 'background-image'],
        ['pseudo-after', 'mask-image']
      ]
    );
  });

  it('uses Resource Timing to identify an image-set candidate', () => {
    const result = scan({
      body: body(
        new FakeElement('div', {
          style: {
            backgroundImage: 'image-set(url("/one.webp") 1x, url("/two.webp") 2x)'
          }
        })
      ),
      resources: [{ name: 'https://example.com/two.webp', encodedBodySize: 200 }]
    });

    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].url, 'https://example.com/two.webp');
    assert.equal(result.resources[0].transferBytes, 200);
  });

  it('leaves image-set selection unknown when multiple candidates have timing entries', () => {
    const result = scan({
      body: body(
        new FakeElement('div', {
          style: {
            backgroundImage: 'image-set(url("/one.webp") 1x, url("/two.webp") 2x)'
          }
        })
      ),
      resources: [
        { name: 'https://example.com/one.webp', encodedBodySize: 100 },
        { name: 'https://example.com/two.webp', encodedBodySize: 200 }
      ]
    });

    assert.equal(result.resources.length, 0);
    assert.equal(result.unsupported.imageSetSelection, 1);
  });

  it('uses density for untyped image-set and leaves typed selection unknown without timing', () => {
    const density = scan({
      body: body(
        new FakeElement('div', {
          style: { backgroundImage: 'image-set(url(/one.png) 1x, url(/two.png) 2x)' }
        })
      ),
      viewport: { width: 1280, height: 800, dpr: 2 }
    });
    assert.equal(density.resources[0].url, 'https://example.com/two.png');
    restore();

    const typed = scan({
      body: body(
        new FakeElement('div', {
          style: {
            backgroundImage:
              'image-set(url(/one.avif) type("image/avif") 1x, url(/one.jpg) type("image/jpeg") 1x)'
          }
        })
      )
    });
    assert.equal(typed.resources.length, 0);
    assert.equal(typed.unsupported.imageSetSelection, 1);
  });

  it('collects SVG image resources and counts unmappable canvas content', () => {
    const result = scan({
      body: body(
        new FakeElement('image', {
          attributes: { href: '/sprite.png' },
          props: { namespaceURI: 'http://www.w3.org/2000/svg' }
        }),
        new FakeElement('canvas')
      )
    });

    assert.equal(result.usages[0].kind, 'svg-image');
    assert.equal(result.resources[0].url, 'https://example.com/sprite.png');
    assert.equal(result.unsupported.canvas, 1);
  });

  it('keeps semantic images when the CSS scan reaches its time budget', () => {
    let clock = 0;
    const result = scan(
      {
        body: body(
          new FakeImage({ attributes: { src: '/hero.jpg' } }),
          new FakeElement('div', { style: { backgroundImage: 'url(/late.png)' } })
        ),
        now: () => clock++ * 20
      },
      { maxScanDurationMs: 10 }
    );

    assert.equal(result.styleScanTruncated, true);
    assert.deepEqual(result.resources.map((resource) => resource.url), [
      'https://example.com/hero.jpg'
    ]);
  });

  it('maps buffered LCP and layout-shift evidence to element usages', () => {
    const hero = new FakeImage({
      attributes: { src: '/hero.jpg', loading: 'lazy' },
      loading: 'lazy'
    });
    const result = scan(
      { body: body(hero), timeOrigin: 1234 },
      {
        watchKey: '__imageguide_test_watch',
        watchState: {
          generation: 7,
          mutationCount: 2,
          lastMutationTime: 99,
          lcpSupported: true,
          clsSupported: true,
          lcp: { startTime: 2500, size: 10000, url: '/hero.jpg', element: hero },
          layoutShifts: [
            { startTime: 100, value: 0.1, sources: [{ node: hero }] },
            { startTime: 900, value: 0.2, sources: [{ node: hero }] },
            { startTime: 2200, value: 0.4, sources: [] }
          ],
          layoutShiftsTruncated: false
        }
      }
    );

    assert.equal(result.watch.documentToken, '1234');
    assert.equal(result.usages[0].isLcp, true);
    assert.equal(result.usages[0].layoutShiftCount, 2);
    assert.equal(result.usages[0].layoutShiftScore, 0.3);
    assert.equal(result.vitals.lcp.time, 2500);
    assert.equal(result.vitals.cls.score, 0.4);
    assert.equal(result.vitals.cls.totalScore, 0.7);
    assert.equal(result.vitals.cls.attributedShiftCount, 2);
  });

  it('reaches open shadow roots and skips blob URLs', () => {
    const host = new FakeElement('my-card');
    host.attachShadow(
      new FakeImage({ attributes: { src: '/shadow.jpg' } }),
      new FakeImage({ attributes: { src: 'blob:https://example.com/a' }, currentSrc: 'blob:x' })
    );
    const result = scan({ body: body(host) });

    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].url, 'https://example.com/shadow.jpg');
  });

  it('sizes an inline data resource from its payload', () => {
    const payload = 'A'.repeat(400);
    const result = scan({
      body: body(new FakeImage({ attributes: { src: `data:image/png;base64,${payload}` } }))
    });

    assert.equal(result.resources[0].isDataUri, true);
    assert.equal(result.resources[0].transferBytes, 300);
  });

  it('requires horizontal and vertical intersection for current visibility', () => {
    const result = scan({
      body: body(
        new FakeImage({
          attributes: { src: '/off-right.jpg' },
          rect: { top: 20, bottom: 120, left: 1400, right: 1500, width: 100, height: 100 }
        })
      ),
      viewport: { width: 1280, height: 800, dpr: 1 }
    });

    assert.equal(result.usages[0].inViewport, false);
  });

  it('bounds elements, resources, usages, and URL payloads independently', () => {
    const elementLimited = scan(
      { body: body(...Array.from({ length: 20 }, () => new FakeElement('div'))) },
      { maxElements: 5 }
    );
    assert.equal(elementLimited.truncated, true);
    assert.equal(elementLimited.scannedElements, 5);
    restore();

    const resourceLimited = scan(
      {
        body: body(
          new FakeImage({ attributes: { src: '/a.jpg' } }),
          new FakeImage({ attributes: { src: '/b.jpg' } })
        )
      },
      { maxResources: 1 }
    );
    assert.equal(resourceLimited.resources.length, 1);
    assert.equal(resourceLimited.skippedResources, 1);
    assert.equal(resourceLimited.skippedUsages, 1);
    restore();

    const usageLimited = scan(
      {
        body: body(
          new FakeImage({ attributes: { src: '/a.jpg' } }),
          new FakeImage({ attributes: { src: '/a.jpg' } })
        )
      },
      { maxUsages: 1 }
    );
    assert.equal(usageLimited.resources.length, 1);
    assert.equal(usageLimited.usages.length, 1);
    assert.equal(usageLimited.skippedUsages, 1);
    restore();

    const longUrl = `data:image/png;base64,${'A'.repeat(100)}`;
    const urlLimited = scan(
      { body: body(new FakeImage({ attributes: { src: longUrl } })) },
      { maxUrlLength: 50 }
    );
    assert.equal(urlLimited.resources.length, 0);
    assert.equal(urlLimited.recordsTruncated, true);
    restore();

    const payloadLimited = scan(
      {
        body: body(...Array.from({ length: 20 }, (unused, index) =>
          new FakeImage({ attributes: { src: `/payload-${index}.jpg` } })
        ))
      },
      { maxSerializedPayloadBytes: 1800 }
    );
    assert.ok(new TextEncoder().encode(JSON.stringify(payloadLimited)).length <= 1800);
    assert.equal(payloadLimited.recordsTruncated, true);
    assert.ok(payloadLimited.skippedUsages > 0);
  });

  it('reports page details for the merged report', () => {
    const result = scan({
      body: body(new FakeImage({ attributes: { src: '/a.jpg' } })),
      title: 'Shop',
      url: 'https://example.com/shop',
      viewport: { width: 375, height: 667, dpr: 3 }
    });

    assert.equal(result.pageTitle, 'Shop');
    assert.equal(result.pageUrl, 'https://example.com/shop');
    assert.deepEqual(result.viewport, { width: 375, height: 667, dpr: 3 });
  });
  it('keys usages by document, URL, kind, and element path', () => {
    const result = scan(
      {
        body: body(
          new FakeImage({ attributes: { src: '/shared.jpg' } }),
          new FakeImage({ attributes: { src: '/shared.jpg', alt: 'Second' } })
        )
      },
      {
        watchKey: '__imageguide_test_watch_identity',
        watchState: {
          documentToken: 'tok-1',
          generation: 3,
          revision: 5,
          mutationCount: 1,
          lastMutationTime: 7
        }
      }
    );

    assert.equal(result.usages.length, 2);
    for (const usage of result.usages) {
      assert.equal(usage.documentToken, 'tok-1');
      assert.ok(usage.stableKey.startsWith('tok-1|https://example.com/shared.jpg|img||'));
    }
    // Same URL, same kind: the weak element path keeps siblings distinct.
    assert.notEqual(result.usages[0].stableKey, result.usages[1].stableKey);
    assert.equal(result.usages[0].stableKey, 'tok-1|https://example.com/shared.jpg|img||BODY[-1]/IMG[0]');
    assert.equal(result.usages[1].stableKey, 'tok-1|https://example.com/shared.jpg|img||BODY[-1]/IMG[1]');
    // Observer revision passes through; the legacy generation stays intact.
    assert.equal(result.watch.revision, 5);
    assert.equal(result.watch.generation, 3);
  });

  it('falls back to generation and time origin without an observer revision', () => {
    const result = scan(
      { body: body(new FakeImage({ attributes: { src: '/a.jpg' } })), timeOrigin: 4321 },
      {
        watchKey: '__imageguide_test_watch_legacy',
        watchState: { generation: 7, mutationCount: 0, lastMutationTime: 0 }
      }
    );

    assert.equal(result.watch.revision, 7);
    assert.equal(result.usages[0].documentToken, '4321');
    assert.ok(result.usages[0].stableKey.startsWith('4321|https://example.com/a.jpg|img||'));
  });

  it('changes the weak identity when the element moves', () => {
    const first = new FakeImage({ attributes: { src: '/move.jpg' } });
    const second = new FakeImage({ attributes: { src: '/move.jpg' } });
    const before = scan({ body: body(first, second) });
    const keyOf = (result, element) => result.usages.find(
      (usage) => usage.elementId === element.getAttribute(MARK_ATTRIBUTE)
    ).stableKey;
    const firstKeyBefore = keyOf(before, first);
    assert.ok(firstKeyBefore.endsWith('BODY[-1]/IMG[0]'));
    restore();

    const after = scan({ body: body(second, first) });
    const firstKeyAfter = keyOf(after, first);
    // The same element sits at a new path, so continuity must revalidate.
    assert.notEqual(firstKeyAfter, firstKeyBefore);
    assert.ok(firstKeyAfter.endsWith('BODY[-1]/IMG[1]'));
  });
});
