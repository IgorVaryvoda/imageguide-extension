import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HANDOFF_MAX_BYTES,
  HANDOFF_TTL_MS,
  createHandoffPayload,
  handoffKey,
  validateHandoff
} from '../lib/handoff.js';

describe('audit handoff', () => {
  it('carries only completed validated measurements under the cap', () => {
    const payload = createHandoffPayload({
      token: 'token-1',
      tabId: 7,
      documentToken: 'doc-1',
      revision: 'rev-1',
      schemaVersion: 4,
      modelVersion: '2026-08-30-v3',
      measurements: [
        { url: 'https://a.test/x.jpg', bytes: 1200, contentType: 'image/jpeg', source: 'content-length', confidence: 'medium' },
        { url: 'https://a.test/y.jpg', bytes: 0, source: 'content-length' },
        { url: 'https://a.test/z.jpg', bytes: 400, source: '' }
      ],
      attempts: [{ key: 'https://a.test/x.jpg', status: 'measured', reason: null }],
      ui: { filter: 'all', sort: 'saving', search: '' }
    });
    assert.equal(payload.measurements.length, 1);
    assert.equal(payload.measurements[0].url, 'https://a.test/x.jpg');
    assert.equal(handoffKey('token-1'), 'imageguide-handoff:token-1');
    assert.ok(JSON.stringify(payload).length <= HANDOFF_MAX_BYTES);
  });

  it('rejects expired, foreign-tab, changed-document and old-schema payloads', () => {
    const fresh = createHandoffPayload({
      token: 't',
      tabId: 7,
      documentToken: 'doc-1',
      revision: 'r1',
      schemaVersion: 4,
      measurements: []
    });
    const current = { tabId: 7, documentToken: 'doc-1', schemaVersion: 4 };
    assert.equal(validateHandoff(fresh, current).ok, true);
    assert.equal(
      validateHandoff({ ...fresh, createdAt: Date.now() - HANDOFF_TTL_MS - 1 }, current).reason,
      'expired'
    );
    assert.equal(validateHandoff(fresh, { ...current, tabId: 8 }).reason, 'tab-mismatch');
    assert.equal(validateHandoff(fresh, { ...current, documentToken: 'doc-2' }).reason, 'document-changed');
    assert.equal(validateHandoff(fresh, { ...current, schemaVersion: 3 }).reason, 'schema-mismatch');
    assert.equal(validateHandoff({ ...fresh, version: 0 }, current).reason, 'version-mismatch');
  });
});
