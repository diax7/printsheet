/**
 * Photoshop files: what can be opened, and the list of what can be added from one. Plain logic
 * over ag-psd's reading of the file, so it runs in the import worker and in unit tests alike;
 * the drawing is in psd-render.ts.
 *
 * Each row is one design to add: a layer (with any layers clipped to it), a folder merged into
 * one, or the whole image as Photoshop saved it. Layer effects, adjustment layers and blend modes
 * a canvas cannot draw are left out, and the row says so.
 */
import type { BlendMode, Layer, LayerEffectsInfo, PixelData, Psd } from 'ag-psd';
import { MAX_IMPORT_AREA, MAX_IMPORT_SIDE } from '@/image/limits';

/** Larger files are refused before reading: a 224 MB mockup took 1.5 GB to read. */
export const MAX_PSD_BYTES = 300 * 1024 * 1024;
/** The decoded layers, masks and composite together, past which a browser tab can run out. */
const MAX_DECODED_BYTES = 1024 * 1024 * 1024;

const RGB = 3;
const GRAYSCALE = 1;
const CMYK = 4;
const OPAQUE_NOTE = 'No transparency: prints as a block';

export interface PsdNode {
  /** Child indexes from the document down, in the file's order (bottom first), joined by "/". */
  id: string;
  label: string;
  kind: 'layer' | 'folder';
  widthPx: number;
  heightPx: number;
  checked: boolean;
  /** Listed but not tickable (a folder whose layers are all hidden); the note says why. */
  disabled?: boolean;
  /** What will be left out or what to know before adding it. */
  notes: string[];
  children?: PsdNode[];
}

/** Canvas blend operations for Photoshop's blend modes; `drawn` is false when none matches. */
const BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  'pass through': 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'linear dodge': 'lighter',
};

export function blendOperation(mode: BlendMode | undefined): {
  op: GlobalCompositeOperation;
  drawn: boolean;
} {
  const op = BLEND[mode ?? 'normal'];
  return op ? { op, drawn: true } : { op: 'source-over', drawn: false };
}

function area(layer: { left?: number; top?: number; right?: number; bottom?: number }): number {
  return (
    Math.max(0, (layer.right ?? 0) - (layer.left ?? 0)) *
    Math.max(0, (layer.bottom ?? 0) - (layer.top ?? 0))
  );
}

/** Bytes the layers, their masks and the composite take once decoded. */
function decodedBytes(psd: Psd): number {
  let total = psd.width * psd.height * 4;
  const walk = (layers: readonly Layer[] | undefined): void => {
    for (const l of layers ?? []) {
      total += area(l) * 4 + (l.mask ? area(l.mask) * 4 : 0);
      walk(l.children);
    }
  };
  walk(psd.children);
  return total;
}

/** Why a PSD (read without its pixels) cannot be opened, or null when it can. */
export function psdRefusal(psd: Psd): string | null {
  // Only RGB is read: the printer works in colour, and other modes' layers are not tested here.
  if (psd.colorMode !== RGB) {
    const named: Record<number, string> = { [CMYK]: 'is in CMYK', [GRAYSCALE]: 'is in Grayscale' };
    const mode = named[psd.colorMode ?? -1] ?? 'uses a colour mode that cannot be opened here';
    return `This PSD ${mode}. In Photoshop choose Image > Mode > RGB Color and save again.`;
  }
  if (psd.bitsPerChannel !== undefined && psd.bitsPerChannel !== 8) {
    return 'This PSD uses 16 or 32 bits per channel. In Photoshop choose Image > Mode > 8 Bits/Channel and save again.';
  }
  if (
    psd.width > MAX_IMPORT_SIDE ||
    psd.height > MAX_IMPORT_SIDE ||
    psd.width * psd.height > MAX_IMPORT_AREA
  ) {
    return `This PSD is too large to open here (${psd.width} × ${psd.height} px; at most ${MAX_IMPORT_SIDE} px on a side and 100 megapixels).`;
  }
  if (decodedBytes(psd) > MAX_DECODED_BYTES) {
    return 'This PSD has too many large layers to open here. Save a copy with fewer layers, or export the layers you need as PNG.';
  }
  return null;
}

/** True when any effect (stroke, shadow, glow...) is switched on. */
function hasEffects(effects: LayerEffectsInfo | undefined): boolean {
  if (!effects || effects.disabled) return false;
  return Object.entries(effects).some(([key, value]) => {
    if (key === 'disabled' || key === 'scale' || !value) return false;
    const list = (Array.isArray(value) ? value : [value]) as Array<{ enabled?: boolean }>;
    return list.some((effect) => effect.enabled !== false);
  });
}

export function hasInk(pixels: PixelData | undefined): boolean {
  if (!pixels) return false;
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i]) return true;
  return false;
}

function isOpaque(pixels: PixelData | undefined): boolean {
  if (!pixels) return false;
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] !== 255) return false;
  return true;
}

/**
 * True when `layers[index]` prints something: it has pixels and opacity, and either fill opacity
 * or layers clipped to it (a fill-0 frame shows only its clipped photo). Adjustment layers and
 * clipped layers themselves (drawn with their base) never count.
 */
function printsAt(layers: readonly Layer[], index: number): boolean {
  const layer = layers[index];
  if (!layer || layer.adjustment || layer.clipping || (layer.opacity ?? 1) === 0) return false;
  const children = layer.children;
  if (children) return children.some((_, i) => printsAt(children, i));
  if (!hasInk(layer.imageData)) return false;
  return (
    (layer.fillOpacity ?? 1) > 0 ||
    clippedTo(layers, index).some((c) => !c.hidden && !c.adjustment && hasInk(c.imageData))
  );
}

/** What a layer's own drawing leaves out. */
function layerNotes(layer: Layer): string[] {
  const notes: string[] = [];
  if (hasEffects(layer.effects)) notes.push('Effects not included');
  if (layer.vectorMask && !layer.vectorFill) notes.push('Vector mask not included');
  const blend = blendOperation(layer.blendMode);
  if (!blend.drawn) notes.push(`Blend mode ${layer.blendMode} drawn as Normal`);
  return notes;
}

/** The layers clipped to `layers[index]`: the ones right above it with clipping on. */
export function clippedTo(layers: readonly Layer[], index: number): Layer[] {
  const clipped: Layer[] = [];
  for (let i = index + 1; i < layers.length && layers[i]?.clipping; i++) {
    clipped.push(layers[i] as Layer);
  }
  return clipped;
}

/** Everything left out of a folder's merged drawing, once each. */
function folderNotes(folder: Layer): string[] {
  const notes = new Set<string>(layerNotes(folder));
  const walk = (layers: readonly Layer[]): void => {
    for (const l of layers) {
      if (l.adjustment) notes.add('Adjustment layers not included');
      else if (!l.hidden) for (const n of layerNotes(l)) notes.add(n);
      if (l.children) walk(l.children);
    }
  };
  walk(folder.children ?? []);
  return [...notes];
}

/** A box in document pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The page a PSD's layers are drawn on (its size is within the image limits). */
export interface Page {
  width: number;
  height: number;
}

/**
 * The part of a layer's box that lies on the page. A file may place a layer anywhere, even far
 * outside the page; Photoshop shows only what is on it, and nothing here may grow past it.
 */
export function layerBox(layer: Layer, page: Page): Box {
  const x = Math.max(0, layer.left ?? 0);
  const y = Math.max(0, layer.top ?? 0);
  const right = Math.min(page.width, layer.right ?? 0);
  const bottom = Math.min(page.height, layer.bottom ?? 0);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/**
 * The box around what a layer or folder draws on the page: a layer's own box, a folder's around
 * its visible layers (the file gives folders no box of their own). Null when it draws nothing.
 */
export function contentBox(layer: Layer, page: Page): Box | null {
  if (!layer.children) {
    const box = layerBox(layer, page);
    return box.w > 0 && box.h > 0 ? box : null;
  }
  let box: Box | null = null;
  const children = layer.children;
  for (const [index, child] of children.entries()) {
    if (child.hidden || !printsAt(children, index)) continue;
    const b = contentBox(child, page);
    if (!b) continue;
    if (!box) {
      box = { ...b };
      continue;
    }
    const right = Math.max(box.x + box.w, b.x + b.w);
    const bottom = Math.max(box.y + box.h, b.y + b.h);
    box.x = Math.min(box.x, b.x);
    box.y = Math.min(box.y, b.y);
    box.w = right - box.x;
    box.h = bottom - box.y;
  }
  return box;
}

/** A folder's row: added merged, or (when all its layers are hidden) only layer by layer. */
function folderNode(
  layer: Layer,
  id: string,
  label: string,
  top: boolean,
  page: Page,
): PsdNode | null {
  const box = contentBox(layer, page);
  const children = nodes(layer.children ?? [], id, false, page);
  if (!box && !children.length) return null;
  if (!box) {
    return {
      id,
      label,
      kind: 'folder',
      widthPx: 0,
      heightPx: 0,
      checked: false,
      disabled: true,
      notes: ['Every layer in it is hidden: open it to add layers one by one'],
      children,
    };
  }
  return {
    id,
    label,
    kind: 'folder',
    widthPx: box.w,
    heightPx: box.h,
    checked: top && !layer.hidden,
    notes: folderNotes(layer),
    children,
  };
}

/** The rows for `layers` (in the file's order), shown top first as in Photoshop. */
function nodes(layers: readonly Layer[], path: string, top: boolean, page: Page): PsdNode[] {
  const out: PsdNode[] = [];
  layers.forEach((layer, index) => {
    if (!printsAt(layers, index)) return;
    const id = path ? `${path}/${index}` : String(index);
    const label = layer.name?.trim() || 'Unnamed layer';
    if (layer.children) {
      const folder = folderNode(layer, id, label, top, page);
      if (folder) out.push(folder);
      return;
    }
    const { w, h } = layerBox(layer, page);
    if (w === 0 || h === 0) return;
    const clipped = clippedTo(layers, index).filter((c) => !c.hidden && !c.adjustment);
    const notes = new Set([...layerNotes(layer), ...clipped.flatMap(layerNotes)]);
    if (isOpaque(layer.imageData)) notes.add(OPAQUE_NOTE);
    out.push({
      id,
      label,
      kind: 'layer',
      widthPx: w,
      heightPx: h,
      checked: top && !layer.hidden,
      notes: [...notes],
    });
  });
  return out.toReversed();
}

/** The list of what can be added from a PSD read with its pixels. */
export function psdTree(psd: Psd): PsdNode[] {
  // A solid layer covering the whole page is a background: it would print as a block of film,
  // so it starts unticked (its note says why).
  return nodes(psd.children ?? [], '', true, psd).map((node) =>
    node.kind === 'layer' &&
    node.widthPx >= psd.width &&
    node.heightPx >= psd.height &&
    node.notes.includes(OPAQUE_NOTE)
      ? { ...node, checked: false }
      : node,
  );
}

/** The layer or folder a row's id points at. */
export function layerAt(
  psd: Psd,
  id: string,
): { layer: Layer; siblings: Layer[]; index: number } | null {
  let siblings = psd.children ?? [];
  let found: { layer: Layer; siblings: Layer[]; index: number } | null = null;
  for (const part of id.split('/')) {
    const index = Number(part);
    const layer = siblings[index];
    if (!Number.isInteger(index) || !layer) return null;
    found = { layer, siblings, index };
    siblings = layer.children ?? [];
  }
  return found;
}
