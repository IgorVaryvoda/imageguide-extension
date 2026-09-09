/**
 * Write the shared Press handoff fixture that the Rust consumer reads.
 *
 * The fixture input and the emitted text live here so the checked-in file and
 * the unit test cannot drift: the test regenerates from these exports instead
 * of restating the payload. Importing this module never writes; only running
 * it does.
 *
 * Run: npm run write-press-fixture
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { buildPressHandoff } from '../lib/press-export.js';

/** The checked-in fixture the Press consumer and the unit test both read. */
export const PRESS_FIXTURE_PATH = new URL('../test/fixtures/press-handoff.json', import.meta.url);

/** Fixed input: private page facts and URL secrets that must not survive export. */
export const PRESS_FIXTURE_INPUT = {
  page: {
    pageUrl: 'https://fixture.test/private?secret=1',
    pageTitle: 'fixture-private-title',
    scannedElements: 2,
    frameCount: 1
  },
  report: {
    resources: [
      {
        id: 'hero',
        url: 'https://cdn.fixture.test/private/hero.jpg?token=fixture-secret#fragment',
        format: 'jpeg',
        formatProvenance: 'observed',
        recommendedFormat: 'avif',
        bytes: 900000,
        byteState: 'measured',
        measured: true,
        sourcePixelWidth: 2400,
        sourcePixelHeight: 1600,
        resizeWidth: 1200,
        resizeHeight: 800,
        issues: ['oversized', 'heavy'],
        isDataUri: false,
        usages: [{ kind: 'img', issues: ['noAlt'] }]
      },
      {
        id: 'icon',
        url: 'https://cdn.fixture.test/icon.webp',
        format: 'webp',
        formatProvenance: 'hint',
        recommendedFormat: 'avif',
        bytes: 3200,
        byteState: 'estimated',
        measured: false,
        sourcePixelWidth: 64,
        sourcePixelHeight: 64,
        resizeWidth: 64,
        resizeHeight: 64,
        issues: [],
        isDataUri: false,
        usages: [{ kind: 'img', issues: [] }]
      }
    ]
  },
  options: {
    observed: '2026-09-08T00:00:00.000Z',
    producerRevision: 'press-export-1',
    producerVersion: '0.5.0'
  }
};

/** Build the fixture export from the fixed input. */
export function buildPressFixture() {
  const { page, report, options } = PRESS_FIXTURE_INPUT;
  return buildPressHandoff(page, report, options);
}

/** The exact file text the fixture holds, including its trailing newline. */
export function pressFixtureText() {
  return `${buildPressFixture().json}\n`;
}

/** Write the fixture to disk. */
export async function writePressFixture() {
  await mkdir(new URL('.', PRESS_FIXTURE_PATH), { recursive: true });
  await writeFile(PRESS_FIXTURE_PATH, pressFixtureText());
}

if (argv[1] && pathToFileURL(argv[1]).href === import.meta.url) {
  await writePressFixture();
}
