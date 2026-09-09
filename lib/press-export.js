/**
 * Build the small, file-based handoff that Press can inspect locally.
 *
 * This is separate from the general report export: a Press handoff carries
 * image evidence and matching hints, never page identity or browser text.
 */

import { buildLimitationSummary } from './analyze.js';
import {
  filterResources,
  REPORT_SCHEMA_VERSION,
  SAVING_MODEL_VERSION
} from './report.js';

export const PRESS_HANDOFF_SCHEMA = 1;
export const PRESS_EXPORT_REVISION = 'press-export-1';
export const PRESS_MAX_FILE_BYTES = 1024 * 1024;
export const PRESS_MAX_RESOURCES = 512;
export const PRESS_MAX_LIST_ENTRIES = 64;
export const PRESS_MAX_STRING_CHARS = 4096;

const DEFAULT_PRODUCER = 'imageguide-extension';
const DEFAULT_PRODUCER_REVISION = PRESS_EXPORT_REVISION;
const DEFAULT_PRODUCER_VERSION = 'unknown';
const DEFAULT_MODEL_REVISION = SAVING_MODEL_VERSION;
const ALLOWED_FILTERS = new Set([
  'all',
  'oversized',
  'legacyFormat',
  'avifOpportunity',
  'heavy',
  'eagerOffscreen',
  'lazyVisible',
  'lazyLcp',
  'layoutShiftSource',
  'noDimensions',
  'noAlt',
  'responsiveOpportunity',
  'sizesMismatch'
]);
/** How the analyzer classified a format. A URL hint never becomes an observation. */
const FORMAT_PROVENANCE = new Set(['observed', 'checked-header', 'hint', 'unknown']);

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

function boundedText(value, fallback = '') {
  return Array.from(text(value, fallback)).slice(0, PRESS_MAX_STRING_CHARS).join('');
}

function boundedList(values, mapper = boundedText) {
  const list = Array.isArray(values) ? values : [];
  const result = [];
  for (const value of list.slice(0, PRESS_MAX_LIST_ENTRIES)) {
    const mapped = mapper(value);
    if (mapped) result.push(mapped);
  }
  return result;
}

function uniqueList(values, mapper = boundedText) {
  return [...new Set(boundedList(values, mapper))].slice(0, PRESS_MAX_LIST_ENTRIES);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonnegativeBytes(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function redaction(redactions, key) {
  if (!redactions.includes(key) && redactions.length < PRESS_MAX_LIST_ENTRIES) {
    redactions.push(key);
  }
}

/**
 * Take the file name from the whole path. Bounding the path first would turn a
 * long directory into a file name that was never served, so the basename is
 * extracted before any limit is applied, and a name that cannot survive the
 * limit intact is named as an omission instead of trimmed into a different one.
 *
 * The basename is split from the raw path, so decoding can put a separator back
 * (`%2F`, `%5C`) and restore the directory structure the split just removed.
 * A decoded candidate that still carries a separator is therefore omitted and
 * named, not re-split: taking a segment out of it would export a file name the
 * path never had.
 */
function filenameHint(parsed, redactions, resourceIndex) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length > 1) redaction(redactions, 'directory-paths-omitted');
  const encodedFilename = segments.at(-1) || '';
  if (!encodedFilename) return '';
  let candidate = '';
  let sanitized = false;
  try {
    candidate = text(decodeURIComponent(encodedFilename));
  } catch {
    // Keep a malformed percent escape as a filename hint only after removing
    // characters that could make it look like another URL or path.
    candidate = text(encodedFilename.replace(/[^\p{L}\p{N}._ -]/gu, '_'));
    sanitized = true;
  }
  if (!candidate) return '';
  if (candidate.includes('/') || candidate.includes('\\')) {
    redaction(redactions, `resource-${resourceIndex}-encoded-path-filename-omitted`);
    return '';
  }
  if (Array.from(candidate).length > PRESS_MAX_STRING_CHARS) {
    redaction(redactions, `resource-${resourceIndex}-filename-too-long-omitted`);
    return '';
  }
  if (sanitized) redaction(redactions, `resource-${resourceIndex}-filename-sanitized`);
  return candidate;
}

function sanitizedUrl(value, redactions, resourceIndex) {
  const raw = text(value);
  if (!raw || raw.startsWith('data:')) {
    if (raw.startsWith('data:')) redaction(redactions, 'inline-data-omitted');
    return { url: '', filename: '' };
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      redaction(redactions, `resource-${resourceIndex}-url-scheme-omitted`);
      return { url: '', filename: '' };
    }
    const hasUserInfo = Boolean(parsed.username || parsed.password);
    const hasQuery = Boolean(parsed.search);
    const hasFragment = Boolean(parsed.hash);
    if (hasUserInfo) redaction(redactions, `resource-${resourceIndex}-userinfo-removed`);
    if (hasQuery) redaction(redactions, `resource-${resourceIndex}-query-removed`);
    if (hasFragment) redaction(redactions, `resource-${resourceIndex}-fragment-removed`);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const filename = filenameHint(parsed, redactions, resourceIndex);
    redaction(redactions, 'source-urls-omitted');
    return { url: '', filename };
  } catch {
    redaction(redactions, `resource-${resourceIndex}-invalid-url-omitted`);
    return { url: '', filename: '' };
  }
}

function usageFindings(resource) {
  const findings = [];
  for (const usage of (Array.isArray(resource.usages) ? resource.usages : []).slice(0, PRESS_MAX_LIST_ENTRIES)) {
    for (const issue of (Array.isArray(usage.issues) ? usage.issues : []).slice(0, PRESS_MAX_LIST_ENTRIES)) {
      findings.push(`usage:${boundedText(usage.kind, 'unknown')}:${boundedText(issue)}`);
      if (findings.length >= PRESS_MAX_LIST_ENTRIES) return findings;
    }
  }
  return findings;
}

function resourceRecord(resource, index, redactions) {
  const resourceIndex = index + 1;
  const source = sanitizedUrl(resource.url, redactions, resourceIndex);
  const id = `r${resourceIndex}`;
  const width = positiveInteger(resource.sourcePixelWidth);
  const height = positiveInteger(resource.sourcePixelHeight);
  const byteState = boundedText(resource.byteState, 'unknown');
  const bytes = byteState === 'unknown' ? null : nonnegativeBytes(resource.bytes);
  const recommendedMaxEdge = resource.issues?.includes('oversized')
    ? Math.max(positiveInteger(resource.resizeWidth) || 0, positiveInteger(resource.resizeHeight) || 0)
    : 0;
  const findings = uniqueList([
    ...(resource.issues || []),
    ...usageFindings(resource)
  ]);
  const observedFormat = boundedText(resource.format).toLowerCase() || null;
  const formatProvenance = boundedText(resource.formatProvenance).toLowerCase();
  const recommendations = uniqueList(
    [resource.recommendedFormat],
    (value) => boundedText(value).toLowerCase()
  );
  const pathHints = source.filename ? [source.filename] : [];
  if (resource.inline || resource.isDataUri) redaction(redactions, 'inline-data-omitted');

  return {
    id,
    urls: source.url ? [source.url] : [],
    path_hints: pathHints,
    width,
    height,
    bytes,
    // Inline bytes are document payload and modelled/unknown bytes are not a
    // response measurement. Preserve those states without upgrading them.
    bytes_measured: byteState === 'measured' && Boolean(resource.measured),
    bytes_state: byteState,
    byte_source: boundedText(resource.byteSource || resource.measurementSource) || null,
    findings,
    // These are advisory until a user confirms an output recipe. The core
    // consumer fields stay empty so observations cannot become constraints.
    max_edge: null,
    formats: [],
    observed_format: observedFormat,
    // Provenance for that observation only: a format read from the URL stays a
    // hint and never becomes a content check or an allowed output format.
    observed_format_provenance: FORMAT_PROVENANCE.has(formatProvenance) ? formatProvenance : 'unknown',
    format_recommendations: recommendations,
    recommended_max_edge: recommendedMaxEdge > 0 ? recommendedMaxEdge : null
  };
}

/**
 * Carry the collector's own limits as stable keys and lower-bound flags. The
 * limitation messages carry counts and page wording, so only the key and the
 * flag travel; no page URL, title, or page text can ride along.
 */
function evidenceLimitations(page, report) {
  const entries = [];
  const seen = new Set();
  for (const limitation of buildLimitationSummary(page, report).slice(0, PRESS_MAX_LIST_ENTRIES)) {
    const key = boundedText(limitation.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, lower_bound: Boolean(limitation.lowerBound) });
  }
  return entries;
}

function scopeOf(selected, page, report, options) {
  const filter = ALLOWED_FILTERS.has(options.filter) ? options.filter : 'all';
  const searchApplied = Boolean(text(options.search));
  const total = Array.isArray(report.resources) ? report.resources.length : 0;
  const truncated = selected.length > PRESS_MAX_RESOURCES;
  const limitations = evidenceLimitations(page, report);
  return {
    // The scope names what was selected from the recorded evidence. It cannot
    // claim the page itself was fully recorded; the evidence fields below say so.
    kind: filter === 'all' && !searchApplied ? 'full-audit' : 'visible-filter',
    filter,
    search_applied: searchApplied,
    total_resources: total,
    retained_resources: Math.min(selected.length, PRESS_MAX_RESOURCES),
    // Exporter trimming: the 512-record cap or the 1 MiB file fit.
    resources_truncated: truncated,
    // Collector limits: the recorded evidence is itself incomplete, so the
    // counts above are a lower bound for the page.
    evidence_lower_bound: limitations.some((entry) => entry.lower_bound),
    evidence_limitations: limitations
  };
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function serialized(payload) {
  return JSON.stringify(payload);
}

function fitToFile(payload, redactions) {
  let candidate = payload;
  let json = serialized(candidate);
  if (byteLength(json) <= PRESS_MAX_FILE_BYTES) return { payload: candidate, json };

  redaction(redactions, 'optional-evidence-trimmed');
  candidate = {
    ...candidate,
    resources: candidate.resources.map((resource) => ({
      ...resource,
      findings: resource.findings.slice(0, 16),
      formats: resource.formats.slice(0, 8)
    }))
  };
  json = serialized(candidate);
  if (byteLength(json) <= PRESS_MAX_FILE_BYTES) return { payload: candidate, json };

  redaction(redactions, 'resource-records-trimmed');
  let resources = candidate.resources;
  while (resources.length > 1) {
    const next = resources.slice(0, Math.ceil(resources.length / 2));
    const nextPayload = {
      ...candidate,
      resources: next,
      scope: { ...candidate.scope, retained_resources: next.length, resources_truncated: true }
    };
    const nextJson = serialized(nextPayload);
    if (byteLength(nextJson) <= PRESS_MAX_FILE_BYTES) {
      candidate = nextPayload;
      json = nextJson;
      return { payload: candidate, json };
    }
    resources = next;
  }
  throw new Error('Press handoff exceeds the 1 MiB file limit after bounded redaction');
}

/**
 * Build a bounded Press handoff and the exact file text to download.
 * Search text is used only to select resources and is never exported.
 */
export function buildPressHandoff(page = {}, report = {}, options = {}) {
  const sourceResources = Array.isArray(report.resources) ? report.resources : [];
  const filter = ALLOWED_FILTERS.has(options.filter) ? options.filter : 'all';
  const search = options.search || '';
  const selected = filterResources(sourceResources, filter, search);
  if (!selected.length) throw new Error('The selected Press handoff scope has no resources');
  const redactions = [
    'page-url-and-title-omitted',
    'page-text-omitted'
  ];
  const retained = selected.slice(0, PRESS_MAX_RESOURCES);
  if (selected.length > PRESS_MAX_RESOURCES) redaction(redactions, 'resource-list-capped');
  const resources = retained.map((resource, index) => resourceRecord(resource, index, redactions));
  const payload = {
    schema: PRESS_HANDOFF_SCHEMA,
    producer: boundedText(options.producer || DEFAULT_PRODUCER),
    producer_revision: boundedText(options.producerRevision || DEFAULT_PRODUCER_REVISION),
    producer_version: boundedText(options.producerVersion || DEFAULT_PRODUCER_VERSION),
    task: 'full-audit',
    observed: boundedText(options.observed || new Date().toISOString()),
    resources,
    redactions,
    scope: scopeOf(selected, page, report, { ...options, filter, search }),
    report_schema: REPORT_SCHEMA_VERSION,
    model_revision: boundedText(options.modelRevision || DEFAULT_MODEL_REVISION)
  };
  const fitted = fitToFile(payload, redactions);
  fitted.payload.redactions = uniqueList(redactions);
  fitted.json = serialized(fitted.payload);
  if (byteLength(fitted.json) > PRESS_MAX_FILE_BYTES) {
    throw new Error('Press handoff exceeds the 1 MiB file limit');
  }
  const preview = {
    kind: fitted.payload.scope.kind,
    filter: fitted.payload.scope.filter,
    searchApplied: fitted.payload.scope.search_applied,
    retainedResources: fitted.payload.resources.length,
    totalResources: sourceResources.length,
    filenames: fitted.payload.resources.flatMap((resource) => resource.path_hints),
    redactions: fitted.payload.redactions,
    limitations: fitted.payload.scope.evidence_limitations.map((entry) => entry.key),
    evidenceLowerBound: fitted.payload.scope.evidence_lower_bound,
    bytes: byteLength(fitted.json)
  };
  return { payload: fitted.payload, json: fitted.json, preview };
}

/** Return the bounded file name used by the browser download. */
export function pressHandoffFileName(page = {}) {
  void page;
  return 'imageguide-press-handoff.json';
}
