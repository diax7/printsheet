/**
 * Centimetre rulers along the top and left of the sheet. They read the canvas's viewport
 * transform, so they line up with the sheet at every zoom and scroll position. In a split job the
 * side ruler counts from each sheet's top and is blank over the gaps between sheets.
 */
import type { TMat2D } from 'fabric';
import { MAX_PAGES, bandOf, type Band } from '@/model/pages';
import type { Settings } from '@/model/types';

const STEPS_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** The smallest labelled step that keeps labels at least ~50 px apart. */
function labelStep(scale: number): number {
  return STEPS_MM.find((mm) => mm * scale >= 50 && mm >= 10) ?? 1000;
}

interface Axis {
  ctx: CanvasRenderingContext2D;
  horizontal: boolean;
  /** Screen position of model 0 along this axis, and pixels per mm. */
  offset: number;
  scale: number;
  thickness: number;
  major: number;
  minor: number;
}

/**
 * Ticks and labels for one stretch of the ruler, from `fromMm` to `toMm` in model mm, labelled
 * in centimetres counted from `baseMm` (the top of its sheet).
 */
function drawStretch(axis: Axis, baseMm: number, fromMm: number, toMm: number): void {
  const { ctx, horizontal, offset, scale, thickness, major, minor } = axis;
  const first = Math.ceil((fromMm - baseMm) / minor - 1e-9) * minor;
  for (let local = first; baseMm + local <= toMm + 1e-9; local += minor) {
    const pos = Math.round(offset + (baseMm + local) * scale) + 0.5;
    const isMajor = Math.abs(local / major - Math.round(local / major)) < 1e-6;
    const tick = isMajor ? thickness : thickness * 0.3;
    if (horizontal) {
      ctx.moveTo(pos, thickness);
      ctx.lineTo(pos, thickness - tick);
    } else {
      ctx.moveTo(thickness, pos);
      ctx.lineTo(thickness - tick, pos);
    }
    if (!isMajor) continue;
    const label = String(Math.round(local / 10));
    if (horizontal) ctx.fillText(label, pos + 3, 10);
    else {
      ctx.save();
      ctx.translate(10, pos + 3);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'right';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
}

/** The stretches the side ruler shows: one for one long sheet, one per visible sheet if split. */
function stretches(settings: Settings, fromMm: number, toMm: number): Band[] {
  if (settings.layout !== 'split') return [{ top: 0, bottom: toMm }];
  const result: Band[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const band = bandOf(i, settings);
    if (band.top > toMm) break;
    if (band.bottom >= fromMm) result.push(band);
  }
  return result;
}

function draw(
  canvas: HTMLCanvasElement,
  horizontal: boolean,
  transform: TMat2D,
  settings: Settings,
): void {
  const ctx = prepare(canvas);
  if (!ctx) return;
  const length = horizontal ? canvas.clientWidth : canvas.clientHeight;
  const thickness = horizontal ? canvas.clientHeight : canvas.clientWidth;
  const scale = transform[0];
  const offset = horizontal ? transform[4] : transform[5];
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  if (horizontal) {
    // Shade the sheet's width so the printable span is obvious.
    ctx.fillStyle = 'rgba(0, 134, 179, 0.08)';
    ctx.fillRect(offset, 0, settings.sheetWidthMm * scale, thickness);
  }

  const major = labelStep(scale);
  const axis: Axis = {
    ctx,
    horizontal,
    offset,
    scale,
    thickness,
    major,
    minor: major / (major >= 100 ? 10 : 5),
  };
  const fromMm = -offset / scale;
  const toMm = (length - offset) / scale;
  ctx.strokeStyle = '#8b948f';
  ctx.fillStyle = '#5f6a65';
  ctx.font = '500 10px Archivo, system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (horizontal) drawStretch(axis, 0, fromMm, toMm);
  else {
    // In a split job each sheet counts from its own top, and the gutters stay blank.
    for (const band of stretches(settings, fromMm, toMm)) {
      const start = settings.layout === 'split' ? Math.max(fromMm, band.top) : fromMm;
      drawStretch(axis, band.top, start, Math.min(toMm, band.bottom));
    }
  }
  ctx.stroke();
}

export function drawRulers(
  top: HTMLCanvasElement,
  left: HTMLCanvasElement,
  transform: TMat2D,
  settings: Settings,
): void {
  draw(top, true, transform, settings);
  draw(left, false, transform, settings);
}
