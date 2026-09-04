/**
 * One-shot popup → full-audit handoff payloads.
 *
 * Pure helpers only (no chrome APIs) so Node can test the contract.
 * Storage itself lives in `extension/handoff.js`. Audited URLs travel only
 * through extension-internal session storage under a random one-use token;
 * they never appear in the navigation query string.
 */

export const HANDOFF_VERSION = 1;
/** A prepared handoff expires; afterwards the audit scans fresh. */
export const HANDOFF_TTL_MS = 60 * 1000;
/** Aggregate serialized cap: never larger than the page payload budget. */
export const HANDOFF_MAX_BYTES = 4_000_000;

export function handoffKey(token) {
  return `imageguide-handoff:${token}`;
}

function byteSize(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return value.length;
}
export function createHandoffPayload(input = {}) {
  const measurements = (input.measurements || []).filter(
    (record) =>
      record &&
      typeof record.url === 'string' &&
      record.url.length > 0 &&
      Number(record.bytes) > 0 &&
      typeof record.source === 'string' &&
      record.source.length > 0
  );
  const payload = {
    version: HANDOFF_VERSION,
    token: input.token || '',
    createdAt: input.createdAt ?? Date.now(),
    tabId: input.tabId ?? null,
    documentToken: input.documentToken || '',
    revision: input.revision || '',
    schemaVersion: input.schemaVersion ?? null,
    modelVersion: input.modelVersion || '',
    measurements: measurements.map((record) => ({
      url: record.url,
      bytes: Number(record.bytes),
      contentType: record.contentType || '',
      source: record.source,
      confidence: record.confidence || 'low'
    })),
    attempts: (input.attempts || []).map((attempt) => ({
      key: attempt.key,
      status: attempt.status,
      reason: attempt.reason ?? null
    })),
    ui: {
      filter: input.ui?.filter || 'all',
      sort: input.ui?.sort || 'saving',
      search: input.ui?.search || ''
    }
  };
  if (byteSize(JSON.stringify(payload)) > HANDOFF_MAX_BYTES) {
    throw new Error('handoff payload exceeds the serialized cap');
  }
  return payload;
}

/**
 * Verify a consumed payload against the audit's fresh evidence.
 * Returns {ok:true} or {ok:false, reason} — never throws for stale input.
 */
export function validateHandoff(payload, current = {}) {
  if (!payload || payload.version !== HANDOFF_VERSION) return { ok: false, reason: 'version-mismatch' };
  if (typeof payload.createdAt !== 'number' || Date.now() - payload.createdAt > HANDOFF_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.tabId == null || current.tabId == null || payload.tabId !== current.tabId) {
    return { ok: false, reason: 'tab-mismatch' };
  }
  if (!payload.documentToken || payload.documentToken !== current.documentToken) {
    return { ok: false, reason: 'document-changed' };
  }
  if (
    payload.schemaVersion != null &&
    current.schemaVersion != null &&
    payload.schemaVersion !== current.schemaVersion
  ) {
    return { ok: false, reason: 'schema-mismatch' };
  }
  return { ok: true, reason: null };
}
