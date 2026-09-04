import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  OBSERVE_DEBOUNCE_MS,
  OBSERVE_MAX_WAIT_MS,
  OBSERVE_RELEVANT_ATTRIBUTES,
  isViewportOnlyDirty,
  needsFullScanFor,
  observePage,
  stableUsageKeyOf
} from '../content/observe.js';
import {
  createRenderMetrics,
  revisionOf,
  stableResourceKey,
  stableUsageKey,
  summarizeObservation
} from '../extension/tab.js';

const WATCH_KEY = '__imageguide_observer_test';
const MARK = 'data-imageguide-auditor-test';
let restore = () => {};

afterEach(async () => {
  if (globalThis[WATCH_KEY]) await observePage(WATCH_KEY, 'stop');
  restore();
  restore = () => {};
});

const overlayNode = () => ({
  nodeType: 1,
  tagName: 'DIV',
  getAttributeNames: () => [`${MARK}-outline`],
  getAttribute: () => 'outline'
});

const markedImage = (id = '7') => ({
  nodeType: 1,
  tagName: 'IMG',
  getAttributeNames: () => [MARK],
  getAttribute: () => id
});

const plainImage = () => ({
  nodeType: 1,
  tagName: 'IMG',
  getAttributeNames: () => [],
  getAttribute: () => null
});

function installObserverEnvironment(options = {}) {
  const saved = new Map();
  const mutationInstances = [];
  const perfCallbacks = new Map();
  const listeners = new Map();

  class StubMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      mutationInstances.push(this);
    }

    observe(target, opts) {
      this.targets.push({ target, opts });
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  class StubPerformanceObserver {
    static supportedEntryTypes = options.entryTypes ?? ['largest-contentful-paint', 'layout-shift'];

    constructor(callback) {
      this.callback = callback;
    }

    observe({ type }) {
      if (!perfCallbacks.has(type)) perfCallbacks.set(type, []);
      perfCallbacks.get(type).push(this.callback);
    }

    disconnect() {}
  }

  const listenable = (obj) => {
    obj.addEventListener = (type, handler, opts) => {
      if (!listeners.has(obj)) listeners.set(obj, new Map());
      const byType = listeners.get(obj);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push({ handler, options: opts });
    };
    obj.removeEventListener = (type, handler) => {
      const byType = listeners.get(obj);
      if (!byType?.has(type)) return;
      byType.set(type, byType.get(type).filter((entry) => entry.handler !== handler));
    };
    return obj;
  };

  let hosts = [...(options.hosts ?? [])];
  const timeOrigin = { value: options.timeOrigin ?? 1234 };
  const document = listenable({
    documentElement: {},
    hidden: false,
    querySelectorAll: () => [...hosts],
    contains: (node) => hosts.includes(node)
  });
  const win = listenable({
    scrollX: 0,
    scrollY: 0,
    innerWidth: options.viewport?.width ?? 1280,
    innerHeight: options.viewport?.height ?? 800,
    devicePixelRatio: options.viewport?.dpr ?? 1
  });

  const globals = {
    document,
    window: win,
    location: { href: 'https://example.com/page' },
    performance: { get timeOrigin() { return timeOrigin.value; } },
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

  const liveMutations = () => mutationInstances.filter((instance) => !instance.disconnected);
  const handlersFor = (target, type) => listeners.get(target)?.get(type) ?? [];
  return {
    document,
    win,
    setHosts: (next) => { hosts = [...next]; },
    setTimeOrigin: (value) => { timeOrigin.value = value; },
    mutate: (records, index = 0) => liveMutations()[index]?.callback(records),
    liveMutationObservers: () => liveMutations().length,
    totalMutationObservers: () => mutationInstances.length,
    observedTargets: () => liveMutations().flatMap((instance) => instance.targets.map((entry) => entry.target)),
    firePerf: (type, entries) => {
      for (const callback of perfCallbacks.get(type) ?? []) callback({ getEntries: () => entries });
    },
    dispatch: (target, type, event = {}) => {
      for (const { handler } of handlersFor(target, type)) handler(event);
    },
    listenerCount: (target, type) => handlersFor(target, type).length,
    totalListeners: () => [...listeners.values()].reduce(
      (total, byType) => total + [...byType.values()].reduce((sum, list) => sum + list.length, 0),
      0
    ),
    listenerOptions: (target, type) => handlersFor(target, type).map((entry) => entry.options)
  };
}

describe('observePage dirtiness and revision', () => {
  it('exposes scheduling hints as verifiable constants, not assumed delivery', async () => {
    installObserverEnvironment();
    const first = await observePage(WATCH_KEY);
    assert.equal(first.debounceMs, 250);
    assert.equal(first.maxWaitMs, 1200);
    assert.equal(first.debounceMs, OBSERVE_DEBOUNCE_MS);
    assert.equal(first.maxWaitMs, OBSERVE_MAX_WAIT_MS);
  });

  it('covers every markup input the analyzer reads, starting with alt', () => {
    for (const attribute of [
      'alt', 'src', 'srcset', 'sizes', 'href', 'poster', 'style', 'class',
      'media', 'type', 'width', 'height', 'loading', 'fetchpriority', 'decoding'
    ]) {
      assert.ok(OBSERVE_RELEVANT_ATTRIBUTES.includes(attribute), `missing ${attribute}`);
    }
  });

  it('buffers vitals only from explicit evidence and reuses one observer set', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);

    // Fixtures stay isolated: nothing fires until the test says so.
    assert.equal(first.documentToken, '1234');
    assert.equal(first.lcpSupported, true);
    assert.equal(first.clsSupported, true);
    assert.equal(first.lcpCount, 0);
    assert.equal(first.layoutShiftCount, 0);
    assert.equal(first.revision, 0);
    assert.equal(environment.liveMutationObservers(), 1);
    assert.equal(environment.totalListeners() > 0, true);

    environment.firePerf('largest-contentful-paint', [{ startTime: 2100, size: 1000 }]);
    environment.firePerf('layout-shift', [{ startTime: 100, value: 0.1, hadRecentInput: true }]);
    const second = await observePage(WATCH_KEY, 'status');
    assert.equal(second.lcpCount, 1);
    assert.equal(second.layoutShiftCount, 0);
    assert.deepEqual(second.dirtyKinds, ['resource']);
    assert.equal(environment.liveMutationObservers(), 1);
    assert.equal(environment.totalMutationObservers(), 1);

    environment.firePerf('layout-shift', [{ startTime: 200, value: 0.2, hadRecentInput: false }]);
    const third = await observePage(WATCH_KEY, 'status');
    assert.equal(third.layoutShiftCount, 1);
    assert.ok(third.dirtyKinds.includes('style'));
  });

  it('invalidates on alt add, remove, and empty changes', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);
    for (const attributeName of ['alt', 'src', 'srcset', 'sizes', 'loading', 'width', 'decoding']) {
      environment.mutate([{
        type: 'attributes',
        attributeName,
        target: plainImage()
      }]);
    }
    const second = await observePage(WATCH_KEY, 'status');
    assert.equal(second.mutationCount, 7);
    assert.ok(second.dirtyKinds.includes('markup'));
    assert.ok(second.dirtyKinds.includes('resource'));
    assert.equal(second.revision, first.revision + 7);
    assert.equal(second.needsFullScan, true);
    assert.equal(second.viewportOnly, false);
  });

  it('classifies resource and style attributes without losing markup dirt', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    environment.mutate([{ type: 'attributes', attributeName: 'class', target: plainImage() }]);
    const second = await observePage(WATCH_KEY, 'status');
    assert.deepEqual([...second.dirtyKinds].sort(), ['markup', 'style']);
  });

  it('lets a removed marked image invalidate while the overlay stays silent', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);

    // Drawing the highlight outline must not self-loop.
    environment.mutate([{ type: 'childList', addedNodes: [overlayNode()], removedNodes: [] }]);
    // Auditor mark bookkeeping itself is never evidence.
    environment.mutate([{ type: 'attributes', attributeName: MARK, target: markedImage() }]);
    const silent = await observePage(WATCH_KEY, 'status');
    assert.equal(silent.mutationCount, first.mutationCount);
    assert.equal(silent.revision, first.revision);

    // Removing or moving a marked inspected image always invalidates.
    environment.mutate([{ type: 'childList', addedNodes: [], removedNodes: [markedImage('7')] }]);
    const removed = await observePage(WATCH_KEY, 'status');
    assert.equal(removed.mutationCount, first.mutationCount + 1);
    assert.ok(removed.dirtyKinds.includes('markup'));

    environment.mutate([{ type: 'attributes', attributeName: 'alt', target: markedImage('7') }]);
    const edited = await observePage(WATCH_KEY, 'status');
    assert.equal(edited.mutationCount, first.mutationCount + 2);
  });

  it('observes open roots, registers newly discovered ones, releases detached ones', async () => {
    const rootA = { isConnected: true };
    const hostA = { shadowRoot: rootA };
    const environment = installObserverEnvironment({ hosts: [hostA] });
    // Closed roots cannot be inspected from the page context; only the open
    // root above is observable. The audit always keeps a Rescan action.
    await observePage(WATCH_KEY);
    assert.deepEqual(environment.observedTargets(), [environment.document.documentElement, rootA]);

    const rootB = { isConnected: true };
    const hostB = { shadowRoot: rootB };
    environment.setHosts([hostA, hostB]);
    environment.dispatch(environment.win, 'focus');
    const discovered = await observePage(WATCH_KEY, 'status');
    assert.deepEqual(discovered.lastDiscovery.added, 1);
    assert.equal(discovered.rootCount, 2);
    assert.ok(discovered.dirtyKinds.includes('markup'));
    assert.equal(environment.liveMutationObservers(), 3);

    rootA.isConnected = false;
    environment.setHosts([hostB]);
    environment.dispatch(environment.win, 'focus');
    const pruned = await observePage(WATCH_KEY, 'status');
    assert.deepEqual(pruned.lastDiscovery.pruned, 1);
    assert.equal(pruned.rootCount, 1);
    assert.deepEqual(environment.observedTargets(), [environment.document.documentElement, rootB]);
    assert.equal(environment.liveMutationObservers(), 2);
  });

  it('bounds root discovery on manual rescan to a single walk', async () => {
    const environment = installObserverEnvironment({ hosts: Array.from({ length: 9000 }, () => ({})) });
    await observePage(WATCH_KEY);
    const rescanned = await observePage(WATCH_KEY, 'rescan');
    assert.equal(rescanned.lastDiscovery.scanned, 8000);
    assert.equal(rescanned.lastDiscovery.bounded, true);
    assert.equal(rescanned.pendingScan, true);
    assert.equal(rescanned.needsFullScan, true);
  });

  it('treats scroll as viewport-only with no full scan', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    assert.deepEqual(environment.listenerOptions(environment.document, 'scroll'), [{ capture: true, passive: true }]);

    environment.dispatch(environment.document, 'scroll', {});
    const scrolled = await observePage(WATCH_KEY, 'status');
    assert.deepEqual(scrolled.dirtyKinds, ['viewport']);
    assert.equal(scrolled.viewportOnly, true);
    assert.equal(scrolled.needsFullScan, false);
    assert.equal(scrolled.pendingScan, true);

    // Viewport facts refresh against live nodes without a CSS reparse.
    const refreshed = await observePage(WATCH_KEY, 'viewport');
    assert.deepEqual(refreshed.dirtyKinds, []);
    assert.equal(refreshed.pendingScan, false);
  });

  it('revalidates on resize, DPR change, and late image load', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);

    environment.dispatch(environment.win, 'resize', {});
    const resized = await observePage(WATCH_KEY, 'status');
    assert.ok(resized.dirtyKinds.includes('viewport'));

    await observePage(WATCH_KEY, 'viewport');
    environment.win.devicePixelRatio = 2;
    const dpr = await observePage(WATCH_KEY, 'status');
    assert.ok(dpr.dirtyKinds.includes('viewport'));
    assert.equal(dpr.viewport.dpr, 2);

    environment.dispatch(environment.document, 'load', { target: plainImage() });
    const loaded = await observePage(WATCH_KEY, 'status');
    assert.ok(loaded.dirtyKinds.includes('resource'));
    assert.equal(loaded.needsFullScan, true);

    environment.dispatch(environment.document, 'error', { target: { ...plainImage(), tagName: 'VIDEO' } });
    const failed = await observePage(WATCH_KEY, 'status');
    assert.ok(failed.dirtyKinds.includes('resource'));
  });

  it('coalesces rapid signals into one pending scan', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const coalesced = await observePage(WATCH_KEY, 'status');
    assert.equal(coalesced.revision, first.revision + 3);
    assert.equal(coalesced.pendingScan, true);
    assert.equal(coalesced.scheduleCount, 3);
    assert.equal(coalesced.trailingResets, 2);
    assert.deepEqual(coalesced.dirtyKinds, ['markup']);
  });

  it('allows a single scan in flight and keeps mid-scan dirt pending', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const before = await observePage(WATCH_KEY, 'status');

    const claimed = await observePage(WATCH_KEY, 'beginScan');
    assert.equal(claimed.scanInFlight, true);
    assert.equal(claimed.lastBeginAccepted, true);
    const refused = await observePage(WATCH_KEY, 'beginScan');
    assert.equal(refused.scanInFlight, true);
    assert.equal(refused.lastBeginAccepted, false);

    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const kept = await observePage(WATCH_KEY, 'endScan');
    assert.equal(kept.scanInFlight, false);
    assert.equal(kept.pendingScan, true);
    assert.ok(kept.dirtyKinds.includes('markup'));

    await observePage(WATCH_KEY, 'beginScan');
    const clean = await observePage(WATCH_KEY, 'endScan');
    assert.equal(clean.pendingScan, false);
    assert.deepEqual(clean.dirtyKinds, []);

    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const dirtied = await observePage(WATCH_KEY, 'status');
    const staleAck = await observePage(WATCH_KEY, 'ack', dirtied.revision - 1);
    assert.equal(staleAck.pendingScan, true);
    const acked = await observePage(WATCH_KEY, 'ack', before.revision + 3);
    void acked;
    const current = await observePage(WATCH_KEY, 'status');
    const cleared = await observePage(WATCH_KEY, 'ack', current.revision);
    assert.equal(cleared.pendingScan, false);
    assert.deepEqual(cleared.dirtyKinds, []);
  });

  it('pauses with full listener/observer/timer teardown and resumes fresh', async () => {
    const environment = installObserverEnvironment();
    const first = await observePage(WATCH_KEY);
    assert.ok(environment.totalListeners() > 0);

    const paused = await observePage(WATCH_KEY, 'pause');
    assert.equal(paused.paused, true);
    assert.ok(globalThis[WATCH_KEY]);
    assert.equal(environment.liveMutationObservers(), 0);
    assert.equal(environment.totalListeners(), 0);

    const resumed = await observePage(WATCH_KEY, 'resume');
    assert.equal(resumed.paused, false);
    assert.equal(resumed.needsFreshScan, false);
    assert.ok(resumed.revision > first.revision);
    assert.deepEqual([...resumed.dirtyKinds].sort(), ['markup', 'resource', 'style', 'viewport']);
    assert.equal(environment.liveMutationObservers(), 1);
    assert.ok(environment.totalListeners() > 0);
  });

  it('treats pagehide as pause and requires a fresh scan on return', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    environment.document.hidden = true;
    environment.dispatch(environment.document, 'visibilitychange', {});
    const hidden = await observePage(WATCH_KEY, 'status');
    assert.equal(hidden.paused, true);
    assert.equal(hidden.needsFreshScan, true);
    assert.equal(environment.liveMutationObservers(), 0);

    environment.document.hidden = false;
    const resumed = await observePage(WATCH_KEY, 'resume');
    assert.equal(resumed.paused, false);
    assert.ok(resumed.revision > hidden.revision);
  });

  it('keeps two owner windows from stopping each other', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY, 'start', 'audit-a');
    const joined = await observePage(WATCH_KEY, 'start', 'audit-b');
    assert.equal(joined.owners, 2);

    const released = await observePage(WATCH_KEY, 'stop', 'audit-a');
    assert.notEqual(released, null);
    assert.equal(released.owners, 1);
    assert.ok(globalThis[WATCH_KEY]);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const alive = await observePage(WATCH_KEY, 'status');
    assert.equal(alive.mutationCount, 1);

    assert.equal(await observePage(WATCH_KEY, 'stop', 'audit-b'), null);
    assert.equal(globalThis[WATCH_KEY], undefined);
  });

  it('disconnects and drops page state when watching stops', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    assert.ok(globalThis[WATCH_KEY]);
    assert.equal(await observePage(WATCH_KEY, 'stop'), null);
    assert.equal(globalThis[WATCH_KEY], undefined);
    assert.equal(environment.liveMutationObservers(), 0);
    assert.equal(environment.totalListeners(), 0);
  });

  it('drops stale identities when the document is replaced', async () => {
    const environment = installObserverEnvironment();
    await observePage(WATCH_KEY);
    environment.mutate([{ type: 'childList', addedNodes: [plainImage()], removedNodes: [] }]);
    const before = await observePage(WATCH_KEY, 'status');
    assert.equal(before.revision, 1);

    environment.setTimeOrigin(9999);
    const after = await observePage(WATCH_KEY);
    assert.equal(after.documentToken, '9999');
    assert.equal(after.revision, 0);
    assert.equal(after.mutationCount, 0);
    assert.deepEqual(after.dirtyKinds, []);
  });
});

describe('observe helpers for the UI wave', () => {
  it('separates viewport-only dirt from scan dirt', () => {
    assert.equal(isViewportOnlyDirty(['viewport']), true);
    assert.equal(isViewportOnlyDirty(['viewport', 'markup']), false);
    assert.equal(isViewportOnlyDirty([]), false);
    assert.equal(needsFullScanFor(['viewport']), false);
    assert.equal(needsFullScanFor(['style']), true);
    assert.equal(needsFullScanFor([]), false);
  });

  it('builds stable usage keys without scan-local ids', () => {
    assert.equal(
      stableUsageKeyOf('tok', 'https://example.com/a.jpg', 'img', '', 'BODY[-1]/IMG[0]'),
      'tok|https://example.com/a.jpg|img||BODY[-1]/IMG[0]'
    );
  });
});

describe('tab revision and identity plumbing', () => {
  it('prefers observer revision with legacy generation fallback', () => {
    assert.equal(
      revisionOf([{ frameId: 0, documentId: 'd1', watch: { documentToken: 't', revision: 4, generation: 2 } }]),
      '0:d1:t:4'
    );
    assert.equal(
      revisionOf([{ frameId: 1, documentId: '', watch: { documentToken: 't', generation: 2 } }]),
      '1::t:2'
    );
    assert.equal(revisionOf([]), '');
  });

  it('summarizes dirty kinds across frames for the UI wave', () => {
    const viewportOnly = summarizeObservation([
      { frameId: 0, documentId: 'a', documentToken: 't', revision: 1, dirtyKinds: ['viewport'], pendingScan: true }
    ]);
    assert.equal(viewportOnly.viewportOnly, true);
    assert.equal(viewportOnly.needsFullScan, false);

    const mixed = summarizeObservation([
      { frameId: 0, documentId: 'a', documentToken: 't', revision: 1, dirtyKinds: ['viewport'], pendingScan: true },
      { frameId: 1, documentId: 'b', documentToken: 't', revision: 2, dirtyKinds: ['markup'], pendingScan: true }
    ]);
    assert.equal(mixed.viewportOnly, false);
    assert.equal(mixed.needsFullScan, true);
    assert.deepEqual([...mixed.dirtyKinds].sort(), ['markup', 'viewport']);
    assert.ok(mixed.revision.includes('0:a:t:1'));
  });

  it('keys resources by frame-document plus URL', () => {
    assert.equal(
      stableResourceKey({ frameId: 2, documentId: 'doc-9' }, { url: 'https://example.com/a.jpg' }),
      '2|doc-9|https://example.com/a.jpg'
    );
  });

  it('prefers collector stable keys over mark-backed fallback', () => {
    assert.equal(
      stableUsageKey({ frameId: 0, documentId: 'd' }, { stableKey: 'd|u|img||p', elementId: '3' }),
      'd|u|img||p'
    );
    assert.ok(
      stableUsageKey({ frameId: 0, documentId: 'd' }, { kind: 'img', cssProperty: '', elementId: '3' }).includes('mark:3')
    );
  });

  it('measures render work separately from scan budgets', () => {
    const metrics = createRenderMetrics();
    assert.equal(metrics.measure('missing'), 0);
    metrics.mark('filter');
    assert.ok(metrics.measure('filter') >= 0);
  });
});
