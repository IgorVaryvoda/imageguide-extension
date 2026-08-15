import { analyzePage, ISSUES } from '../lib/analyze.js';
import { formatFromContentType, humanBytes } from '../lib/format.js';
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
  measureNote: document.getElementById('measure-note'),
  estimatedCount: document.getElementById('estimated-count'),
  measure: document.getElementById('measure'),
  filters: document.getElementById('filters'),
  images: document.getElementById('images'),
  rescan: document.getElementById('rescan'),
  copy: document.getElementById('copy')
};

/** @type {{page: object, report: object, filter: string}} */
const state = { page: null, report: null, filter: 'all' };

function show(section) {
  for (const key of ['loading', 'error', 'empty', 'results']) {
    elements[key].hidden = key !== section;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInPage(func, args = []) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error('No active tab.');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    func,
    args
  });
  return result?.result;
}

async function scan() {
  show('loading');
  try {
    state.page = await runInPage(collectImages);
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

  elements.measureNote.hidden = summary.estimatedCount === 0;
  elements.estimatedCount.textContent = String(summary.estimatedCount);

  renderFilters(summary.issueCounts);
  renderImages();
  show('results');
}

function renderFilters(issueCounts) {
  elements.filters.replaceChildren();

  const entries = [['all', `All ${state.report.summary.count}`]];
  for (const [key, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
    entries.push([key, `${ISSUES[key]?.label ?? key} ${count}`]);
  }

  for (const [key, label] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(state.filter === key));
    chip.title = ISSUES[key]?.hint ?? 'Show every image';
    chip.addEventListener('click', () => {
      state.filter = key;
      renderFilters(issueCounts);
      renderImages();
    });
    elements.filters.appendChild(chip);
  }
}

function renderImages() {
  const list =
    state.filter === 'all'
      ? state.report.images
      : state.report.images.filter((image) => image.issues.includes(state.filter));

  elements.images.replaceChildren();

  for (const image of list.slice(0, 150)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image';
    button.title = image.url;

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.loading = 'lazy';
    thumb.src = image.url;
    thumb.alt = '';

    const body = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = fileName(image.url);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const size = `${image.naturalWidth}×${image.naturalHeight}`;
    const box = `${image.displayWidth}×${image.displayHeight}`;
    meta.textContent = `${image.format.toUpperCase()} · ${humanBytes(image.bytes)}${
      image.measured ? '' : ' (est.)'
    } · ${size} in a ${box} box`;

    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const issue of image.issues) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = ISSUES[issue]?.label ?? issue;
      tag.title = ISSUES[issue]?.hint ?? '';
      tags.appendChild(tag);
    }

    body.append(name, meta, tags);

    const saving = document.createElement('div');
    saving.className = 'saving';
    saving.textContent = image.savingBytes > 0 ? `−${humanBytes(image.savingBytes)}` : '✓';

    button.append(thumb, body, saving);
    button.addEventListener('click', async () => {
      await runInPage(highlightImage, [image.url]);
      window.close();
    });

    item.appendChild(button);
    elements.images.appendChild(item);
  }
}

function fileName(url) {
  if (url.startsWith('data:')) return 'inline data URI';
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

/**
 * Ask the server for the real size of the images the page could not measure.
 * This needs host access, so we request it only for the origins involved.
 */
async function measureRealSizes() {
  const pending = state.report.images.filter((image) => !image.measured && !image.isDataUri);
  if (!pending.length) return;

  const origins = [...new Set(pending.map((image) => originPattern(image.url)).filter(Boolean))];
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
    if (result.value.format !== 'unknown') record.format = result.value.format;
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
    format: formatFromContentType(response.headers.get('content-type'))
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
    format: formatFromContentType(ranged.headers.get('content-type'))
  };
}

function buildReport() {
  const { summary, images } = state.report;
  const lines = [
    `# Image audit — ${state.page.pageTitle}`,
    '',
    state.page.pageUrl,
    '',
    `Grade **${summary.grade}**. ${summary.count} images weigh ${humanBytes(summary.totalBytes)}.`,
    `An optimised page weighs about ${humanBytes(summary.optimisedBytes)}, a saving of ${humanBytes(
      summary.savingBytes
    )} (${Math.round(summary.savingRatio * 100)}%).`,
    '',
    '| Image | Format | Size | Natural | Box | Saving | Issues |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const image of images.slice(0, 50)) {
    lines.push(
      `| ${fileName(image.url)} | ${image.format} | ${humanBytes(image.bytes)}${
        image.measured ? '' : ' est.'
      } | ${image.naturalWidth}×${image.naturalHeight} | ${image.displayWidth}×${
        image.displayHeight
      } | ${humanBytes(image.savingBytes)} | ${image.issues
        .map((issue) => ISSUES[issue]?.label ?? issue)
        .join(', ')} |`
    );
  }

  lines.push('', 'Report by the ImageGuide Auditor — https://www.imageguide.dev');
  return lines.join('\n');
}

elements.rescan.addEventListener('click', scan);
elements.measure.addEventListener('click', measureRealSizes);
elements.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildReport());
  elements.copy.textContent = 'Copied';
  setTimeout(() => {
    elements.copy.textContent = 'Copy report';
  }, 1500);
});

scan();
