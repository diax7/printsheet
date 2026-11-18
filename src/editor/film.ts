/**
 * Drawing the cutting mat and the film under the designs: one film for one long sheet, or one
 * film per sheet of a split job with mat between them. Pure drawing on a 2D context in screen
 * pixels; the canvas module passes in where model y = 0 and x = 0 land and the zoom.
 */
import { contentLengthMm } from '@/model/geometry';
import { MAX_PAGES, bandOf, pageCount, pageLengths } from '@/model/pages';
import { formatM } from '@/model/units';
import type { Sheet } from '@/model/types';
import type { Prefs } from '@/prefs';

const ACCENT = '#0086b3';
const FIXED = '#d6338a';

export interface FilmView {
  ctx: CanvasRenderingContext2D;
  /** Screen x of the sheet's left edge and screen y of model y = 0. */
  x0: number;
  y0: number;
  /** Screen pixels per millimetre. */
  s: number;
  /** Canvas size in screen pixels. */
  w: number;
  h: number;
  prefs: Prefs;
  sheetWidthMm: number;
}

/** How much the scroll area shows: the sheets in use plus room to drag designs below. */
export function viewLengthMm(sheet: Sheet): number {
  const s = sheet.settings;
  if (s.layout === 'split') {
    // The sheets in use and one empty sheet after them, to drop designs onto.
    return bandOf(Math.min(pageCount(sheet), MAX_PAGES - 1), s).bottom + 100;
  }
  const content = contentLengthMm(sheet.designs);
  const base = s.lengthMode === 'fixed' ? Math.max(s.fixedLengthMm, content) : content;
  return Math.max(base + 300, 600);
}

/** Mat grid lines: every 5 cm a little brighter. */
function line(i: number): string {
  return i % 5 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)';
}

/** The green cutting mat with a centimetre grid that follows the sheet. */
export function drawMat(view: FilmView): void {
  const { ctx, x0, y0, s, w, h } = view;
  ctx.fillStyle = '#2f5d50';
  ctx.fillRect(0, 0, w, h);
  const step = 10 * s;
  if (step < 6) return;
  ctx.lineWidth = 1;
  const startX = x0 % step;
  for (let x = startX, i = Math.round((startX - x0) / step); x < w; x += step, i++) {
    ctx.strokeStyle = line(i);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
  }
  const startY = y0 % step;
  for (let y = startY, i = Math.round((startY - y0) / step); y < h; y += step, i++) {
    ctx.strokeStyle = line(i);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
}

function gridColour(mm: number, dark: boolean): string {
  if (dark) return mm % 50 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.25)';
  return mm % 50 ? 'rgba(0,80,110,0.12)' : 'rgba(0,80,110,0.28)';
}

/** The optional 1 cm grid on one film, counted from that film's top. */
function drawFilmGrid(view: FilmView, top: number, length: number): void {
  const { ctx, x0, s, h, sheetWidthMm } = view;
  const dark = view.prefs.background === 'black';
  const bottom = top + length * s;
  for (let mm = 10; mm < sheetWidthMm; mm += 10) {
    ctx.strokeStyle = gridColour(mm, dark);
    ctx.beginPath();
    ctx.moveTo(Math.round(x0 + mm * s) + 0.5, Math.max(top, 0));
    ctx.lineTo(Math.round(x0 + mm * s) + 0.5, Math.min(bottom, h));
    ctx.stroke();
  }
  for (let mm = 10; mm < length; mm += 10) {
    const y = top + mm * s;
    if (y < 0 || y > h) continue;
    ctx.strokeStyle = gridColour(mm, dark);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x0 + sheetWidthMm * s, Math.round(y) + 0.5);
    ctx.stroke();
  }
}

/** One piece of film, `lengthMm` long, starting at model y `topMm`, in the workspace colour. */
export function drawFilm(view: FilmView, topMm: number, lengthMm: number): void {
  const { ctx, x0, y0, s, h, prefs } = view;
  const top = y0 + topMm * s;
  const width = view.sheetWidthMm * s;
  const height = lengthMm * s;
  if (top > h || top + height < 0) return;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, top, width, height);
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.rect(x0, top, width, height);
  ctx.clip();
  if (prefs.background === 'transparent') {
    const cell = 8;
    ctx.fillStyle = '#d9ddd6';
    const firstRow = Math.max(0, Math.floor(-top / cell));
    const lastRow = Math.min(Math.ceil(height / cell), Math.ceil((h - top) / cell));
    const cols = Math.ceil(width / cell);
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = r % 2; c < cols; c += 2) ctx.fillRect(x0 + c * cell, top + r * cell, cell, cell);
    }
  } else {
    const { background, customColor } = prefs;
    ctx.fillStyle =
      background === 'white' ? '#ffffff' : background === 'black' ? '#000000' : customColor;
    ctx.fillRect(x0, top, width, height);
  }
  if (prefs.grid && 10 * s >= 4) drawFilmGrid(view, top, lengthMm);
  ctx.restore();
}

/** A dashed line across the film where it is cut, with a label beside it. */
function drawCut(view: FilmView, yMm: number, label: string, colour: string): void {
  const { ctx, x0, y0, s } = view;
  const y = y0 + yMm * s;
  if (y < -20 || y > view.h + 20) return;
  const width = view.sheetWidthMm * s;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(x0 - 16, Math.round(y) + 0.5);
  ctx.lineTo(x0 + width + 16, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 11px Archivo, system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.roundRect(x0 + width + 18, y - 9, tw + 12, 18, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x0 + width + 24, y + 4);
  ctx.restore();
}

/** A sheet's name above its top-right corner, on the mat. */
function drawSheetName(view: FilmView, topMm: number, label: string): void {
  const { ctx, x0, y0, s } = view;
  const y = y0 + topMm * s;
  if (y < -20 || y > view.h + 20) return;
  ctx.save();
  ctx.font = '600 11px Archivo, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'right';
  ctx.fillText(label, x0 + view.sheetWidthMm * s, y - 8);
  ctx.restore();
}

/**
 * All the film of the sheet: one long film with its cut line, or each sheet of a split job (the
 * ones in use and one empty sheet after them) with its name and, where it is cut short, a cut
 * line at its trimmed length.
 */
export function drawSheets(view: FilmView, sheet: Sheet): void {
  const s = sheet.settings;
  if (s.layout === 'single') {
    drawFilm(view, 0, viewLengthMm(sheet));
    const cut = s.lengthMode === 'fixed' ? s.fixedLengthMm : contentLengthMm(sheet.designs);
    if (cut > 0) drawCut(view, cut, formatM(cut), s.lengthMode === 'fixed' ? FIXED : ACCENT);
    return;
  }
  const lengths = pageLengths(sheet);
  const shown = Math.min(lengths.length + 1, MAX_PAGES);
  for (let i = 0; i < shown; i++) {
    const band = bandOf(i, s);
    const used = lengths[i] ?? 0;
    drawFilm(view, band.top, s.pageLengthMm);
    drawSheetName(view, band.top, used > 0 ? `Sheet ${i + 1}` : `Sheet ${i + 1} (empty)`);
    if (used > 0) drawCut(view, band.top + used, formatM(used), ACCENT);
  }
}
