/**
 * What kind of file was added, read from its first bytes, never from its name alone: a PNG
 * renamed to .jpg is still a PNG. The name only tells an Illustrator file from a PDF, since a
 * PDF-compatible .ai is a PDF inside.
 *
 * Files this app cannot open get a refusal that says what to do instead. Bytes it does not
 * recognise are left to the browser's image decoder, which also reads BMP, AVIF and ICO.
 */
export const FILE_FORMATS = ['png', 'jpg', 'webp', 'gif', 'svg', 'pdf', 'ai', 'psd'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** True for one of the formats above (a saved file can hold anything). */
export function isFileFormat(value: unknown): value is FileFormat {
  return (FILE_FORMATS as readonly unknown[]).includes(value);
}

/** How many bytes `detectFormat` needs to see. */
export const FORMAT_HEAD_BYTES = 1024;

const EPS_MESSAGE = "EPS files can't be opened here. Save it as SVG or PDF and add it again.";
const OLD_AI_MESSAGE =
  'This Illustrator file is too old to open. In Illustrator, save it with "Create PDF Compatible File" ticked, or as SVG or PDF.';
const PSB_MESSAGE = "Large Document (PSB) files can't be opened here. Save it as PSD.";
const SVGZ_MESSAGE = "Compressed SVG (.svgz) can't be opened. Save it as a plain SVG.";

function startsWith(head: Uint8Array, ...values: number[]): boolean {
  return values.every((value, i) => head[i] === value);
}

function ascii(head: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...head.subarray(from, from + length));
}

/** True when the text, past a byte order mark, an XML prolog, comments and a doctype, is an SVG. */
function isSvg(head: Uint8Array): boolean {
  const content = new TextDecoder()
    .decode(head)
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .trimStart();
  return /^<svg[\s>/]/i.test(content);
}

/**
 * The format of a file from its first bytes (at least `FORMAT_HEAD_BYTES` when the file is that
 * long), a refusal with a way forward, or 'unknown' for the image decoder to try.
 */
export function detectFormat(
  head: Uint8Array,
  fileName: string,
): FileFormat | 'unknown' | { refuse: string } {
  const isAiName = /\.ai$/i.test(fileName);
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(head, 0xff, 0xd8, 0xff)) return 'jpg';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (ascii(head, 0, 4) === '8BPS') return head[5] === 2 ? { refuse: PSB_MESSAGE } : 'psd';
  if (ascii(head, 0, 5) === '%PDF-') return isAiName ? 'ai' : 'pdf';
  if (startsWith(head, 0xc5, 0xd0, 0xd3, 0xc6)) return { refuse: EPS_MESSAGE };
  if (ascii(head, 0, 4) === '%!PS') {
    return {
      refuse: isAiName && !ascii(head, 0, 64).includes('EPSF') ? OLD_AI_MESSAGE : EPS_MESSAGE,
    };
  }
  if (startsWith(head, 0x1f, 0x8b)) return { refuse: SVGZ_MESSAGE };
  if (isSvg(head)) return 'svg';
  return 'unknown';
}
