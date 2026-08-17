/**
 * Compose the Chrome Web Store screenshots.
 *
 * The popup captures in `images/screens/` come from the real extension, running
 * against a real page. This script only frames them: it draws the 1280x800
 * canvas the store asks for, writes the caption, and drops the popup in.
 *
 * Capture the popup shots first, then run: npm run screenshots
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'images/screens');
const target = join(root, 'store');

const WIDTH = 1280;
const HEIGHT = 800;

/** The popup is 420x600. Draw it at this scale inside the canvas. */
const SCALE = 1.15;

const BACKGROUND = '#0f172a';
const HEADLINE = '#ffffff';
const SUBLINE = '#94a3b8';
const ACCENT = '#2563eb';

// Liberation Sans carries the Helvetica metrics of the promo tiles.
const HEAD_FONT = 'Liberation-Sans-Bold';
const BODY_FONT = 'Liberation-Sans';

const SCREENS = [
  {
    file: '01-summary.png',
    out: 'screenshot-1-summary.png',
    headline: 'Grade any page\nin one click',
    subline: 'Every image on the page, weighed and scored.\nThe grade comes from the weight you can avoid.',
    note: 'A real audit of an article with 44 images.'
  },
  {
    file: '02-list.png',
    out: 'screenshot-2-list.png',
    headline: 'See the cost of\nevery image',
    subline: 'Format, transfer size, and the size to resize to.\nThe worst offender sits at the top.',
    note: 'Sizes come from the browser, not from a guess.'
  },
  {
    file: '03-filter.png',
    out: 'screenshot-3-filter.png',
    headline: 'Filter to the\nproblem you have',
    subline: 'Oversized, legacy format, heavy, lazy hero,\nno alt text, no srcset, no sizes, and more.',
    note: 'Each chip carries the avoidable weight behind it.'
  },
  {
    file: '04-search.png',
    out: 'screenshot-4-search.png',
    headline: 'Search and sort\nthe whole page',
    subline: 'Match a file name or a URL. Order by saving,\nby size, by wasted pixels, or by name.',
    note: 'The popup remembers your filter and sort.'
  },
  {
    file: '05-actions.png',
    out: 'screenshot-5-actions.png',
    headline: 'Jump to it,\nor fix it',
    subline: 'Click a name to scroll to the image and outline it.\nCopy the URL, or open it in the converter.',
    note: 'Copy the whole audit as Markdown or JSON.'
  }
];

if (!existsSync(source)) {
  console.error(`Missing ${source}. Capture the popup shots first.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

const popupWidth = Math.round(420 * SCALE);
const popupHeight = Math.round(600 * SCALE);
const popupX = WIDTH - popupWidth - 70;
const popupY = Math.round((HEIGHT - popupHeight) / 2);

for (const screen of SCREENS) {
  const input = join(source, screen.file);
  if (!existsSync(input)) {
    console.error(`Missing ${input}`);
    process.exit(1);
  }

  const output = join(target, screen.out);

  // Step one: the popup at the size it will sit on the canvas.
  const card = join(tmpdir(), `imageguide-card-${screen.out}`);
  execFileSync('magick', [input, '-resize', `${popupWidth}x${popupHeight}!`, card]);

  // Step two: the canvas, the words, the shadow, and the card. Every layer
  // lands at a known coordinate, so nothing depends on how magick pads.
  execFileSync('magick', [
    '-size', `${WIDTH}x${HEIGHT}`, `xc:${BACKGROUND}`,

    // A wide, faint blue wash behind the card. It lifts the popup off the
    // canvas without reading as a glow.
    '(',
      '-size', `${WIDTH}x${HEIGHT}`, `xc:${BACKGROUND}`,
      '-fill', ACCENT,
      '-draw', `roundrectangle ${popupX - 60},${popupY - 60} ${popupX + popupWidth + 60},${popupY + popupHeight + 60} 40,40`,
      '-blur', '0x60',
    ')', '-compose', 'blend', '-define', 'compose:args=28', '-composite',

    // The headline.
    '-font', HEAD_FONT, '-pointsize', '54', '-fill', HEADLINE,
    '-interline-spacing', '14',
    '-annotate', '+80+250', screen.headline,

    // The supporting lines.
    '-font', BODY_FONT, '-pointsize', '23', '-fill', SUBLINE,
    '-interline-spacing', '11',
    '-annotate', '+80+400', screen.subline,

    // The footnote, in the brand blue.
    '-font', BODY_FONT, '-pointsize', '19', '-fill', ACCENT,
    '-interline-spacing', '0',
    '-annotate', '+80+520', screen.note,

    // The shadow that seats the card on the canvas.
    '(',
      '-size', `${WIDTH}x${HEIGHT}`, 'xc:none',
      '-fill', 'black',
      '-draw', `roundrectangle ${popupX - 2},${popupY + 14} ${popupX + popupWidth + 2},${popupY + popupHeight + 22} 18,18`,
      '-blur', '0x20',
    ')', '-compose', 'over', '-composite',

    // The real popup.
    card, '-geometry', `+${popupX}+${popupY}`, '-compose', 'over', '-composite',

    '-depth', '8', '-strip', output
  ]);

  rmSync(card, { force: true });
  console.log(`Wrote ${screen.out}`);
}

console.log(`\n${SCREENS.length} screenshots at ${WIDTH}x${HEIGHT}, ready for the store.`);
