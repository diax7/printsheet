/**
 * The `.printsheet` project file: one binary file holding the layout and every image it uses.
 *
 *   bytes 0..7    "PSHEET01"
 *   bytes 8..11   header length (u32, big-endian)
 *   header        JSON: { version, sheet, assets: [{ id, name, widthPx, heightPx,
 *                 hasTransparency, format?, vector?, offset, size }], sources?: [{ id, type,
 *                 offset, size }] }
 *   rest          the images' PNG bytes and the vector source files, back to back; `offset`
 *                 counts from the end of the header. A source file shared by several designs
 *                 (the pages of one PDF) is stored once.
 *
 * Images stay binary (no base64), so large projects do not hit JavaScript's string size limit,
 * and opening uses Blob slices, so images are not copied into memory twice.
 */
import { validateSheetLenient } from '@/model/validate';
import { isFileFormat } from '@/image/format';
import {
  MAX_SIZE_MM,
  MIN_SIZE_MM,
  type FileFormat,
  type ImageAsset,
  type Sheet,
  type VectorSource,
} from '@/model/types';

export const PROJECT_MAGIC = 'PSHEET01';
/**
 * Newest version this build reads. Version 2 marks a split job (sheets stored with the gutters
 * between them); one long sheet is still written as version 1, so older copies of the app keep
 * opening it, while they refuse a split job instead of showing it as one sheet with gaps.
 * Version 3 marks vector designs, whose source files older copies would not keep.
 */
export const PROJECT_VERSION = 3;

/** The lowest version that holds this sheet: 3 with a vector design, 2 for a split job, else 1. */
export function formatVersion(sheet: Sheet, assets: ReadonlyMap<string, ImageAsset>): number {
  if (sheet.designs.some((d) => assets.get(d.assetId)?.vector)) return 3;
  return sheet.settings.layout === 'split' ? 2 : 1;
}
export const PROJECT_EXTENSION = '.printsheet';
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_SIDE = 65_535;
const MAX_PAGE = 100_000;

interface AssetEntry {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  hasTransparency: boolean;
  format?: FileFormat;
  vector?: Omit<VectorSource, 'blob'>;
  offset: number;
  size: number;
}

interface SourceEntry {
  id: string;
  type: VectorSource['type'];
  offset: number;
  size: number;
}

const SOURCE_MIME: Record<VectorSource['type'], string> = {
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function withoutBlob(vector: VectorSource): Omit<VectorSource, 'blob'> {
  const { blob: _blob, ...rest } = vector;
  return rest;
}

export async function serializeProject(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
): Promise<Blob> {
  const used = [...new Set(sheet.designs.map((d) => d.assetId))];
  const entries: AssetEntry[] = [];
  const sources: SourceEntry[] = [];
  const blobs: Blob[] = [];
  let offset = 0;
  const append = (blob: Blob): number => {
    const at = offset;
    blobs.push(blob);
    offset += blob.size;
    return at;
  };
  for (const id of used) {
    const asset = assets.get(id);
    if (!asset) throw new Error(`Cannot save: the image for a design is missing (${id})`);
    const { vector } = asset;
    if (vector && !sources.some((s) => s.id === vector.sourceId)) {
      const size = vector.blob.size;
      sources.push({ id: vector.sourceId, type: vector.type, offset: append(vector.blob), size });
    }
    entries.push({
      id,
      name: asset.name,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      ...(asset.format ? { format: asset.format } : {}),
      ...(vector ? { vector: withoutBlob(vector) } : {}),
      offset: append(asset.blob),
      size: asset.blob.size,
    });
  }
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: formatVersion(sheet, assets),
      sheet,
      assets: entries,
      ...(sources.length ? { sources } : {}),
    }),
  );
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length);
  return new Blob([new TextEncoder().encode(PROJECT_MAGIC), length, header, ...blobs], {
    type: 'application/octet-stream',
  });
}

/** Thrown for anything wrong with a file being opened; the message is shown to the user. */
export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

const damaged = (detail: string): ProjectFileError =>
  new ProjectFileError(`This project file is damaged and cannot be opened (${detail}).`);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function int(n: unknown, max: number): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
}

/**
 * Each image and each source file must have its own id and its own bytes. Overlapping or repeated
 * entries would let a small file claim many large images and exhaust memory when copied out.
 */
function checkNoOverlap(entries: readonly AssetEntry[], sources: readonly SourceEntry[]): void {
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw damaged('repeated image');
  if (new Set(sources.map((e) => e.id)).size !== sources.length) throw damaged('repeated source');
  const ranges = [...entries, ...sources].toSorted((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) {
    const before = ranges[i - 1] as SourceEntry;
    if ((ranges[i] as SourceEntry).offset < before.offset + before.size)
      throw damaged('overlapping images');
  }
}

const fraction = (n: unknown): n is number => typeof n === 'number' && n >= 0 && n <= 1;
const printSize = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= MIN_SIZE_MM && n <= MAX_SIZE_MM;

/** A vector's details, or a refusal: a crafted file must not point outside its page or source. */
function checkVector(v: unknown, sourceIds: ReadonlySet<string>): Omit<VectorSource, 'blob'> {
  if (!isRecord(v) || !isRecord(v['crop']) || !isRecord(v['sizeMm'])) throw damaged('vector');
  const { type, sourceId, page } = v;
  const { x, y, w, h } = v['crop'];
  const { w: widthMm, h: heightMm } = v['sizeMm'];
  const cropOk =
    fraction(x) && fraction(y) && fraction(w) && fraction(h) && w > 0 && h > 0
      ? x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9
      : false;
  if (
    (type !== 'svg' && type !== 'pdf') ||
    typeof sourceId !== 'string' ||
    !sourceIds.has(sourceId) ||
    !int(page, MAX_PAGE) ||
    page < 1 ||
    !cropOk ||
    !printSize(widthMm) ||
    !printSize(heightMm)
  ) {
    throw damaged('vector');
  }
  return {
    type,
    sourceId,
    page,
    crop: { x: x as number, y: y as number, w: w as number, h: h as number },
    sizeMm: { w: widthMm, h: heightMm },
  };
}

function checkSource(v: unknown, dataSize: number): SourceEntry {
  if (!isRecord(v)) throw damaged('source list');
  const { id, type, offset, size } = v;
  if (typeof id !== 'string' || id.length === 0 || (type !== 'svg' && type !== 'pdf'))
    throw damaged('source details');
  if (!int(offset, dataSize) || !int(size, dataSize) || offset + size > dataSize)
    throw damaged('source position');
  return { id, type, offset, size };
}

function checkEntry(v: unknown, dataSize: number, sourceIds: ReadonlySet<string>): AssetEntry {
  if (!isRecord(v)) throw damaged('image list');
  const { id, name, widthPx, heightPx, hasTransparency, format, vector, offset, size } = v;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof name !== 'string' ||
    typeof hasTransparency !== 'boolean'
  ) {
    throw damaged('image details');
  }
  if (
    !int(widthPx, MAX_IMAGE_SIDE) ||
    !int(heightPx, MAX_IMAGE_SIDE) ||
    widthPx === 0 ||
    heightPx === 0
  ) {
    throw damaged('image size');
  }
  if (!int(offset, dataSize) || !int(size, dataSize) || offset + size > dataSize)
    throw damaged('image position');
  // The file type only picks a badge: one this build does not know is dropped, not refused.
  return {
    id,
    name,
    widthPx,
    heightPx,
    hasTransparency,
    ...(isFileFormat(format) ? { format } : {}),
    ...(vector === undefined ? {} : { vector: checkVector(vector, sourceIds) }),
    offset,
    size,
  };
}

/** The header's checked image and source lists. */
function checkLists(
  header: Record<string, unknown>,
  dataSize: number,
): { entries: AssetEntry[]; sources: SourceEntry[] } {
  if (!Array.isArray(header['assets'])) throw damaged('image list');
  const rawSources = header['sources'] ?? [];
  if (!Array.isArray(rawSources)) throw damaged('source list');
  const sources = rawSources.map((e) => checkSource(e, dataSize));
  const sourceIds = new Set(sources.map((e) => e.id));
  const entries = header['assets'].map((e) => checkEntry(e, dataSize, sourceIds));
  checkNoOverlap(entries, sources);
  return { entries, sources };
}

/** The header of a project file, checked as far as its signature, length and version. */
async function readHeader(
  file: Blob,
): Promise<{ header: Record<string, unknown>; dataStart: number }> {
  const notProject = new ProjectFileError('This file is not a PrintSheet project.');
  if (file.size < 12) throw file.size >= 8 ? damaged('too short') : notProject;
  const start = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(start.subarray(0, 8)) !== PROJECT_MAGIC) throw notProject;
  const headerLength = new DataView(start.buffer).getUint32(8);
  if (headerLength > MAX_HEADER_BYTES || 12 + headerLength > file.size) throw damaged('header');

  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder().decode(await file.slice(12, 12 + headerLength).arrayBuffer()),
    );
  } catch {
    throw damaged('header');
  }
  if (!isRecord(header)) throw damaged('header');
  if (typeof header['version'] !== 'number') throw damaged('version');
  if (header['version'] > PROJECT_VERSION) {
    throw new ProjectFileError(
      'This project was made by a newer version of PrintSheet. Reload the page to update.',
    );
  }
  return { header, dataStart: 12 + headerLength };
}

/**
 * Open a project file. Designs that cannot be used (malformed, or their image is missing) are
 * left out and counted in `dropped`; anything wrong with the file's structure refuses it.
 */
export async function parseProject(
  file: Blob,
): Promise<{ sheet: Sheet; assets: Map<string, ImageAsset>; dropped: number }> {
  const { header, dataStart } = await readHeader(file);
  const { entries, sources } = checkLists(header, file.size - dataStart);

  let layout;
  try {
    layout = validateSheetLenient(header['sheet'], new Set(entries.map((e) => e.id)));
  } catch (error) {
    throw damaged(error instanceof Error ? error.message : 'layout');
  }
  // Copy out only the images a usable design needs. The bytes are copied because a slice stays
  // tied to the file and breaks if the file is moved later.
  const used = new Set(layout.sheet.designs.map((d) => d.assetId));
  const copy = async (e: { offset: number; size: number }, type: string): Promise<Blob> =>
    new Blob(
      [await file.slice(dataStart + e.offset, dataStart + e.offset + e.size).arrayBuffer()],
      { type },
    );
  // One Blob per source file, shared by every design cut from it.
  const sourceBlobs = new Map<string, Blob>();
  const assets = new Map<string, ImageAsset>();
  for (const e of entries.filter((x) => used.has(x.id))) {
    let vector: VectorSource | undefined;
    if (e.vector) {
      const entry = sources.find((s) => s.id === e.vector?.sourceId) as SourceEntry;
      const blob = sourceBlobs.get(entry.id) ?? (await copy(entry, SOURCE_MIME[entry.type]));
      sourceBlobs.set(entry.id, blob);
      vector = { ...e.vector, blob };
    }
    assets.set(e.id, {
      id: e.id,
      name: e.name,
      widthPx: e.widthPx,
      heightPx: e.heightPx,
      hasTransparency: e.hasTransparency,
      ...(e.format ? { format: e.format } : {}),
      ...(vector ? { vector } : {}),
      blob: await copy(e, 'image/png'),
    });
  }
  return { sheet: layout.sheet, assets, dropped: layout.dropped };
}
