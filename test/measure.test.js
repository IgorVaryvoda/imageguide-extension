import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  measureImageResponse,
  measureImageResponses,
  totalFromContentRange
} from '../lib/measure.js';

function response(status, headers = {}, onCancel = () => {}, url = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers(headers),
    body: { cancel: async () => onCancel() }
  };
}

describe('totalFromContentRange', () => {
  it('accepts a validated byte range and rejects malformed totals', () => {
    assert.equal(totalFromContentRange('bytes 0-0/12345'), 12345);
    assert.equal(totalFromContentRange('bytes 0-99/12345'), 0);
    assert.equal(totalFromContentRange('bytes 1-1/12345'), 0);
    assert.equal(totalFromContentRange('bytes 0-0/*'), 0);
    assert.equal(totalFromContentRange('garbage/12345'), 0);
  });
});

describe('measureImageResponse', () => {
  it('accepts a successful image HEAD response', async () => {
    const calls = [];
    let cancelled = 0;
    const result = await measureImageResponse('https://cdn.test/a.jpg', {
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return response(
          200,
          { 'content-type': 'image/jpeg', 'content-length': '1234' },
          () => cancelled++
        );
      }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].method, 'HEAD');
    assert.equal(calls[0][1].credentials, 'omit');
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(cancelled, 1);
    assert.deepEqual(result, {
      bytes: 1234,
      contentType: 'image/jpeg',
      source: 'content-length',
      confidence: 'medium'
    });
  });

  it('rejects an HTML error size and accepts a valid 206 range total', async () => {
    let calls = 0;
    let cancelled = 0;
    const result = await measureImageResponse('https://cdn.test/a.jpg', {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return response(
            403,
            { 'content-type': 'text/html', 'content-length': '9999' },
            () => cancelled++
          );
        }
        return response(
          206,
          { 'content-type': 'image/webp', 'content-range': 'bytes 0-0/4567' },
          () => cancelled++
        );
      }
    });

    assert.equal(calls, 2);
    assert.equal(cancelled, 2);
    assert.equal(result.bytes, 4567);
    assert.equal(result.source, 'content-range');
  });

  it('rejects and cancels a server that ignores the Range header', async () => {
    let calls = 0;
    let cancelled = 0;
    const result = await measureImageResponse('https://cdn.test/a.jpg', {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response(405, { 'content-type': 'text/html' });
        return response(
          200,
          { 'content-type': 'image/jpeg', 'content-length': '999999' },
          () => cancelled++
        );
      }
    });

    assert.equal(result, null);
    assert.equal(cancelled, 1);
  });

  it('rejects 403, 404, and 405 response bodies as image measurements', async () => {
    for (const status of [403, 404, 405]) {
      const result = await measureImageResponse('https://cdn.test/a.jpg', {
        fetchImpl: async () => response(status, {
          'content-type': 'image/jpeg',
          'content-length': '9999'
        })
      });
      assert.equal(result, null);
    }
  });

  it('rejects a cross-origin redirect result', async () => {
    let calls = 0;
    const result = await measureImageResponse('https://cdn.test/a.jpg', {
      fetchImpl: async () => {
        calls += 1;
        return response(
          calls === 1 ? 200 : 206,
          calls === 1
            ? { 'content-type': 'image/jpeg', 'content-length': '1234' }
            : { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-0/1234' },
          () => {},
          'https://other.test/a.jpg'
        );
      }
    });
    assert.equal(result, null);
  });

  it('aborts a stalled request', async () => {
    const result = await measureImageResponse('https://cdn.test/slow.jpg', {
      timeoutMs: 5,
      fetchImpl: async (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    });

    assert.equal(result, null);
  });
});

describe('measureImageResponses', () => {
  it('bounds concurrency and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const progress = [];
    const urls = Array.from({ length: 12 }, (unused, index) => `https://cdn.test/${index}.jpg`);
    const results = await measureImageResponses(urls, {
      concurrency: 4,
      onProgress: (done, total) => progress.push([done, total]),
      measure: async (url) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { bytes: Number(/(\d+)/.exec(url)[1]) + 1 };
      }
    });

    assert.equal(peak, 4);
    assert.deepEqual(
      results.map((result) => result.bytes),
      Array.from({ length: 12 }, (unused, index) => index + 1)
    );
    assert.deepEqual(progress.at(-1), [12, 12]);
  });
});
