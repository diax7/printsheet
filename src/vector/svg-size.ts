/**
 * The print size of an SVG, read from its root `<svg>` tag without drawing it: the width and
 * height in their units, or the viewBox when they are missing. It also gives the viewBox to draw
 * through, written as `0 0 w h` in user units when the file has none, so a crop of the artwork
 * can be mapped into it.
 *
 * The tag is read as text, not with DOMParser, so the same code runs in unit tests (Node) and
 * the browser.
 */

export interface SvgSize {
  widthMm: number;
  heightMm: number;
  /** min-x, min-y, width, height in the SVG's user units. */
  viewBox: [number, number, number, number];
}

const MM_PER_INCH = 25.4;
/** CSS pixels per inch; Illustrator writes points and calls them px, so its files use 72. */
const PX_PER_INCH = 96;
const ILLUSTRATOR_PX_PER_INCH = 72;

/**
 * The text after what may come before an SVG's root tag: a byte order mark, an XML prolog,
 * comments and a doctype, including the entity block older Illustrator versions put in it.
 */
export function afterSvgPrologue(text: string): string {
  return text.slice(svgPrologueLength(text));
}

/** How many characters come before the root tag (see `afterSvgPrologue`). */
export function svgPrologueLength(text: string): number {
  const item = /﻿|\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/iy;
  let at = 0;
  for (;;) {
    item.lastIndex = at;
    const match = item.exec(text);
    if (!match || match[0].length === 0) return at;
    at += match[0].length;
  }
}

/** The root `<svg ...>` tag, or null when the text does not start with one. */
function rootTag(text: string): string | null {
  return /^<svg(?=[\s>/])[^>]*>/i.exec(afterSvgPrologue(text))?.[0] ?? null;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * A length in millimetres and in user units, or null when it is missing, a percentage or not a
 * positive number. A px or plain number is its own user units; other units are CSS px.
 */
function length(value: string | undefined, pxPerInch: number): { mm: number; px: number } | null {
  const match = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?)\s*(mm|cm|in|pt|pc|px)?\s*$/i.exec(
    value ?? '',
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!(amount > 0) || !Number.isFinite(amount)) return null;
  const inches: Record<string, number> = {
    mm: amount / MM_PER_INCH,
    cm: (amount * 10) / MM_PER_INCH,
    in: amount,
    pt: amount / 72,
    pc: amount / 6,
    px: amount / pxPerInch,
  };
  const unit = (match[2] ?? 'px').toLowerCase();
  const inch = inches[unit] ?? amount / pxPerInch;
  return { mm: inch * MM_PER_INCH, px: unit === 'px' ? amount : inch * PX_PER_INCH };
}

function viewBoxOf(tag: string): [number, number, number, number] | null {
  const parts = (attribute(tag, 'viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

/** The SVG's print size and viewBox, or null when it has no usable size or is not an SVG. */
export function svgSize(text: string): SvgSize | null {
  const tag = rootTag(text);
  if (!tag) return null;
  const pxPerInch = /Generator:\s*Adobe Illustrator/i.test(text.slice(0, 2048))
    ? ILLUSTRATOR_PX_PER_INCH
    : PX_PER_INCH;
  const width = length(attribute(tag, 'width'), pxPerInch);
  const height = length(attribute(tag, 'height'), pxPerInch);
  const box = viewBoxOf(tag);
  const mmPerUnit = MM_PER_INCH / pxPerInch;
  if (width && height && !box) {
    return { widthMm: width.mm, heightMm: height.mm, viewBox: [0, 0, width.px, height.px] };
  }
  if (width && height && box) {
    // A viewBox shaped unlike the width and height is drawn fitted inside them (the SVG
    // default), so the page is the viewBox at that scale.
    const scale = Math.min(width.mm / box[2], height.mm / box[3]);
    return { widthMm: box[2] * scale, heightMm: box[3] * scale, viewBox: box };
  }
  if (!box) return null;
  const ratio = box[3] / box[2];
  if (width) return { widthMm: width.mm, heightMm: width.mm * ratio, viewBox: box };
  if (height) return { widthMm: height.mm / ratio, heightMm: height.mm, viewBox: box };
  return { widthMm: box[2] * mmPerUnit, heightMm: box[3] * mmPerUnit, viewBox: box };
}
