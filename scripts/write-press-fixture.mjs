import { mkdir, writeFile } from 'node:fs/promises';

import { buildPressHandoff } from '../lib/press-export.js';

const resources = [
  {
    id: 'hero',
    url: 'https://cdn.fixture.test/private/hero.jpg?token=fixture-secret#fragment',
    format: 'jpeg',
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
];

const exported = buildPressHandoff(
  { pageUrl: 'https://fixture.test/private?secret=1', pageTitle: 'fixture-private-title' },
  { resources },
  {
    observed: '2026-09-08T00:00:00.000Z',
    producerRevision: 'press-export-1',
    producerVersion: '0.5.0'
  }
);
const target = new URL('../test/fixtures/press-handoff.json', import.meta.url);
await mkdir(new URL('.', target), { recursive: true });
await writeFile(target, `${exported.json}\n`);
