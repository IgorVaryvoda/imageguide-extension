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

describe('measurement candidates and jobs', () => {
  it('treats only HTTP(S) URLs as eligible', async () => {
    const { isEligibleMeasurementUrl } = await import('../lib/measure.js');
    assert.equal(isEligibleMeasurementUrl('https://cdn.test/a.jpg'), true);
    assert.equal(isEligibleMeasurementUrl('http://cdn.test/a.jpg'), true);
    assert.equal(isEligibleMeasurementUrl('data:image/png;base64,aaa'), false);
    assert.equal(isEligibleMeasurementUrl('blob:https://cdn.test/uuid'), false);
    assert.equal(isEligibleMeasurementUrl('chrome://extensions'), false);
    assert.equal(isEligibleMeasurementUrl('not a url'), false);
    assert.equal(isEligibleMeasurementUrl(null), false);
  });

  it('caps batches at 100 without spending slots on unsupported URLs', async () => {
    const { selectMeasurementCandidates, MAX_MEASURE_CANDIDATES } = await import('../lib/measure.js');
    assert.equal(MAX_MEASURE_CANDIDATES, 100);
    const candidates = [
      'data:image/png;base64,aaa',
      'blob:https://cdn.test/uuid',
      ...Array.from({ length: 105 }, (unused, index) => `https://cdn.test/${index}.jpg`)
    ];
    const batch = selectMeasurementCandidates(candidates);
    assert.equal(batch.length, 100);
    assert.ok(batch.every((url) => url.startsWith('https://')));
    assert.deepEqual(batch.slice(0, 3), [
      'https://cdn.test/0.jpg',
      'https://cdn.test/1.jpg',
      'https://cdn.test/2.jpg'
    ]);
  });

  it('reaches candidate 101 after the first 100 fail, without resetting progress', async () => {
    const {
      createMeasurementJob,
      runMeasurementJob,
      selectJobRetryCandidates,
      summarizeMeasurementJob,
      ATTEMPT_STATUS
    } = await import('../lib/measure.js');
    const all = Array.from({ length: 105 }, (unused, index) => `https://cdn.test/${index}.jpg`);
    const job = createMeasurementJob(
      all.slice(0, 100).map((url) => ({ url })),
      { tabId: 7, documentIdentity: 'doc-a', revision: 'r1' }
    );
    assert.equal(job.tabId, 7);
    assert.equal(job.documentIdentity, 'doc-a');
    await runMeasurementJob(job, { measure: async () => null });
    const summary = summarizeMeasurementJob(job);
    assert.equal(summary.checked, 100);
    assert.equal(summary.unavailable, 100);
    assert.equal(summary.remaining, 0);
    const retry = selectJobRetryCandidates(job, all);
    assert.ok(retry.includes('https://cdn.test/100.jpg'));
    assert.ok(!retry.slice(0, 4).includes('https://cdn.test/0.jpg'));
    const job2 = createMeasurementJob(retry.map((url) => ({ url })));
    await runMeasurementJob(job2, {
      measure: async (url) => (url.endsWith('/100.jpg') ? { bytes: 42 } : null)
    });
    assert.equal(
      job2.attempts.find((attempt) => attempt.url.endsWith('/100.jpg')).status,
      ATTEMPT_STATUS.MEASURED
    );
  });

  it('records structured attempt outcomes without inferring HTTP status', async () => {
    const { measureImageResponseDetailed } = await import('../lib/measure.js');
    let fetched = 0;
    const denied = await measureImageResponseDetailed('data:image/png;base64,aaa', {
      fetchImpl: async () => { fetched += 1; }
    });
    assert.deepEqual(denied, {
      status: 'unavailable',
      reason: 'unsupported-scheme',
      measurement: null
    });
    assert.equal(fetched, 0);

    const opaque = await measureImageResponseDetailed('https://cdn.test/a.jpg', {
      fetchImpl: async () => { throw new TypeError('opaque network failure'); }
    });
    assert.equal(opaque.status, 'unavailable');
    assert.equal(opaque.reason, 'request-failure');
    assert.equal(opaque.measurement, null);
    assert.ok(!('httpStatus' in opaque) && !('status_code' in opaque));

    const slow = await measureImageResponseDetailed('https://cdn.test/slow.jpg', {
      timeoutMs: 5,
      fetchImpl: async (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    });
    assert.deepEqual([slow.status, slow.reason], ['unavailable', 'timeout']);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await measureImageResponseDetailed('https://cdn.test/a.jpg', {
      signal: controller.signal,
      fetchImpl: async () => { throw new Error('must not fetch after abort'); }
    });
    assert.deepEqual([cancelled.status, cancelled.measurement], ['cancelled', null]);
  });

  it('cancels a blocked pool: aborts six, starts nothing new, keeps completed', async () => {
    const { measureImageResponses } = await import('../lib/measure.js');
    const controller = new AbortController();
    const started = [];
    const urls = Array.from({ length: 9 }, (unused, index) => `https://cdn.test/${index}.jpg`);
    const pending = measureImageResponses(urls, {
      concurrency: 6,
      signal: controller.signal,
      measure: (url, index) =>
        new Promise((resolve, reject) => {
          started.push(index);
          if (index === 0) {
            resolve({ bytes: 1 });
            return;
          }
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
        })
    });
    // Six workers dequeue synchronously; abort before any of them can loop.
    controller.abort();
    const results = await pending;
    assert.equal(results.length, 9);
    assert.deepEqual(results[0], { bytes: 1 });
    assert.deepEqual([...started].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(results.slice(1), [null, null, null, null, null, null, null, null]);
    const snapshot = [...results];
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(results, snapshot);
  });

  it('marks unstarted job attempts cancelled on abort and preserves completed', async () => {
    const {
      createMeasurementJob,
      runMeasurementJob,
      summarizeMeasurementJob
    } = await import('../lib/measure.js');
    const controller = new AbortController();
    const started = [];
    const job = createMeasurementJob([
      'https://cdn.test/fast.jpg',
      ...Array.from({ length: 7 }, (unused, index) => `https://cdn.test/${index}.jpg`),
      'data:image/png;base64,aaa'
    ]);
    const pending = runMeasurementJob(job, {
      concurrency: 6,
      signal: controller.signal,
      measureDetailed: (url) => {
        if (url.endsWith('/fast.jpg')) return { status: 'measured', reason: null, measurement: { bytes: 7 } };
        return new Promise((resolve, reject) => {
          started.push(url);
          controller.signal.addEventListener('abort', () =>
            reject(controller.signal.reason)
          );
        });
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await pending;
    const summary = summarizeMeasurementJob(job);
    assert.equal(summary.measured, 1);
    assert.equal(summary.unavailable, 1);
    assert.equal(
      job.attempts.find((attempt) => attempt.url.startsWith('data:')).reason,
      'unsupported-scheme'
    );
    assert.equal(summary.remaining + summary.running, 0);
    assert.equal(summary.checked, job.attempts.length);
    assert.ok(job.attempts.some((attempt) => attempt.status === 'cancelled'));
  });

  it('lets stronger browser evidence win and keeps format provenance separate', async () => {
    const {
      compareMeasurementSources,
      shouldApplyMeasurement,
      applyMeasurementToResource
    } = await import('../lib/measure.js');
    assert.ok(compareMeasurementSources('resource-timing-encoded', 'content-length') > 0);
    assert.ok(compareMeasurementSources('content-range', 'resource-timing-transfer') < 0);
    assert.equal(
      shouldApplyMeasurement(
        { transferBytes: 900, measurementSource: 'resource-timing-encoded' },
        { transferBytes: 1200, measurementSource: 'content-length' }
      ),
      false
    );
    assert.equal(
      shouldApplyMeasurement(
        { transferBytes: 1200, measurementSource: 'content-length' },
        { transferBytes: 900, measurementSource: 'resource-timing-encoded' }
      ),
      true
    );
    const resource = {
      transferBytes: 1200,
      measurementSource: 'content-length',
      measurementConfidence: 'medium',
      contentType: 'image/jpeg'
    };
    const changed = applyMeasurementToResource(resource, {
      bytes: 900,
      contentType: 'image/png',
      source: 'resource-timing-encoded',
      confidence: 'high'
    });
    assert.equal(changed, true);
    assert.equal(resource.transferBytes, 900);
    assert.equal(resource.measurementSource, 'resource-timing-encoded');
    assert.equal(resource.contentType, 'image/jpeg');
  });
});
