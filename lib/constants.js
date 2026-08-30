/**
 * Values that both the popup and the injected functions need.
 *
 * The injected functions cannot import anything, because Chrome serialises
 * them on their own. The popup imports these names and passes them in as
 * arguments to `chrome.scripting.executeScript`.
 */

/** Prefix for the random attribute a scan uses to find an element again. */
export const MARK_ATTRIBUTE_PREFIX = 'data-imageguide-auditor-';

/** The number of elements the collector reads before it stops. */
export const MAX_ELEMENTS_SCANNED = 8000;

/** Hard bounds for results copied across the page/extension boundary. */
export const MAX_RESOURCE_RECORDS = 2000;
export const MAX_USAGE_RECORDS = 8000;
export const MAX_URL_LENGTH = 4096;
export const MAX_SERIALIZED_URL_CHARS = 1_000_000;
export const MAX_SERIALIZED_PAYLOAD_BYTES = 4_000_000;

/** Stop optional CSS/pseudo inspection before one scan monopolises the page. */
export const MAX_SCAN_DURATION_MS = 750;

/** Chrome keeps this many resource timing entries unless a page raises it. */
export const RESOURCE_TIMING_BUFFER = 250;

/** The page that opens one image in the ImageGuide converter. */
export const CONVERTER_URL = 'https://www.imageguide.dev/convert/';

/** The number of rows the popup draws at once. */
export const MAX_ROWS = 200;

/** The number of optional response checks one click may start. */
export const MAX_RESPONSE_CHECKS = 100;

/** The number of rows the Markdown report holds. */
export const MAX_REPORT_ROWS = 50;
