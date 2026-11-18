/**
 * The `.printsheet` project file: one binary file holding the layout and every image it uses.
 *
 *   bytes 0..7    "PSHEET01"
 *   bytes 8..11   header length (u32, big-endian)
 *   header        JSON: { version, sheet, assets: [{ id, name, widthPx, heightPx,
 *                 hasTransparency, offset, size }] }
 *   rest          the images' PNG bytes back to back; `offset` counts from the end of the header
 *
 * Images stay binary (no base64), so large projects do not hit JavaScript's string size limit,
 * and opening uses Blob slices, so images are not copied into memory twice.
 */
import { validateSheetLenient } from '@/model/validate';
import type { ImageAsset, Sheet } from '@/model/types';

export const PROJECT_MAGIC = 'PSHEET01';
/**
 * Newest version this build reads. Version 2 marks a split job (sheets stored with the gutters
 * between them); one long sheet is still written as version 1, so older copies of the app keep
 * opening it, while they refuse a split job instead of showing it as one sheet with gaps.
 */
export const PROJECT_VERSION = 2;

/** The version to write for a sheet: 2 for a split job, 1 otherwise. */
export function formatVersion(sheet: Sheet): number {
  return sheet.settings.layout === 'split' ? 2 : 1;
}
export const PROJECT_EXTENSION = '.printsheet';
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_SIDE = 65_535;

interface AssetEntry {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  hasTransparency: boolean;
  offset: number;
  size: number;
}

export async function serializeProject(
  sheet: Sheet,
  assets: ReadonlyMap<string, ImageAsset>,
): Promise<Blob> {
  const used = [...new Set(sheet.designs.map((d) => d.assetId))];
  const entries: AssetEntry[] = [];
  const blobs: Blob[] = [];
  let offset = 0;
  for (const id of used) {
    const asset = assets.get(id);
    if (!asset) throw new Error(`Cannot save: the image for a design is missing (${id})`);
    entries.push({
      id,
      name: asset.name,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      offset,
      size: asset.blob.size,
    });
    blobs.push(asset.blob);
    offset += asset.blob.size;
  }
  const header = new TextEncoder().encode(
    JSON.stringify({ version: formatVersion(sheet), sheet, assets: entries }),
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
 * Each image must have its own id and its own bytes. Overlapping or repeated entries would let a
 * small file claim many large images and exhaust memory when they are copied out.
 */
function checkNoOverlap(entries: readonly AssetEntry[]): void {
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw damaged('repeated image');
  const sorted = entries.toSorted((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1] as AssetEntry;
    if ((sorted[i] as AssetEntry).offset < before.offset + before.size)
      throw damaged('overlapping images');
  }
}

function checkEntry(v: unknown, dataSize: number): AssetEntry {
  if (!isRecord(v)) throw damaged('image list');
  const { id, name, widthPx, heightPx, hasTransparency, offset, size } = v;
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
  return { id, name, widthPx, heightPx, hasTransparency, offset, size };
}

/**
 * Open a project file. Designs that cannot be used (malformed, or their image is missing) are
 * left out and counted in `dropped`; anything wrong with the file's structure refuses it.
 */
export async function parseProject(
  file: Blob,
): Promise<{ sheet: Sheet; assets: Map<string, ImageAsset>; dropped: number }> {
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
  if (!Array.isArray(header['assets'])) throw damaged('image list');

  const dataStart = 12 + headerLength;
  const entries = header['assets'].map((e) => checkEntry(e, file.size - dataStart));
  checkNoOverlap(entries);

  let layout;
  try {
    layout = validateSheetLenient(header['sheet'], new Set(entries.map((e) => e.id)));
  } catch (error) {
    throw damaged(error instanceof Error ? error.message : 'layout');
  }
  // Copy out only the images a usable design needs. The bytes are copied because a slice stays
  // tied to the file and breaks if the file is moved later.
  const used = new Set(layout.sheet.designs.map((d) => d.assetId));
  const assets = new Map<string, ImageAsset>();
  for (const e of entries.filter((x) => used.has(x.id))) {
    const bytes = await file
      .slice(dataStart + e.offset, dataStart + e.offset + e.size)
      .arrayBuffer();
    assets.set(e.id, {
      id: e.id,
      name: e.name,
      widthPx: e.widthPx,
      heightPx: e.heightPx,
      hasTransparency: e.hasTransparency,
      blob: new Blob([bytes], { type: 'image/png' }),
    });
  }
  return { sheet: layout.sheet, assets, dropped: layout.dropped };
}
