import {
  MARK_ATTRIBUTE_PREFIX,
  MAX_ELEMENTS_SCANNED,
  MAX_RESOURCE_RECORDS,
  MAX_SCAN_DURATION_MS,
  MAX_SERIALIZED_PAYLOAD_BYTES,
  MAX_SERIALIZED_URL_CHARS,
  MAX_USAGE_RECORDS,
  MAX_URL_LENGTH,
  RESOURCE_TIMING_BUFFER
} from '../lib/constants.js';
import { mergeFrames } from '../lib/merge.js';
import { collectImages } from '../content/collect.js';
import { highlightImage } from '../content/highlight.js';
import { observePage } from '../content/observe.js';

export function createWatchKey() {
  return `__imageguideAuditor_${crypto.randomUUID().replaceAll('-', '')}`;
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Loss of activeTab is a recovery action for the caller (re-run from the
  // popup on a normal tab), never a trigger to request broader host access.
  if (!tab?.id) throw new Error('No active tab. Re-open the popup on the page you want to audit and try again.');
  return tab;
}

async function runInAllFrames(tabId, func, args = []) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args
    });
  } catch {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
  }
  return results
    .filter((entry) => entry && entry.result)
    .map((entry) => ({
      frameId: entry.frameId ?? 0,
      documentId: entry.documentId || '',
      ...entry.result
    }));
}

/**
 * Frame-document identity plus observer revision. Scan-local `r1`/`u1` ids
 * and auditor mark values are serialization labels, never cache keys; the
 * stable per-usage key comes from `stableUsageKey` below.
 */
export function revisionOf(frames) {
  return (frames || [])
    .map((frame) =>
      [
        frame.frameId,
        frame.documentId || '',
        frame.documentToken || frame.watch?.documentToken || '',
        frame.revision ?? frame.watch?.revision ?? frame.generation ?? frame.watch?.generation ?? 0
      ].join(':')
    )
    .sort()
    .join('|');
}

/**
 * Coalesced dirty summary across frames for the UI wave. `needsFullScan`
 * means at least one frame needs a bounded full scan; `viewportOnly` means
 * every dirty frame only needs viewport-fact refresh (no CSS reparse).
 */
export function summarizeObservation(frames) {
  const kinds = new Set();
  let pendingScan = false;
  let scanInFlight = false;
  for (const frame of frames || []) {
    for (const kind of frame.dirtyKinds || frame.watch?.dirtyKinds || []) kinds.add(kind);
    if (frame.pendingScan || frame.watch?.pendingScan) pendingScan = true;
    if (frame.scanInFlight) scanInFlight = true;
  }
  const dirtyKinds = [...kinds];
  const needsFullScan = dirtyKinds.some((kind) => kind !== 'viewport');
  return {
    revision: revisionOf(frames),
    dirtyKinds,
    pendingScan,
    scanInFlight,
    needsFullScan,
    viewportOnly: pendingScan && dirtyKinds.length > 0 && !needsFullScan
  };
}

/** Stable resource identity: frame-document plus canonical URL. */
export function stableResourceKey(frame = {}, resource = {}) {
  const token = frame.documentId || frame.documentToken || frame.watch?.documentToken || '';
  return `${frame.frameId ?? 0}|${token}|${resource.url || ''}`;
}

/**
 * Stable usage identity for the UI wave. Prefers the collector-provided
 * `stableKey` (document token + URL + kind + CSS property + element path);
 * the mark-backed fallback is legacy-only and must not become a cache key.
 */
export function stableUsageKey(frame = {}, usage = {}) {
  if (usage.stableKey) return String(usage.stableKey);
  const token = frame.documentId || frame.documentToken || frame.watch?.documentToken
    || usage.documentToken || '';
  return `${frame.frameId ?? 0}|${token}|${usage.kind || ''}|${usage.cssProperty || ''}|mark:${usage.elementId || ''}`;
}

/**
 * Cheap render-metric hooks for the UI wave (filter/update timing), kept
 * separate from scan/CSS budgets. Returns elapsed milliseconds per label.
 */
export function createRenderMetrics() {
  const marks = new Map();
  return {
    mark(label) {
      marks.set(label, performance.now());
    },
    measure(label) {
      if (!marks.has(label)) return 0;
      return performance.now() - marks.get(label);
    }
  };
}

export async function observeTab(tabId, watchKey, command = 'start', detail) {
  // chrome.scripting.executeScript args must be JSON-serializable: an
  // `undefined` detail would reject the entire injection as unserializable.
  const args = detail === undefined ? [watchKey, command] : [watchKey, command, detail];
  const frames = await runInAllFrames(tabId, observePage, args);
  return { frames, ...summarizeObservation(frames) };
}

export async function scanTab(tabId, options = {}) {
  const watchKey = options.watchKey || createWatchKey();
  await observeTab(tabId, watchKey);
  const markAttribute = `${MARK_ATTRIBUTE_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
  let frames;
  try {
    frames = await runInAllFrames(tabId, collectImages, [
      markAttribute,
      options.previousMarkAttribute || '',
      MAX_ELEMENTS_SCANNED,
      MAX_RESOURCE_RECORDS,
      MAX_USAGE_RECORDS,
      MAX_URL_LENGTH,
      MAX_SERIALIZED_URL_CHARS,
      MAX_SERIALIZED_PAYLOAD_BYTES,
      RESOURCE_TIMING_BUFFER,
      MAX_SCAN_DURATION_MS,
      watchKey
    ]);
  } finally {
    if (!options.persistentWatch) await observeTab(tabId, watchKey, 'stop').catch(() => {});
  }
  const page = mergeFrames(frames);
  return {
    page,
    markAttribute,
    watchKey,
    revision: revisionOf(frames)
  };
}

export async function highlightUsage(tabId, markAttribute, usage, url) {
  if (!usage || !url) return false;
  // A replaced child frame keeps its old frameId slot semantics but a new
  // document; callers must compare usage.documentToken against a fresh
  // observation before highlighting and treat false as "rescan first".
  // A detached frame rejects below and maps to false, never a throw.
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [usage.frameId ?? 0] },
      func: highlightImage,
      args: [markAttribute, usage.elementId, url]
    });
    return Boolean(result?.result);
  } catch {
    return false;
  }
}
