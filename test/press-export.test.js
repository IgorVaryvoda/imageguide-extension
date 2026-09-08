import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildPressHandoff,
  PRESS_HANDOFF_SCHEMA,
  PRESS_MAX_FILE_BYTES,
  PRESS_MAX_LIST_ENTRIES,
  PRESS_MAX_RESOURCES,
  PRESS_MAX_STRING_CHARS
} from '../lib/press-export.js';

const fixturePath = new URL('./fixtures/press-handoff.json', import.meta.url);

function resource(id, url, overrides = {}) {
  const value = {
    id,
    url,
    format: 'jpeg',
    recommendedFormat: 'avif',
    bytes: 1200,
    byteState: 'measured',
    measured: true,
    sourcePixelWidth: 3000,
    sourcePixelHeight: 2000,
    resizeWidth: 1200,
    resizeHeight: 800,
    issues: ['oversized'],
    isDataUri: false,
    usages: [{ kind: 'img', issues: ['noAlt'] }],
    ...overrides
  };
  value.allIssues = [...new Set([
    ...value.issues,
    ...value.usages.flatMap((usage) => usage.issues || [])
  ])];
  return value;
}

function report(resources) {
  return { resources };
}

describe('Press handoff export', () => {
  it('redacts page data and URL credentials, query, fragment, and directories', () => {
    const exported = buildPressHandoff(
      { pageUrl: 'https://private.test/account?token=secret', pageTitle: 'Private customer name' },
      report([resource(
        'r1',
        'https://user:password@cdn.test/private/customer/hero.jpg?token=secret#private'
      )]),
      { observed: '2026-09-08T00:00:00.000Z' }
    );
    const json = exported.json;
    const parsed = JSON.parse(json);
    const record = parsed.resources[0];
    assert.deepEqual(record.urls, []);
    assert.deepEqual(record.path_hints, ['hero.jpg']);
    assert.deepEqual(record.formats, []);
    assert.equal(record.observed_format, 'jpeg');
    assert.equal(record.max_edge, null);
    assert.ok(!json.includes('password'));
    assert.ok(!json.includes('token'));
    assert.ok(!json.includes('Private customer name'));
    assert.ok(parsed.redactions.includes('page-url-and-title-omitted'));
    assert.ok(parsed.redactions.includes('page-text-omitted'));
    assert.ok(parsed.redactions.includes('directory-paths-omitted'));
    assert.ok(parsed.redactions.includes('source-urls-omitted'));
  });

  it('keeps visible scope and does not export the search text', () => {
    const exported = buildPressHandoff(
      {},
      report([
        resource('r1', 'https://cdn.test/hero.jpg'),
        resource('r2', 'https://cdn.test/icon.png?private-search-term', { issues: ['heavy'] })
      ]),
      { filter: 'heavy', search: 'private-search-term', observed: '2026-09-08T00:00:00.000Z' }
    );
    assert.deepEqual(exported.payload.scope, {
      kind: 'visible-filter',
      filter: 'heavy',
      search_applied: true,
      total_resources: 2,
      retained_resources: 1,
      resources_truncated: false
    });
    assert.equal(exported.payload.resources.length, 1);
    assert.ok(!exported.json.includes('private-search-term'));
  });

  it('refuses an empty filtered scope instead of creating an unusable file', () => {
    assert.throws(
      () => buildPressHandoff({}, report([resource('r1', 'https://cdn.test/hero.jpg')]), {
        search: 'does-not-match'
      }),
      /scope has no resources/
    );
  });

  it('preserves measured, estimated, and unknown byte states', () => {
    const exported = buildPressHandoff({}, report([
      resource('measured', 'https://cdn.test/measured.jpg'),
      resource('estimated', 'https://cdn.test/estimated.jpg', {
        measured: false,
        byteState: 'estimated',
        bytes: 800
      }),
      resource('unknown', 'https://cdn.test/unknown.jpg', {
        measured: false,
        byteState: 'unknown',
        bytes: 0
      })
    ]), { observed: '2026-09-08T00:00:00.000Z' });
    assert.deepEqual(
      exported.payload.resources.map((item) => [item.bytes, item.bytes_measured, item.bytes_state]),
      [[1200, true, 'measured'], [800, false, 'estimated'], [null, false, 'unknown']]
    );
  });

  it('caps lists, strings, resources, and serialized bytes', () => {
    const huge = Array.from({ length: PRESS_MAX_RESOURCES + 20 }, (_, index) => resource(
      `r${index + 1}`,
      `https://cdn.test/${'x'.repeat(PRESS_MAX_STRING_CHARS)}/${index}.jpg`,
      {
        issues: Array.from({ length: PRESS_MAX_LIST_ENTRIES + 12 }, () => 'heavy'),
        usages: Array.from({ length: PRESS_MAX_LIST_ENTRIES + 12 }, () => ({
          kind: 'img',
          issues: ['noAlt']
        }))
      }
    ));
    const exported = buildPressHandoff({}, report(huge));
    assert.ok(exported.payload.resources.length <= PRESS_MAX_RESOURCES);
    assert.ok(exported.payload.redactions.includes('resource-list-capped'));
    assert.ok(exported.preview.bytes <= PRESS_MAX_FILE_BYTES);
    for (const item of exported.payload.resources) {
      assert.ok(item.id.length <= PRESS_MAX_STRING_CHARS);
      assert.ok(item.urls.length <= PRESS_MAX_LIST_ENTRIES);
      assert.ok(item.path_hints.length <= PRESS_MAX_LIST_ENTRIES);
      assert.ok(item.findings.length <= PRESS_MAX_LIST_ENTRIES);
      assert.ok(item.formats.length <= PRESS_MAX_LIST_ENTRIES);
      for (const value of [item.id, ...item.urls, ...item.path_hints, ...item.findings, ...item.formats]) {
        assert.ok([...value].length <= PRESS_MAX_STRING_CHARS);
      }
    }
  });

  it('emits the checked shared fixture in the Rust consumer shape', async () => {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    assert.equal(fixture.schema, PRESS_HANDOFF_SCHEMA);
    assert.equal(fixture.producer, 'imageguide-extension');
    assert.equal(fixture.resources.length, 2);
    assert.equal(fixture.resources[0].bytes_measured, true);
    assert.equal(fixture.resources[1].bytes_measured, false);
    assert.ok(fixture.resources[0].findings.includes('usage:img:noAlt'));
    assert.ok(!JSON.stringify(fixture).includes('fixture-private-title'));
  });
});
