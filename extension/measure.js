import { measureImageResponses } from '../lib/measure.js';

export function originPattern(url) {
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `${protocol}//${host}/*`;
  } catch {
    return null;
  }
}

export async function snapshotPermissions(resources) {
  const origins = [...new Set(resources.map((resource) => originPattern(resource.url)).filter(Boolean))];
  const values = await Promise.all(
    origins.map((origin) => chrome.permissions.contains({ origins: [origin] }))
  );
  return new Map(origins.map((origin, index) => [origin, values[index]]));
}

/** Measure resources and remove only origins granted by this user action. */
export async function measureResources(resources, snapshot, onProgress) {
  const origins = [...new Set(resources.map((resource) => originPattern(resource.url)).filter(Boolean))];
  const newlyGranted = origins.filter((origin) => !snapshot.get(origin));
  let grantedForCheck = [];
  try {
    if (newlyGranted.length) {
      const granted = await chrome.permissions.request({ origins: newlyGranted });
      if (!granted) return [];
      grantedForCheck = newlyGranted;
    }
    return await measureImageResponses(
      resources.map((resource) => resource.url),
      { onProgress }
    );
  } finally {
    if (grantedForCheck.length) {
      await chrome.permissions.remove({ origins: grantedForCheck }).catch(() => {});
    }
  }
}
