import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { measureResources, snapshotPermissions } from '../extension/measure.js';

const savedChrome = globalThis.chrome;
const savedFetch = globalThis.fetch;

afterEach(() => {
  if (savedChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = savedChrome;
  globalThis.fetch = savedFetch;
});

describe('temporary host permissions', () => {
  it('removes only origins granted for the response check', async () => {
    const requested = [];
    const removed = [];
    globalThis.chrome = {
      permissions: {
        contains: async ({ origins }) => origins[0] === 'https://kept.test/*',
        request: async ({ origins }) => {
          requested.push(...origins);
          return true;
        },
        remove: async ({ origins }) => {
          removed.push(...origins);
          return true;
        }
      }
    };
    globalThis.fetch = async () => new Response(null, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '123' }
    });
    const resources = [
      { url: 'https://kept.test/image.png' },
      { url: 'https://temporary.test/image.png' }
    ];
    const snapshot = await snapshotPermissions(resources);
    const results = await measureResources(resources, snapshot);

    assert.equal(results.length, 2);
    assert.deepEqual(requested, ['https://temporary.test/*']);
    assert.deepEqual(removed, ['https://temporary.test/*']);
  });

  it('does not remove a permission when the user declines it', async () => {
    let removed = false;
    let fetched = false;
    globalThis.chrome = {
      permissions: {
        request: async () => false,
        remove: async () => { removed = true; }
      }
    };
    globalThis.fetch = async () => { fetched = true; };
    const results = await measureResources(
      [{ url: 'https://declined.test/image.png' }],
      new Map([['https://declined.test/*', false]])
    );

    assert.deepEqual(results, []);
    assert.equal(removed, false);
    assert.equal(fetched, false);
  });
});

describe('permission leases and structured outcomes', () => {
  it('surfaces denial visibly and requires another user action to retry', async () => {
    const { preparePermissionLease, runAuthorizedMeasurement } = await import(
      '../extension/measure.js'
    );
    let requested = 0;
    let fetched = false;
    const permissions = {
      contains: async () => false,
      request: async () => { requested += 1; return false; },
      remove: async () => { throw new Error('must not remove a declined grant'); }
    };
    globalThis.fetch = async () => { fetched = true; };
    const resources = [{ url: 'https://declined.test/image.png' }];
    const lease = await preparePermissionLease(resources, { permissions });
    assert.equal(lease.version, 1);
    const outcome = await runAuthorizedMeasurement(resources, lease, { permissions });
    assert.deepEqual(outcome.results, []);
    assert.deepEqual([outcome.outcome, outcome.reason], ['denied', 'user-denied']);
    assert.equal(outcome.requiresUserAction, true);
    assert.equal(requested, 1);
    assert.equal(fetched, false);
  });

  it('refuses a stale snapshot for new candidates without requesting or fetching', async () => {
    const { preparePermissionLease, runAuthorizedMeasurement, isLeaseStale } = await import(
      '../extension/measure.js'
    );
    let requested = 0;
    let fetched = false;
    const permissions = {
      contains: async () => false,
      request: async () => { requested += 1; return true; },
      remove: async () => {}
    };
    globalThis.fetch = async () => { fetched = true; };
    const before = [{ url: 'https://cdn.test/before.jpg' }];
    const after = [
      { url: 'https://cdn.test/before.jpg' },
      { url: 'https://cdn.test/added.jpg' }
    ];
    const lease = await preparePermissionLease(before, { permissions });
    assert.equal(isLeaseStale(lease, before), false);
    assert.equal(isLeaseStale(lease, after), true);
    const outcome = await runAuthorizedMeasurement(after, lease, { permissions });
    assert.deepEqual([outcome.outcome, outcome.reason], ['stale', 'candidates-changed']);
    assert.equal(requested, 0);
    assert.equal(fetched, false);
  });

  it('treats a foreign lease version as stale', async () => {
    const { preparePermissionLease, runAuthorizedMeasurement } = await import(
      '../extension/measure.js'
    );
    const permissions = { contains: async () => true };
    const resources = [{ url: 'https://cdn.test/a.jpg' }];
    const lease = await preparePermissionLease(resources, { permissions });
    const outcome = await runAuthorizedMeasurement(resources, { ...lease, version: 999 }, {
      permissions
    });
    assert.deepEqual([outcome.outcome, outcome.reason], ['stale', 'version-mismatch']);
  });

  it('serializes two surfaces on a shared origin: attach-or-busy, no replay', async () => {
    const {
      preparePermissionLease,
      runAuthorizedMeasurement,
      getActiveLease
    } = await import('../extension/measure.js');
    const permissions = {
      contains: async () => false,
      request: async () => true,
      remove: async () => {}
    };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '64' }
      });
    const first = [{ url: 'https://shared.test/a.jpg' }];
    const second = [{ url: 'https://shared.test/b.jpg' }];
    const leaseA = await preparePermissionLease(first, { permissions });
    const leaseB = await preparePermissionLease(second, { permissions });
    const running = runAuthorizedMeasurement(first, leaseA, {
      permissions,
      fetchImpl: async () => { await gate; return globalThis.fetch(); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(getActiveLease()?.leaseId === leaseA.leaseId);
    const busy = await runAuthorizedMeasurement(second, leaseB, { permissions });
    assert.equal(busy.outcome, 'busy');
    assert.equal(busy.owner?.leaseId, leaseA.leaseId);
    assert.equal(busy.attachable, true);
    assert.deepEqual(busy.results, []);
    release();
    const done = await running;
    assert.equal(done.outcome, 'measured');
    assert.equal(done.results.length, 1);
    assert.equal(getActiveLease(), null);
  });

  it('records failed cleanup and blocks the next lease until reconciled', async () => {
    const {
      preparePermissionLease,
      runAuthorizedMeasurement,
      getPendingCleanup,
      resolvePendingCleanup
    } = await import('../extension/measure.js');
    try {
      const removed = [];
      const permissions = {
        contains: async () => false,
        request: async () => true,
        remove: async () => { throw new Error('removal failed'); }
      };
      globalThis.fetch = async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '64' }
        });
      const resources = [{ url: 'https://temporary.test/image.png' }];
      const lease = await preparePermissionLease(resources, { permissions });
      const done = await runAuthorizedMeasurement(resources, lease, {
        permissions,
        fetchImpl: () => globalThis.fetch()
      });
      assert.equal(done.outcome, 'measured');
      assert.deepEqual(getPendingCleanup()?.patterns, ['https://temporary.test/*']);
      const next = await preparePermissionLease(resources, { permissions });
      const blocked = await runAuthorizedMeasurement(resources, next, { permissions });
      assert.deepEqual([blocked.outcome, blocked.reason], ['blocked', 'pending-cleanup']);
      assert.equal(blocked.requiresUserAction, true);
      assert.deepEqual(removed, []);
    } finally {
      resolvePendingCleanup();
    }
    assert.equal(getPendingCleanup(), null);
  });

  it('keeps pre-existing exact and covering grants across cleanup', async () => {
    const { preparePermissionLease, runAuthorizedMeasurement } = await import(
      '../extension/measure.js'
    );
    const removed = [];
    const permissions = {
      contains: async ({ origins }) => origins[0] !== 'https://temporary.test/*',
      request: async ({ origins }) => true,
      remove: async ({ origins }) => { removed.push(...origins); }
    };
    globalThis.fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '64' }
      });
    const resources = [
      { url: 'https://kept.test/image.png' },
      { url: 'https://temporary.test/image.png' }
    ];
    const lease = await preparePermissionLease(resources, { permissions });
    assert.deepEqual(lease.preexisting, {
      'https://kept.test/*': true,
      'https://temporary.test/*': false
    });
    const outcome = await runAuthorizedMeasurement(resources, lease, {
      permissions,
      fetchImpl: () => globalThis.fetch()
    });
    assert.equal(outcome.outcome, 'measured');
    assert.deepEqual(removed, ['https://temporary.test/*']);
  });

  it('cancels mid-run with completed work preserved and the grant released', async () => {
    const { preparePermissionLease, runAuthorizedMeasurement, getActiveLease } = await import(
      '../extension/measure.js'
    );
    const removed = [];
    const permissions = {
      contains: async () => false,
      request: async () => true,
      remove: async ({ origins }) => { removed.push(...origins); }
    };
    const controller = new AbortController();
    const resources = [{ url: 'https://slow.test/image.png' }];
    const lease = await preparePermissionLease(resources, { permissions });
    const pending = runAuthorizedMeasurement(resources, lease, {
      permissions,
      signal: controller.signal,
      fetchImpl: (url, init) =>
        new Promise((resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
        })
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.outcome, 'cancelled');
    assert.deepEqual(removed, ['https://slow.test/*']);
    assert.equal(getActiveLease(), null);
  });
});

describe('01b manual lifetime fixtures (require an installed extension)', () => {
  // These cases cannot run in Node: they need real user gestures, permission
  // dialogs, document closure and extension-context termination. Each is an
  // explicit skipped fixture with manual steps — never a mocked pass. Until
  // executed against the packaged build, the release gate stays Not run.
  const MANUAL = `
    1. Load the packaged extension in Chrome (chrome://extensions).
    2. Open chrome://extensions in a second window for independent inspection.
    3. Perform the steps below, then inspect effective host permissions from
       the second window (a surviving independent context, not the closed UI).
    4. Record pass/fail per case in the release notes.
  `;
  it.skip('grant then close the popup during a slow request cleans up', () => {
    // Steps: throttle the target to 20s via DevTools, start "Check response
    // sizes" from the popup, close the popup (focus leaves it) mid-request,
    // then prove from the independent window that the temporary origin is
    // gone or that the documented recovery path fired. Manual: MANUAL.
    void MANUAL;
  });
  it.skip('denial leaves no grant and retry needs another click', () => {
    // Steps: decline the permission dialog, assert no network checks start
    // and the outcome stays visible; retry must need another explicit click
    // with no automatic prompt loop. Manual: MANUAL.
    void MANUAL;
  });
  it.skip('closing the audit after granting cleans up', () => {
    // Steps: grant from the audit surface, close the audit tab mid-check,
    // prove cleanup or documented recovery from the independent window.
    // Manual: MANUAL.
    void MANUAL;
  });
  it.skip('navigating the target invalidates the in-flight job', () => {
    // Steps: start a check on page A, navigate A to B (same image URL),
    // prove A's delayed sizes never appear in B, including reload at the
    // same URL. Manual: MANUAL.
    void MANUAL;
  });
  it.skip('pre-existing exact and wildcard grants survive cleanup', () => {
    // Steps: pre-grant the exact origin and a broader covering pattern,
    // run a check, prove both grants still exist afterwards. The check must
    // remove only access attributable to its own lease. Manual: MANUAL.
    void MANUAL;
  });
  it.skip('removal failure stays recorded and blocks the next lease', () => {
    // Steps: force chrome.permissions.remove to fail (e.g. revoke via
    // chrome://extensions mid-check), assert the warning persists, new
    // checks are blocked, and no broad host-permission clearing happens.
    // Manual: MANUAL.
    void MANUAL;
  });
  it.skip('terminating the extension context follows the recovery path', () => {
    // Steps: grant, then terminate the context (extension reload/disable);
    // on next enable, assert the documented recovery behavior (reconcile
    // before new work, no silent replay). Manual: MANUAL.
    void MANUAL;
  });
});
