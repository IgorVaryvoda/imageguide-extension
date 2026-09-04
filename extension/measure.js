import { measureImageResponses } from '../lib/measure.js';

/**
 * Temporary host permissions for optional response-size checks (slice 01a).
 *
 * Contract for the later UI wave:
 *
 * - Prepare an immutable, versioned lease (PERMISSION_LEASE_VERSION) before
 *   enabling the permission-confirmation button: exact requested patterns
 *   plus the pre-existing grant snapshot. A lease is memory-only and is never
 *   persisted; there is no storage journal and no background worker in this
 *   slice (01b evidence gate not met).
 * - A stale lease (version mismatch, expiry, or changed candidates/patterns)
 *   cannot authorize new candidates: runAuthorizedMeasurement returns
 *   `{outcome: 'stale'}` without requesting permissions or fetching.
 * - Outcomes are structured (measured / denied / cancelled / failed / stale /
 *   busy / blocked) instead of a silent reset, so denial and cancellation
 *   stay visible and retry always needs another explicit user action. Nothing
 *   is ever replayed automatically.
 * - Extension-wide serialization is in-memory: while one lease runs,
 *   getActiveLease() exposes its owner so a second surface can attach to it,
 *   and a second run returns `{outcome: 'busy'}`. NOTE: module state is
 *   per-document (popup and audit are separate JS contexts), so true
 *   cross-context serialization still needs the 01b lifetime proof and its
 *   coordinator; until then the busy state covers concurrent runs sharing
 *   this module and the manual 01b fixtures cover the cross-context cases.
 * - Cleanup removes only origins granted for this check. Pre-existing exact
 *   or covering grants are never removed. A removal failure is recorded via
 *   getPendingCleanup(), blocks new runs (`blocked` outcome) until
 *   resolvePendingCleanup() reconciles it externally, and is never guessed
 *   away.
 */

export function originPattern(url) {
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `${protocol}//${host}/*`;
  } catch {
    return null;
  }
}

export async function snapshotPermissions(resources) {
  const origins = [...new Set(resources.map((resource) => originPattern(resource.url)).filter(Boolean))];
  const values = await Promise.all(
    origins.map((origin) => chrome.permissions.contains({ origins: [origin] }))
  );
  return new Map(origins.map((origin, index) => [origin, values[index]]));
}

/** Lease schema version. A lease prepared under another version is stale. */
export const PERMISSION_LEASE_VERSION = 1;
/** A prepared lease expires; afterwards preparing again needs another click. */
export const PERMISSION_LEASE_TTL_MS = 5 * 60 * 1000;

let leaseSequence = 0;
/** In-memory owner of the running check, if any. Never persisted. */
let activeLease = null;
/** Unresolved cleanup metadata. Blocks new runs until reconciled. */
let pendingCleanup = null;

/** Current run owner for attach-or-busy surfaces, or null when idle. */
export function getActiveLease() {
  return activeLease ? { ...activeLease, patterns: [...activeLease.patterns] } : null;
}

/** Recorded removal failure blocking new runs, or null when clean. */
export function getPendingCleanup() {
  return pendingCleanup
    ? { ...pendingCleanup, patterns: [...pendingCleanup.patterns] }
    : null;
}

/**
 * Clear a recorded cleanup failure after externally verifying actual
 * permission state. Returns the cleared record, or null when clean.
 */
export function resolvePendingCleanup() {
  const cleared = pendingCleanup;
  pendingCleanup = null;
  return cleared;
}

function patternsFor(resources) {
  return [
    ...new Set(
      (resources || []).map((resource) => originPattern(resource?.url)).filter(Boolean)
    )
  ].sort();
}

function candidateKeysFor(resources) {
  return (resources || []).map((resource) => resource?.url).sort();
}

function permissionsApi(options = {}) {
  return options.permissions ?? globalThis.chrome?.permissions ?? null;
}

/**
 * Prepare an immutable versioned lease: exact requested patterns plus the
 * pre-existing grant snapshot for the current candidate set. Call this before
 * enabling the final permission-confirmation button.
 */
export async function preparePermissionLease(resources, options = {}) {
  const api = permissionsApi(options);
  if (!api) throw new Error('permissions API unavailable');
  const patterns = patternsFor(resources);
  const values = await Promise.all(
    patterns.map((pattern) => api.contains({ origins: [pattern] }))
  );
  const preexisting = {};
  patterns.forEach((pattern, index) => {
    preexisting[pattern] = values[index] === true;
  });
  const lease = {
    version: PERMISSION_LEASE_VERSION,
    leaseId: options.leaseId ?? `permission-lease-${(leaseSequence += 1)}`,
    patterns,
    preexisting,
    candidateKeys: candidateKeysFor(resources),
    createdAt: Date.now(),
    maxAgeMs: options.maxAgeMs ?? PERMISSION_LEASE_TTL_MS
  };
  return Object.freeze({ ...lease, patterns: [...patterns], preexisting: { ...preexisting } });
}

/** Why a lease cannot authorize `resources`, or null when it can. */
export function staleLeaseReason(lease, resources) {
  if (!lease || lease.version !== PERMISSION_LEASE_VERSION) return 'version-mismatch';
  if (
    typeof lease.createdAt !== 'number' ||
    Date.now() - lease.createdAt > (lease.maxAgeMs ?? PERMISSION_LEASE_TTL_MS)
  ) {
    return 'expired';
  }
  if (JSON.stringify([...(lease.patterns || [])].sort()) !== JSON.stringify(patternsFor(resources))) {
    return 'candidates-changed';
  }
  if (
    JSON.stringify([...(lease.candidateKeys || [])].sort()) !==
    JSON.stringify(candidateKeysFor(resources))
  ) {
    return 'candidates-changed';
  }
  return null;
}

/** True when the lease must not enable or authorize the current candidates. */
export function isLeaseStale(lease, resources) {
  return staleLeaseReason(lease, resources) !== null;
}

function leaseFromSnapshot(resources, snapshot) {
  const patterns = patternsFor(resources);
  const preexisting = {};
  for (const pattern of patterns) {
    preexisting[pattern] = snapshot?.get?.(pattern) === true;
  }
  return {
    version: PERMISSION_LEASE_VERSION,
    leaseId: `permission-lease-${(leaseSequence += 1)}`,
    patterns,
    preexisting,
    candidateKeys: candidateKeysFor(resources),
    createdAt: Date.now(),
    maxAgeMs: PERMISSION_LEASE_TTL_MS
  };
}

/**
 * Run response checks under a prepared lease. Never requests permissions or
 * fetches for a stale lease; never removes a pre-existing grant; never
 * replays automatically. Returns a structured outcome:
 * measured / denied / cancelled / failed / stale / busy / blocked.
 */
export async function runAuthorizedMeasurement(resources, lease, options = {}) {
  const stale = staleLeaseReason(lease, resources);
  if (stale) {
    return { outcome: 'stale', reason: stale, requiresUserAction: true, results: [] };
  }
  if (pendingCleanup) {
    return {
      outcome: 'blocked',
      reason: 'pending-cleanup',
      patterns: [...pendingCleanup.patterns],
      requiresUserAction: true,
      results: []
    };
  }
  if (activeLease) {
    return {
      outcome: 'busy',
      reason: 'lease-active',
      owner: getActiveLease(),
      attachable: true,
      requiresUserAction: false,
      results: []
    };
  }
  const callerSignal = options.signal;
  if (callerSignal?.aborted) {
    return { outcome: 'cancelled', reason: 'aborted', requiresUserAction: false, results: [] };
  }
  const api = permissionsApi(options);
  if (!api) {
    return {
      outcome: 'failed',
      reason: 'permissions-unavailable',
      requiresUserAction: true,
      results: []
    };
  }

  activeLease = { leaseId: lease.leaseId, patterns: [...lease.patterns], startedAt: Date.now() };
  const grantedForCheck = [];
  let results = [];
  try {
    const newlyGranted = lease.patterns.filter((pattern) => !lease.preexisting[pattern]);
    if (newlyGranted.length) {
      let granted;
      try {
        granted = await api.request({ origins: newlyGranted });
      } catch (error) {
        return {
          outcome: 'failed',
          reason: 'permission-request-failed',
          error: error?.message ?? String(error),
          requiresUserAction: true,
          results: []
        };
      }
      if (callerSignal?.aborted) {
        return { outcome: 'cancelled', reason: 'aborted', requiresUserAction: false, results: [] };
      }
      if (!granted) {
        return {
          outcome: 'denied',
          reason: 'user-denied',
          requiresUserAction: true,
          results: []
        };
      }
      grantedForCheck.push(...newlyGranted);
    }

    const eligible = (resources || [])
      .map((resource, index) => ({ resource, index }))
      .filter(({ resource }) => originPattern(resource?.url));
    const measured = Array((resources || []).length).fill(null);
    if (eligible.length) {
      const partial = await measureImageResponses(
        eligible.map(({ resource }) => resource.url),
        {
          onProgress: options.onProgress,
          signal: callerSignal,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          concurrency: options.concurrency
        }
      );
      eligible.forEach(({ index }, position) => {
        measured[index] = partial[position];
      });
    }
    results = measured;
    if (callerSignal?.aborted) {
      return { outcome: 'cancelled', reason: 'aborted', requiresUserAction: false, results };
    }
    return {
      outcome: 'measured',
      reason: null,
      requiresUserAction: false,
      results,
      granted: [...grantedForCheck]
    };
  } catch (error) {
    return {
      outcome: 'failed',
      reason: 'measurement-failed',
      error: error?.message ?? String(error),
      requiresUserAction: true,
      results
    };
  } finally {
    if (grantedForCheck.length) {
      try {
        await api.remove({ origins: grantedForCheck });
      } catch {
        pendingCleanup = {
          leaseId: lease.leaseId,
          patterns: [...grantedForCheck],
          recordedAt: Date.now()
        };
      }
    }
    activeLease = null;
  }
}

/**
 * Measure resources and remove only origins granted by this user action.
 * Thin backward-compatible wrapper: returns the results array on success
 * and [] for denial/cancel/failure/stale/busy, as before.
 */
export async function measureResources(resources, snapshot, onProgress) {
  const lease = leaseFromSnapshot(resources, snapshot);
  const outcome = await runAuthorizedMeasurement(resources, lease, { onProgress });
  return outcome.outcome === 'measured' ? outcome.results : [];
}
