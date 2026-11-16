/**
 * Checks a sheet read from outside (a project file or the browser's saved copy). Anything that
 * is not exactly the expected shape and within sane bounds is refused, so a damaged or crafted
 * file cannot put the editor in an impossible state.
 */
import {
  MAX_DESIGNS,
  MAX_SHEET_LENGTH_MM,
  MAX_SIZE_MM,
  MAX_WIDTH_MM,
  MIN_SIZE_MM,
  MIN_WIDTH_MM,
  type Design,
  type Settings,
  type Sheet,
} from '@/model/types';

export class InvalidSheetError extends Error {
  constructor(what: string) {
    super(`Invalid sheet data: ${what}`);
    this.name = 'InvalidSheetError';
  }
}

/** Largest coordinate accepted, in mm (well beyond any real sheet). */
const LIMIT_MM = 1_000_000;
const MAX_NAME = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new InvalidSheetError(`${what} must be a number from ${min} to ${max}`);
  }
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new InvalidSheetError(`${what} must be true or false`);
  return v;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_NAME) {
    throw new InvalidSheetError(`${what} must be text of 1 to ${MAX_NAME} characters`);
  }
  return v;
}

export function validateSettings(v: unknown): Settings {
  if (!isRecord(v)) throw new InvalidSheetError('settings are missing');
  const lengthMode = v['lengthMode'];
  if (lengthMode !== 'auto' && lengthMode !== 'fixed') {
    throw new InvalidSheetError('length mode must be auto or fixed');
  }
  return {
    sheetWidthMm: num(v['sheetWidthMm'], 'sheet width', MIN_WIDTH_MM, MAX_WIDTH_MM),
    lengthMode,
    fixedLengthMm: num(v['fixedLengthMm'], 'fixed length', 10, MAX_SHEET_LENGTH_MM),
    gapMm: num(v['gapMm'], 'cutting gap', 0, 100),
  };
}

function validateDesign(v: unknown, index: number, assetIds: ReadonlySet<string>): Design {
  const at = `design ${index + 1}`;
  if (!isRecord(v)) throw new InvalidSheetError(`${at} is not a design`);
  const assetId = text(v['assetId'], `${at} image`);
  if (!assetIds.has(assetId)) throw new InvalidSheetError(`${at} points at a missing image`);
  return {
    id: text(v['id'], `${at} id`),
    assetId,
    name: text(v['name'], `${at} name`),
    xMm: num(v['xMm'], `${at} x`, -LIMIT_MM, LIMIT_MM),
    yMm: num(v['yMm'], `${at} y`, -LIMIT_MM, LIMIT_MM),
    widthMm: num(v['widthMm'], `${at} width`, MIN_SIZE_MM, MAX_SIZE_MM),
    heightMm: num(v['heightMm'], `${at} height`, MIN_SIZE_MM, MAX_SIZE_MM),
    angleDeg: num(v['angleDeg'], `${at} angle`, -360, 360),
    flipX: bool(v['flipX'], `${at} flip`),
    flipY: bool(v['flipY'], `${at} flip`),
    locked: bool(v['locked'], `${at} lock`),
  };
}

/** A checked copy of the sheet. Every design must use one of `assetIds`; ids must be unique. */
export function validateSheet(v: unknown, assetIds: ReadonlySet<string>): Sheet {
  if (!isRecord(v) || !Array.isArray(v['designs']))
    throw new InvalidSheetError('designs are missing');
  if (v['designs'].length > MAX_DESIGNS)
    throw new InvalidSheetError(`more than ${MAX_DESIGNS} designs`);
  const designs = v['designs'].map((d, i) => validateDesign(d, i, assetIds));
  if (new Set(designs.map((d) => d.id)).size !== designs.length) {
    throw new InvalidSheetError('two designs share an id');
  }
  return { designs, settings: validateSettings(v['settings']) };
}

/**
 * Like validateSheet, but one bad design does not refuse the whole sheet: designs that are
 * malformed, point at a missing image, repeat an id or go past the design limit are left out and
 * counted. The settings and the designs list itself must still be valid.
 */
export function validateSheetLenient(
  v: unknown,
  assetIds: ReadonlySet<string>,
): { sheet: Sheet; dropped: number } {
  if (!isRecord(v) || !Array.isArray(v['designs'])) {
    throw new InvalidSheetError('designs are missing');
  }
  const settings = validateSettings(v['settings']);
  const designs: Design[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  v['designs'].forEach((raw, i) => {
    try {
      const d = validateDesign(raw, i, assetIds);
      if (seen.has(d.id) || designs.length >= MAX_DESIGNS) throw new InvalidSheetError('extra');
      seen.add(d.id);
      designs.push(d);
    } catch {
      dropped++;
    }
  });
  return { sheet: { designs, settings }, dropped };
}
