/**
 * Keep browser-owned performance evidence and a lightweight mutation counter
 * alive in the extension's isolated world while a full audit holds a lease.
 *
 * Chrome serialises this function, so every helper must stay inside it.
 */
export async function observePage(watchKey, command = 'start') {
  const VERSION = 1;
  const MARK_PREFIX = 'data-imageguide-auditor-';
  const LEASE_MS = 120000;

  const disconnect = (state) => {
    for (const observer of state?.observers || []) observer.disconnect?.();
    if (state?.leaseTimer) clearTimeout(state.leaseTimer);
    if (state) state.observers = [];
  };

  const summary = (state) => ({
    documentToken: String(performance.timeOrigin || 0),
    generation: state.generation,
    mutationCount: state.mutationCount,
    lastMutationTime: state.lastMutationTime,
    lcpSupported: state.lcpSupported,
    clsSupported: state.clsSupported,
    lcpCount: state.lcpCount,
    layoutShiftCount: state.layoutShifts.length,
    layoutShiftsTruncated: state.layoutShiftsTruncated
  });

  let state = globalThis[watchKey];
  if (command === 'stop') {
    disconnect(state);
    if (state) delete globalThis[watchKey];
    return null;
  }
  if (!state || state.version !== VERSION) {
    const supported = globalThis.PerformanceObserver?.supportedEntryTypes || [];
    state = {
      version: VERSION,
      generation: 0,
      mutationCount: 0,
      lastMutationTime: 0,
      lcpSupported: supported.includes('largest-contentful-paint'),
      clsSupported: supported.includes('layout-shift'),
      lcpCount: 0,
      lcp: null,
      layoutShifts: [],
      layoutShiftsTruncated: false,
      leaseTimer: 0,
      observers: []
    };
    Object.defineProperty(globalThis, watchKey, {
      value: state,
      configurable: true
    });

    const bump = () => {
      state.generation += 1;
    };

    const hasAuditorMark = (node) =>
      node?.nodeType === 1 &&
      typeof node.getAttributeNames === 'function' &&
      node.getAttributeNames().some((name) => name.startsWith(MARK_PREFIX));

    if (typeof MutationObserver === 'function' && document.documentElement) {
      const mutations = new MutationObserver((records) => {
        const relevant = records.some((record) => {
          if (record.type === 'attributes') return true;
          const changed = [...record.addedNodes, ...record.removedNodes];
          return changed.some((node) => !hasAuditorMark(node));
        });
        if (!relevant) return;
        state.mutationCount += 1;
        state.lastMutationTime = Date.now();
        bump();
      });
      mutations.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'src',
          'srcset',
          'sizes',
          'href',
          'poster',
          'style',
          'class',
          'media',
          'type',
          'width',
          'height',
          'loading',
          'fetchpriority'
        ]
      });
      state.observers.push(mutations);
    }

    if (state.lcpSupported) {
      try {
        const lcp = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.lcp = entry;
            state.lcpCount += 1;
          }
          bump();
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
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            if (state.layoutShifts.length >= 1000) {
              state.layoutShiftsTruncated = true;
              continue;
            }
            state.layoutShifts.push(entry);
          }
          bump();
        });
        shifts.observe({ type: 'layout-shift', buffered: true });
        state.observers.push(shifts);
      } catch {
        state.clsSupported = false;
      }
    }
  }

  clearTimeout(state.leaseTimer);
  state.leaseTimer = setTimeout(() => {
    disconnect(state);
    if (globalThis[watchKey] === state) delete globalThis[watchKey];
  }, LEASE_MS);

  // Buffered PerformanceObserver entries are delivered asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return summary(state);
}
