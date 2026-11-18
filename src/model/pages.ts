/**
 * Split jobs: the film cut into sheets of one length. Sheets live in the same model space as one
 * long sheet, stacked top to bottom with a gutter between them, so the editor can drag, snap and
 * hit-test exactly as before; the gutter is only a band no design may touch. Every calculation
 * that maps a y position to a sheet lives here, so no caller does its own arithmetic.
 */
import { contentLengthMm, footprint } from '@/model/geometry';
import type { Design, Settings, Sheet } from '@/model/types';

/**
 * Space between two sheets in the editor. It is part of the saved file format (designs are
 * stored with these gaps in their positions), so changing it needs a file migration.
 */
export const PAGE_GUTTER_MM = 40;
/** Most sheets one job can hold. Every loop over sheets is bounded by this, never by design y. */
export const MAX_PAGES = 50;

const EPS = 0.01;

export interface Band {
  top: number;
  bottom: number;
}

const pitch = (s: Settings): number => s.pageLengthMm + PAGE_GUTTER_MM;

/** Where sheet `index` (from 0) sits in model space. */
export function bandOf(index: number, s: Settings): Band {
  const top = index * pitch(s);
  return { top, bottom: top + s.pageLengthMm };
}

/** Index of the band of sheet + gutter holding `y`, kept within the sheets that can exist. */
function bandIndex(y: number, s: Settings): number {
  return Math.min(MAX_PAGES - 1, Math.max(0, Math.floor(y / pitch(s))));
}

/** The sheet holding the whole design (by its rectangle), or null when it is on none. */
export function pageOf(d: Design, s: Settings): number | null {
  const box = footprint(d);
  if (box.minY < -EPS || box.minY >= MAX_PAGES * pitch(s)) return null;
  const index = bandIndex(box.minY, s);
  const band = bandOf(index, s);
  return box.minY >= band.top - EPS && box.maxY <= band.bottom + EPS ? index : null;
}

/** Sheets in use: up to the last one any design starts on (crossing designs count too). */
export function pageCount(sheet: Sheet): number {
  let count = 0;
  for (const d of sheet.designs)
    count = Math.max(count, bandIndex(footprint(d).minY, sheet.settings) + 1);
  return count;
}

/** The designs wholly on each sheet in use, by sheet. */
export function designsByPage(sheet: Sheet): Design[][] {
  const pages: Design[][] = Array.from({ length: pageCount(sheet) }, () => []);
  for (const d of sheet.designs) {
    const index = pageOf(d, sheet.settings);
    if (index !== null) pages[index]?.push(d);
  }
  return pages;
}

/**
 * The film length of each sheet in use: the full sheet length, except that empty sheets are 0
 * and the last non-empty sheet is cut after its designs when the last sheet is set to Trim
 * (rounded up to the cm, never longer than the sheet).
 */
export function pageLengths(sheet: Sheet): number[] {
  const s = sheet.settings;
  const pages = designsByPage(sheet);
  const last = pages.findLastIndex((p) => p.length > 0);
  return pages.map((designs, index) => {
    if (designs.length === 0) return 0;
    if (index !== last || s.lastPage === 'full') return s.pageLengthMm;
    const top = bandOf(index, s).top;
    const shifted = designs.map((d) => ({ ...d, yMm: d.yMm - top }));
    return Math.min(s.pageLengthMm, contentLengthMm(shifted));
  });
}

/** Film needed: the sheet length for one long sheet, the sum of the sheets for a split job. */
export function filmLengthMm(sheet: Sheet): number {
  if (sheet.settings.layout === 'split') return pageLengths(sheet).reduce((a, b) => a + b, 0);
  const { lengthMode, fixedLengthMm } = sheet.settings;
  return lengthMode === 'fixed' ? fixedLengthMm : contentLengthMm(sheet.designs);
}

function shiftY(d: Design, dy: number): Design {
  return dy === 0 ? d : { ...d, yMm: d.yMm + dy };
}

/**
 * One long sheet to sheets of `pageLengthMm`: each design moves down by the gutters above the
 * sheet holding its top edge, crossing a split or not, so a crossing design stays across its
 * split (and is flagged) instead of landing unseen inside the next sheet. Locked designs move
 * too: their place on the film does not change, only the gaps the editor draws between sheets.
 */
export function toSplit(sheet: Sheet, pageLengthMm: number): Sheet {
  const settings: Settings = { ...sheet.settings, layout: 'split', pageLengthMm };
  const designs = sheet.designs.map((d) => {
    const top = footprint(d).minY;
    const index = Math.min(MAX_PAGES - 1, Math.max(0, Math.floor(top / pageLengthMm)));
    return shiftY(d, index * PAGE_GUTTER_MM);
  });
  return { designs, settings };
}

/**
 * Sheets back to one long sheet: each design moves up by the gutters above its sheet. A design
 * whose top edge is in a gutter belongs to the sheet above it.
 */
export function toSingle(sheet: Sheet): Sheet {
  const s = sheet.settings;
  const designs = sheet.designs.map((d) =>
    shiftY(d, -bandIndex(footprint(d).minY, s) * PAGE_GUTTER_MM),
  );
  return { designs, settings: { ...s, layout: 'single' } };
}

/** A new sheet length, keeping every design's position on the film. */
export function changePageLength(sheet: Sheet, pageLengthMm: number): Sheet {
  return toSplit(toSingle(sheet), pageLengthMm);
}

/** Why a design is on no sheet of a split job, or null when it is on one. */
export type OffSheetReason = 'too-tall' | 'past-last' | 'crossing';

export function offSheetReason(d: Design, s: Settings): OffSheetReason | null {
  if (pageOf(d, s) !== null) return null;
  const box = footprint(d);
  if (box.maxY - box.minY > s.pageLengthMm + EPS) return 'too-tall';
  if (box.minY >= MAX_PAGES * pitch(s)) return 'past-last';
  return 'crossing';
}

/** True when two designs sit wholly on two different sheets (they are separate files). */
export function onDifferentPages(a: Design, b: Design, s: Settings): boolean {
  const pa = pageOf(a, s);
  const pb = pageOf(b, s);
  return pa !== null && pb !== null && pa !== pb;
}

/** The sheets a packer may fill, top to bottom; null for one long sheet (no bands). */
export function bandsFor(s: Settings): Band[] | null {
  if (s.layout !== 'split') return null;
  return Array.from({ length: MAX_PAGES }, (_, i) => bandOf(i, s));
}

/**
 * Where to put a design no free spot can hold: below everything on one long sheet, or at the
 * top of the first sheet after the ones in use. With all 50 sheets in use that is past the last
 * sheet, never on top of another design; the checks then say why it does not fit.
 */
export function fallbackTop(sheet: Sheet): number {
  if (sheet.settings.layout === 'single') {
    return contentLengthMm(sheet.designs) + sheet.settings.gapMm;
  }
  return bandOf(Math.min(pageCount(sheet), MAX_PAGES), sheet.settings).top;
}

/** The sheet a design belongs to by its top edge (also when it crosses a split). */
export function bandHolding(d: Design, s: Settings): Band {
  return bandOf(bandIndex(footprint(d).minY, s), s);
}

/** Top of the sheet after the one holding `y` (the last sheet's own top past the cap). */
export function nextBandTop(y: number, s: Settings): number {
  return bandOf(Math.min(MAX_PAGES - 1, bandIndex(y, s) + 1), s).top;
}

/** One file's worth of an export: a sheet of the job, as a one-long-sheet `Sheet`. */
export interface ExportPart {
  /** Position among the exported files, 1..of. */
  number: number;
  of: number;
  /** The sheet's number in the editor (differs from `number` after an empty sheet). */
  sheetNumber: number;
  sheet: Sheet;
}

/**
 * The parts to export. One long sheet is one part, as it is. A split job gives each non-empty
 * sheet as its own one-long-sheet part: designs moved up to the sheet's top and a fixed length
 * from `pageLengths` (the last one trimmed or full). Empty sheets are left out and listed by
 * their editor number in `empty`; parts are numbered 1..K so no file number is missing.
 */
export function splitForExport(sheet: Sheet): { parts: ExportPart[]; empty: number[] } {
  if (sheet.settings.layout === 'single') {
    return { parts: [{ number: 1, of: 1, sheetNumber: 1, sheet }], empty: [] };
  }
  const lengths = pageLengths(sheet);
  const pages = designsByPage(sheet);
  const empty: number[] = [];
  const used: Array<{ sheetNumber: number; sheet: Sheet }> = [];
  pages.forEach((designs, index) => {
    if (designs.length === 0) {
      empty.push(index + 1);
      return;
    }
    const top = bandOf(index, sheet.settings).top;
    const settings: Settings = {
      ...sheet.settings,
      layout: 'single',
      lengthMode: 'fixed',
      fixedLengthMm: lengths[index] ?? sheet.settings.pageLengthMm,
    };
    used.push({
      sheetNumber: index + 1,
      sheet: { settings, designs: designs.map((d) => shiftY(d, -top)) },
    });
  });
  const parts = used.map((u, i) => ({ number: i + 1, of: used.length, ...u }));
  return { parts, empty };
}
