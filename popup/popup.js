import { analyzePage, buildLimitationSummary, CHECKED_RESPONSE_NOTE, ISSUES } from '../lib/analyze.js';
import {
  CONVERTER_URL,
  MAX_ROWS,
} from '../lib/constants.js';
import { humanBytes } from '../lib/format.js';
import { createHandoffPayload } from '../lib/handoff.js';
import {
  applyMeasurementToResource,
  ATTEMPT_STATUS,
  createMeasurementJob,
  isEligibleMeasurementUrl,
  selectMeasurementCandidates,
  setAttemptStatus,
  summarizeMeasurementJob,
} from '../lib/measure.js';
import {
  buildJsonReport,
  buildMarkdownReport,
  fileNameFromUrl,
  filterResources,
  REPORT_SCHEMA_VERSION,
  SAVING_MODEL_VERSION,
  sortResources
} from '../lib/report.js';
import {
  activeTab,
  highlightUsage as highlightTabUsage,
  scanTab
} from '../extension/tab.js';
import { saveHandoff } from '../extension/handoff.js';
import {
  getPendingCleanup,
  isLeaseStale,
  preparePermissionLease,
  runAuthorizedMeasurement,
  staleLeaseReason,
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
  openAudit: document.getElementById('open-audit'),
  openAuditTop: document.getElementById('open-audit-top')
};

const state = {
  tabId: null,
  page: null,
  report: null,
  filter: 'all',
  sort: 'saving',
  search: '',
  markAttribute: '',
  watchKey: '',
  revision: '',
  documentToken: '',
  job: null,
  lease: null,
  measuring: false,
  measureController: null,
  measureMessage: '',
  attemptedKeys: new Set()
};

let scanGeneration = 0;
let permissionSnapshotGeneration = 0;
let measureGeneration = 0;

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
  // A rescan invalidates any running check: abort it and discard late results.
  state.measureController?.abort();
  state.measuring = false;
  state.measureController = null;
  state.job = null;
  state.lease = null;
  ++measureGeneration;
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
    state.revision = result.revision || '';
    state.documentToken = result.page?.documentToken || '';
    // Attempts belong to one document: a new document starts clean.
    state.attemptedKeys = new Set();
    state.measureMessage = '';
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

  // The A–F delivery grade is retired: fixed-ratio model arithmetic is not
  // calibrated evidence (report schema v4 carries grade:null). Lead with the
  // estimated opportunity and the measured/estimated/unknown counts instead.
  elements.grade.textContent = 'n/a';
  elements.grade.dataset.grade = 'retired';
  elements.grade.title =
    'Delivery grade retired: conversion ratios are uncalibrated heuristics (schema v4).';
  elements.saving.textContent = `≈${humanBytes(summary.savingBytes)}`;
  elements.count.textContent = String(summary.resourceCount);
  elements.usageCount.textContent = String(summary.usageCount);
  elements.total.textContent = humanBytes(summary.totalBytes);
  elements.optimised.textContent = humanBytes(summary.optimisedBytes);
  elements.barFill.style.width = `${Math.round(summary.savingRatio * 100)}%`;
  elements.resizeSaving.textContent = `≈${humanBytes(summary.resizeSaving)}`;
  elements.formatSaving.textContent = `≈${humanBytes(summary.formatSaving)}`;
  const coverage = summary.coverage || {};
  elements.confidence.textContent =
    `${summary.measuredResourceCount} measured · ${summary.checkedResourceCount || 0} checked-header` +
    ` · ${summary.estimatedResourceCount} estimated · ${summary.unknownResourceCount || 0} unknown` +
    ` · ${summary.markupIssueCount} markup findings`;
  elements.confidence.title = coverage.note || '';
  const lcp = summary.vitals?.lcp;
  const cls = summary.vitals?.cls;
  elements.vitals.textContent =
    `LCP ${lcp?.time > 0 ? `${(lcp.time / 1000).toFixed(2)} s` : lcp?.supported ? 'not captured' : 'unsupported'}` +
    ` · CLS ${cls?.supported ? Number(cls.score || 0).toFixed(3) : 'unsupported'}` +
    ' · top-frame observations, not field performance';

  renderMeasureNote(summary);
  renderLimitationNotes();

  renderFilters();
  renderResources();
  show('results');
  preparePermissionSnapshot();
}

function renderMeasureNote(summary) {
  const pending = pendingResponseChecks();
  const unmeasured = summary.estimatedResourceCount + (summary.unknownResourceCount || 0);
  elements.measureNote.hidden = unmeasured === 0 && !state.measuring && !state.measureMessage;
  const parts = [];
  if (unmeasured > 0) {
    parts.push(
      `${unmeasured} of ${summary.resourceCount} sizes use the model or are unknown.` +
      ' Cross-origin files hide their size.'
    );
  }
  if (state.job) {
    const jobSummary = summarizeMeasurementJob(state.job);
    parts.push(
      `Last check: ${jobSummary.measured} measured · ${jobSummary.unavailable} unavailable` +
      (jobSummary.cancelled ? ` · ${jobSummary.cancelled} cancelled` : '') +
      (jobSummary.denied ? ` · ${jobSummary.denied} denied` : '') +
      '. Retry needs another click.'
    );
  }
  if (state.measureMessage) parts.push(state.measureMessage);
  const label = state.measuring ? 'Cancel checks' : `Check ${pending.length} response sizes`;
  elements.estimatedCount.textContent = `${String(summary.estimatedResourceCount)}${parts.length ? ` — ${parts.join(' ')}` : ''}`;
  elements.measure.textContent = state.measuring ? 'Cancel checks' : label;
  elements.measure.disabled = state.measuring ? false : pending.length === 0;
}

function renderLimitationNotes() {
  // One normalized summary feeds the popup, the audit, Markdown and JSON.
  const limitations = buildLimitationSummary(state.page, state.report);
  const lowerBound = limitations.filter((entry) => entry.lowerBound).map((entry) => entry.message);
  const timing = limitations
    .filter((entry) => entry.key === 'timing-buffer')
    .map((entry) => entry.message);
  const rest = limitations
    .filter((entry) => !entry.lowerBound && entry.key !== 'timing-buffer')
    .map((entry) => entry.message);
  elements.truncateNote.hidden = lowerBound.length === 0;
  elements.truncateNote.textContent = lowerBound.join(' ');
  elements.bufferNote.hidden = timing.length === 0;
  elements.bufferNote.textContent = timing.join(' ');
  elements.coverageNote.hidden = rest.length === 0;
  elements.coverageNote.textContent = rest.join(' ');
}

async function preparePermissionSnapshot() {
  const generation = ++permissionSnapshotGeneration;
  const pending = pendingResponseChecks();
  state.lease = null;
  // A stale lease must never enable the button: candidates may have changed
  // while the snapshot was in flight.
  elements.measure.disabled = true;
  renderMeasureNote(state.report.summary);
  if (!pending.length) return;

  try {
    const lease = await preparePermissionLease(pending);
    if (generation !== permissionSnapshotGeneration) return;
    if (isLeaseStale(lease, pendingResponseChecks())) return;
    state.lease = lease;
    elements.measure.disabled = false;
    renderMeasureNote(state.report.summary);
  } catch {
    // Without a trustworthy snapshot we cannot safely revoke only new grants.
    if (generation === permissionSnapshotGeneration) {
      state.measureMessage = 'Permission state unavailable; retry to check again.';
      renderMeasureNote(state.report.summary);
    }
  }
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
  const sizeLabel =
    resource.byteState === 'unknown'
      ? 'size unknown'
      : resource.inline
        ? `inline payload ${humanBytes(resource.bytes)}`
        : `${humanBytes(resource.bytes)}${resource.measured ? '' : ' (model estimate)'}`;
  meta.textContent =
    `${resource.format.toUpperCase()}${resource.formatProvenance === 'hint' ? ' (from URL hint)' : ''} · ${sizeLabel} · ${pixels} · ${useCount}`;
  meta.title =
    `Source size ${natural} (${resource.sourceDimensionConfidence}). ` +
    `Most demanding recorded usage needs ${resource.targetWidth}×${resource.targetHeight}. ` +
    `Size source: ${resource.measurement.source} (${resource.measurement.confidence}).` +
    (resource.checkedResponse ? ` ${CHECKED_RESPONSE_NOTE}` : '') +
    (resource.savingsKind === 'heuristic-estimate' && resource.savingBytes > 0
      ? ' Opportunity is a heuristic estimate, not a promised saving.'
      : '');

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
  if (!resource.isDataUri && resource.recommendedFormat !== resource.format) {
    const convert = document.createElement('a');
    convert.className = 'icon';
    convert.textContent = 'Open converter';
    convert.title =
      `Open the ImageGuide converter for ${resource.recommendedFormat.toUpperCase()}. ` +
      'The audited image is not transferred.';
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
 * Run one bounded, cancellable check under the prepared lease. The job owns
 * its candidates; a rescan aborts the run and late completions are discarded.
 * Retry always needs another click — nothing replays automatically.
 */
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
    renderMeasureNote(state.report.summary);
    preparePermissionSnapshot();
    return;
  }
  const blocked = getPendingCleanup();
  if (blocked) {
    state.measureMessage =
      'A previous permission cleanup needs attention before another check can start.';
    renderMeasureNote(state.report.summary);
    return;
  }

  const run = ++measureGeneration;
  const job = createMeasurementJob(pending, {
    tabId: state.tabId,
    documentIdentity: state.documentToken,
    revision: state.revision
  });
  for (const attempt of job.attempts) {
    attempt.status = ATTEMPT_STATUS.RUNNING;
  }
  state.job = job;
  state.measuring = true;
  state.measureController = new AbortController();
  state.measureMessage = '';
  elements.measure.disabled = false;
  elements.measure.textContent = 'Cancel checks';
  elements.rescan.disabled = true;

  try {
    const outcome = await runAuthorizedMeasurement(pending, state.lease, {
      signal: state.measureController.signal,
      onProgress: (done, total) => {
        if (run === measureGeneration) elements.measure.textContent = `Checking ${done}/${total}…`;
      }
    });
    if (run !== measureGeneration) return;
    applyCheckOutcome(job, pending, outcome);
  } catch {
    if (run !== measureGeneration) return;
    state.measureMessage = 'The check failed; retry needs another click.';
  } finally {
    if (run === measureGeneration) {
      state.measuring = false;
      state.measureController = null;
      elements.rescan.disabled = false;
      render();
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
    // Guard the completion: the job, document and revision must still match
    // and the resource must remain in the captured candidate set.
    if (job !== state.job) return;
    if (!state.page || state.documentToken !== job.documentIdentity) return;
    if (state.revision !== job.revision) return;
    if (!job.candidates.includes(candidate.url)) return;
    const record = byUrl.get(candidate.url);
    if (!record) return;
    applyMeasurementToResource(record, {
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
  state.lease = null;
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
    state.measureMessage = 'The check failed; retry needs another click.';
    state.measuring = false;
    state.measureController = null;
    render();
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

async function openAudit() {
  if (!state.tabId || !state.watchKey) return;
  const query = new URLSearchParams({
    tab: String(state.tabId),
    watch: state.watchKey
  });
  // One-shot, extension-internal handoff: completed validated measurements,
  // provenance, attempt outcomes and UI state travel under a random token in
  // session storage. Audited URLs never go in the query string. Any failure
  // falls back to a fresh scan in the audit, never a crash.
  try {
    const measurements = (state.page?.resources || [])
      .filter((resource) => Number(resource.transferBytes) > 0 && resource.measurementSource)
      .map((resource) => ({
        url: resource.url,
        bytes: Number(resource.transferBytes),
        contentType: resource.contentType || '',
        source: resource.measurementSource,
        confidence: resource.measurementConfidence || 'low'
      }));
    const attempts = (state.job?.attempts || []).map((attempt) => ({
      key: attempt.key,
      status: attempt.status,
      reason: attempt.reason ?? null
    }));
    if (measurements.length || attempts.length) {
      const token = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `handoff-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      await saveHandoff(
        createHandoffPayload({
          token,
          tabId: state.tabId,
          documentToken: state.documentToken,
          revision: state.revision,
          schemaVersion: REPORT_SCHEMA_VERSION,
          modelVersion: SAVING_MODEL_VERSION,
          measurements,
          attempts,
          // Sort order travels; popup filter/search never narrow the audit.
          // A screenshot-driven `shared=1` search must not hide evidence.
          ui: { filter: 'all', sort: state.sort, search: '' }
        })
      );
      query.set('handoff', token);
    }
  } catch {
    query.delete('handoff');
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`audit/audit.html?${query}`) });
  window.close();
}

elements.openAudit.addEventListener('click', openAudit);
elements.openAuditTop?.addEventListener('click', openAudit);

loadSettings().then(scan);
