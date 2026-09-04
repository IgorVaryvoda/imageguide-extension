/**
 * Capture the popup and full-audit surfaces that the store screenshots frame.
 *
 * The e2e suite captures the same surfaces against the local fixture, which
 * keeps it offline and deterministic. A store screenshot has to show a real
 * audit, so this script runs the same sequence against a public article and
 * writes over `images/screens/`.
 *
 * Run: npm run screens [url]   then: npm run screenshots
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The article the 0.2.0 screenshots audited: many images, stable, public. */
const DEFAULT_URL = 'https://en.wikipedia.org/wiki/History_of_photography';

const POPUP_WIDTH = 436;
const POPUP_HEIGHT = 600;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Write the four popup frames and the full-audit frame.
 *
 * The fixture and a real article disagree on which findings exist, so the
 * caller names the filter chip and the search term to demonstrate.
 */
export async function captureStoreSurfaces(popup, audit, directory, options = {}) {
  const { filterLabel = 'Missing alt', search = 'shared=1' } = options;
  await mkdir(directory, { recursive: true });
  if (popup) {
    // 600 is Chrome's popup ceiling and the height the framing script draws the
    // card at. Capturing shorter leaves an empty strip under every shot.
    // Some Chromium builds reject viewport emulation on the extension popup
    // target; then fall back to the natural viewport instead of failing.
    const framed = await popup
      .setViewport({ width: POPUP_WIDTH, height: POPUP_HEIGHT, deviceScaleFactor: 1 })
      .then(() => true)
      .catch(() => false);
    const screenshot = async (file) => {
      if (!framed) {
        await popup.screenshot({ path: resolve(directory, file), captureBeyondViewport: false });
        return;
      }
      const viewport = await popup.evaluate(() => ({ y: scrollY, height: innerHeight }));
      await popup.screenshot({
        path: resolve(directory, file),
        clip: {
          x: 0,
          y: viewport.y,
          width: POPUP_WIDTH,
          height: Math.min(POPUP_HEIGHT, viewport.height)
        },
        captureBeyondViewport: false
      });
    };
    await popup.evaluate(() => scrollTo(0, 0));
    await screenshot('01-summary.png');
    // One viewport down, not to the end: the list sorts by saving, so the tail
    // is the smallest files on the page and sells nothing.
    await popup.evaluate(() => scrollTo(0, innerHeight));
    await screenshot('02-list.png');
    await popup.evaluate((label) => {
      scrollTo(0, 0);
      const chips = [...document.querySelectorAll('#filters button')];
      // Fall back to the largest finding group when the named one is absent.
      const chip = chips.find((button) => button.textContent.includes(label)) || chips[1];
      chip?.click();
    }, filterLabel);
    await screenshot('03-filter.png');
    await popup.evaluate((term) => {
      document.querySelector('#filters button')?.click();
      const box = document.getElementById('search');
      box.value = term;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, search);
    await screenshot('04-search.png');
  }
  if (audit) {
    // The store frame is 1280x800. Capture at that size so the stat grid is
    // whole, instead of scaling a narrow viewport up and cropping a tile.
    await audit
      .setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
      .catch(() => {});
    await audit.evaluate(() => scrollTo(0, 0));
    await audit.screenshot({ path: resolve(directory, '05-actions.png') });
  }
}

async function waitForExtensionPage(extension, pathname, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of await extension.pages()) {
      try {
        if (new URL(page.url()).pathname === pathname) return page;
      } catch {
        // The extension can briefly expose about:blank while opening a tab.
      }
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for extension page ${pathname}`);
}

async function waitForInstalledExtension(browser, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const installed = [...(await browser.extensions()).values()].find(
      (candidate) => candidate.name === 'ImageGuide — Image Auditor'
    );
    if (installed) return installed;
    await wait(50);
  }
  throw new Error('ImageGuide extension was not loaded');
}

async function waitForResults(page, surface) {
  await page.waitForFunction(
    () => !document.getElementById('results').hidden || !document.getElementById('state-error').hidden,
    { timeout: 30000 }
  );
  const error = await page.$eval('#state-error', (node) => (node.hidden ? '' : node.textContent.trim()));
  if (error) throw new Error(`${surface} failed: ${error}`);
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const browser = await puppeteer.launch({
    headless: true,
    enableExtensions: [root],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  });
  try {
    const extension = await waitForInstalledExtension(browser);
    const target = await browser.newPage();
    await target.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await target.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // A real article lazy-loads. Walk the page so the images decode, then go
    // back to the top so LCP and the viewport findings describe a fresh read.
    await target.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += innerHeight) {
        scrollTo(0, y);
        await new Promise((done) => setTimeout(done, 150));
      }
      scrollTo(0, 0);
    });
    await wait(1500);

    await extension.triggerAction(target);
    const popup = await waitForExtensionPage(extension, '/popup/popup.html');
    await waitForResults(popup, 'popup');

    const directory = resolve(root, 'images/screens');
    await captureStoreSurfaces(popup, null, directory, {
      filterLabel: 'Legacy format',
      search: 'px-'
    });

    // Opening the full audit closes the popup, so read its summary first.
    const summary = await popup.evaluate(() => ({
      saving: document.getElementById('saving').textContent,
      count: document.getElementById('count').textContent,
      grade: document.getElementById('grade').textContent
    }));

    await popup.click('#open-audit');
    const audit = await waitForExtensionPage(extension, '/audit/audit.html');
    await waitForResults(audit, 'full audit');
    await captureStoreSurfaces(null, audit, directory);

    console.log(`Captured ${url}`);
    console.log(`Grade ${summary.grade} · ${summary.count} resources · ${summary.saving} opportunity`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
