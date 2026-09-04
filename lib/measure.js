/**
 * Validate optional response-size checks without pretending they reproduce the
 * page's original request. Pure web APIs only, so Node can test the behavior.
 *
 * Wave-1 measurement core (docs/plans/01-measurement-lifecycle.md, slice 01a):
 *
 * - Each check belongs to an immutable measurement job (job id, tab, document
 *   identity, revision, captured candidates). Attempt status is separate from
 *   evidence: unattempted / running / measured / unavailable /
 *   permission-denied / cancelled, with an unavailable reason (timeout,
 *   unsupported-scheme, invalid-response, request-failure). An opaque fetch
 *   failure never infers an HTTP status.
 * - Only eligible HTTP(S) candidates enter the queue; data:/blob:/chrome: and
 *   other unsupported schemes resolve as unavailable without occupying a pool
 *   slot. callers cap batches with MAX_MEASURE_CANDIDATES (100 preserved).
 * - The pool honors caller cancellation (AbortSignal): active requests abort,
 *   no new candidate starts, started work settles, completed measurements are
 *   preserved and remaining work is marked honestly.
 * - Source precedence lives here (compareMeasurementSources /
 *   shouldApplyMeasurement / applyMeasurementToResource) so rescan,
 *   frame-merge (lib/merge.js) and the later UI wave cannot disagree.
 *   Stronger browser evidence wins; byte provenance and format provenance are
 *   separate, so a HEAD response never proves the page loaded that variant.
 */

export const MEASURE_CONCURRENCY = 6;
export const MEASURE_TIMEOUT_MS = 8000;
/** One bounded batch keeps huge pages finite; unsupported URLs never occupy it. */
export const MAX_MEASURE_CANDIDATES = 100;

/** Attempt lifecycle states. Status is separate from evidence. */
export const ATTEMPT_STATUS = {
  UNATTEMPTED: 'unattempted',
  RUNNING: 'running',
  MEASURED: 'measured',
  UNAVAILABLE: 'unavailable',
  PERMISSION_DENIED: 'permission-denied',
  CANCELLED: 'cancelled'
};

/** Reasons for `unavailable` results, only where distinguishable. */
export const UNAVAILABLE_REASON = {
  TIMEOUT: 'timeout',
  UNSUPPORTED_SCHEME: 'unsupported-scheme',
  INVALID_RESPONSE: 'invalid-response',
  REQUEST_FAILURE: 'request-failure'
};

/**
 * Strongest browser evidence first. Shared by rescan, frame merge and the UI
 * application path so they cannot disagree.
 */
const MEASUREMENT_SOURCE_RANK = {
  'resource-timing-encoded': 5,
  'resource-timing-transfer': 4,
  inline: 3,
  'content-length': 2,
  'content-range': 2
};

export function measurementSourceRank(source) {
  return MEASUREMENT_SOURCE_RANK[source] || 0;
}

/** Positive when `a` is stronger browser evidence than `b`. */
export function compareMeasurementSources(a, b) {
  return measurementSourceRank(a) - measurementSourceRank(b);
}

function evidenceBytes(record) {
  return Number(record?.transferBytes ?? record?.bytes ?? 0) || 0;
}

function evidenceSource(record) {
  return record?.measurementSource ?? record?.source ?? '';
}

/**
 * Decide whether an incoming measurement may overwrite existing evidence.
 * Accepts both merge records ({transferBytes, measurementSource}) and
 * response checks ({bytes, source}).
 */
export function shouldApplyMeasurement(existing, incoming) {
  const incomingBytes = evidenceBytes(incoming);
  if (!(incomingBytes > 0)) return false;
  if (!(evidenceBytes(existing) > 0)) return true;
  return (
    compareMeasurementSources(evidenceSource(incoming), evidenceSource(existing)) > 0
  );
}

/**
 * Apply a HEAD/range measurement to a page resource without letting byte
 * provenance leak into format provenance: bytes only win per
 * shouldApplyMeasurement, and a new response never overwrites a known
 * content type because it does not prove the page loaded that variant.
 *
 * @returns {boolean} true when the resource changed.
 */
export function applyMeasurementToResource(resource, measurement) {
  if (!resource || !measurement) return false;
  let changed = false;
  if (shouldApplyMeasurement(resource, measurement)) {
    resource.transferBytes = evidenceBytes(measurement);
    resource.measurementSource = evidenceSource(measurement);
    resource.measurementConfidence =
      measurement.confidence ?? measurement.measurementConfidence ?? '';
    changed = true;
  }
  if (!resource.contentType && measurement.contentType) {
    resource.contentType = measurement.contentType;
    changed = true;
  }
  return changed;
}

/** True only for fetchable HTTP(S) URLs. Everything else never enters the queue. */
export function isEligibleMeasurementUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host !== ''
    );
  } catch {
    return false;
  }
}

function candidateUrl(candidate) {
  return typeof candidate === 'string' ? candidate : candidate?.url;
}

function candidateKey(candidate) {
  return typeof candidate === 'string' ? candidate : (candidate?.id ?? candidate?.url);
}

/**
 * Pick the next bounded batch: eligible, not yet attempted, order preserved,
 * capped at `limit` (default 100). Unsupported/data/blob candidates are
 * filtered before the cap so they never occupy queue slots; already-attempted
 * keys are skipped so a retry reaches new candidates instead of resetting
 * progress.
 *
 * @param {Array} candidates URL strings or {url, id?} records.
 * @param {{attempted?: Set|Array, limit?: number}} options
 */
export function selectMeasurementCandidates(candidates = [], options = {}) {
  const limit = options.limit ?? MAX_MEASURE_CANDIDATES;
  const attempted =
    options.attempted instanceof Set
      ? options.attempted
      : new Set(options.attempted ?? []);
  const selected = [];
  for (const candidate of candidates || []) {
    if (selected.length >= limit) break;
    const url = candidateUrl(candidate);
    const key = candidateKey(candidate);
    if (!url) continue;
    if (attempted.has(key)) continue;
    if (typeof candidate !== 'string' && attempted.has(url)) continue;
    if (!isEligibleMeasurementUrl(url)) continue;
    selected.push(candidate);
  }
  return selected;
}

let jobSequence = 0;

/**
 * Create an immutable-identity job owning one bounded check: job id, target
 * tab, top-document identity, frame document identities, scan revision and
 * the captured candidate set. Attempts start `unattempted`.
 */
export function createMeasurementJob(candidates = [], meta = {}) {
  const attempts = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const url = candidateUrl(candidate);
    const id = typeof candidate === 'string' ? null : (candidate?.id ?? null);
    return {
      key: id ?? url,
      url,
      id,
      status: ATTEMPT_STATUS.UNATTEMPTED,
      reason: null,
      measurement: null
    };
  });
  return {
    id: meta.jobId ?? `measurement-job-${(jobSequence += 1)}`,
    tabId: meta.tabId ?? null,
    documentIdentity: meta.documentIdentity ?? null,
    revision: meta.revision ?? null,
    frameDocumentIds: Array.isArray(meta.frameDocumentIds)
      ? [...meta.frameDocumentIds]
      : [],
    candidates: attempts.map((attempt) => attempt.url),
    attempts,
    createdAt: Date.now()
  };
}

const KNOWN_STATUSES = new Set(Object.values(ATTEMPT_STATUS));

/** Pure transition helper: record one attempt outcome on its owning job. */
export function setAttemptStatus(job, key, status, detail = {}) {
  if (!KNOWN_STATUSES.has(status)) throw new Error(`unknown attempt status: ${status}`);
  const attempt = job?.attempts?.find((entry) => entry.key === key);
  if (!attempt) throw new Error(`unknown attempt key: ${key}`);
  attempt.status = status;
  attempt.reason = detail.reason ?? null;
  attempt.measurement = detail.measurement ?? null;
  return attempt;
}

/** Keys already attempted (anything past `unattempted`, including in-flight). */
export function attemptedCandidateKeys(job) {
  const keys = new Set();
  for (const attempt of job?.attempts || []) {
    if (attempt.status !== ATTEMPT_STATUS.UNATTEMPTED) keys.add(attempt.key);
  }
  return keys;
}

/** Next bounded batch for a job: new candidates only, progress never reset. */
export function selectJobRetryCandidates(job, candidates, options = {}) {
  return selectMeasurementCandidates(candidates, {
    ...options,
    attempted: attemptedCandidateKeys(job)
  });
}

/** Checked / unavailable / remaining counts for the UI wave. */
export function summarizeMeasurementJob(job) {
  const summary = {
    total: 0,
    checked: 0,
    measured: 0,
    unavailable: 0,
    denied: 0,
    cancelled: 0,
    running: 0,
    remaining: 0
  };
  for (const attempt of job?.attempts || []) {
    summary.total += 1;
    switch (attempt.status) {
      case ATTEMPT_STATUS.MEASURED:
        summary.checked += 1;
        summary.measured += 1;
        break;
      case ATTEMPT_STATUS.UNAVAILABLE:
        summary.checked += 1;
        summary.unavailable += 1;
        break;
      case ATTEMPT_STATUS.PERMISSION_DENIED:
        summary.checked += 1;
        summary.denied += 1;
        break;
      case ATTEMPT_STATUS.CANCELLED:
        summary.checked += 1;
        summary.cancelled += 1;
        break;
      case ATTEMPT_STATUS.RUNNING:
        summary.running += 1;
        break;
      default:
        summary.remaining += 1;
        break;
    }
  }
  return summary;
}

function imageType(response) {
  const contentType = response.headers.get('content-type') || '';
  return contentType.toLowerCase().startsWith('image/') ? contentType : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return /^\d+$/.test(value || '') && Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function staysOnOrigin(url, response) {
  if (!response.url) return true;
  try {
    return new URL(response.url).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

export function totalFromContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec((value || '').trim());
  if (!match) return 0;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(total) && start === 0 && end === 0 && total > end ? total : 0;
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The headers are all we need; an already closed body is harmless.
  }
}

/**
 * Check one URL with HEAD, then a one-byte range request when needed.
 * Structured attempt outcome: `measured` carries the measurement, while
 * `unavailable` carries a reason (timeout, unsupported-scheme,
 * invalid-response, request-failure). An opaque fetch failure reports
 * request-failure and never infers an HTTP status. Caller cancellation via
 * `options.signal` reports `cancelled`. Unsupported schemes never fetch.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{status: string, reason: string|null, measurement: object|null}>}
 */
export async function measureImageResponseDetailed(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    return { status: ATTEMPT_STATUS.CANCELLED, reason: 'aborted', measurement: null };
  }
  if (!isEligibleMeasurementUrl(url)) {
    return {
      status: ATTEMPT_STATUS.UNAVAILABLE,
      reason: UNAVAILABLE_REASON.UNSUPPORTED_SCHEME,
      measurement: null
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? MEASURE_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener?.('abort', onCallerAbort, { once: true });
  const abortedByCaller = () => callerSignal?.aborted === true;
  const request = (init) =>
    fetchImpl(url, {
      credentials: 'omit',
      cache: 'force-cache',
      redirect: 'error',
      signal: controller.signal,
      ...init
    });

  try {
    try {
      const response = await request({ method: 'HEAD' });
      const contentType = imageType(response);
      const bytes = positiveInteger(response.headers.get('content-length'));
      if (response.ok && contentType && bytes && staysOnOrigin(url, response)) {
        await cancelBody(response);
        return {
          status: ATTEMPT_STATUS.MEASURED,
          reason: null,
          measurement: { bytes, contentType, source: 'content-length', confidence: 'medium' }
        };
      }
      await cancelBody(response);
    } catch {
      if (abortedByCaller()) {
        return { status: ATTEMPT_STATUS.CANCELLED, reason: 'aborted', measurement: null };
      }
      if (timedOut || controller.signal.aborted) {
        return {
          status: ATTEMPT_STATUS.UNAVAILABLE,
          reason: UNAVAILABLE_REASON.TIMEOUT,
          measurement: null
        };
      }
    }

    let response;
    try {
      response = await request({ method: 'GET', headers: { Range: 'bytes=0-0' } });
      const contentType = imageType(response);
      const bytes = totalFromContentRange(response.headers.get('content-range'));
      if (response.status === 206 && contentType && bytes && staysOnOrigin(url, response)) {
        return {
          status: ATTEMPT_STATUS.MEASURED,
          reason: null,
          measurement: { bytes, contentType, source: 'content-range', confidence: 'medium' }
        };
      }
      return {
        status: ATTEMPT_STATUS.UNAVAILABLE,
        reason: UNAVAILABLE_REASON.INVALID_RESPONSE,
        measurement: null
      };
    } catch {
      if (abortedByCaller()) {
        return { status: ATTEMPT_STATUS.CANCELLED, reason: 'aborted', measurement: null };
      }
      if (timedOut || controller.signal.aborted) {
        return {
          status: ATTEMPT_STATUS.UNAVAILABLE,
          reason: UNAVAILABLE_REASON.TIMEOUT,
          measurement: null
        };
      }
      return {
        status: ATTEMPT_STATUS.UNAVAILABLE,
        reason: UNAVAILABLE_REASON.REQUEST_FAILURE,
        measurement: null
      };
    } finally {
      await cancelBody(response);
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.('abort', onCallerAbort);
  }
}

/**
 * Check one URL with HEAD, then a one-byte range request when needed.
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<object|null>}
 */
export async function measureImageResponse(url, options = {}) {
  return (await measureImageResponseDetailed(url, options)).measurement;
}

/** Run response checks through a bounded worker pool. */
export async function measureImageResponses(urls, options = {}) {
  const results = Array(urls.length).fill(null);
  const callerSignal = options.signal;
  const concurrency = Math.max(1, Math.min(options.concurrency || MEASURE_CONCURRENCY, urls.length));
  const measure = options.measure || ((url) => measureImageResponse(url, options));
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (next < urls.length) {
      if (callerSignal?.aborted) break;
      const index = next;
      next += 1;
      try {
        results[index] = await measure(urls[index], index);
      } catch {
        results[index] = null;
      }
      completed += 1;
      options.onProgress?.(completed, urls.length);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * Run a measurement job through the bounded pool, recording a structured
 * attempt outcome per candidate. Unsupported schemes resolve as
 * unavailable/unsupported-scheme without fetching. On caller cancellation the
 * pool aborts active requests, starts nothing new, settles every started
 * operation, preserves completed measurements and marks the never-started
 * remainder cancelled.
 *
 * @param {object} job created by createMeasurementJob.
 * @param {{signal?: AbortSignal, concurrency?: number, onProgress?: Function, measureDetailed?: Function, measure?: Function, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * @returns {Promise<object>} the same job, with attempts recorded.
 */
export async function runMeasurementJob(job, options = {}) {
  const callerSignal = options.signal;
  const total = job?.attempts?.length || 0;
  let completed = 0;
  const progress = () => options.onProgress?.(completed, total);

  const runOne =
    options.measureDetailed ||
    (options.measure
      ? async (url) => {
          const measurement = await options.measure(url);
          return measurement
            ? { status: ATTEMPT_STATUS.MEASURED, reason: null, measurement }
            : {
                status: ATTEMPT_STATUS.UNAVAILABLE,
                reason: UNAVAILABLE_REASON.INVALID_RESPONSE,
                measurement: null
              };
        }
      : (url) => measureImageResponseDetailed(url, options));

  const queue = [];
  for (const attempt of job?.attempts || []) {
    if (attempt.status !== ATTEMPT_STATUS.UNATTEMPTED) {
      completed += 1;
      continue;
    }
    if (typeof attempt.url !== 'string' || !isEligibleMeasurementUrl(attempt.url)) {
      attempt.status = ATTEMPT_STATUS.UNAVAILABLE;
      attempt.reason = UNAVAILABLE_REASON.UNSUPPORTED_SCHEME;
      attempt.measurement = null;
      completed += 1;
      progress();
    } else {
      queue.push(attempt);
    }
  }

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency || MEASURE_CONCURRENCY, queue.length || 1)
  );
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (callerSignal?.aborted) break;
      const attempt = queue[next];
      next += 1;
      attempt.status = ATTEMPT_STATUS.RUNNING;
      try {
        const outcome = await runOne(attempt.url);
        if (outcome && typeof outcome === 'object' && 'status' in outcome) {
          attempt.status = outcome.status;
          attempt.reason = outcome.reason ?? null;
          attempt.measurement = outcome.measurement ?? null;
        } else if (outcome) {
          attempt.status = ATTEMPT_STATUS.MEASURED;
          attempt.reason = null;
          attempt.measurement = outcome;
        } else {
          attempt.status = ATTEMPT_STATUS.UNAVAILABLE;
          attempt.reason = UNAVAILABLE_REASON.INVALID_RESPONSE;
          attempt.measurement = null;
        }
      } catch {
        if (callerSignal?.aborted) {
          attempt.status = ATTEMPT_STATUS.CANCELLED;
          attempt.reason = 'aborted';
        } else {
          attempt.status = ATTEMPT_STATUS.UNAVAILABLE;
          attempt.reason = UNAVAILABLE_REASON.REQUEST_FAILURE;
        }
        attempt.measurement = null;
      }
      completed += 1;
      progress();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  for (const attempt of queue) {
    if (attempt.status === ATTEMPT_STATUS.UNATTEMPTED) {
      attempt.status = ATTEMPT_STATUS.CANCELLED;
      attempt.reason = 'aborted';
      completed += 1;
      progress();
    }
  }
  return job;
}
