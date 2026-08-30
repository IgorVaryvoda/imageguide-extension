import { analyzePage, ISSUES } from '../lib/analyze.js';
import { CONVERTER_URL, MAX_RESPONSE_CHECKS } from '../lib/constants.js';
import { humanBytes } from '../lib/format.js';
import {
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterResources,
  sortResources
} from '../lib/report.js';
import { measureResources, snapshotPermissions } from '../extension/measure.js';
import { highlightUsage, observeTab, scanTab } from '../extension/tab.js';

const query = new URLSearchParams(location.search);
const tabId = Number(query.get('tab'));

const elements = {
  loading: document.getElementById('state-loading'),
  error: document.getElementById('state-error'),
  errorMessage: document.getElementById('error-message'),
  results: document.getElementById('results'),
  pageTitle: document.getElementById('page-title'),
  pageUrl: document.getElementById('page-url'),
  grade: document.getElementById('grade'),
  deliveryDetail: document.getElementById('delivery-detail'),
  saving: document.getElementById('saving'),
  savingDetail: document.getElementById('saving-detail'),
  markupCount: document.getElementById('markup-count'),
  usageDetail: document.getElementById('usage-detail'),
  confidence: document.getElementById('confidence'),
  confidenceDetail: document.getElementById('confidence-detail'),
  lcpValue: document.getElementById('lcp-value'),
  lcpDetail: document.getElementById('lcp-detail'),
  clsValue: document.getElementById('cls-value'),
  clsDetail: document.getElementById('cls-detail'),
  scanValue: document.getElementById('scan-value'),
  scanDetail: document.getElementById('scan-detail'),
  warnings: document.getElementById('warnings'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  sort: document.getElementById('sort'),
  resources: document.getElementById('resources'),
  resultCount: document.getElementById('result-count'),
  emptyFilter: document.getElementById('empty-filter'),
  measure: document.getElementById('measure'),
  copyJson: document.getElementById('copy-json'),
  copyReport: document.getElementById('copy-report'),
  rescan: document.getElementById('rescan'),
  showPage: document.getElementById('show-page'),
  toggleWatch: document.getElementById('toggle-watch'),
  watchStatus: document.getElementById('watch-status')
};

const state = {
  page: null,
  report: null,
  markAttribute: '',
  watchKey: query.get('watch') || '',
  revision: '',
  search: '',
  filter: 'all',
  sort: 'saving',
  paused: false,
  polling: false,
  scanning: false,
  scanGeneration: 0,
  permissionSnapshot: null
};

const make = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const label = (issue) => ISSUES[issue]?.label || issue;

function show(section) {
  elements.loading.hidden = section !== 'loading';
  elements.error.hidden = section !== 'error';
  elements.results.hidden = section !== 'results';
}

function flash(button, message) {
  const labelText = button.dataset.label || button.textContent;
  button.dataset.label = labelText;
  button.textContent = message;
  clearTimeout(Number(button.dataset.timer));
  button.dataset.timer = String(setTimeout(() => {
    button.textContent = labelText;
  }, 1200));
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
}

function keepCheckedMeasurements(nextPage, previousPage) {
  if (!previousPage || previousPage.documentToken !== nextPage.documentToken) return;
  const prior = new Map(
    previousPage.resources
      .filter((resource) => ['content-length', 'content-range'].includes(resource.measurementSource))
      .map((resource) => [resource.url, resource])
  );
  for (const resource of nextPage.resources) {
    const measured = prior.get(resource.url);
    if (!measured || resource.transferBytes > 0) continue;
    resource.transferBytes = measured.transferBytes;
    resource.contentType = measured.contentType;
    resource.measurementSource = measured.measurementSource;
    resource.measurementConfidence = measured.measurementConfidence;
  }
}

async function scan(silent = false) {
  const generation = ++state.scanGeneration;
  state.scanning = true;
  elements.rescan.disabled = true;
  if (!silent || !state.page) show('loading');
  try {
    const result = await scanTab(tabId, {
      watchKey: state.watchKey,
      previousMarkAttribute: state.markAttribute,
      persistentWatch: true
    });
    if (generation !== state.scanGeneration) return;
    keepCheckedMeasurements(result.page, state.page);
    state.page = result.page;
    state.markAttribute = result.markAttribute;
    state.watchKey = result.watchKey;
    state.revision = result.revision;
    state.report = analyzePage(state.page.resources, state.page.usages, state.page);
    render();
    show('results');
    preparePermissionSnapshot();
  } catch (error) {
    if (generation !== state.scanGeneration) return;
    elements.errorMessage.textContent =
      `${String(error?.message || error)} Open the popup on the target page to grant access again.`;
    show('error');
  } finally {
    if (generation === state.scanGeneration) {
      state.scanning = false;
      elements.rescan.disabled = false;
    }
  }
}

function render() {
  const { summary } = state.report;
  elements.pageTitle.textContent = state.page.pageTitle || 'Untitled page';
  elements.pageUrl.textContent = state.page.pageUrl;
  document.title = `${state.page.pageTitle || 'Page'} — ImageGuide audit`;

  elements.grade.textContent = summary.grade;
  elements.deliveryDetail.textContent = summary.measuredResourceCount
    ? `${humanBytes(summary.measuredBytes)} observed · ${humanBytes(summary.measuredSavingBytes)} estimated opportunity`
    : 'No measured resource sizes';
  elements.saving.textContent = humanBytes(summary.savingBytes);
  elements.savingDetail.textContent =
    `Resize ${humanBytes(summary.resizeSaving)} · Format ${humanBytes(summary.formatSaving)}`;
  elements.markupCount.textContent = String(summary.markupIssueCount);
  elements.usageDetail.textContent =
    `${summary.resourceCount} resources · ${summary.usageCount} usages`;
  elements.confidence.textContent = `${Math.round(summary.measuredByteRatio * 100)}%`;
  elements.confidenceDetail.textContent =
    `${summary.measuredResourceCount} of ${summary.resourceCount} resource sizes`;

  const lcp = summary.vitals?.lcp;
  elements.lcpValue.textContent = lcp?.time > 0
    ? `${(lcp.time / 1000).toFixed(2)} s`
    : lcp?.supported
      ? 'No candidate'
      : 'Unsupported';
  elements.lcpDetail.textContent = lcp?.time > 0
    ? `${lcp.tagName || 'element'}${lcp.url ? ` · ${fileNameFromUrl(lcp.url)}` : ''}`
    : 'Buffered browser evidence';

  const cls = summary.vitals?.cls;
  elements.clsValue.textContent = cls?.supported
    ? Number(cls.score || 0).toFixed(3)
    : 'Unsupported';
  elements.clsDetail.textContent = cls?.supported
    ? `${cls.shiftCount || 0} shifts · ${cls.attributedShiftCount || 0} attributed to recorded media`
    : 'Layout Instability API unavailable';
  elements.scanValue.textContent = `${Math.round(state.page.scanDurationMs || 0)} ms`;
  elements.scanDetail.textContent =
    `${state.page.scannedElements || 0} elements · ${state.page.frameCount} frames`;

  renderWarnings();
  renderFilter();
  renderResources();
  elements.watchStatus.textContent = state.paused
    ? 'Page watch paused'
    : `Watching page changes · ${state.page.dynamicMutationCount || 0} observed`;
  elements.watchStatus.style.color = state.paused ? 'var(--amber)' : 'var(--green)';
}

function renderWarnings() {
  const warnings = [];
  if (state.page.truncated) warnings.push('The element limit was reached; totals are a lower bound.');
  if (state.page.styleScanTruncated) {
    warnings.push('The CSS and pseudo-element scan hit its time budget; semantic images remain covered.');
  }
  if (state.page.recordsTruncated) {
    warnings.push(
      `${state.page.skippedResources} resources and ${state.page.skippedUsages} usages exceeded payload limits.`
    );
  }
  if (state.page.timingBufferFull) {
    warnings.push('The Resource Timing buffer may be full; some response sizes can remain modelled.');
  }
  if (state.page.unsupported?.canvas) {
    warnings.push(
      `${state.page.unsupported.canvas} canvas elements were counted but cannot be mapped back to source requests.`
    );
  }
  if (state.page.unsupported?.imageSetSelection) {
    warnings.push(
      `${state.page.unsupported.imageSetSelection} typed image-set selections had no browser timing match and remain unknown.`
    );
  }
  elements.warnings.replaceChildren();
  for (const warning of warnings) elements.warnings.append(make('p', 'warning', warning));
  elements.warnings.hidden = warnings.length === 0;
}

function renderFilter() {
  const current = state.filter;
  elements.filter.replaceChildren();
  elements.filter.append(new Option(`All resources (${state.report.summary.resourceCount})`, 'all'));
  for (const [issue, stat] of Object.entries(state.report.summary.issueStats)
    .sort((a, b) => b[1].count - a[1].count)) {
    elements.filter.append(new Option(`${label(issue)} (${stat.count})`, issue));
  }
  state.filter = [...elements.filter.options].some((option) => option.value === current)
    ? current
    : 'all';
  elements.filter.value = state.filter;
}

function issueBadges(issues, extra = []) {
  const badges = make('div', 'badges');
  for (const text of extra) badges.append(make('span', 'badge evidence', text));
  for (const issue of issues) {
    const badge = make(ISSUES[issue]?.guide ? 'a' : 'span', 'badge', label(issue));
    badge.title = ISSUES[issue]?.hint || '';
    if (badge.tagName === 'A') {
      badge.href = ISSUES[issue].guide;
      badge.target = '_blank';
      badge.rel = 'noreferrer';
    }
    badges.append(badge);
  }
  return badges;
}

function fact(labelText, value, note = '') {
  const node = make('div', 'fact');
  node.append(make('span', 'fact-label', labelText), make('strong', '', value));
  if (note) node.append(make('small', '', note));
  return node;
}

async function jump(button, usage, resource) {
  if (!usage) return;
  try {
    const highlighted = await highlightUsage(tabId, state.markAttribute, usage, resource.url);
    if (!highlighted) {
      flash(button, 'Element changed');
      return;
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    flash(button, 'Element changed');
  }
}

function resourceCard(resource) {
  const article = make('article', 'resource');
  article.dataset.resourceId = resource.id;
  const summary = make('div', 'resource-summary');
  summary.append(make('span', 'format-tile', resource.format.slice(0, 4).toUpperCase()));

  const name = make('div', 'resource-name');
  const primary = resource.usages.find((usage) => usage.id === resource.primaryUsageId) || resource.usages[0];
  const target = make('button', 'resource-target', fileNameFromUrl(resource.url));
  target.type = 'button';
  target.title = resource.url;
  target.addEventListener('click', () => jump(target, primary, resource));
  name.append(target, make('span', 'resource-url', resource.url));
  const evidence = [];
  if (resource.usages.some((usage) => usage.isLcp)) evidence.push('Browser LCP');
  if (resource.usages.some((usage) => usage.layoutShiftCount)) evidence.push('Shift attribution');
  name.append(issueBadges(resource.issues, evidence));

  const actions = make('div', 'badges');
  const copy = make('button', 'badge', 'Copy URL');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(copy, resource.url));
  actions.append(copy);
  if (!resource.isDataUri && resource.recommendedFormat !== resource.format) {
    const convert = make('a', 'badge', `Convert to ${resource.recommendedFormat.toUpperCase()}`);
    convert.href = CONVERTER_URL;
    convert.target = '_blank';
    convert.rel = 'noreferrer';
    actions.append(convert);
  }
  name.append(actions);

  const sourcePixels = resource.sourcePixelWidth
    ? `${resource.sourcePixelWidth}×${resource.sourcePixelHeight}`
    : 'Unknown';
  const opportunity = resource.savingBytes ? `≈−${humanBytes(resource.savingBytes)}` : 'None found';
  summary.append(
    name,
    fact(
      'Response',
      humanBytes(resource.bytes),
      `${resource.measurement.source} · ${resource.measurement.confidence}`
    ),
    fact('Source pixels', sourcePixels, resource.sourceDimensionConfidence),
    fact('Opportunity', opportunity, resource.recommendedFormat.toUpperCase()),
    fact('Usages', String(resource.usages.length), `${resource.allIssues.length} finding types`)
  );
  article.append(summary);

  const details = make('details', 'usage-details');
  const detailsSummary = make(
    'summary',
    '',
    `${resource.usages.length} ${resource.usages.length === 1 ? 'usage' : 'usages'} · element-level evidence`
  );
  const list = make('ul', 'usage-list');
  for (const usage of resource.usages) {
    const row = make('li', 'usage-row');
    row.dataset.kind = usage.kind;
    const usageTarget = make('button', 'usage-target', `${usage.kind} · frame ${usage.frameId} #${usage.elementId}`);
    usageTarget.type = 'button';
    usageTarget.addEventListener('click', () => jump(usageTarget, usage, resource));
    const evidenceText = [
      usage.isLcp ? 'LCP' : '',
      usage.layoutShiftCount ? `${usage.layoutShiftCount} shifts` : '',
      usage.selectedCandidateDescriptor || ''
    ].filter(Boolean);
    row.append(
      usageTarget,
      make('span', 'usage-kind', `${usage.displayWidth}×${usage.displayHeight} CSS px`),
      make('span', 'usage-kind', `${usage.targetWidth}×${usage.targetHeight} required`),
      make('span', 'usage-kind', `Alt: ${usage.altState}`),
      issueBadges(usage.issues, evidenceText)
    );
    list.append(row);
  }
  details.append(detailsSummary, list);
  article.append(details);
  return article;
}

function renderResources() {
  const matched = sortResources(
    filterResources(state.report.resources, state.filter, state.search),
    state.sort
  );
  elements.resources.replaceChildren(...matched.map(resourceCard));
  elements.resultCount.textContent = `${matched.length} of ${state.report.summary.resourceCount} resources`;
  elements.emptyFilter.hidden = matched.length > 0;
}

function pendingResponseChecks() {
  return state.report.resources
    .filter((resource) => !resource.measured && !resource.isDataUri)
    .slice(0, MAX_RESPONSE_CHECKS);
}

async function preparePermissionSnapshot() {
  const pending = pendingResponseChecks();
  state.permissionSnapshot = null;
  elements.measure.disabled = true;
  elements.measure.textContent = pending.length
    ? `Check ${pending.length} response sizes`
    : 'All response sizes checked';
  if (!pending.length) return;
  try {
    state.permissionSnapshot = await snapshotPermissions(pending);
    elements.measure.disabled = false;
  } catch {
    elements.measure.textContent = 'Permission state unavailable';
  }
}

async function checkResponseSizes() {
  const pending = pendingResponseChecks();
  if (!pending.length || !state.permissionSnapshot) return;
  elements.measure.disabled = true;
  elements.measure.textContent = 'Checking permission…';
  try {
    const results = await measureResources(
      pending,
      state.permissionSnapshot,
      (done, total) => {
        elements.measure.textContent = `Checking ${done}/${total}…`;
      }
    );
    const byUrl = new Map(state.page.resources.map((resource) => [resource.url, resource]));
    results.forEach((result, index) => {
      if (!result) return;
      const resource = byUrl.get(pending[index].url);
      if (!resource) return;
      resource.transferBytes = result.bytes;
      resource.contentType = result.contentType;
      resource.measurementSource = result.source;
      resource.measurementConfidence = result.confidence;
    });
    state.report = analyzePage(state.page.resources, state.page.usages, state.page);
    render();
  } finally {
    preparePermissionSnapshot();
  }
}

async function poll() {
  if (state.paused || state.scanning || state.polling || !state.watchKey) return;
  state.polling = true;
  try {
    const observation = await observeTab(tabId, state.watchKey);
    if (observation.revision && observation.revision !== state.revision) {
      elements.watchStatus.textContent = 'Page changed · refreshing evidence';
      await scan(true);
    }
  } catch {
    state.paused = true;
    elements.watchStatus.textContent = 'Page watch lost access';
    elements.toggleWatch.textContent = 'Retry watch';
  } finally {
    state.polling = false;
  }
}

elements.search.addEventListener('input', () => {
  state.search = elements.search.value;
  renderResources();
});
elements.filter.addEventListener('change', () => {
  state.filter = elements.filter.value;
  renderResources();
});
elements.sort.addEventListener('change', () => {
  state.sort = elements.sort.value;
  renderResources();
});
elements.rescan.addEventListener('click', () => scan());
elements.showPage.addEventListener('click', () => chrome.tabs.update(tabId, { active: true }));
elements.toggleWatch.addEventListener('click', async () => {
  state.paused = !state.paused;
  elements.toggleWatch.textContent = state.paused ? 'Resume watch' : 'Pause watch';
  elements.watchStatus.textContent = state.paused ? 'Page watch paused' : 'Watching page changes';
  if (state.paused) await observeTab(tabId, state.watchKey, 'stop').catch(() => {});
  else poll();
});
elements.measure.addEventListener('click', checkResponseSizes);
elements.copyJson.addEventListener('click', () =>
  copyText(elements.copyJson, buildJsonReport(state.page, state.report, new Date().toISOString()))
);
elements.copyReport.addEventListener('click', () =>
  copyText(elements.copyReport, buildMarkdownReport(state.page, state.report))
);

if (!Number.isInteger(tabId) || tabId <= 0) {
  elements.errorMessage.textContent = 'This audit has no target tab. Open it from the extension popup.';
  show('error');
} else {
  scan();
  setInterval(poll, 1200);
  addEventListener('pagehide', () => {
    observeTab(tabId, state.watchKey, 'stop').catch(() => {});
  }, { once: true });
}
