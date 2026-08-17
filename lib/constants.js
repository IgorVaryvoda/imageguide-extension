/**
 * Values that both the popup and the injected functions need.
 *
 * The injected functions cannot import anything, because Chrome serialises
 * them on their own. The popup imports these names and passes them in as
 * arguments to `chrome.scripting.executeScript`.
 */

/** The attribute the collector writes on every element it records. */
export const MARK_ATTRIBUTE = 'data-imageguide-id';

/** The number of elements the collector reads before it stops. */
export const MAX_ELEMENTS_SCANNED = 8000;

/** Chrome keeps this many resource timing entries unless a page raises it. */
export const RESOURCE_TIMING_BUFFER = 250;

/** The page that opens one image in the ImageGuide converter. */
export const CONVERTER_URL = 'https://www.imageguide.dev/convert';

/** The number of rows the popup draws at once. */
export const MAX_ROWS = 200;

/** The number of rows the Markdown report holds. */
export const MAX_REPORT_ROWS = 50;
