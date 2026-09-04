/** Turn a scan into text a person or a build can read. */

import { MAX_REPORT_ROWS } from './constants.js';
import { ISSUES, buildLimitationSummary } from './analyze.js';
import { humanBytes } from './format.js';

/**
 * Schema v4 retires the prominent A–F delivery grade: summary.grade is always
 * null with gradeReason 'uncalibrated-model'. Fixed-ratio model arithmetic is
 * not calibrated evidence, so no threshold may silently redefine the letters.
 * SAVING_MODEL_VERSION is unchanged: saving formulas and coefficients did not
 * move, only their presentation did. Future comparison code must separate
 * model changes from site changes via these two versions.
 */
export const REPORT_SCHEMA_VERSION = 4;
export const SAVING_MODEL_VERSION = '2026-08-30-v3';

/** Report schemas this build can read. Anything else must fail loudly. */
export const SUPPORTED_SCHEMA_VERSIONS = [REPORT_SCHEMA_VERSION];

/**
 * Reject report payloads this build cannot interpret. Historical schemas
 * (notably v3, whose grade field carried an uncalibrated A–F/modelled
 * success) must never be silently compared against v4 output.
 *
 * @param {object|number} report parsed report or bare schema version
 * @returns {number} the supported version
 * @throws {Error} on any unsupported or missing version
 */
export function assertSupportedSchema(report) {
  const version =
    typeof report === 'number' ? report : report?.schemaVersion ?? report?.schema_version;
  if (version === REPORT_SCHEMA_VERSION) return version;
  if (version === 3) {
    throw new Error(
      'Unsupported report schema v3: v4 retired the A–F delivery grade ' +
        "(grade is now null with reason 'uncalibrated-model'). Re-run the audit; " +
        'do not compare v3 grades against v4 output.'
    );
  }
  throw new Error(
    `Unsupported report schema v${String(version ?? 'unknown')}: ` +
      `this build reads v${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. Re-run the audit.`
  );
}

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

/** Short provenance marker for a resource's format detection. */
function formatCell(resource) {
  const base = escapeMarkdown(resource.format);
  if (resource.formatProvenance === 'hint') return `${base} (URL hint)`;
  if (resource.formatProvenance === 'checked-header') return `${base} (checked header)`;
  if (resource.formatProvenance === 'unknown') return `${base} (unknown)`;
  return base;
}

/** Short provenance marker for a resource's byte size. */
function sizeCell(resource) {
  const size = humanBytes(resource.bytes);
  if (resource.byteState === 'measured') return resource.checkedResponse ? `${size} (checked)` : size;
  if (resource.byteState === 'inline') return `${size} (inline)`;
  if (resource.byteState === 'unknown') return 'unknown';
  return `${size} (est.)`;
}

/** Build a Markdown report for a pull request or a ticket. */
export function buildMarkdownReport(page, report) {
  const { summary, resources, usages } = report;
  const percent = Math.round(summary.savingRatio * 100);
  const measuredPercent = Math.round(summary.measuredByteRatio * 100);
  const pageName = escapeMarkdown(page.pageTitle || page.pageUrl);
  const limitations = buildLimitationSummary(page, report);
  const frameScope = Number(page.frameCount) > 1 ? ' (top frame)' : '';

  const lines = [
    `# Image delivery audit — ${pageName}`,
    '',
    escapeMarkdown(page.pageUrl),
    '',
    'Delivery grade: none (uncalibrated model; schema v4 carries no A–F score).',
    `${summary.resourceCount} resources across ${summary.usageCount} usages have a modelled weight of ${humanBytes(summary.totalBytes)}.`,
    `Estimated opportunity: ${humanBytes(summary.savingBytes)} (${percent}%) — heuristic estimate, not a measured saving; ` +
      `modelled result ${humanBytes(summary.optimisedBytes)}.`,
    '',
    `Estimated resize opportunity ${humanBytes(summary.resizeSaving)}. ` +
      `Estimated format opportunity ${humanBytes(summary.formatSaving)}.`,
    `Measured sizes: ${summary.measuredResourceCount} of ${summary.resourceCount} resources ` +
      `(${summary.checkedResourceCount || 0} via separately checked headers, ` +
      `${summary.inlineResourceCount || 0} inline, ` +
      `${summary.unknownResourceCount || 0} unknown weight).`,
    `Measurement coverage: ${measuredPercent}% of modelled image weight with measured inputs — ` +
      'a share of the model, not a claim about the true page weight.',
    `Markup checks: ${summary.markupIssueCount} findings across ${summary.usageCount} usages.`
  ];

  if (summary.estimatedResourceCount > 0) {
    lines.push('', `Provisional: ${summary.estimatedResourceCount} resource sizes use the model.`);
  }
  if (summary.inlineBytes > 0) {
    lines.push(
      '',
      `Inline payload of ${humanBytes(summary.inlineBytes)} rides inside the document; ` +
        'it is not an independent network transfer and carries no modelled saving.'
    );
  }
  const lcp = summary.vitals?.lcp;
  const cls = summary.vitals?.cls;
  lines.push('', '## Browser vitals', '');
  lines.push(
    lcp?.time > 0
      ? `Observed LCP${frameScope}: ${(lcp.time / 1000).toFixed(2)} s, ${escapeMarkdown(lcp.tagName || 'element')}` +
          `${lcp.url ? ` (${escapeMarkdown(lcp.url)})` : ''}.`
      : `Observed LCP${frameScope}: ${lcp?.supported ? 'no buffered candidate found' : 'not supported'}.`
  );
  lines.push(
    cls?.supported
      ? `Observed CLS${frameScope}: ${Number(cls.score || 0).toFixed(3)} across ${cls.shiftCount || 0} shifts.`
      : 'Observed CLS: not supported.'
  );
  lines.push(
    'These are audit observations from this page load, not field performance; ' +
      'a shifted node is not necessarily the cause, and an offscreen-now image ' +
      'is not proof it was initially offscreen.'
  );
  if (limitations.length) {
    lines.push('', '## Limitations & evidence', '');
    for (const limitation of limitations) {
      lines.push(`- ${escapeMarkdown(limitation.message)}`);
    }
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
      'Finding categories overlap: one resource can be heavy, oversized and legacy format ' +
        'at once. Only the resource-deduplicated estimated total above is additive — ' +
        'do not sum the rows below.',
      '',
      '| Finding | Scope | Count | Est. opportunity |',
      '| --- | --- | --- | --- |'
    );
    for (const [key, stat] of findings) {
      lines.push(
        `| ${escapeMarkdown(label(key))} | ${stat.scope} | ${stat.count} | ` +
          `${humanBytes(stat.savingBytes)} (est.) |`
      );
    }
  }

  lines.push(
    '',
    '## Resources',
    '',
    'Each row carries a report-local ID; usage rows below point at that ID. ' +
      'URLs are full references so same-named files at different paths stay distinguishable.',
    '',
    '| ID | Resource | Format | Size | Source pixels | Resize target | Est. opportunity | Usages | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  );
  for (const resource of resources.slice(0, MAX_REPORT_ROWS)) {
    const sourcePixels = resource.sourcePixelWidth
      ? `${resource.sourcePixelWidth}×${resource.sourcePixelHeight}`
      : 'unknown';
    const resizeTarget = resource.issues.includes('oversized')
      ? `${resource.resizeWidth}×${resource.resizeHeight}`
      : 'none';
    lines.push(
      `| ${escapeMarkdown(resource.id)} | ${escapeMarkdown(resource.url)} | ${formatCell(resource)} | ` +
        `${sizeCell(resource)} | ${sourcePixels} | ` +
        `${resizeTarget} | ${humanBytes(resource.savingBytes)} (est.) | ${resource.usages.length} | ` +
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
    '| Resource ID | Usage | Box | Required pixels | Candidate | Alt | Browser evidence | Findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  );
  for (const usage of usages.slice(0, MAX_REPORT_ROWS)) {
    lines.push(
      `| ${escapeMarkdown(usage.resourceId)} | ` +
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
        // Merged frame evidence keeps top-frame vitals; label the scope so
        // readers never mistake them for whole-page field performance.
        vitalsScope: Number(page.frameCount) > 1 ? 'top-frame' : 'single-frame',
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
      limitations: buildLimitationSummary(page, report),
      resources: resources.map((resource) => ({
        id: resource.id,
        url: resource.url,
        format: resource.format,
        formatProvenance: resource.formatProvenance,
        recommendedFormat: resource.recommendedFormat,
        usageCount: resource.usages.length,
        measured: resource.measured,
        measurement: resource.measurement,
        byteSource: resource.byteSource,
        byteState: resource.byteState,
        bytesEstimated: resource.bytesEstimated,
        inline: resource.inline,
        checkedResponse: resource.checkedResponse,
        bytes: resource.bytes,
        optimisedBytes: resource.optimisedBytes,
        savingBytes: resource.savingBytes,
        resizeSaving: resource.resizeSaving,
        formatSaving: resource.formatSaving,
        savingsKind: resource.savingsKind,
        resizeEstimated: resource.resizeEstimated,
        formatEstimated: resource.formatEstimated,
        estimateNote: resource.estimateNote,
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
