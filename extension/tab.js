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
  if (!tab?.id) throw new Error('No active tab.');
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

function revisionOf(frames) {
  return frames
    .map((frame) =>
      [
        frame.frameId,
        frame.documentId || '',
        frame.documentToken || frame.watch?.documentToken || '',
        frame.generation ?? frame.watch?.generation ?? 0
      ].join(':')
    )
    .sort()
    .join('|');
}

export async function observeTab(tabId, watchKey, command = 'start') {
  const frames = await runInAllFrames(tabId, observePage, [watchKey, command]);
  return { frames, revision: revisionOf(frames) };
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
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [usage.frameId ?? 0] },
    func: highlightImage,
    args: [markAttribute, usage.elementId, url]
  });
  return Boolean(result?.result);
}
