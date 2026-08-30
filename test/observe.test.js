import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { observePage } from '../content/observe.js';

const WATCH_KEY = '__imageguide_observer_test';
let restore = () => {};

afterEach(async () => {
  if (globalThis[WATCH_KEY]) await observePage(WATCH_KEY, 'stop');
  restore();
  restore = () => {};
});

function installObserverEnvironment() {
  const saved = new Map();
  let mutationCallback;
  let mutationObservers = 0;
  let performanceObservers = 0;
  const hero = { nodeType: 1, tagName: 'IMG', getAttributeNames: () => [] };

  class StubMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
      mutationObservers += 1;
    }

    observe() {}
    disconnect() {}
  }

  class StubPerformanceObserver {
    static supportedEntryTypes = ['largest-contentful-paint', 'layout-shift'];

    constructor(callback) {
      this.callback = callback;
      performanceObservers += 1;
    }

    observe({ type }) {
      const entries = type === 'largest-contentful-paint'
        ? [{ startTime: 2100, size: 1000, url: '/hero.jpg', element: hero }]
        : [
            { startTime: 100, value: 0.1, hadRecentInput: false, sources: [{ node: hero }] },
            { startTime: 200, value: 0.2, hadRecentInput: true, sources: [{ node: hero }] }
          ];
      this.callback({ getEntries: () => entries });
    }

    disconnect() {}
  }

  const globals = {
    document: { documentElement: {} },
    location: { href: 'https://example.com/page' },
    performance: { timeOrigin: 1234 },
    MutationObserver: StubMutationObserver,
    PerformanceObserver: StubPerformanceObserver
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, globalThis[name]);
    globalThis[name] = value;
  }
  restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  };

  return {
    hero,
    mutate: (records) => mutationCallback(records),
    counts: () => ({ mutationObservers, performanceObservers })
  };
}

describe('observePage', () => {
  it('buffers browser vitals and reuses one observer set for the document', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);

    assert.equal(first.documentToken, '1234');
    assert.equal(first.lcpSupported, true);
    assert.equal(first.clsSupported, true);
    assert.equal(first.lcpCount, 1);
    assert.equal(first.layoutShiftCount, 1);
    assert.deepEqual(environment.counts(), { mutationObservers: 1, performanceObservers: 2 });

    environment.mutate([
      {
        type: 'childList',
        addedNodes: [{ nodeType: 1, getAttributeNames: () => [] }],
        removedNodes: []
      }
    ]);
    const second = await observePage(WATCH_KEY);
    assert.equal(second.mutationCount, 1);
    assert.ok(second.generation > first.generation);
    assert.deepEqual(environment.counts(), { mutationObservers: 1, performanceObservers: 2 });
  });

  it('disconnects and drops page state when watching stops', async () => {
    installObserverEnvironment();
    await observePage(WATCH_KEY);
    assert.ok(globalThis[WATCH_KEY]);
    assert.equal(await observePage(WATCH_KEY, 'stop'), null);
    assert.equal(globalThis[WATCH_KEY], undefined);
  });

  it('ignores its own marked outline mutations', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);
    environment.mutate([
      {
        type: 'childList',
        addedNodes: [{
          nodeType: 1,
          getAttributeNames: () => ['data-imageguide-auditor-abc']
        }],
        removedNodes: []
      }
    ]);
    const second = await observePage(WATCH_KEY);
    assert.equal(second.mutationCount, first.mutationCount);
  });
});
