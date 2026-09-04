/**
 * Document-scoped observation state for one live audit.
 *
 * `observePage` runs inside the inspected page (Chrome serialises it), so
 * every helper it uses must stay inside the function body and every shared
 * value must arrive as an argument. The module-scope exports below are pure
 * scheduling/identity helpers for the extension UI wave; they mirror the
 * literals inside `observePage` and are deliberately never referenced from
 * its body (see scripts/verify.mjs).
 */

/** Trailing debounce before a coalesced refresh may run. Scheduling hint, not a delivery bound. */
export const OBSERVE_DEBOUNCE_MS = 250;
/** Maximum wait from first dirt to refresh while the audit stays visible. Likewise a hint. */
export const OBSERVE_MAX_WAIT_MS = 1200;
/**
 * Markup attributes the collector/analyzer read per usage. Any change here
 * invalidates findings; `alt` changes are the smallest such case. Kept in
 * sync with the attribute filter inside `observePage`.
 */
export const OBSERVE_RELEVANT_ATTRIBUTES = [
  'alt',
  'src',
  'srcset',
  'sizes',
  'href',
  'xlink:href',
  'poster',
  'style',
  'class',
  'media',
  'type',
  'width',
  'height',
  'loading',
  'fetchpriority',
  'decoding',
  'crossorigin',
  'referrerpolicy'
];

/** Viewport-only dirt refreshes geometry facts; anything else needs a full scan. */
export function isViewportOnlyDirty(kinds = []) {
  const list = Array.isArray(kinds) ? kinds : [];
  return list.length > 0 && list.every((kind) => kind === 'viewport');
}

/** True when the dirty kinds cannot be resolved without a bounded full scan. */
export function needsFullScanFor(kinds = []) {
  const list = Array.isArray(kinds) ? kinds : [];
  return list.some((kind) => kind === 'markup' || kind === 'resource' || kind === 'style');
}

/**
 * Stable usage identity for the UI wave: frame-document token plus resource
 * URL plus element path. Scan-local `r1`/`u1` ids and auditor mark values
 * must never be used as cache keys.
 */
export function stableUsageKeyOf(documentToken, url, kind, cssProperty, domPath) {
  return [documentToken || '', url || '', kind || '', cssProperty || '', domPath || ''].join('|');
}

/**
 * Keep browser-owned performance evidence and document-scoped dirtiness alive
 * in the extension's isolated world while a full audit holds a lease.
 *
 * Chrome serialises this function, so every helper must stay inside it and
 * every literal it needs is declared below (never imported from module scope).
 *
 * Dirtiness model for the UI wave:
 * - `viewport`: scroll (including nested scrollers), resize/DPR changes.
 *   Refresh viewport facts against known live nodes; no CSS reparse.
 * - `markup`: child-list or relevant-attribute changes (starting with `alt`).
 * - `resource`: image load/error, `src`/`srcset`/`sizes`/poster/media changes,
 *   largest-contentful-paint evidence.
 * - `style`: `class`/`style` changes and layout-shift evidence.
 * Any non-viewport dirt schedules exactly one bounded full scan (coalesced,
 * never one scan per event). The 250 ms trailing / 1200 ms maximum waits are
 * scheduling hints; the UI must verify behaviour against fixtures rather than
 * assuming exact timer delivery. The CSS time budget bounds style parsing
 * only; it is not an end-to-end bound for scanning or rendering.
 *
 * Shadow roots: discovered open roots are observed as separate roots, newly
 * discovered roots are registered on bounded rescans (audit focus / manual
 * rescan), and detached roots release their observers. Closed roots cannot
 * be inspected from the page context; that limitation is by design and the
 * audit must always keep an explicit Rescan action.
 *
 * Auditor overlay nodes (the highlight outline, marked `outline`) are
 * suppressed; inspected page nodes that merely carry a numeric auditor mark
 * are never suppressed, so removing or moving a marked image invalidates.
 *
 * Commands: `start` (idempotent attach/status), `status`, `rescan` (bounded
 * root discovery), `viewport` (fresh viewport facts, clears viewport dirt
 * only), `ack` (clear dirt up to an applied revision), `beginScan`/`endScan`
 * (single scan/update in flight), `pause` (detach, keep state), `resume`
 * (re-attach with a fresh revision), `stop` (release ownership).
 */
export async function observePage(watchKey, command = 'start', detail) {
  const VERSION = 2;
  const MARK_PREFIX = 'data-imageguide-auditor-';
  const OUTLINE_VALUE = 'outline';
  const LEASE_MS = 120000;
  const TRAILING_MS = 250;
  const MAX_WAIT_MS = 1200;
  const MAX_ROOT_WALK = 8000;
  const MAX_SHIFTS = 1000;
  const RELEVANT_ATTRIBUTES = [
    'alt',
    'src',
    'srcset',
    'sizes',
    'href',
    'xlink:href',
    'poster',
    'style',
    'class',
    'media',
    'type',
    'width',
    'height',
    'loading',
    'fetchpriority',
    'decoding',
    'crossorigin',
    'referrerpolicy'
  ];
  const RESOURCE_ATTRIBUTES = {
    src: 1,
    srcset: 1,
    sizes: 1,
    media: 1,
    poster: 1,
    href: 1,
    'xlink:href': 1,
    type: 1
  };
  const STYLE_ATTRIBUTES = { style: 1, class: 1 };

  const win = globalThis.window;
  const doc = globalThis.document;

  const currentToken = () => String(
    (globalThis.performance && globalThis.performance.timeOrigin) || 0
  );

  const snapshotViewport = () => ({
    x: typeof win?.scrollX === 'number' ? win.scrollX : 0,
    y: typeof win?.scrollY === 'number' ? win.scrollY : 0,
    width: win?.innerWidth || 0,
    height: win?.innerHeight || 0,
    dpr: win?.devicePixelRatio || 1
  });

  const summary = (state) => {
    const dirty = [...(state.dirtyKinds || [])];
    return {
      documentToken: state.documentToken,
      generation: state.generation,
      revision: state.revision,
      dirtyKinds: dirty,
      pendingScan: state.pendingScan,
      scanInFlight: state.scanInFlight,
      lastBeginAccepted: state.lastBeginAccepted,
      needsFullScan: dirty.some((kind) => kind !== 'viewport'),
      viewportOnly: state.pendingScan && dirty.length > 0 && dirty.every((kind) => kind === 'viewport'),
      debounceMs: TRAILING_MS,
      maxWaitMs: MAX_WAIT_MS,
      mutationCount: state.mutationCount,
      lastMutationTime: state.lastMutationTime,
      viewport: { ...state.viewport },
      rootCount: state.roots.length,
      owners: (state.owners || []).length,
      paused: state.paused,
      needsFreshScan: state.needsFreshScan,
      lcpSupported: state.lcpSupported,
      clsSupported: state.clsSupported,
      lcpCount: state.lcpCount,
      layoutShiftCount: state.layoutShifts.length,
      layoutShiftsTruncated: state.layoutShiftsTruncated,
      scheduleCount: state.scheduleCount,
      trailingResets: state.trailingResets,
      lastDiscovery: { ...state.lastDiscovery }
    };
  };

  const clearScanTimers = (state) => {
    if (state.trailingTimer) clearTimeout(state.trailingTimer);
    if (state.maxTimer) clearTimeout(state.maxTimer);
    state.trailingTimer = 0;
    state.maxTimer = 0;
  };

  const detach = (state) => {
    for (const observer of state.observers || []) {
      try { observer.disconnect?.(); } catch { /* detached root; already gone */ }
    }
    for (const [target, type, handler, options] of state.listeners || []) {
      try { target.removeEventListener?.(type, handler, options); } catch { /* target gone */ }
    }
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    clearScanTimers(state);
    state.observers = [];
    state.listeners = [];
    state.leaseTimer = 0;
    state.wired = false;
  };

  const markDirty = (state, kinds) => {
    for (const kind of kinds || []) {
      if (!state.dirtyKinds.includes(kind)) state.dirtyKinds.push(kind);
    }
    // Every invalidating signal gets a fresh revision; coalescing applies to
    // scan scheduling (one pending flag, one trailing timer), never to
    // freshness. The UI wave polls revision to notice change.
    state.revision += 1;
    state.generation = state.revision;
    if (state.dirtyKinds.length) scheduleScan(state);
    return true;
  };
  const scheduleScan = (state) => {
    state.pendingScan = true;
    state.scheduleCount += 1;
    // Coalesce: one trailing timer at a time no matter how many events fire.
    if (state.trailingTimer) {
      clearTimeout(state.trailingTimer);
      state.trailingTimer = 0;
      state.trailingResets += 1;
    }
    if (!state.maxTimer) {
      state.maxTimer = setTimeout(() => {
        state.maxTimer = 0;
        if (state.trailingTimer) {
          clearTimeout(state.trailingTimer);
          state.trailingTimer = 0;
        }
      }, MAX_WAIT_MS);
    }
    state.trailingTimer = setTimeout(() => {
      state.trailingTimer = 0;
      if (state.maxTimer) {
        clearTimeout(state.maxTimer);
        state.maxTimer = 0;
      }
    }, TRAILING_MS);
  };

  const markValueOf = (node) => {
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') return null;
    try {
      for (const name of node.getAttributeNames?.() || []) {
        if (typeof name === 'string' && name.startsWith(MARK_PREFIX)) return node.getAttribute(name);
      }
    } catch { return null; }
    return null;
  };

  const isOverlayNode = (node) => markValueOf(node) === OUTLINE_VALUE;

  const kindsForAttribute = (name) => {
    const kinds = ['markup'];
    if (RESOURCE_ATTRIBUTES[name]) kinds.push('resource');
    if (STYLE_ATTRIBUTES[name]) kinds.push('style');
    return kinds;
  };

  const rootAttached = (root) => {
    if (!root) return false;
    if (root.isConnected === false) return false;
    const host = root.host;
    try {
      if (host && typeof doc?.contains === 'function') return doc.contains(host);
    } catch { return true; }
    return true;
  };

  const observeRoot = (state, mutationCallback, root) => {
    if (typeof MutationObserver !== 'function') return false;
    try {
      const observer = new MutationObserver(mutationCallback);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: RELEVANT_ATTRIBUTES
      });
      state.observers.push(observer);
      return true;
    } catch { return false; }
  };

  const discoverRoots = (state) => {
    let elements = [];
    try {
      elements = typeof doc?.querySelectorAll === 'function'
        ? [...doc.querySelectorAll('*')].slice(0, MAX_ROOT_WALK) : [];
    } catch { elements = []; }
    let pruned = 0;
    const kept = [];
    for (const root of state.roots) {
      if (rootAttached(root)) kept.push(root);
      else pruned += 1;
    }
    state.roots = kept;
    let added = 0;
    for (const element of elements) {
      const root = element?.shadowRoot;
      if (root && !state.roots.includes(root)) {
        state.roots.push(root);
        added += 1;
      }
    }
    state.lastDiscovery = {
      scanned: elements.length,
      observed: state.roots.length,
      added,
      pruned,
      bounded: elements.length >= MAX_ROOT_WALK
    };
    state.rootCount = state.roots.length;
    return { added, pruned };
  };

  const attachAll = (state, mutationCallback) => {
    state.observers = [];
    if (doc?.documentElement) observeRoot(state, mutationCallback, doc.documentElement);
    for (const root of state.roots) {
      if (!rootAttached(root)) continue;
      observeRoot(state, mutationCallback, root);
    }
    state.rootCount = state.roots.length;
  };

  const on = (state, target, type, handler, options) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    try {
      target.addEventListener(type, handler, options);
      state.listeners.push([target, type, handler, options]);
    } catch { /* page does not allow this listener */ }
  };

  const createState = () => {
    const supported = globalThis.PerformanceObserver?.supportedEntryTypes || [];
    const state = {
      version: VERSION,
      documentToken: currentToken(),
      owners: [],
      revision: 0,
      generation: 0,
      dirtyKinds: [],
      pendingScan: false,
      scanInFlight: false,
      scanRevision: -1,
      lastBeginAccepted: false,
      mutationCount: 0,
      lastMutationTime: 0,
      viewport: snapshotViewport(),
      roots: [],
      rootCount: 0,
      lastDiscovery: { scanned: 0, observed: 0, added: 0, pruned: 0, bounded: false },
      lcpSupported: supported.includes('largest-contentful-paint'),
      clsSupported: supported.includes('layout-shift'),
      lcpCount: 0,
      lcp: null,
      layoutShifts: [],
      layoutShiftsTruncated: false,
      paused: false,
      wired: false,
      needsFreshScan: false,
      scheduleCount: 0,
      trailingResets: 0,
      trailingTimer: 0,
      maxTimer: 0,
      leaseTimer: 0,
      observers: [],
      listeners: []
    };
    Object.defineProperty(globalThis, watchKey, { value: state, configurable: true });
    return state;
  };

  const armLease = (state) => {
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    state.leaseTimer = setTimeout(() => {
      detach(state);
      if (globalThis[watchKey] === state) delete globalThis[watchKey];
    }, LEASE_MS);
  };

  let state = globalThis[watchKey];
  if (state && state.version !== VERSION) {
    try { detach(state); } catch { /* stale observer set */ }
    try { if (globalThis[watchKey] === state) delete globalThis[watchKey]; } catch { /* key gone */ }
    state = null;
  }
  // A replaced document keeps the same isolated world but gets a new token;
  // stale identities must never survive navigation or frame replacement.
  if (state && state.documentToken !== currentToken()) {
    try { detach(state); } catch { /* stale observer set */ }
    try { if (globalThis[watchKey] === state) delete globalThis[watchKey]; } catch { /* key gone */ }
    state = null;
  }

  if (command === 'stop') {
    if (state) {
      const owner = typeof detail === 'string' ? detail : '';
      if (owner) {
        state.owners = (state.owners || []).filter((entry) => entry !== owner);
        // One audit window releasing its lease must not stop another owner's watch.
        if (state.owners.length > 0) return summary(state);
      }
      detach(state);
      try { if (globalThis[watchKey] === state) delete globalThis[watchKey]; } catch { /* key gone */ }
    }
    return null;
  }

  if (!state) state = createState();
  if (command === 'pause') {
    // Pause removes listeners, observers, and timers; state (including dirt)
    // is kept so resume can demand a fresh revision/scan.
    detach(state);
    state.paused = true;
    return summary(state);
  }

  if (command === 'resume' || (command === 'start' && state.paused)) {
    const owner = typeof detail === 'string' && detail ? detail : '';
    if (owner && !state.owners.includes(owner)) state.owners.push(owner);
    detach(state);
    state.paused = false;
    state.needsFreshScan = false;
    discoverRoots(state);
    wire(state);
    // Resume always needs a fresh revision/scan; never reuse pre-pause dirt.
    markDirty(state, ['markup', 'resource', 'style', 'viewport']);
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  function wire(state) {
    const mutationCallback = (records) => {
      const kinds = new Set();
      let relevant = false;
      for (const record of records || []) {
        if (record.type === 'attributes') {
          // Auditor marks change during scans and outlining; only the
          // overlay's own nodes are suppressed, never inspected images.
          if (typeof record.attributeName === 'string' && record.attributeName.startsWith(MARK_PREFIX)) continue;
          if (isOverlayNode(record.target)) continue;
          relevant = true;
          for (const kind of kindsForAttribute(record.attributeName)) kinds.add(kind);
          continue;
        }
        const changed = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        // Suppress only auditor-owned overlay nodes. A removed or moved
        // inspected image carries a numeric mark, not `outline`, so it
        // always invalidates here.
        if (changed.length && changed.every((node) => isOverlayNode(node))) continue;
        if (!changed.length && record.type !== 'childList') continue;
        relevant = true;
        kinds.add('markup');
      }
      if (!relevant) return;
      state.mutationCount += 1;
      try { state.lastMutationTime = Date.now(); } catch { state.lastMutationTime = 0; }
      markDirty(state, [...kinds]);
    };

    // Callers run discoverRoots() first so attachAll observes the current
    // root list; wire() itself never re-runs discovery (and never clobbers
    // the discovery stats a focus/rescan just recorded).
    attachAll(state, mutationCallback);
    on(state, doc, 'scroll', () => {
      state.viewport = snapshotViewport();
      markDirty(state, ['viewport']);
    }, { capture: true, passive: true });
    on(state, win, 'resize', () => {
      state.viewport = snapshotViewport();
      markDirty(state, ['viewport']);
    }, { passive: true });
    // Late image loads and failures change selected candidates and measured
    // dimensions; they need dimension/candidate revalidation, not cached geometry.
    const loadHandler = (event) => {
      const tag = event?.target?.tagName;
      if (tag !== 'IMG' && tag !== 'VIDEO' && tag !== 'SOURCE' && tag !== 'PICTURE') return;
      if (isOverlayNode(event.target)) return;
      state.viewport = snapshotViewport();
      markDirty(state, ['resource']);
    };
    on(state, doc, 'load', loadHandler, { capture: true });
    on(state, doc, 'error', loadHandler, { capture: true });
    // Attaching a shadow root needs no light-DOM mutation, so newly
    // attachable roots are only found by bounded discovery on focus/rescan.
    const focusHandler = () => {
      const found = discoverRoots(state);
      if (found.added === 0 && found.pruned === 0) return;
      detach(state);
      wire(state);
      armLease(state);
      if (found.added > 0) markDirty(state, ['markup']);
    };
    on(state, win, 'focus', focusHandler);
    on(state, doc, 'focusin', focusHandler);
    on(state, doc, 'visibilitychange', () => {
      if (doc?.hidden) {
        detach(state);
        state.paused = true;
        state.needsFreshScan = true;
      }
    });
    on(state, win, 'pagehide', () => {
      detach(state);
      state.paused = true;
      state.needsFreshScan = true;
    });

    if (state.lcpSupported) {
      try {
        const lcp = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.lcp = entry;
            state.lcpCount += 1;
          }
          markDirty(state, ['resource']);
        });
        lcp.observe({ type: 'largest-contentful-paint', buffered: true });
        state.observers.push(lcp);
      } catch {
        state.lcpSupported = false;
      }
    }

    if (state.clsSupported) {
      try {
        const shifts = new PerformanceObserver((list) => {
          let stored = false;
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            if (state.layoutShifts.length >= MAX_SHIFTS) {
              state.layoutShiftsTruncated = true;
              continue;
            }
            state.layoutShifts.push(entry);
            stored = true;
          }
          // Shifts tied to recent input are incidental, not page instability.
          if (stored) markDirty(state, ['style']);
        });
        shifts.observe({ type: 'layout-shift', buffered: true });
        state.observers.push(shifts);
      } catch {
        state.clsSupported = false;
      }
    }
    state.wired = true;
  };

  const ensureWired = () => {
    if (state.wired || state.paused) return;
    discoverRoots(state);
    wire(state);
  };


  if (command === 'start' || command === 'status') {
    const owner = typeof detail === 'string' && detail ? detail : '';
    if (command === 'start' && owner && !state.owners.includes(owner)) state.owners.push(owner);
    // DPR/zoom changes surface here even without a resize event reaching us.
    const fresh = snapshotViewport();
    const before = state.viewport || {};
    if (fresh.dpr !== before.dpr || fresh.width !== before.width || fresh.height !== before.height) {
      state.viewport = fresh;
      markDirty(state, ['viewport']);
    } else {
      state.viewport = { ...fresh, x: fresh.x, y: fresh.y };
    }
    ensureWired();
    if (command === 'start') armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  if (command === 'rescan') {
    // Bounded root discovery (at most one walk, capped element count) plus a
    // viewport refresh. This only sets coalesced scan flags; it never fans
    // out one scan per event.
    discoverRoots(state);
    detach(state);
    wire(state);
    state.viewport = snapshotViewport();
    markDirty(state, ['markup', 'resource', 'style', 'viewport']);
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }
  if (command === 'viewport') {
    ensureWired();
    state.viewport = snapshotViewport();
    state.dirtyKinds = (state.dirtyKinds || []).filter((kind) => kind !== 'viewport');
    if (!state.dirtyKinds.length) state.pendingScan = false;
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  if (command === 'ack') {
    ensureWired();
    const applied = typeof detail === 'number' ? detail : -1;
    if (applied >= state.revision) {
      state.dirtyKinds = [];
      state.pendingScan = false;
    }
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  if (command === 'beginScan') {
    ensureWired();
    if (state.scanInFlight) {
      state.lastBeginAccepted = false;
      armLease(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return summary(state);
    }
    state.scanInFlight = true;
    state.scanRevision = state.revision;
    state.lastBeginAccepted = true;
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  if (command === 'endScan') {
    ensureWired();
    state.scanInFlight = false;
    // Dirt that arrived mid-scan keeps its pending flag; only a clean scan clears it.
    if (state.revision === state.scanRevision) {
      state.dirtyKinds = [];
      state.pendingScan = false;
    }
    state.lastBeginAccepted = false;
    armLease(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return summary(state);
  }

  armLease(state);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return summary(state);
}
