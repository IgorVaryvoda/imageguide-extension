/** Turn a scan into text a person or a build can read. */

import { MAX_REPORT_ROWS } from './constants.js';
import { ISSUES } from './analyze.js';
import { humanBytes } from './format.js';

export const REPORT_SCHEMA_VERSION = 3;
export const SAVING_MODEL_VERSION = '2026-08-30-v3';

/** Escape page-controlled text before placing it in copied Markdown. */
export function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([|`*_[\]()<>#!])/g, '\\$1');
}

/** The last path segment of a URL, for a short row label. */
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

/** Sort unique resource results without mutating the input. */
export function sortResources(resources, key) {
  const copy = [...resources];
  if (key === 'bytes') return copy.sort((a, b) => b.bytes - a.bytes);
  if (key === 'wasted') return copy.sort((a, b) => b.resizeSaving - a.resizeSaving);
  if (key === 'name') {
    return copy.sort((a, b) => fileNameFromUrl(a.url).localeCompare(fileNameFromUrl(b.url)));
  }
  return copy.sort((a, b) => b.savingBytes - a.savingBytes);
}

/** Filter resources; a usage-level finding keeps its parent resource visible. */
export function filterResources(resources, issue, search) {
  const term = (search || '').trim().toLowerCase();
  return resources.filter((resource) => {
    if (issue !== 'all' && !resource.allIssues.includes(issue)) return false;
    if (term && !resource.url.toLowerCase().includes(term)) return false;
    return true;
  });
}

const label = (issue) => ISSUES[issue]?.label ?? issue;

/** Build a Markdown report for a pull request or a ticket. */
export function buildMarkdownReport(page, report) {
  const { summary, resources, usages } = report;
  const percent = Math.round(summary.savingRatio * 100);
  const measuredPercent = Math.round(summary.measuredByteRatio * 100);
  const pageName = escapeMarkdown(page.pageTitle || page.pageUrl);

  const lines = [
    `# Image delivery audit — ${pageName}`,
    '',
    escapeMarkdown(page.pageUrl),
    '',
    summary.grade === '?'
      ? 'Delivery grade unavailable: no resource size was measured.'
      : `Delivery grade **${summary.grade}**, based on ${summary.measuredResourceCount} measured resources.`,
    `${summary.resourceCount} resources across ${summary.usageCount} usages have a modelled weight of ${humanBytes(summary.totalBytes)}.`,
    `Estimated opportunity: ${humanBytes(summary.savingBytes)} (${percent}%); ` +
      `modelled result ${humanBytes(summary.optimisedBytes)}.`,
    '',
    `Estimated resize opportunity ${humanBytes(summary.resizeSaving)}. ` +
      `Estimated format opportunity ${humanBytes(summary.formatSaving)}.`,
    `Measurement coverage: ${measuredPercent}% of modelled image weight ` +
      `(${summary.measuredResourceCount} of ${summary.resourceCount} resource sizes).`,
    `Markup checks: ${summary.markupIssueCount} findings across ${summary.usageCount} usages.`
  ];

  if (summary.estimatedResourceCount > 0) {
    lines.push('', `Provisional: ${summary.estimatedResourceCount} resource sizes use the model.`);
  }
  const lcp = summary.vitals?.lcp;
  const cls = summary.vitals?.cls;
  lines.push('', '## Browser vitals', '');
  lines.push(
    lcp?.time > 0
      ? `Observed LCP: ${(lcp.time / 1000).toFixed(2)} s, ${escapeMarkdown(lcp.tagName || 'element')}` +
          `${lcp.url ? ` (${escapeMarkdown(fileNameFromUrl(lcp.url))})` : ''}.`
      : `Observed LCP: ${lcp?.supported ? 'no buffered candidate found' : 'not supported'}.`
  );
  lines.push(
    cls?.supported
      ? `Observed CLS: ${Number(cls.score || 0).toFixed(3)} across ${cls.shiftCount || 0} shifts.`
      : 'Observed CLS: not supported.'
  );
  if (page.truncated) {
    lines.push('', 'The page is large, so the element scan stopped early. Totals are a lower bound.');
  }
  if (page.recordsTruncated) {
    lines.push(
      '',
      `${page.skippedResources || 0} resources and ${page.skippedUsages || 0} usages ` +
        'exceeded record or payload limits. Totals are a lower bound.'
    );
  }
  if (resources.some((resource) => resource.usages.length > 1)) {
    lines.push('', 'Repeated URLs are grouped as one resource; every recorded usage remains listed.');
  }

  const findings = Object.entries(summary.issueStats).sort((a, b) => b[1].count - a[1].count);
  if (findings.length) {
    lines.push(
      '',
      '## Findings',
      '',
      '| Finding | Scope | Count | Opportunity |',
      '| --- | --- | --- | --- |'
    );
    for (const [key, stat] of findings) {
      lines.push(
        `| ${escapeMarkdown(label(key))} | ${stat.scope} | ${stat.count} | ` +
          `${humanBytes(stat.savingBytes)} |`
      );
    }
  }

  lines.push(
    '',
    '## Resources',
    '',
    '| Resource | Format | Size | Source pixels | Resize target | Opportunity | Usages | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  );
  for (const resource of resources.slice(0, MAX_REPORT_ROWS)) {
    const sourcePixels = resource.sourcePixelWidth
      ? `${resource.sourcePixelWidth}×${resource.sourcePixelHeight}`
      : 'unknown';
    const resizeTarget = resource.issues.includes('oversized')
      ? `${resource.resizeWidth}×${resource.resizeHeight}`
      : 'none';
    lines.push(
      `| ${escapeMarkdown(fileNameFromUrl(resource.url))} | ${escapeMarkdown(resource.format)} | ` +
        `${humanBytes(resource.bytes)}${resource.measured ? '' : ' est.'} | ${sourcePixels} | ` +
        `${resizeTarget} | ${humanBytes(resource.savingBytes)} | ${resource.usages.length} | ` +
        `${escapeMarkdown(resource.issues.map(label).join(', '))} |`
    );
  }
  if (resources.length > MAX_REPORT_ROWS) {
    lines.push('', `${resources.length - MAX_REPORT_ROWS} more resources are not listed.`);
  }

  lines.push(
    '',
    '## Usages',
    '',
    '| Resource | Usage | Box | Required pixels | Candidate | Alt | Browser evidence | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  );
  const resourceNames = new Map(
    resources.map((resource) => [resource.id, fileNameFromUrl(resource.url)])
  );
  for (const usage of usages.slice(0, MAX_REPORT_ROWS)) {
    lines.push(
      `| ${escapeMarkdown(resourceNames.get(usage.resourceId) || usage.resourceId)} | ` +
        `${escapeMarkdown(`${usage.kind} f${usage.frameId}#${usage.elementId}`)} | ` +
        `${usage.displayWidth}×${usage.displayHeight} | ` +
        `${usage.targetWidth}×${usage.targetHeight} | ` +
        `${escapeMarkdown(usage.selectedCandidateDescriptor || 'n/a')} | ` +
        `${escapeMarkdown(usage.altState)} | ` +
        `${escapeMarkdown([
          usage.isLcp ? 'LCP' : '',
          usage.layoutShiftCount ? `${usage.layoutShiftCount} shifts` : ''
        ].filter(Boolean).join(', ') || 'none')} | ` +
        `${escapeMarkdown(usage.issues.map(label).join(', '))} |`
    );
  }
  if (usages.length > MAX_REPORT_ROWS) {
    lines.push('', `${usages.length - MAX_REPORT_ROWS} more usages are not listed.`);
  }

  lines.push('', 'Report by the ImageGuide Auditor — https://www.imageguide.dev');
  return lines.join('\n');
}

/** Build a versioned JSON report for a build step. */
export function buildJsonReport(page, report, generatedAt) {
  const { summary, resources, usages } = report;

  return JSON.stringify(
    {
      tool: 'imageguide-auditor',
      schemaVersion: REPORT_SCHEMA_VERSION,
      modelVersion: SAVING_MODEL_VERSION,
      generatedAt,
      page: {
        url: page.pageUrl,
        title: page.pageTitle,
        viewport: page.viewport,
        frameCount: page.frameCount,
        truncated: Boolean(page.truncated),
        recordsTruncated: Boolean(page.recordsTruncated),
        styleScanTruncated: Boolean(page.styleScanTruncated),
        skippedResources: page.skippedResources || 0,
        skippedUsages: page.skippedUsages || 0,
        timingBufferFull: Boolean(page.timingBufferFull),
        scannedElements: page.scannedElements || 0,
        scanDurationMs: page.scanDurationMs || 0,
        dynamicMutationCount: page.dynamicMutationCount || 0,
        lastMutationTime: page.lastMutationTime || 0,
        unsupported: page.unsupported || {},
        vitals: page.vitals || null
      },
      summary,
      resources: resources.map((resource) => ({
        id: resource.id,
        url: resource.url,
        format: resource.format,
        recommendedFormat: resource.recommendedFormat,
        usageCount: resource.usages.length,
        measured: resource.measured,
        measurement: resource.measurement,
        bytes: resource.bytes,
        optimisedBytes: resource.optimisedBytes,
        savingBytes: resource.savingBytes,
        resizeSaving: resource.resizeSaving,
        formatSaving: resource.formatSaving,
        sourcePixelWidth: resource.sourcePixelWidth,
        sourcePixelHeight: resource.sourcePixelHeight,
        sourceDimensionConfidence: resource.sourceDimensionConfidence,
        sourceDimensionReason: resource.sourceDimensionReason,
        targetWidth: resource.targetWidth,
        targetHeight: resource.targetHeight,
        resizeWidth: resource.resizeWidth,
        resizeHeight: resource.resizeHeight,
        issues: resource.issues
      })),
      usages: usages.map((usage) => ({
        id: usage.id,
        resourceId: usage.resourceId,
        frameId: usage.frameId,
        elementId: usage.elementId,
        kind: usage.kind,
        cssProperty: usage.cssProperty,
        displayWidth: usage.displayWidth,
        displayHeight: usage.displayHeight,
        targetWidth: usage.targetWidth,
        targetHeight: usage.targetHeight,
        dpr: usage.dpr,
        inViewport: usage.inViewport,
        loading: usage.loading,
        fetchPriority: usage.fetchPriority,
        decoding: usage.decoding,
        altState: usage.altState,
        hasDimensions: usage.hasDimensions,
        hasSrcset: usage.hasSrcset,
        hasSizes: usage.hasSizes,
        usesWidthDescriptors: usage.usesWidthDescriptors,
        pictureFallbackSelected: usage.pictureFallbackSelected,
        densityCorrectedWidth: usage.densityCorrectedWidth,
        densityCorrectedHeight: usage.densityCorrectedHeight,
        selectedCandidateDescriptor: usage.selectedCandidateDescriptor,
        sourceDimensionConfidence: usage.sourceDimensionConfidence,
        isLcp: usage.isLcp,
        layoutShiftCount: usage.layoutShiftCount,
        layoutShiftScore: usage.layoutShiftScore,
        issues: usage.issues
      }))
    },
    null,
    2
  );
}
