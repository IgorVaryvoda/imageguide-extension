import { analyzePage, ISSUES } from '../lib/analyze.js';
import {
  CONVERTER_URL,
  MAX_RESPONSE_CHECKS,
  MAX_ROWS,
} from '../lib/constants.js';
import { humanBytes } from '../lib/format.js';
import {
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterResources,
  sortResources
} from '../lib/report.js';
import {
  activeTab,
  highlightUsage as highlightTabUsage,
  scanTab
} from '../extension/tab.js';
import {
  measureResources,
  originPattern,
  snapshotPermissions
} from '../extension/measure.js';

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
  confidence: document.getElementById('confidence'),
  vitals: document.getElementById('vitals'),
  measureNote: document.getElementById('measure-note'),
  estimatedCount: document.getElementById('estimated-count'),
  measure: document.getElementById('measure'),
  truncateNote: document.getElementById('truncate-note'),
  bufferNote: document.getElementById('buffer-note'),
  coverageNote: document.getElementById('coverage-note'),
  usageCount: document.getElementById('usage-count'),
  filters: document.getElementById('filters'),
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  images: document.getElementById('images'),
  listNote: document.getElementById('list-note'),
  rescan: document.getElementById('rescan'),
  copy: document.getElementById('copy'),
  copyJson: document.getElementById('copy-json'),
  openAudit: document.getElementById('open-audit')
};

/** @type {{tabId: number|null, page: object|null, report: object|null, filter: string, sort: string, search: string, markAttribute: string, watchKey: string, pregrantedOrigins: Map<string, boolean>|null}} */
const state = {
  tabId: null,
  page: null,
  report: null,
  filter: 'all',
  sort: 'saving',
  search: '',
  markAttribute: '',
  watchKey: '',
  pregrantedOrigins: null
};

let scanGeneration = 0;
let permissionSnapshotGeneration = 0;

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

async function scan() {
  const generation = ++scanGeneration;
  elements.rescan.disabled = true;
  show('loading');
  try {
    const tab = await activeTab();
    const sameTab = state.tabId === tab.id;
    const result = await scanTab(tab.id, {
      watchKey: sameTab ? state.watchKey : '',
      previousMarkAttribute: sameTab ? state.markAttribute : ''
    });
    if (generation !== scanGeneration) return;
    state.tabId = tab.id;
    state.page = result.page;
    state.markAttribute = result.markAttribute;
    state.watchKey = result.watchKey;
  } catch (error) {
    if (generation !== scanGeneration) return;
    elements.errorMessage.textContent = String(error?.message || error);
    show('error');
    return;
  } finally {
    if (generation === scanGeneration) elements.rescan.disabled = false;
  }

  if (!state.page?.resources?.length) {
    show('empty');
    return;
  }

  render();
}

function render() {
  state.report = analyzePage(state.page.resources, state.page.usages, state.page);
  const { summary } = state.report;

  elements.grade.textContent = summary.grade;
  elements.grade.dataset.grade = summary.grade;
  elements.grade.title =
    summary.grade === '?'
      ? 'Delivery grade unavailable until at least one resource size is measured.'
      : `Delivery grade based on ${summary.measuredResourceCount} measured resources.`;
  elements.saving.textContent = humanBytes(summary.savingBytes);
  elements.count.textContent = String(summary.resourceCount);
  elements.usageCount.textContent = String(summary.usageCount);
  elements.total.textContent = humanBytes(summary.totalBytes);
  elements.optimised.textContent = humanBytes(summary.optimisedBytes);
  elements.barFill.style.width = `${Math.round(summary.savingRatio * 100)}%`;
  elements.resizeSaving.textContent = humanBytes(summary.resizeSaving);
  elements.formatSaving.textContent = humanBytes(summary.formatSaving);
  elements.confidence.textContent =
    `${Math.round(summary.measuredByteRatio * 100)}% of modelled weight measured` +
    ` · ${summary.markupIssueCount} markup findings`;
  const lcp = summary.vitals?.lcp;
  const cls = summary.vitals?.cls;
  elements.vitals.textContent =
    `LCP ${lcp?.time > 0 ? `${(lcp.time / 1000).toFixed(2)} s` : lcp?.supported ? 'not captured' : 'unsupported'}` +
    ` · CLS ${cls?.supported ? Number(cls.score || 0).toFixed(3) : 'unsupported'}`;

  elements.measureNote.hidden = summary.estimatedResourceCount === 0;
  elements.estimatedCount.textContent = String(summary.estimatedResourceCount);
  const limitWarnings = [];
  if (state.page.truncated) limitWarnings.push('The element scan stopped early.');
  if (state.page.styleScanTruncated) limitWarnings.push('The CSS and pseudo-element scan hit its time budget.');
  if (state.page.recordsTruncated) {
    limitWarnings.push(
      `${state.page.skippedResources} resources and ${state.page.skippedUsages} usages ` +
        'exceeded the record or payload limits.'
    );
  }
  elements.truncateNote.hidden = limitWarnings.length === 0;
  elements.truncateNote.textContent = `${limitWarnings.join(' ')} Totals are a lower bound.`;
  elements.bufferNote.hidden =
    !state.page.timingBufferFull || summary.estimatedResourceCount === 0;
  const coverage = [];
  if (state.page.unsupported?.canvas) {
    coverage.push(`${state.page.unsupported.canvas} canvas elements cannot be mapped back to source images.`);
  }
  if (state.page.unsupported?.imageSetSelection) {
    coverage.push(
      `${state.page.unsupported.imageSetSelection} typed image-set selections could not be established.`
    );
  }
  elements.coverageNote.hidden = coverage.length === 0;
  elements.coverageNote.textContent = coverage.join(' ');

  renderFilters();
  renderResources();
  show('results');
  preparePermissionSnapshot();
}

async function preparePermissionSnapshot() {
  const generation = ++permissionSnapshotGeneration;
  const pending = pendingResponseChecks();
  const origins = [...new Set(pending.map((image) => originPattern(image.url)).filter(Boolean))];
  state.pregrantedOrigins = null;
  elements.measure.disabled = origins.length > 0;
  if (!origins.length) return;

  try {
    if (generation !== permissionSnapshotGeneration) return;
    state.pregrantedOrigins = await snapshotPermissions(pending);
    if (generation !== permissionSnapshotGeneration) return;
    elements.measure.disabled = false;
  } catch {
    // Without a trustworthy snapshot we cannot safely revoke only new grants.
    if (generation === permissionSnapshotGeneration) elements.measure.disabled = true;
  }
}

function pendingResponseChecks() {
  // ponytail: one bounded batch keeps huge pages finite; add cancellation if 100 is too slow.
  return state.report.resources
    .filter((resource) => !resource.measured && !resource.isDataUri)
    .slice(0, MAX_RESPONSE_CHECKS);
}

function renderFilters() {
  const { summary } = state.report;
  const stats = summary.issueStats;

  // A filter that matches nothing would trap the user on an empty list.
  if (state.filter !== 'all' && !stats[state.filter]) state.filter = 'all';

  const entries = [['all', `All ${summary.resourceCount}`, 'Show every resource']];
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
      renderResources();
    });
    elements.filters.appendChild(chip);
  }
}

function renderResources() {
  const matched = sortResources(
    filterResources(state.report.resources, state.filter, state.search),
    state.sort
  );

  elements.images.replaceChildren();
  for (const resource of matched.slice(0, MAX_ROWS)) {
    elements.images.appendChild(resourceRow(resource));
  }

  if (matched.length === 0) {
    elements.listNote.hidden = false;
    elements.listNote.textContent = 'No resource matches this filter.';
  } else if (matched.length > MAX_ROWS) {
    elements.listNote.hidden = false;
    elements.listNote.textContent = `${matched.length - MAX_ROWS} more resources are not listed.`;
  } else {
    elements.listNote.hidden = true;
  }
}

async function highlightUsage(button, usage, url) {
  if (!usage) return;
  try {
    const highlighted = await highlightTabUsage(
      state.tabId,
      state.markAttribute,
      usage,
      url
    );
    if (!highlighted) {
      flash(button, 'Gone from the page');
      return;
    }
  } catch {
    flash(button, 'Gone from the page');
    return;
  }
  window.close();
}

function appendIssueTags(container, issues) {
  for (const issue of issues) {
    const tag = document.createElement(ISSUES[issue]?.guide ? 'a' : 'span');
    tag.className = 'tag';
    tag.textContent = ISSUES[issue]?.label ?? issue;
    tag.title = ISSUES[issue]?.hint ?? '';
    if (ISSUES[issue]?.guide) {
      tag.href = ISSUES[issue].guide;
      tag.target = '_blank';
      tag.rel = 'noreferrer';
    }
    container.appendChild(tag);
  }
}

function resourceRow(resource) {
  const item = document.createElement('li');
  item.className = 'image';

  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  thumb.textContent = resource.format.slice(0, 4).toUpperCase();
  thumb.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'body';

  const primary =
    resource.usages.find((usage) => usage.id === resource.primaryUsageId) || resource.usages[0];

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'name';
  name.textContent = fileNameFromUrl(resource.url);
  name.title = `${resource.url}\nClick to scroll to the most demanding usage.`;
  name.addEventListener('click', () => highlightUsage(name, primary, resource.url));

  // Keep the source aspect ratio when showing the modelled resize action.
  const natural = resource.sourcePixelWidth
    ? `${resource.sourcePixelWidth}×${resource.sourcePixelHeight}`
    : 'source pixels unknown';
  const resize = `${resource.resizeWidth}×${resource.resizeHeight}`;
  const pixels = resource.issues.includes('oversized') ? `${natural} → ${resize}` : natural;
  const useCount = `${resource.usages.length} ${resource.usages.length === 1 ? 'usage' : 'usages'}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent =
    `${resource.format.toUpperCase()} · ${humanBytes(resource.bytes)}` +
    `${resource.measured ? '' : ' model'} · ${pixels} · ${useCount}`;
  meta.title =
    `Source size ${natural} (${resource.sourceDimensionConfidence}). ` +
    `Most demanding recorded usage needs ${resource.targetWidth}×${resource.targetHeight}. ` +
    `Size source: ${resource.measurement.source} (${resource.measurement.confidence}).`;

  const tags = document.createElement('div');
  tags.className = 'tags';
  appendIssueTags(tags, resource.issues);
  if (resource.usages.length === 1) appendIssueTags(tags, resource.usages[0].issues);

  body.append(name, meta, tags);

  if (resource.usages.length > 1) {
    const details = document.createElement('details');
    details.className = 'usage-group';
    const summary = document.createElement('summary');
    const findingCount = resource.usages.reduce(
      (count, usage) => count + usage.issues.length,
      0
    );
    summary.textContent =
      `Show ${resource.usages.length} usages` +
      (findingCount ? ` · ${findingCount} markup findings` : '');
    details.appendChild(summary);

    for (const usage of resource.usages) {
      const usageRow = document.createElement('div');
      usageRow.className = 'usage';
      const target = document.createElement('button');
      target.type = 'button';
      target.className = 'usage-target';
      target.textContent =
        `${usage.kind.toUpperCase()} · ${usage.displayWidth}×${usage.displayHeight}` +
        (usage.selectedCandidateDescriptor ? ` · ${usage.selectedCandidateDescriptor}` : '');
      target.title =
        `Frame ${usage.frameId}, element ${usage.elementId}. ` +
        `Required pixels ${usage.targetWidth}×${usage.targetHeight}. Alt: ${usage.altState}.`;
      target.addEventListener('click', () => highlightUsage(target, usage, resource.url));
      const usageTags = document.createElement('span');
      usageTags.className = 'tags usage-tags';
      appendIssueTags(usageTags, usage.issues);
      usageRow.append(target, usageTags);
      details.appendChild(usageRow);
    }
    body.appendChild(details);
  }

  const right = document.createElement('div');
  right.className = 'right';

  const saving = document.createElement('div');
  saving.className = 'saving';
  saving.textContent =
    resource.savingBytes > 0 ? `≈−${humanBytes(resource.savingBytes)}` : '✓';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copyUrl = document.createElement('button');
  copyUrl.type = 'button';
  copyUrl.className = 'icon';
  copyUrl.textContent = 'Copy';
  copyUrl.title = 'Copy the image URL';
  copyUrl.addEventListener('click', () => copyText(copyUrl, resource.url));
  actions.appendChild(copyUrl);

  if (!resource.isDataUri && resource.recommendedFormat !== resource.format) {
    const convert = document.createElement('a');
    convert.className = 'icon';
    convert.textContent = 'Convert';
    convert.title =
      `Open the ImageGuide converter for ${resource.recommendedFormat.toUpperCase()}. ` +
      'The audited URL is not sent.';
    convert.href = CONVERTER_URL;
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
 * Ask the server for a validated response size for images the page could not measure.
 * This needs host access, so we request it only for the origins involved.
 */
async function checkResponseSizes() {
  const pending = pendingResponseChecks();
  if (!pending.length) return;

  const origins = [...new Set(pending.map((image) => originPattern(image.url)).filter(Boolean))];
  if (!origins.length || !state.pregrantedOrigins) return;

  elements.measure.disabled = true;
  elements.rescan.disabled = true;
  elements.measure.textContent = 'Checking permission…';

  let changed = false;

  try {
    const byUrl = new Map(state.page.resources.map((resource) => [resource.url, resource]));
    const results = await measureResources(
      pending,
      state.pregrantedOrigins,
      (done, total) => {
        elements.measure.textContent = `Checking ${done}/${total}…`;
      }
    );

    results.forEach((result, index) => {
      if (!result) return;
      const record = byUrl.get(pending[index].url);
      if (!record) return;
      record.transferBytes = result.bytes;
      record.contentType = result.contentType;
      record.measurementSource = result.source;
      record.measurementConfidence = result.confidence;
    });
    changed = true;
  } finally {
    elements.measure.textContent = 'Check response sizes';
    elements.measure.disabled = false;
    elements.rescan.disabled = false;
  }
  if (changed) render();
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
    await checkResponseSizes();
  } catch {
    // Chrome refused the host access, or the tab went away. Let the user retry.
    elements.measure.textContent = 'Check response sizes';
    elements.measure.disabled = false;
    elements.rescan.disabled = false;
  }
});

elements.sort.addEventListener('change', () => {
  state.sort = elements.sort.value;
  saveSettings();
  renderResources();
});

elements.search.addEventListener('input', () => {
  state.search = elements.search.value;
  renderResources();
});

elements.copy.addEventListener('click', () =>
  copyText(elements.copy, buildMarkdownReport(state.page, state.report))
);

elements.copyJson.addEventListener('click', () =>
  copyText(elements.copyJson, buildJsonReport(state.page, state.report, new Date().toISOString()))
);

elements.openAudit.addEventListener('click', async () => {
  if (!state.tabId || !state.watchKey) return;
  const query = new URLSearchParams({
    tab: String(state.tabId),
    watch: state.watchKey
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`audit/audit.html?${query}`) });
  window.close();
});

loadSettings().then(scan);
