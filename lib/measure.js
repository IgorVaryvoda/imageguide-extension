/**
 * Validate optional response-size checks without pretending they reproduce the
 * page's original request. Pure web APIs only, so Node can test the behavior.
 */

export const MEASURE_CONCURRENCY = 6;
export const MEASURE_TIMEOUT_MS = 8000;

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
 *
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * @returns {Promise<object|null>}
 */
export async function measureImageResponse(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MEASURE_TIMEOUT_MS);
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
        return { bytes, contentType, source: 'content-length', confidence: 'medium' };
      }
      await cancelBody(response);
    } catch {
      if (controller.signal.aborted) return null;
    }

    let response;
    try {
      response = await request({ method: 'GET', headers: { Range: 'bytes=0-0' } });
      const contentType = imageType(response);
      const bytes = totalFromContentRange(response.headers.get('content-range'));
      if (response.status === 206 && contentType && bytes && staysOnOrigin(url, response)) {
        return { bytes, contentType, source: 'content-range', confidence: 'medium' };
      }
      return null;
    } catch {
      return null;
    } finally {
      await cancelBody(response);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Run response checks through a bounded worker pool. */
export async function measureImageResponses(urls, options = {}) {
  const results = Array(urls.length).fill(null);
  const concurrency = Math.max(1, Math.min(options.concurrency || MEASURE_CONCURRENCY, urls.length));
  const measure = options.measure || ((url) => measureImageResponse(url, options));
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (next < urls.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await measure(urls[index]);
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
