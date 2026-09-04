import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';

import puppeteer, { PredefinedNetworkConditions } from 'puppeteer';

import { measureImageResponse } from '../../lib/measure.js';
import { captureStoreSurfaces } from '../../scripts/capture-screens.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

let browser;
let extension;
let server;
let redirectServer;
let baseUrl;
let redirectBaseUrl;
let imageBytes;

function listen(instance) {
  instance.listen(0, '127.0.0.1');
  return once(instance, 'listening');
}

function close(instance) {
  if (!instance) return Promise.resolve();
  return new Promise((resolveClose) => instance.close(resolveClose));
}

async function staticResponse(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, baseUrl).pathname);
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const bytes = await readFile(path);
    response.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'content-length': bytes.length,
      'cache-control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(bytes);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

function endpointResponse(request, response) {
  const pathname = new URL(request.url, baseUrl).pathname;
  const status = /^\/status\/(403|404|405)$/.exec(pathname);
  if (status) {
    response.writeHead(Number(status[1]), {
      'content-type': 'image/png',
      'content-length': imageBytes.length
    }).end(request.method === 'HEAD' ? undefined : imageBytes);
    return true;
  }
  if (pathname === '/auth-image') {
    const allowed = request.headers.cookie?.includes('fixture_session=1');
    response.writeHead(allowed ? 200 : 401, {
      'content-type': allowed ? 'image/png' : 'text/html',
      'content-length': allowed ? imageBytes.length : 12
    }).end(allowed && request.method !== 'HEAD' ? imageBytes : undefined);
    return true;
  }
  if (pathname === '/range-image') {
    if (request.method === 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain' }).end();
    } else if (request.headers.range === 'bytes=0-0') {
      response.writeHead(206, {
        'content-type': 'image/png',
        'content-range': `bytes 0-0/${imageBytes.length}`,
        'content-length': 1
      }).end(imageBytes.subarray(0, 1));
    } else {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': imageBytes.length
      }).end(imageBytes);
    }
    return true;
  }
  if (pathname === '/ignored-range') {
    if (request.method === 'HEAD') response.writeHead(405).end();
    else response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': imageBytes.length
    }).end(imageBytes);
    return true;
  }
  if (pathname === '/redirect-cross-origin') {
    response.writeHead(302, { location: `${redirectBaseUrl}/image` }).end();
    return true;
  }
  return false;
}

async function waitForExtensionPage(pathname, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of await extension.pages()) {
      try {
        if (new URL(page.url()).pathname === pathname) return page;
      } catch {
        // The extension can briefly expose about:blank while opening a tab.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for extension page ${pathname}`);
}

async function waitForInstalledExtension(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const installed = [...(await browser.extensions()).values()].find(
      (candidate) => candidate.name === 'ImageGuide — Image Auditor'
    );
    if (installed) return installed;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('ImageGuide extension was not loaded');
}

async function openPopup(pathname, options = {}) {
  for (const page of await extension.pages()) {
    if (page.url().includes('/popup/popup.html')) await page.close();
  }
  const target = await browser.newPage();
  await target.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  if (options.authCookie) {
    await target.setCookie({ name: 'fixture_session', value: '1', url: baseUrl });
  }
  if (options.slowNetwork) {
    await target.emulateNetworkConditions(PredefinedNetworkConditions['Slow 4G']);
  }
  await target.goto(`${baseUrl}${pathname}`, { waitUntil: 'networkidle0' });
  if (options.ready) {
    await target.waitForFunction(() => globalThis.__fixtureReady === true, { timeout: 15000 });
  }
  if (options.settleMs) {
    await new Promise((resolveWait) => setTimeout(resolveWait, options.settleMs));
  }
  await extension.triggerAction(target);
  const popup = await waitForExtensionPage('/popup/popup.html');
  await popup.waitForFunction(
    () => !document.getElementById('results').hidden || !document.getElementById('state-error').hidden,
    { timeout: 20000 }
  );
  const error = await popup.$eval('#state-error', (node) =>
    node.hidden ? '' : node.textContent.trim()
  );
  assert.equal(error, '', `popup failed: ${error}`);
  return { target, popup };
}

async function openAudit(popup) {
  await popup.click('#open-audit');
  const audit = await waitForExtensionPage('/audit/audit.html');
  await audit.waitForFunction(
    () => !document.getElementById('results').hidden || !document.getElementById('state-error').hidden,
    { timeout: 20000 }
  );
  const error = await audit.$eval('#state-error', (node) =>
    node.hidden ? '' : node.textContent.trim()
  );
  assert.equal(error, '', `full audit failed: ${error}`);
  return audit;
}

async function auditSnapshot(audit) {
  // Usage rows mount on expansion, as for a keyboard/mouse user: open every
  // group with a real toggle, then let the toggle handlers mount the rows.
  await audit.evaluate(async () => {
    for (const summary of document.querySelectorAll('details:not([open]) > summary')) {
      summary.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return audit.evaluate(() => {
    const resources = [...document.querySelectorAll('.resource')].map((card) => ({
      url: card.querySelector('.resource-url')?.textContent || '',
      text: card.textContent,
      usageCount: card.querySelectorAll('.usage-row').length
    }));
    return {
      body: document.body.innerText,
      lcp: document.getElementById('lcp-value').textContent,
      cls: document.getElementById('cls-value').textContent,
      resultCount: document.getElementById('result-count').textContent,
      usageKinds: [...document.querySelectorAll('.usage-row')].map((row) => row.dataset.kind),
      resources
    };
  });
}

async function captureIfRequested(popup, audit = null) {
  const requested = process.env.IMAGEGUIDE_CAPTURE_DIR;
  if (!requested) return;
  await captureStoreSurfaces(popup, audit, resolve(root, requested));
}

describe('ImageGuide extension in Chromium', { timeout: 120000 }, () => {
  before(async () => {
    imageBytes = await readFile(resolve(root, 'icons/icon16.png'));
    redirectServer = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': imageBytes.length
      });
      response.end(request.method === 'HEAD' ? undefined : imageBytes);
    });
    await listen(redirectServer);
    redirectBaseUrl = `http://127.0.0.1:${redirectServer.address().port}`;

    server = createServer(async (request, response) => {
      if (!endpointResponse(request, response)) await staticResponse(request, response);
    });
    await listen(server);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const launch = {
      headless: true,
      enableExtensions: [root],
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      args: process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []
    };
    if (process.env.IMAGEGUIDE_CHROME_CHANNEL === 'chrome') launch.channel = 'chrome';
    browser = await puppeteer.launch(launch);
    extension = await waitForInstalledExtension();
  });

  after(async () => {
    await browser?.close();
    await Promise.all([close(server), close(redirectServer)]);
  });

  afterEach(async () => {
    for (const page of await browser.pages()) {
      if (page.url() !== 'about:blank') await page.close().catch(() => {});
    }
  });

  it('preserves browser evidence and every usage in the persistent full audit', async () => {
    const { target, popup } = await openPopup('/test/fixtures/browser-grade.html', {
      authCookie: true,
      ready: true,
      settleMs: 250
    });
    assert.equal(await popup.$$eval('img', (images) => images.length), 0, 'popup must not refetch thumbnails');
    assert.match(await popup.$eval('#count', (node) => node.textContent), /^\d+$/);
    assert.match(await popup.$eval('#vitals', (node) => node.textContent), /LCP .+ · CLS/);
    await captureIfRequested(popup);

    const audit = await openAudit(popup);
    const snapshot = await auditSnapshot(audit);
    await captureIfRequested(null, audit);
    assert.match(snapshot.lcp, /^\d+\.\d{2} s$/);
    assert.notEqual(snapshot.cls, 'Unsupported');
    assert.ok(Number(snapshot.cls) > 0, `expected buffered layout shift, got ${snapshot.cls}`);

    const widthCandidate = snapshot.resources.find((item) => item.url.includes('width=128'));
    const densityCandidate = snapshot.resources.find((item) => item.url.includes('density=2'));
    const shared = snapshot.resources.find((item) => item.url.includes('shared=1'));
    const imageSet = snapshot.resources.find((item) => item.url.includes('set=2'));
    const fallback = snapshot.resources.find((item) => item.url.includes('fallback=1'));
    const authenticated = snapshot.resources.find((item) => item.url.endsWith('/auth-image'));
    const framed = snapshot.resources.find((item) => item.url.includes('frame-child=1'));
    assert.match(widthCandidate.text, /128×128/);
    assert.match(widthCandidate.text, /128w/);
    assert.match(densityCandidate.text, /128×128/);
    assert.match(densityCandidate.text, /2x/);
    assert.equal(shared.usageCount, 3);
    assert.ok(imageSet, 'browser-selected image-set candidate was not retained');
    assert.ok(!snapshot.resources.some((item) => item.url.includes('set=1')));
    assert.match(fallback.text, /Alt: empty/);
    assert.match(authenticated.text, /resource-timing-encoded · high/);
    assert.match(framed.text, /frame [1-9]/);
    assert.doesNotMatch(snapshot.body, /Unused sources/);
    for (const kind of [
      'background',
      'mask',
      'border',
      'pseudo-before',
      'pseudo-after',
      'svg-image',
      'poster'
    ]) {
      assert.ok(snapshot.usageKinds.includes(kind), `missing ${kind} usage`);
    }
    assert.match(snapshot.body, /canvas element\(s\) were counted/);
    assert.match(snapshot.body, /Browser LCP/);
    assert.match(snapshot.body, /Shift attribution/);

    const before = Number(/\d+/.exec(snapshot.resultCount)[0]);
    await target.evaluate(() => {
      const image = document.createElement('img');
      image.src = `/icons/icon48.png?dynamic=${Date.now()}`;
      image.width = 48;
      image.height = 48;
      image.alt = 'Dynamically added image';
      document.body.append(image);
    });
    await audit.waitForFunction(
      (count) => Number.parseInt(document.getElementById('result-count').textContent, 10) > count,
      { timeout: 10000 },
      before
    );

    await audit.click('.resource-target');
    await target.waitForFunction(() =>
      [...document.querySelectorAll('div')].some((node) => node.style.zIndex === '2147483647')
    );
    await Promise.all([target.close(), audit.close()]);
  });

  it('labels the current viewport after scrolling under a throttled network', async () => {
    const target = await browser.newPage();
    await target.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await target.emulateNetworkConditions(PredefinedNetworkConditions['Slow 4G']);
    await target.goto(`${baseUrl}/test/fixtures/scroll-state.html`, { waitUntil: 'networkidle0' });
    await target.$eval('#current', (node) => node.scrollIntoView());
    await extension.triggerAction(target);
    const popup = await waitForExtensionPage('/popup/popup.html');
    await popup.waitForFunction(() => !document.getElementById('results').hidden);
    const text = await popup.$eval('#images', (node) => node.innerText);
    assert.match(text, /Lazy image visible now/);
    assert.match(text, /Eager image offscreen now/);
    await Promise.all([popup.close(), target.close()]);
  });

  it('reports a saturated Resource Timing buffer', async () => {
    const { target, popup } = await openPopup('/test/fixtures/timing-buffer.html', { ready: true });
    const count = Number(await popup.$eval('#count', (node) => node.textContent));
    assert.ok(count >= 250, `expected at least 250 resources, got ${count}`);
    assert.equal(await popup.$eval('#buffer-note', (node) => node.hidden), false);
    await Promise.all([popup.close(), target.close()]);
  });

  it('bounds an 8,000-element scan and its serialized payload', async () => {
    const { target, popup } = await openPopup('/test/fixtures/large-page.html', { ready: true });
    assert.equal(await popup.$eval('#truncate-note', (node) => node.hidden), false);
    const audit = await openAudit(popup);
    const tabId = Number(new URL(audit.url()).searchParams.get('tab'));
    const metrics = await audit.evaluate(async (targetTabId) => {
      const [{ scanTab }, { analyzePage }, { buildJsonReport }] = await Promise.all([
        import(chrome.runtime.getURL('extension/tab.js')),
        import(chrome.runtime.getURL('lib/analyze.js')),
        import(chrome.runtime.getURL('lib/report.js'))
      ]);
      const result = await scanTab(targetTabId);
      const report = analyzePage(result.page.resources, result.page.usages, result.page);
      return {
        scannedElements: result.page.scannedElements,
        scanDurationMs: result.page.scanDurationMs,
        truncated: result.page.truncated,
        jsonBytes: new TextEncoder().encode(
          buildJsonReport(result.page, report, new Date().toISOString())
        ).length
      };
    }, tabId);
    assert.equal(metrics.scannedElements, 8000);
    assert.equal(metrics.truncated, true);
    assert.ok(metrics.scanDurationMs <= 2000, `scan took ${metrics.scanDurationMs} ms`);
    assert.ok(metrics.jsonBytes <= 1_500_000, `report was ${metrics.jsonBytes} bytes`);
    await Promise.all([target.close(), audit.close()]);
  });

  it('validates live HEAD, range, auth, status, and redirect responses', async () => {
    const ranged = await measureImageResponse(`${baseUrl}/range-image`);
    assert.equal(ranged.bytes, imageBytes.length);
    assert.equal(ranged.source, 'content-range');
    assert.equal(await measureImageResponse(`${baseUrl}/ignored-range`), null);
    assert.equal(await measureImageResponse(`${baseUrl}/auth-image`), null);
    for (const status of [403, 404, 405]) {
      assert.equal(await measureImageResponse(`${baseUrl}/status/${status}`), null);
    }
    assert.equal(await measureImageResponse(`${baseUrl}/redirect-cross-origin`), null);
  });
});
