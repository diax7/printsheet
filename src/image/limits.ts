/**
 * Largest image this tool makes or accepts. Chromium returns blank pixels past 16384 px on a
 * side; 100 megapixels keeps the decoded copies (about 400 MB each) within what a browser tab can
 * hold. Its own file so the main thread can use it without loading the import worker's code.
 */
export const MAX_IMPORT_SIDE = 16384;
export const MAX_IMPORT_AREA = 100_000_000;
