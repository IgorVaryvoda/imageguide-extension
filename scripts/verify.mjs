/**
 * Static checks that catch the mistakes unit tests cannot.
 *
 * Chrome does not report a broken reference until you open the popup, so this
 * script walks the manifest and the HTML, then checks two extension-specific
 * rules:
 *
 * 1. Every referenced file exists.
 * 2. A function that Chrome injects with `scripting.executeScript({func})` must
 *    not read a module-scope name. Chrome serialises the function alone, so a
 *    free identifier becomes a ReferenceError inside the page.
 *
 * Run: npm run verify
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const fail = (message) => problems.push(message);

/** Every file the manifest points at must exist. */
function checkManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const files = [];

  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|json)$/.test(value)) files.push(value);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(manifest);

  for (const file of new Set(files)) {
    if (!existsSync(join(root, file))) fail(`manifest.json points at a missing file: ${file}`);
  }

  if (manifest.manifest_version !== 3) fail('The manifest must declare version 3.');
  return manifest;
}

/** Every script, stylesheet, and link in an HTML page must exist. */
function checkHtml(htmlPath) {
  const source = readFileSync(join(root, htmlPath), 'utf8');
  const base = dirname(join(root, htmlPath));

  for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1];
    if (/^(https?:|data:|#|mailto:)/.test(reference)) continue;
    if (!existsSync(resolve(base, reference))) {
      fail(`${htmlPath} points at a missing file: ${reference}`);
    }
  }

  // A popup cannot use an inline script. The default CSP blocks it.
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(source)) {
    fail(`${htmlPath} holds an inline script. Manifest V3 blocks it.`);
  }
}

/**
 * Check that an injected function reads nothing from its module.
 *
 * @param {string} filePath the module that exports the function
 * @param {string} exportName
 */
function checkInjectedFunction(filePath, exportName) {
  const source = readFileSync(join(root, filePath), 'utf8');

  const imported = [...source.matchAll(/^import\s+\{([^}]+)\}\s+from/gm)]
    .flatMap((match) => match[1].split(','))
    .map((name) => name.trim().split(/\s+as\s+/).pop())
    .filter(Boolean);

  const moduleConstants = [...source.matchAll(/^(?:export\s+)?const\s+([A-Za-z0-9_$]+)/gm)].map(
    (match) => match[1]
  );

  const start = source.indexOf(`export function ${exportName}`);
  if (start === -1) {
    fail(`${filePath} does not export ${exportName}.`);
    return;
  }
  const body = source.slice(start);

  for (const name of [...imported, ...moduleConstants]) {
    if (new RegExp(`\\b${name}\\b`).test(body)) {
      fail(
        `${filePath}: ${exportName} reads the module-scope name "${name}". ` +
          'Chrome injects the function on its own, so this throws a ReferenceError in the page.'
      );
    }
  }
}

const manifest = checkManifest();

checkHtml('popup/popup.html');
checkInjectedFunction('content/collect.js', 'collectImages');
checkInjectedFunction('content/highlight.js', 'highlightImage');

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✔ ${manifest.name} ${manifest.version} — manifest, pages, and injected functions are sound.`);
