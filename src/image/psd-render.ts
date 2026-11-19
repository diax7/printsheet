/// <reference lib="webworker" />
/**
 * Drawing what was chosen from a PSD, in the import worker: a layer with its mask, opacity and
 * the layers clipped to it, a folder merged bottom to top, or the whole image. Positions are in
 * document pixels, and nothing is drawn outside the page: a file may place a layer anywhere,
 * but only the page is shown in Photoshop, and the page is within the image limits. The import
 * then trims each drawing like any image.
 *
 * As in Photoshop: a clipped layer shows only where its base layer has pixels, at the base's own
 * alpha (before the base's fill opacity), and blends with what is under it; fill opacity applies
 * to the base's pixels alone; a layer's mask applies to it, and a folder's mask and opacity to
 * its merged result. Effects and adjustment layers are not drawn (the list says so).
 */
import type { Layer, LayerMaskData, PixelData, Psd } from 'ag-psd';
import {
  blendOperation,
  clippedTo,
  contentBox,
  layerAt,
  layerBox,
  type Box,
  type Page,
} from '@/image/psd';

interface Drawn {
  canvas: OffscreenCanvas;
  box: Box;
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot process images here.');
  return ctx;
}

/** The part of `pixels` (placed at `at`) that falls inside `box`, as a canvas of `box`'s size. */
function pixelsIn(pixels: PixelData, at: { x: number; y: number }, box: Box): OffscreenCanvas {
  const canvas = new OffscreenCanvas(box.w, box.h);
  // ImageData needs 8-bit values on a plain ArrayBuffer; an 8-bit PSD's layers already are.
  const data = new Uint8ClampedArray(pixels.width * pixels.height * 4);
  data.set(pixels.data);
  const image = new ImageData(data, pixels.width, pixels.height);
  context(canvas).putImageData(image, at.x - box.x, at.y - box.y);
  return canvas;
}

/** Scale each pixel's alpha by the mask: its grey value inside the mask's box, its default outside. */
function applyMask(drawn: Drawn, mask: LayerMaskData | undefined): void {
  if (!mask || mask.disabled) return;
  const ctx = context(drawn.canvas);
  const image = ctx.getImageData(0, 0, drawn.box.w, drawn.box.h);
  const outside = mask.defaultColor ?? 255;
  const left = mask.left ?? 0;
  const top = mask.top ?? 0;
  const values = mask.imageData;
  const mw = values?.width ?? 0;
  const mh = values?.height ?? 0;
  for (let py = 0; py < drawn.box.h; py++) {
    const my = drawn.box.y + py - top;
    for (let px = 0; px < drawn.box.w; px++) {
      const mx = drawn.box.x + px - left;
      const inside = values && mx >= 0 && my >= 0 && mx < mw && my < mh;
      const m = inside ? (values.data[(my * mw + mx) * 4] ?? 255) : outside;
      const a = (py * drawn.box.w + px) * 4 + 3;
      image.data[a] = Math.round(((image.data[a] ?? 0) * m) / 255);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** The part of a layer's pixels on the page, with its mask applied, or null when there is none. */
function ownPixels(layer: Layer, page: Page): Drawn | null {
  const box = layerBox(layer, page);
  if (!layer.imageData || box.w === 0 || box.h === 0) return null;
  const at = { x: layer.left ?? 0, y: layer.top ?? 0 };
  const drawn = { canvas: pixelsIn(layer.imageData, at, box), box };
  applyMask(drawn, layer.mask);
  return drawn;
}

/** Draw `drawn` onto `target` at its place, with an opacity and the layer's blend mode. */
function drawOnto(target: Drawn, drawn: Drawn, opacity: number, layer: Layer): void {
  const ctx = context(target.canvas);
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blendOperation(layer.blendMode).op;
  ctx.drawImage(drawn.canvas, drawn.box.x - target.box.x, drawn.box.y - target.box.y);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * A clipped layer cut to its base's shape: its pixels kept only where the base has pixels, at
 * the base's full alpha, on a canvas the size of the base.
 */
function cutToBase(layer: Layer, base: Drawn, page: Page): Drawn | null {
  const own = ownPixels(layer, page);
  if (!own) return null;
  const cut: Drawn = { canvas: new OffscreenCanvas(base.box.w, base.box.h), box: base.box };
  const ctx = context(cut.canvas);
  ctx.drawImage(own.canvas, own.box.x - base.box.x, own.box.y - base.box.y);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(base.canvas, 0, 0);
  return cut;
}

/** A layer and the layers clipped to it, before its own opacity and blend mode. */
function clipGroup(siblings: readonly Layer[], index: number, page: Page): Drawn | null {
  const layer = siblings[index];
  const base = layer && ownPixels(layer, page);
  if (!layer || !base) return null;
  const group: Drawn = { canvas: new OffscreenCanvas(base.box.w, base.box.h), box: base.box };
  const ctx = context(group.canvas);
  ctx.globalAlpha = layer.fillOpacity ?? 1;
  ctx.drawImage(base.canvas, 0, 0);
  ctx.globalAlpha = 1;
  // Each clipped layer blends with the base and the clipped layers under it (multiply darkens
  // the base's colour, as in Photoshop), cut to the base's shape first.
  for (const clipped of clippedTo(siblings, index)) {
    if (clipped.hidden || clipped.adjustment) continue;
    const cut = cutToBase(clipped, base, page);
    if (cut) drawOnto(group, cut, (clipped.opacity ?? 1) * (clipped.fillOpacity ?? 1), clipped);
  }
  return group;
}

/** A folder's visible layers merged bottom to top, with its own mask (not its opacity). */
function mergedFolder(folder: Layer, page: Page): Drawn | null {
  const box = contentBox(folder, page);
  if (!box) return null;
  const merged: Drawn = { canvas: new OffscreenCanvas(box.w, box.h), box };
  const children = folder.children ?? [];
  children.forEach((child, index) => {
    if (child.hidden || child.adjustment || child.clipping) return;
    const drawn = child.children ? mergedFolder(child, page) : clipGroup(children, index, page);
    if (drawn) drawOnto(merged, drawn, child.opacity ?? 1, child);
  });
  applyMask(merged, folder.mask);
  return merged;
}

/** Copy `drawn` at an opacity, so a chosen layer or folder carries its own opacity. */
function atOpacity(drawn: Drawn, opacity: number): OffscreenCanvas {
  if (opacity >= 1) return drawn.canvas;
  const out = new OffscreenCanvas(drawn.box.w, drawn.box.h);
  const ctx = context(out);
  ctx.globalAlpha = opacity;
  ctx.drawImage(drawn.canvas, 0, 0);
  return out;
}

/** The drawing for a row of the list (`whole` for the composite), or null when it is empty. */
export function renderPsdNode(psd: Psd, id: string): OffscreenCanvas | null {
  const page: Page = { width: psd.width, height: psd.height };
  if (id === 'whole') {
    if (!psd.imageData) return null;
    return pixelsIn(psd.imageData, { x: 0, y: 0 }, { x: 0, y: 0, w: psd.width, h: psd.height });
  }
  const found = layerAt(psd, id);
  if (!found) return null;
  const { layer, siblings, index } = found;
  const drawn = layer.children ? mergedFolder(layer, page) : clipGroup(siblings, index, page);
  return drawn ? atOpacity(drawn, layer.opacity ?? 1) : null;
}
