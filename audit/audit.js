import { analyzePage, buildLimitationSummary, CHECKED_RESPONSE_NOTE, ISSUES } from '../lib/analyze.js';
import { CONVERTER_URL } from '../lib/constants.js';
import { humanBytes } from '../lib/format.js';
import { validateHandoff } from '../lib/handoff.js';
import {
  applyMeasurementToResource,
  ATTEMPT_STATUS,
  createMeasurementJob,
  isEligibleMeasurementUrl,
  selectMeasurementCandidates,
  setAttemptStatus,
} from '../lib/measure.js';
import {
  assertSupportedSchema,
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterResources,
  REPORT_SCHEMA_VERSION,
  sortResources
} from '../lib/report.js';
import { takeHandoff } from '../extension/handoff.js';
import {
  getPendingCleanup,
  isLeaseStale,
  preparePermissionLease,
  runAuthorizedMeasurement,
  staleLeaseReason,
} from '../extension/measure.js';
import {
  createRenderMetrics,
  highlightUsage,
  observeTab,
  scanTab,
  stableResourceKey,
  stableUsageKey,
} from '../extension/tab.js';

const query = new URLSearchParams(location.search);
const tabId = Number(query.get('tab'));
const handoffToken = query.get('handoff') || '';
if (handoffToken) query.delete('handoff');

const RENDER_BATCH = 100;

const renderMetrics = createRenderMetrics();

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
  handoffNote: document.getElementById('handoff-note'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  sort: document.getElementById('sort'),
  resources: document.getElementById('resources'),
  resultCount: document.getElementById('result-count'),
  emptyFilter: document.getElementById('empty-filter'),
  showMore: document.getElementById('show-more'),
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
  documentToken: '',
  search: '',
  filter: 'all',
  sort: 'saving',
  paused: false,
  polling: false,
  scanning: false,
  scanGeneration: 0,
  renderCap: RENDER_BATCH,
  focusKey: '',
  job: null,
  lease: null,
  measuring: false,
  measureController: null,
  measureMessage: '',
  attemptedKeys: new Set(),
  handoffApplied: false,
  handoffNotice: ''
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
      .filter((resource) => Number(resource.transferBytes) > 0 && resource.measurementSource)
      .map((resource) => [resource.url, resource])
  );
  for (const resource of nextPage.resources) {
    const measured = prior.get(resource.url);
    if (!measured) continue;
    // One shared precedence rule: stronger browser evidence wins, and a new
    // HEAD response never proves the page loaded that variant.
    applyMeasurementToResource(resource, {
      transferBytes: measured.transferBytes,
      contentType: measured.contentType,
      measurementSource: measured.measurementSource,
      measurementConfidence: measured.measurementConfidence
    });
  }
}

async function receiveHandoff() {
  if (!handoffToken || state.handoffApplied) return;
  state.handoffApplied = true;
  const taken = await takeHandoff(handoffToken).catch(() => ({
    ok: false,
    reason: 'unavailable',
    payload: null
  }));
  if (!taken.ok || !taken.payload) {
    state.handoffNotice =
      'The popup handoff was unavailable; showing a fresh scan instead.';
    return;
  }
  const payload = taken.payload;
  try {
    assertSupportedSchema({ schemaVersion: payload.schemaVersion });
  } catch {
    state.handoffNotice =
      'The popup handoff used an unsupported report schema; showing a fresh scan instead.';
    return;
  }
  const validation = validateHandoff(payload, {
    tabId,
    documentToken: state.page?.documentToken || '',
    schemaVersion: REPORT_SCHEMA_VERSION
  });
  if (!validation.ok) {
    state.handoffNotice =
      'The popup handoff was stale; showing a fresh scan instead.';
    return;
  }
  // Reconcile with fresh browser evidence: the handoff never overwrites a
  // stronger measurement, and unknown URLs are ignored.
  const byUrl = new Map(state.page.resources.map((resource) => [resource.url, resource]));
  let applied = 0;
  for (const record of payload.measurements || []) {
    const resource = byUrl.get(record.url);
    if (!resource) continue;
    if (applyMeasurementToResource(resource, {
      transferBytes: record.bytes,
      contentType: record.contentType,
      measurementSource: record.source,
      measurementConfidence: record.confidence
    })) applied += 1;
  }
  for (const attempt of payload.attempts || []) {
    state.attemptedKeys.add(attempt.key);
  }
  // Sort order travels; popup filter/search never narrow the audit ledger.
  if (payload.ui && typeof payload.ui.sort === 'string') {
    const sorts = [...elements.sort.options].map((option) => option.value);
    if (sorts.includes(payload.ui.sort)) {
      state.sort = payload.ui.sort;
      elements.sort.value = state.sort;
    }
  }
  state.handoffNotice =
    applied > 0
      ? `Carried ${applied} validated measurement(s) from the popup; stronger fresh evidence wins.`
      : 'The popup handoff carried no usable measurements; showing a fresh scan.';
}

async function scan(silent = false) {
  const generation = ++state.scanGeneration;
  state.scanning = true;
  // Navigation or rescan invalidates the current job; abort and discard late.
  state.measureController?.abort();
  state.measuring = false;
  state.measureController = null;
  state.job = null;
  state.lease = null;
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
    state.documentToken = result.page?.documentToken || '';
    await receiveHandoff();
    if (generation !== state.scanGeneration) return;
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
  // Rendering is synchronous, so filter/sort input cannot interleave with a
  // render; async refresh chains stay ordered through scanGeneration.
  const { summary } = state.report;
  elements.pageTitle.textContent = state.page.pageTitle || 'Untitled page';
  elements.pageUrl.textContent = state.page.pageUrl;
  document.title = `${state.page.pageTitle || 'Page'} — ImageGuide audit`;

  // Grade retired (schema v4): lead with the estimated opportunity and the
  // measured/checked/estimated/unknown evidence counts.
  elements.grade.textContent = 'n/a';
  elements.grade.title = 'Delivery grade retired: conversion ratios are uncalibrated heuristics.';
  elements.deliveryDetail.textContent = summary.measuredResourceCount
    ? `${humanBytes(summary.measuredBytes)} observed · ≈${humanBytes(summary.measuredSavingBytes)} estimated opportunity`
    : 'No measured resource sizes';
  elements.saving.textContent = `≈${humanBytes(summary.savingBytes)}`;
  elements.savingDetail.textContent =
    `Resize ≈${humanBytes(summary.resizeSaving)} · Format ≈${humanBytes(summary.formatSaving)} (heuristic estimates)`;
  elements.markupCount.textContent = String(summary.markupIssueCount);
  elements.usageDetail.textContent =
    `${summary.resourceCount} resources · ${summary.usageCount} usages`;
  elements.confidence.textContent =
    `${summary.measuredResourceCount} measured · ${summary.checkedResourceCount || 0} checked`;
  elements.confidenceDetail.textContent =
    `${summary.measuredResourceCount} of ${summary.resourceCount} sizes measured · ` +
    `${summary.estimatedResourceCount} estimated · ${summary.unknownResourceCount || 0} unknown` +
    (summary.inlineResourceCount ? ` · ${summary.inlineResourceCount} inline` : '');

  const lcp = summary.vitals?.lcp;
  elements.lcpValue.textContent = lcp?.time > 0
    ? `${(lcp.time / 1000).toFixed(2)} s`
    : lcp?.supported
      ? 'No candidate'
      : 'Unsupported';
  elements.lcpDetail.textContent = lcp?.time > 0
    ? `${lcp.tagName || 'element'}${lcp.url ? ` · ${fileNameFromUrl(lcp.url)}` : ''} · top-frame observation, not field performance`
    : 'Buffered top-frame browser evidence';

  const cls = summary.vitals?.cls;
  elements.clsValue.textContent = cls?.supported
    ? Number(cls.score || 0).toFixed(3)
    : 'Unsupported';
  elements.clsDetail.textContent = cls?.supported
    ? `${cls.shiftCount || 0} shifts · ${cls.attributedShiftCount || 0} attributed to recorded media · top-frame observation`
    : 'Layout Instability API unavailable';
  elements.scanValue.textContent = `${Math.round(state.page.scanDurationMs || 0)} ms`;
  elements.scanDetail.textContent =
    `${state.page.scannedElements || 0} elements · ${state.page.frameCount} frames`;

  renderHandoffNote();
  renderWarnings();
  renderFilter();
  renderResources();
  elements.watchStatus.textContent = state.paused
    ? 'Page watch paused'
    : `Watching page changes · ${state.page.dynamicMutationCount || 0} observed`;
  elements.watchStatus.style.color = state.paused ? 'var(--amber)' : 'var(--green)';
}

function renderHandoffNote() {
  if (!elements.handoffNote) return;
  elements.handoffNote.hidden = !state.handoffNotice;
  elements.handoffNote.textContent = state.handoffNotice;
}

function renderWarnings() {
  // The same normalized summary feeds the popup, Markdown and JSON.
  const limitations = buildLimitationSummary(state.page, state.report);
  elements.warnings.replaceChildren();
  for (const entry of limitations) elements.warnings.append(make('p', 'warning', entry.message));
  elements.warnings.hidden = limitations.length === 0;
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
  // A replaced document keeps no highlight target: rescan first instead of
  // jumping into the wrong page.
  if (usage.documentToken && state.documentToken && usage.documentToken !== state.documentToken) {
    flash(button, 'Page changed — rescan first');
    return;
  }
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

function resourceKeyOf(resource) {
  // Scan-local `r1` ids and auditor marks are serialization labels, never
  // cache keys: identity is the document plus the canonical URL.
  return stableResourceKey({ documentToken: state.documentToken }, resource);
}

function usageKeyOf(usage) {
  return stableUsageKey({ documentToken: state.documentToken }, usage);
}

function usageRow(usage, resource) {
  const row = make('li', 'usage-row');
  row.dataset.kind = usage.kind;
  const key = usageKeyOf(usage);
  const usageTarget = make('button', 'usage-target', `${usage.kind} · frame ${usage.frameId} #${usage.elementId}`);
  usageTarget.type = 'button';
  usageTarget.dataset.focusKey = `usage:${key}`;
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
  return row;
}

function resourceCard(resource) {
  const key = resourceKeyOf(resource);
  const expanded = state.expandedKeys.has(key);
  const article = make('article', 'resource');
  article.dataset.key = key;
  const summary = make('div', 'resource-summary');
  summary.append(make('span', 'format-tile', resource.format.slice(0, 4).toUpperCase()));

  const name = make('div', 'resource-name');
  const primary = resource.usages.find((usage) => usage.id === resource.primaryUsageId) || resource.usages[0];
  const target = make('button', 'resource-target', fileNameFromUrl(resource.url));
  target.type = 'button';
  target.title = resource.url;
  target.dataset.focusKey = `resource:${key}`;
  target.addEventListener('click', () => jump(target, primary, resource));
  name.append(target, make('span', 'resource-url', resource.url));
  const evidence = [];
  if (resource.usages.some((usage) => usage.isLcp)) evidence.push('Browser LCP');
  if (resource.usages.some((usage) => usage.layoutShiftCount)) evidence.push('Shift attribution');
  if (resource.formatProvenance === 'hint') evidence.push('Format from URL hint');
  if (resource.checkedResponse) evidence.push('Checked header');
  name.append(issueBadges(resource.issues, evidence));

  const actions = make('div', 'badges');
  const copy = make('button', 'badge', 'Copy URL');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(copy, resource.url));
  actions.append(copy);
  if (!resource.isDataUri && resource.recommendedFormat !== resource.format) {
    const convert = make('a', 'badge', `Open converter`);
    convert.title =
      `Open the ImageGuide converter for ${resource.recommendedFormat.toUpperCase()}. ` +
      'The audited image is not transferred.';
    convert.href = CONVERTER_URL;
    convert.target = '_blank';
    convert.rel = 'noreferrer';
    actions.append(convert);
  }
  name.append(actions);

  const sourcePixels = resource.sourcePixelWidth
    ? `${resource.sourcePixelWidth}×${resource.sourcePixelHeight}`
    : 'Unknown';
  const responseLabel =
    resource.byteState === 'unknown'
      ? 'size unknown'
      : resource.inline
        ? `inline payload ${humanBytes(resource.bytes)}`
        : `${humanBytes(resource.bytes)}${resource.measured ? '' : ' (model estimate)'}`;
  const opportunity = resource.savingBytes
    ? `≈−${humanBytes(resource.savingBytes)} (heuristic estimate)`
    : 'None found';
  summary.append(
    name,
    fact(
      'Response',
      responseLabel,
      `${resource.measurement.source} · ${resource.measurement.confidence}` +
      (resource.checkedResponse ? ` · ${CHECKED_RESPONSE_NOTE}` : '')
    ),
    fact('Source pixels', sourcePixels, resource.sourceDimensionConfidence),
    fact('Opportunity', opportunity, resource.recommendedFormat.toUpperCase()),
    fact('Usages', String(resource.usages.length), `${resource.allIssues.length} finding types`)
  );
  article.append(summary);

  const details = make('details', 'usage-details');
  details.open = expanded;
  const detailsSummary = make(
    'summary',
    '',
    `${resource.usages.length} ${resource.usages.length === 1 ? 'usage' : 'usages'} · element-level evidence`
  );
  const list = make('ul', 'usage-list');
  // Usage rows mount only on expansion so a large ledger stays responsive;
  // search, sort, counts and exports still run on the full dataset.
  const buildRows = () => {
    if (list.childElementCount) return;
    renderMetrics.mark('usage-rows');
    for (const usage of resource.usages) list.append(usageRow(usage, resource));
  };
  if (expanded) buildRows();
  details.addEventListener('toggle', () => {
    if (details.open) {
      state.expandedKeys.add(key);
      buildRows();
    } else {
      state.expandedKeys.delete(key);
    }
  });
  details.append(detailsSummary, list);
  article.append(details);
  return article;
}

function pendingResponseChecks() {
  if (!state.report) return [];
  const candidates = state.report.resources.filter(
    (resource) => !resource.measured && !resource.isDataUri && isEligibleMeasurementUrl(resource.url)
  );
  // Already-attempted keys are skipped so a retry reaches new candidates
  // instead of resetting progress; failed resources retry only via a new click.
  return selectMeasurementCandidates(candidates, { attempted: state.attemptedKeys });
}

function renderResources() {
  renderMetrics.mark('render');
  // Capture inspection state before replacing nodes: expanded groups keyed by
  // stable identity, the focused control, and the scroll position.
  const focused = elements.resources.contains(document.activeElement)
    ? document.activeElement.dataset.focusKey || ''
    : '';
  if (focused) state.focusKey = focused;
  const scrollY = window.scrollY;
  const matched = sortResources(
    filterResources(state.report.resources, state.filter, state.search),
    state.sort
  );
  const shown = matched.slice(0, state.renderCap).map(resourceCard);
  elements.resources.replaceChildren(...shown);
  const total = state.report.summary.resourceCount;
  elements.resultCount.textContent =
    matched.length <= state.renderCap
      ? `${matched.length} of ${total} resources`
      : `${matched.length} of ${total} resources · showing ${shown.length}`;
  elements.emptyFilter.hidden = matched.length > 0;
  if (elements.showMore) {
    const remaining = matched.length - shown.length;
    elements.showMore.hidden = remaining <= 0;
    elements.showMore.textContent =
      `Show more (${shown.length} of ${matched.length})`;
  }
  // Restore without yanking the user back to the start of the ledger. If the
  // selected item disappeared, move focus to the results heading instead.
  window.scrollTo(0, scrollY);
  if (state.focusKey) {
    const next = elements.resources.querySelector(`[data-focus-key="${CSS.escape(state.focusKey)}"]`);
    if (next) next.focus({ preventScroll: true });
    else if (focused) document.getElementById('result-count')?.setAttribute('tabindex', '-1');
  }
}
async function preparePermissionSnapshot() {
  const pending = pendingResponseChecks();
  state.lease = null;
  elements.measure.disabled = true;
  elements.measure.textContent = state.measuring
    ? 'Cancel checks'
    : pending.length
      ? `Check ${pending.length} response sizes`
      : 'All response sizes checked';
  if (state.measureMessage) elements.measure.title = state.measureMessage;
  else elements.measure.removeAttribute('title');
  if (!pending.length || state.measuring) return;
  try {
    const lease = await preparePermissionLease(pending);
    if (isLeaseStale(lease, pendingResponseChecks())) return;
    state.lease = lease;
    elements.measure.disabled = false;
  } catch {
    elements.measure.textContent = 'Permission state unavailable';
  }
}

async function checkResponseSizes() {
  if (state.measuring) {
    state.measureController?.abort();
    return;
  }
  const pending = pendingResponseChecks();
  if (!pending.length || !state.lease) return;
  if (isLeaseStale(state.lease, pending)) {
    state.measureMessage = 'Candidates changed while preparing; check again to refresh.';
    state.lease = null;
    preparePermissionSnapshot();
    return;
  }
  if (getPendingCleanup()) {
    state.measureMessage =
      'A previous permission cleanup needs attention before another check can start.';
    preparePermissionSnapshot();
    return;
  }
  const job = createMeasurementJob(pending, {
    tabId,
    documentIdentity: state.documentToken,
    revision: state.revision
  });
  for (const attempt of job.attempts) attempt.status = ATTEMPT_STATUS.RUNNING;
  state.job = job;
  state.measuring = true;
  state.measureController = new AbortController();
  state.measureMessage = '';
  elements.measure.disabled = false;
  elements.measure.textContent = 'Cancel checks';
  const scanRun = state.scanGeneration;
  try {
    const outcome = await runAuthorizedMeasurement(pending, state.lease, {
      signal: state.measureController.signal,
      onProgress: (done, total) => {
        elements.measure.textContent = `Checking ${done}/${total}…`;
      }
    });
    if (scanRun !== state.scanGeneration) return;
    applyCheckOutcome(job, pending, outcome);
    state.report = analyzePage(state.page.resources, state.page.usages, state.page);
    render();
  } catch {
    if (scanRun !== state.scanGeneration) return;
    state.measureMessage = 'The check failed; retry needs another click.';
  } finally {
    if (scanRun === state.scanGeneration) {
      state.measuring = false;
      state.measureController = null;
      state.lease = null;
      preparePermissionSnapshot();
    }
  }
}

function applyCheckOutcome(job, pending, outcome) {
  const byUrl = new Map(state.page.resources.map((resource) => [resource.url, resource]));
  const recordAttempt = (candidate, status, reason, measurement) => {
    const key = candidate.id ?? candidate.url;
    try {
      setAttemptStatus(job, key, status, { reason, measurement });
    } catch {
      // Unknown key: never let bookkeeping lose valid evidence.
    }
    state.attemptedKeys.add(key);
    if (typeof candidate.url === 'string') state.attemptedKeys.add(candidate.url);
  };
  const applyResult = (candidate, result) => {
    if (job !== state.job) return;
    if (!state.page || state.documentToken !== job.documentIdentity) return;
    if (state.revision !== job.revision) return;
    if (!job.candidates.includes(candidate.url)) return;
    const resource = byUrl.get(candidate.url);
    if (!resource) return;
    applyMeasurementToResource(resource, {
      transferBytes: result.bytes,
      contentType: result.contentType,
      measurementSource: result.source,
      measurementConfidence: result.confidence
    });
  };
  switch (outcome.outcome) {
    case 'measured':
      outcome.results.forEach((result, index) => {
        const candidate = pending[index];
        if (!candidate) return;
        if (result) {
          recordAttempt(candidate, ATTEMPT_STATUS.MEASURED, null, result);
          applyResult(candidate, result);
        } else {
          recordAttempt(candidate, ATTEMPT_STATUS.UNAVAILABLE, 'no-validated-size', null);
        }
      });
      state.measureMessage = '';
      break;
    case 'denied':
      for (const candidate of pending) {
        recordAttempt(candidate, ATTEMPT_STATUS.PERMISSION_DENIED, outcome.reason, null);
      }
      state.measureMessage = 'Host access was declined; no checks ran. Retry needs another click.';
      break;
    case 'cancelled':
      (outcome.results || []).forEach((result, index) => {
        const candidate = pending[index];
        if (!candidate) return;
        if (result) {
          recordAttempt(candidate, ATTEMPT_STATUS.MEASURED, null, result);
          applyResult(candidate, result);
        } else {
          recordAttempt(candidate, ATTEMPT_STATUS.CANCELLED, outcome.reason || 'aborted', null);
        }
      });
      for (const attempt of job.attempts) {
        if (attempt.status === ATTEMPT_STATUS.RUNNING) {
          attempt.status = ATTEMPT_STATUS.CANCELLED;
          attempt.reason = outcome.reason || 'aborted';
        }
      }
      state.measureMessage = 'Check cancelled; completed measurements were kept.';
      break;
    case 'stale':
      state.measureMessage = `Candidates changed (${staleLeaseReason(state.lease, pending) || outcome.reason}); check again to refresh.`;
      break;
    case 'busy':
      state.measureMessage = 'Another check already owns this origin; wait for it to finish.';
      break;
    case 'blocked':
      state.measureMessage =
        'A previous permission cleanup needs attention before another check can start.';
      break;
    default:
      for (const candidate of pending) {
        recordAttempt(candidate, ATTEMPT_STATUS.UNAVAILABLE, outcome.reason || 'measurement-failed', null);
      }
      state.measureMessage = 'The check failed; retry needs another click.';
      break;
  }
}

async function poll() {
  if (state.paused || state.scanning || state.polling || !state.watchKey) return;
  state.polling = true;
  try {
    const observation = await observeTab(tabId, state.watchKey);
    if (!observation.revision || observation.revision === state.revision) return;
    if (observation.viewportOnly && !observation.needsFullScan) {
      // Cheap update: viewport facts only, no CSS reparse and no full scan.
      state.revision = observation.revision;
      elements.watchStatus.textContent =
        `Viewport changed · ${state.page.dynamicMutationCount || 0} observed`;
      await observeTab(tabId, state.watchKey, 'ack', { revision: observation.revision }).catch(() => {});
      return;
    }
    if (observation.scanInFlight) return;
    // Exactly one bounded full scan for resource/markup/style dirt, never one
    // scan per event; the observer coalesces signals into one pending flag.
    await observeTab(tabId, state.watchKey, 'beginScan').catch(() => {});
    try {
      elements.watchStatus.textContent = 'Page changed · refreshing evidence';
      await scan(true);
    } finally {
      await observeTab(tabId, state.watchKey, 'endScan').catch(() => {});
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
elements.showMore?.addEventListener('click', () => {
  state.renderCap += RENDER_BATCH;
  renderResources();
});
elements.showPage.addEventListener('click', () => chrome.tabs.update(tabId, { active: true }));
elements.toggleWatch.addEventListener('click', async () => {
  state.paused = !state.paused;
  elements.toggleWatch.textContent = state.paused ? 'Resume watch' : 'Pause watch';
  elements.watchStatus.textContent = state.paused ? 'Page watch paused' : 'Watching page changes';
  // Pause detaches listeners but keeps observer state; resume re-attaches
  // with a fresh revision so the next poll reconciles instead of replaying.
  if (state.paused) await observeTab(tabId, state.watchKey, 'pause').catch(() => {});
  else {
    await observeTab(tabId, state.watchKey, 'resume').catch(() => {});
    poll();
  }
});
elements.measure.addEventListener('click', async () => {
  try {
    await checkResponseSizes();
  } catch {
    state.measureMessage = 'The check failed; retry needs another click.';
    state.measuring = false;
    state.measureController = null;
    preparePermissionSnapshot();
  }
});
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
