/**
 * Extension-internal one-shot handoff transport over chrome.storage.session.
 *
 * Session storage is scoped to this extension, so only trusted extension
 * contexts can read a payload. Each token is consumed and deleted on success;
 * expired items are purged on access and startup. Quota or access failures
 * throw so the caller falls back to a fresh scan with an explanation — the
 * audit must never crash because handoff failed. Audit results are otherwise
 * memory-only (see the privacy policy).
 */

import { HANDOFF_TTL_MS, handoffKey } from '../lib/handoff.js';

function sessionApi() {
  return globalThis.chrome?.storage?.session || null;
}

export async function saveHandoff(payload) {
  const api = sessionApi();
  if (!api) throw new Error('session storage unavailable');
  await purgeExpiredHandoffs().catch(() => {});
  await api.set({ [handoffKey(payload.token)]: payload });
}

export async function takeHandoff(token) {
  const api = sessionApi();
  if (!api || !token) return { ok: false, reason: 'unavailable', payload: null };
  const key = handoffKey(token);
  const stored = await api.get(key).catch(() => null);
  const payload = stored?.[key] || null;
  await api.remove(key).catch(() => {});
  if (!payload) return { ok: false, reason: 'consumed-or-unknown', payload: null };
  if (typeof payload.createdAt !== 'number' || Date.now() - payload.createdAt > HANDOFF_TTL_MS) {
    return { ok: false, reason: 'expired', payload: null };
  }
  return { ok: true, reason: null, payload };
}

export async function purgeExpiredHandoffs() {
  const api = sessionApi();
  if (!api) return;
  const all = await api.get(null).catch(() => null);
  if (!all) return;
  const expired = Object.keys(all).filter(
    (key) =>
      key.startsWith('imageguide-handoff:') &&
      (typeof all[key]?.createdAt !== 'number' ||
        Date.now() - all[key].createdAt > HANDOFF_TTL_MS)
  );
  if (expired.length) await api.remove(expired).catch(() => {});
}
