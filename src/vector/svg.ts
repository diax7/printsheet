/**
 * Drawing an SVG at any size. The browser draws it through an `<img>`, which runs no scripts and
 * loads nothing from outside the file. Before drawing, the root tag is rewritten to the exact
 * pixel size and the exact region wanted, so the browser rasterizes the vector at that size
 * instead of drawing it small and scaling it up.
 */
import { clearFaintPixels } from '@/image/trim';
import { MAX_IMPORT_SIDE } from '@/image/limits';
import type { Crop } from '@/model/types';
import { svgPrologueLength } from '@/vector/svg-size';

type ViewBox = readonly [number, number, number, number];

/** About 16 megapixels: sharp enough to trim, mask and show any design, small enough for a phone. */
const BASE_AREA = 16_000_000;
const BASE_MAX_SIDE = 8192;

/** The pixel size of the render made at import, keeping the page's shape. */
export function baseRenderSize(
  widthMm: number,
  heightMm: number,
): { widthPx: number; heightPx: number } {
  const ratio = widthMm / heightMm;
  let widthPx = Math.sqrt(BASE_AREA * ratio);
  let heightPx = widthPx / ratio;
  const fit = Math.min(1, BASE_MAX_SIDE / widthPx, BASE_MAX_SIDE / heightPx);
  widthPx *= fit;
  heightPx *= fit;
  return { widthPx: Math.max(1, Math.floor(widthPx)), heightPx: Math.max(1, Math.floor(heightPx)) };
}

/** A crop given as fractions of the page, in the SVG's user units. */
export function cropViewBox(box: ViewBox, crop: Crop): [number, number, number, number] {
  return [box[0] + crop.x * box[2], box[1] + crop.y * box[3], crop.w * box[2], crop.h * box[3]];
}

/**
 * The SVG text with its root tag drawing `viewBox` stretched exactly to `widthPx` × `heightPx`.
 * Any size, viewBox or aspect setting of its own is replaced; everything else is kept.
 */
export function retargetSvg(
  text: string,
  viewBox: ViewBox,
  widthPx: number,
  heightPx: number,
): string {
  // Only the root tag, never an <svg> written in a comment or doctype before it.
  const start = svgPrologueLength(text);
  const root = text
    .slice(start)
    .replace(/^<svg(?=[\s>/])([^>]*?)(\/?)>/i, (_tag, attributes: string, close: string) => {
      const kept = attributes.replace(
        /\s(?:width|height|viewBox|preserveAspectRatio)\s*=\s*(?:"[^"]*"|'[^']*')/gi,
        '',
      );
      return (
        `<svg${kept} width="${widthPx}" height="${heightPx}" viewBox="${viewBox.join(' ')}"` +
        ` preserveAspectRatio="none"${close}>`
      );
    });
  return text.slice(0, start) + root;
}

/** Thrown when a render comes back with no ink: a browser canvas limit, usually on a phone. */
export class BlankRenderError extends Error {}

/**
 * Draw `region` of an SVG at `widthPx` × `heightPx`, haze cleared as at import, so a print
 * matches what the screen and the ink mask show.
 */
export async function renderSvg(
  text: string,
  region: ViewBox,
  widthPx: number,
  heightPx: number,
  name: string,
): Promise<HTMLCanvasElement> {
  if (widthPx > MAX_IMPORT_SIDE || heightPx > MAX_IMPORT_SIDE) {
    throw new Error(`"${name}" cannot be drawn this large (${widthPx} × ${heightPx} px).`);
  }
  const image = new Image();
  // A data URL, not a blob URL: nothing outside the page (a browser tool, a test recorder) ever
  // tries to fetch it, and the page's security policy allows data images only.
  image.src = await dataUrl(
    new Blob([retargetSvg(text, region, widthPx, heightPx)], { type: 'image/svg+xml' }),
  );
  try {
    await image.decode();
  } catch {
    throw new Error(`"${name}" could not be drawn: the SVG is damaged or not valid.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot draw images here.');
  ctx.drawImage(image, 0, 0, widthPx, heightPx);
  image.src = '';
  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, widthPx, heightPx);
  } catch {
    throw new Error(`"${name}" can't be drawn here (it contains embedded HTML).`);
  }
  clearFaintPixels(pixels.data);
  if (!pixels.data.some((v, i) => i % 4 === 3 && v > 0)) throw new BlankRenderError(name);
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Could not read the SVG.')),
    );
    reader.readAsDataURL(blob);
  });
}

/** What an SVG relies on that may not print as designed: live text, or images linked by path. */
export function svgWarnings(text: string): { liveText: boolean; linkedImages: boolean } {
  return {
    liveText: /<text[\s>]/i.test(text),
    linkedImages: /<image\b[^>]*\shref\s*=\s*["'](?!data:|#)/i.test(
      text.replace(/xlink:href/gi, 'href'),
    ),
  };
}
