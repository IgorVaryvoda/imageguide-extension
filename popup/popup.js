import { analyzePage, ISSUES } from '../lib/analyze.js';
import {
  CONVERTER_URL,
  MARK_ATTRIBUTE,
  MAX_ELEMENTS_SCANNED,
  MAX_ROWS,
  RESOURCE_TIMING_BUFFER
} from '../lib/constants.js';
import { humanBytes } from '../lib/format.js';
import { mergeFrames } from '../lib/merge.js';
import {
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterImages,
  sortImages
} from '../lib/report.js';
import { collectImages } from '../content/collect.js';
import { highlightImage } from '../content/highlight.js';

const elements = {
  loading: document.getElementById('state-loading'),
  error: document.getElementById('state-error'),
  errorMessage: document.getElementById('error-message'),
  empty: document.getElementById('state-empty'),
  results: document.getElementById('results'),
  grade: document.getElementById('grade'),
  saving: document.getElementById('saving'),
  count: document.getElementById('count'),
  total: document.getElementById('total'),
  optimised: document.getElementById('optimised'),
  barFill: document.getElementById('bar-fill'),
  resizeSaving: document.getElementById('resize-saving'),
  formatSaving: document.getElementById('format-saving'),
  measureNote: document.getElementById('measure-note'),
  estimatedCount: document.getElementById('estimated-count'),
  measure: document.getElementById('measure'),
  truncateNote: document.getElementById('truncate-note'),
  bufferNote: document.getElementById('buffer-note'),
  filters: document.getElementById('filters'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  images: document.getElementById('images'),
  listNote: document.getElementById('list-note'),
  rescan: document.getElementById('rescan'),
  copy: document.getElementById('copy'),
  copyJson: document.getElementById('copy-json')
};

/** @type {{page: object|null, report: object|null, filter: string, sort: string, search: string}} */
const state = { page: null, report: null, filter: 'all', sort: 'saving', search: '' };

const SETTING_KEYS = ['filter', 'sort'];

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTING_KEYS);
    const sorts = [...elements.sort.options].map((option) => option.value);
    if (typeof stored.filter === 'string') state.filter = stored.filter;
    if (sorts.includes(stored.sort)) state.sort = stored.sort;
  } catch {
    // A missing store is not worth an error. The defaults still work.
  }
  elements.sort.value = state.sort;
}

function saveSettings() {
  chrome.storage.local.set({ filter: state.filter, sort: state.sort }).catch(() => {});
}

function show(section) {
  for (const key of ['loading', 'error', 'empty', 'results']) {
    elements[key].hidden = key !== section;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab;
}

/**
 * Run a function in every frame of the page we can reach.
 * A cross-origin frame that activeTab does not cover simply returns nothing.
 */
async function runInAllFrames(func, args = []) {
  const tab = await activeTab();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func,
      args
    });
  } catch {
    // Some pages refuse an all-frames injection. The top frame still works.
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args
    });
  }
  return results
    .filter((entry) => entry && entry.result)
    .map((entry) => ({ frameId: entry.frameId ?? 0, ...entry.result }));
}

async function runInFrame(frameId, func, args = []) {
  const tab = await activeTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId ?? 0] },
    func,
    args
  });
  return result?.result;
}

async function scan() {
  show('loading');
  try {
    const frames = await runInAllFrames(collectImages, [
      MARK_ATTRIBUTE,
      MAX_ELEMENTS_SCANNED,
      RESOURCE_TIMING_BUFFER
    ]);
    state.page = mergeFrames(frames);
  } catch (error) {
    elements.errorMessage.textContent = String(error?.message || error);
    show('error');
    return;
  }

  if (!state.page?.images?.length) {
    show('empty');
    return;
  }

  render();
}

function render() {
  state.report = analyzePage(state.page.images);
  const { summary } = state.report;

  elements.grade.textContent = summary.grade;
  elements.grade.dataset.grade = summary.grade;
  elements.saving.textContent = humanBytes(summary.savingBytes);
  elements.count.textContent = String(summary.count);
  elements.total.textContent = humanBytes(summary.totalBytes);
  elements.optimised.textContent = humanBytes(summary.optimisedBytes);
  elements.barFill.style.width = `${Math.round(summary.savingRatio * 100)}%`;
  elements.resizeSaving.textContent = humanBytes(summary.resizeSaving);
  elements.formatSaving.textContent = humanBytes(summary.formatSaving);

  elements.measureNote.hidden = summary.estimatedCount === 0;
  elements.estimatedCount.textContent = String(summary.estimatedCount);
  elements.truncateNote.hidden = !state.page.truncated;
  elements.bufferNote.hidden = !state.page.timingBufferFull || summary.estimatedCount === 0;

  renderFilters();
  renderImages();
  show('results');
}

function renderFilters() {
  const { summary } = state.report;
  const stats = summary.issueStats;

  // A filter that matches nothing would trap the user on an empty list.
  if (state.filter !== 'all' && !stats[state.filter]) state.filter = 'all';

  const entries = [['all', `All ${summary.count}`, 'Show every image']];
  for (const [key, stat] of Object.entries(stats).sort((a, b) => b[1].count - a[1].count)) {
    const hint = ISSUES[key]?.hint ?? '';
    const weight =
      stat.savingBytes > 0 ? `\nAvoidable weight: ${humanBytes(stat.savingBytes)}` : '';
    entries.push([key, `${ISSUES[key]?.label ?? key} ${stat.count}`, `${hint}${weight}`]);
  }

  elements.filters.replaceChildren();
  for (const [key, label, hint] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(state.filter === key));
    chip.title = hint;
    chip.addEventListener('click', () => {
      state.filter = key;
      saveSettings();
      renderFilters();
      renderImages();
    });
    elements.filters.appendChild(chip);
  }
}

function renderImages() {
  const matched = sortImages(
    filterImages(state.report.images, state.filter, state.search),
    state.sort
  );

  elements.images.replaceChildren();
  for (const image of matched.slice(0, MAX_ROWS)) {
    elements.images.appendChild(imageRow(image));
  }

  if (matched.length === 0) {
    elements.listNote.hidden = false;
    elements.listNote.textContent = 'No image matches this filter.';
  } else if (matched.length > MAX_ROWS) {
    elements.listNote.hidden = false;
    elements.listNote.textContent = `${matched.length - MAX_ROWS} more images are not listed.`;
  } else {
    elements.listNote.hidden = true;
  }
}

function imageRow(image) {
  const item = document.createElement('li');
  item.className = 'image';

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  thumb.src = image.url;
  thumb.alt = '';

  const body = document.createElement('div');
  body.className = 'body';

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'name';
  name.textContent = fileNameFromUrl(image.url);
  name.title = `${image.url}\nClick to scroll to it in the page.`;
  name.addEventListener('click', async () => {
    try {
      await runInFrame(image.frameId, highlightImage, [MARK_ATTRIBUTE, image.elementId, image.url]);
    } catch {
      // The frame went away since the scan. Nothing to scroll to.
      flash(name, 'Gone from the page');
      return;
    }
    window.close();
  });

  // Show the size to resize to, not the CSS box. That number is the action.
  const natural = `${image.naturalWidth}×${image.naturalHeight}`;
  const target = `${image.targetWidth}×${image.targetHeight}`;
  const pixels = image.issues.includes('oversized') ? `${natural} → ${target}` : natural;
  const repeat = image.occurrences > 1 ? ` · ×${image.occurrences}` : '';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent =
    `${image.format.toUpperCase()} · ${humanBytes(image.bytes)}${image.measured ? '' : ' est.'}` +
    ` · ${pixels}${repeat}`;
  meta.title =
    `Natural size ${natural}. The ${image.displayWidth}×${image.displayHeight} box needs ${target} ` +
    `at ${Math.min(image.dpr || 1, 2)}× density.`;

  const tags = document.createElement('div');
  tags.className = 'tags';
  for (const issue of image.issues) {
    const tag = document.createElement(ISSUES[issue]?.guide ? 'a' : 'span');
    tag.className = 'tag';
    tag.textContent = ISSUES[issue]?.label ?? issue;
    tag.title = ISSUES[issue]?.hint ?? '';
    if (ISSUES[issue]?.guide) {
      tag.href = ISSUES[issue].guide;
      tag.target = '_blank';
      tag.rel = 'noreferrer';
    }
    tags.appendChild(tag);
  }

  body.append(name, meta, tags);

  const right = document.createElement('div');
  right.className = 'right';

  const saving = document.createElement('div');
  saving.className = 'saving';
  saving.textContent = image.savingBytes > 0 ? `−${humanBytes(image.savingBytes)}` : '✓';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copyUrl = document.createElement('button');
  copyUrl.type = 'button';
  copyUrl.className = 'icon';
  copyUrl.textContent = 'Copy';
  copyUrl.title = 'Copy the image URL';
  copyUrl.addEventListener('click', async () => {
    await navigator.clipboard.writeText(image.url);
    flash(copyUrl, 'Copied');
  });
  actions.appendChild(copyUrl);

  if (!image.isDataUri && image.recommendedFormat !== image.format) {
    const convert = document.createElement('a');
    convert.className = 'icon';
    convert.textContent = 'Convert';
    // The converter runs in the browser, so it takes a file, not a URL. The
    // parameters ride along for the day it can fetch one itself.
    convert.title = `Open the ImageGuide converter. Send this one to ${image.recommendedFormat.toUpperCase()}.`;
    convert.href = `${CONVERTER_URL}?url=${encodeURIComponent(image.url)}&to=${image.recommendedFormat}`;
    convert.target = '_blank';
    convert.rel = 'noreferrer';
    actions.appendChild(convert);
  }

  right.append(saving, actions);
  item.append(thumb, body, right);
  return item;
}

/**
 * Show a short message on a button, then put its label back.
 * The label lives on the element, so a second click never keeps the message.
 */
function flash(button, message) {
  if (button.dataset.label === undefined) button.dataset.label = button.textContent;
  clearTimeout(Number(button.dataset.timer));
  button.textContent = message;
  button.dataset.timer = String(
    setTimeout(() => {
      button.textContent = button.dataset.label;
    }, 1200)
  );
}

/**
 * Ask the server for the real size of the images the page could not measure.
 * This needs host access, so we request it only for the origins involved.
 */
async function measureRealSizes() {
  const pending = state.report.images.filter((image) => !image.measured && !image.isDataUri);
  if (!pending.length) return;

  const origins = [...new Set(pending.map((image) => originPattern(image.url)).filter(Boolean))];
  if (!origins.length) return;

  const granted = await chrome.permissions.request({ origins });
  if (!granted) return;

  elements.measure.textContent = 'Measuring…';
  elements.measure.disabled = true;

  const byUrl = new Map(state.page.images.map((image) => [image.url, image]));
  const results = await Promise.allSettled(pending.map((image) => headSize(image.url)));

  results.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value) return;
    const record = byUrl.get(pending[index].url);
    if (!record) return;
    if (result.value.bytes > 0) record.transferBytes = result.value.bytes;
    if (result.value.contentType) record.contentType = result.value.contentType;
  });

  elements.measure.textContent = 'Measure the real sizes';
  elements.measure.disabled = false;
  render();
}

function originPattern(url) {
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `${protocol}//${host}/*`;
  } catch {
    return null;
  }
}

async function headSize(url) {
  const read = (response) => ({
    bytes: Number(response.headers.get('content-length')) || 0,
    contentType: response.headers.get('content-type') || ''
  });

  const head = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'force-cache' });
  const fromHead = read(head);
  if (fromHead.bytes > 0) return fromHead;

  // Some servers ignore HEAD. Ask for one byte and read the total from the range.
  const ranged = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'force-cache',
    headers: { Range: 'bytes=0-0' }
  });
  const contentRange = ranged.headers.get('content-range');
  const total = contentRange ? Number(contentRange.split('/')[1]) : 0;
  return {
    bytes: Number.isFinite(total) ? total : 0,
    contentType: ranged.headers.get('content-type') || ''
  };
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
}

elements.rescan.addEventListener('click', scan);

elements.measure.addEventListener('click', async () => {
  try {
    await measureRealSizes();
  } catch {
    // Chrome refused the host access, or the tab went away. Let the user retry.
    elements.measure.textContent = 'Measure the real sizes';
    elements.measure.disabled = false;
  }
});

elements.sort.addEventListener('change', () => {
  state.sort = elements.sort.value;
  saveSettings();
  renderImages();
});

elements.search.addEventListener('input', () => {
  state.search = elements.search.value;
  renderImages();
});

elements.copy.addEventListener('click', () =>
  copyText(elements.copy, buildMarkdownReport(state.page, state.report))
);

elements.copyJson.addEventListener('click', () =>
  copyText(elements.copyJson, buildJsonReport(state.page, state.report, new Date().toISOString()))
);

loadSettings().then(scan);
