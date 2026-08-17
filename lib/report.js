/**
 * Turn a scan into text a person or a build can read.
 *
 * Pure functions only. No browser or extension APIs.
 */

import { MAX_REPORT_ROWS } from './constants.js';
import { ISSUES } from './analyze.js';
import { humanBytes } from './format.js';

/**
 * The last path segment of a URL, for a short row label.
 *
 * @param {string} url
 * @returns {string}
 */
export function fileNameFromUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return 'inline data URI';
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

/**
 * Sort a list of scored images.
 *
 * @param {object[]} images
 * @param {string} key one of saving, bytes, wasted, name
 * @returns {object[]} a new array
 */
export function sortImages(images, key) {
  const copy = [...images];
  if (key === 'bytes') return copy.sort((a, b) => b.bytes - a.bytes);
  if (key === 'wasted') return copy.sort((a, b) => b.resizeSaving - a.resizeSaving);
  if (key === 'name') {
    return copy.sort((a, b) => fileNameFromUrl(a.url).localeCompare(fileNameFromUrl(b.url)));
  }
  return copy.sort((a, b) => b.savingBytes - a.savingBytes);
}

/**
 * Keep the images that match a filter and a search term.
 *
 * @param {object[]} images
 * @param {string} issue an issue key, or `all`
 * @param {string} search free text matched against the URL
 * @returns {object[]}
 */
export function filterImages(images, issue, search) {
  const term = (search || '').trim().toLowerCase();
  return images.filter((image) => {
    if (issue !== 'all' && !image.issues.includes(issue)) return false;
    if (term && !image.url.toLowerCase().includes(term)) return false;
    return true;
  });
}

const label = (issue) => ISSUES[issue]?.label ?? issue;

/**
 * Build a Markdown report for a pull request or a ticket.
 *
 * @param {object} page the merged page record
 * @param {object} report the output of analyzePage
 * @returns {string}
 */
export function buildMarkdownReport(page, report) {
  const { summary, images } = report;
  const percent = Math.round(summary.savingRatio * 100);

  const lines = [
    `# Image audit — ${page.pageTitle || page.pageUrl}`,
    '',
    page.pageUrl,
    '',
    `Grade **${summary.grade}**. ${summary.count} images weigh ${humanBytes(summary.totalBytes)}.`,
    `An optimised page weighs about ${humanBytes(summary.optimisedBytes)}, ` +
      `a saving of ${humanBytes(summary.savingBytes)} (${percent}%).`,
    '',
    `Resizing saves ${humanBytes(summary.resizeSaving)}. ` +
      `A modern format saves a further ${humanBytes(summary.formatSaving)}.`
  ];

  if (summary.estimatedCount > 0) {
    lines.push('', `${summary.estimatedCount} of the sizes are estimates.`);
  }
  if (page.truncated) {
    lines.push('', 'The page is large, so the scan stopped early. The totals are a lower bound.');
  }

  const issues = Object.entries(summary.issueStats).sort((a, b) => b[1].count - a[1].count);
  if (issues.length) {
    lines.push('', '## Issues', '', '| Issue | Images | Saving |', '| --- | --- | --- |');
    for (const [key, stat] of issues) {
      lines.push(`| ${label(key)} | ${stat.count} | ${humanBytes(stat.savingBytes)} |`);
    }
  }

  lines.push(
    '',
    '## Images',
    '',
    '| Image | Format | Size | Natural | Box | Saving | Issues |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  );

  for (const image of images.slice(0, MAX_REPORT_ROWS)) {
    lines.push(
      `| ${fileNameFromUrl(image.url)} | ${image.format} | ` +
        `${humanBytes(image.bytes)}${image.measured ? '' : ' est.'} | ` +
        `${image.naturalWidth}×${image.naturalHeight} | ` +
        `${image.displayWidth}×${image.displayHeight} | ` +
        `${humanBytes(image.savingBytes)} | ` +
        `${image.issues.map(label).join(', ')} |`
    );
  }

  if (images.length > MAX_REPORT_ROWS) {
    lines.push('', `${images.length - MAX_REPORT_ROWS} more images are not listed.`);
  }

  lines.push('', 'Report by the ImageGuide Auditor — https://www.imageguide.dev');
  return lines.join('\n');
}

/**
 * Build a JSON report for a build step.
 *
 * @param {object} page the merged page record
 * @param {object} report the output of analyzePage
 * @param {string} generatedAt an ISO timestamp
 * @returns {string}
 */
export function buildJsonReport(page, report, generatedAt) {
  const { summary, images } = report;

  return JSON.stringify(
    {
      tool: 'imageguide-auditor',
      generatedAt,
      page: {
        url: page.pageUrl,
        title: page.pageTitle,
        viewport: page.viewport,
        frameCount: page.frameCount,
        truncated: Boolean(page.truncated),
        timingBufferFull: Boolean(page.timingBufferFull)
      },
      summary,
      images: images.map((image) => ({
        url: image.url,
        kind: image.kind,
        format: image.format,
        recommendedFormat: image.recommendedFormat,
        occurrences: image.occurrences,
        measured: image.measured,
        bytes: image.bytes,
        optimisedBytes: image.optimisedBytes,
        savingBytes: image.savingBytes,
        resizeSaving: image.resizeSaving,
        formatSaving: image.formatSaving,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        displayWidth: image.displayWidth,
        displayHeight: image.displayHeight,
        targetWidth: image.targetWidth,
        targetHeight: image.targetHeight,
        issues: image.issues
      }))
    },
    null,
    2
  );
}
