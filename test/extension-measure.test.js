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
