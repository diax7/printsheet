/**
 * A minimal zip writer for sending several sheets as one file. Files are stored, not compressed:
 * PDFs and PNGs are compressed already, so deflating again would only cost time. The zip is
 * assembled from Blob parts, so large files are not copied into one big buffer.
 */
import { crc32 } from '@/export/png-stream';

export interface ZipEntry {
  name: string;
  blob: Blob;
}

/** Zip without Zip64 tops out at 4 GB; far above any sheet set this app makes. */
const MAX_ZIP_BYTES = 0xffffffff;
/** General-purpose flag bit 11: the file name is UTF-8 (Arabic names stay readable). */
const UTF8_NAMES = 0x0800;

/** Date and time in the MS-DOS format zip uses. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Header {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/** The fields shared by the local header and the central directory entry, from "version needed". */
function commonFields(
  view: DataView,
  at: number,
  h: Header,
  stamp: ReturnType<typeof dosStamp>,
): void {
  view.setUint16(at, 20, true); // version needed: 2.0
  view.setUint16(at + 2, UTF8_NAMES, true);
  view.setUint16(at + 4, 0, true); // method: stored
  view.setUint16(at + 6, stamp.time, true);
  view.setUint16(at + 8, stamp.date, true);
  view.setUint32(at + 10, h.crc, true);
  view.setUint32(at + 14, h.size, true); // compressed size
  view.setUint32(at + 18, h.size, true); // uncompressed size
  view.setUint16(at + 22, h.name.length, true);
  view.setUint16(at + 24, 0, true); // extra field length
}

function localHeader(h: Header, stamp: ReturnType<typeof dosStamp>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(30 + h.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  commonFields(view, 4, h, stamp);
  out.set(h.name, 30);
  return out;
}

function centralEntry(h: Header, stamp: ReturnType<typeof dosStamp>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(46 + h.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // version made by
  commonFields(view, 6, h, stamp);
  // Comment length, disk number, attributes: all zero.
  view.setUint32(42, h.offset, true);
  out.set(h.name, 46);
  return out;
}

function endOfDirectory(count: number, size: number, offset: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return out;
}

/**
 * Packs the files into one zip, in the given order.
 *
 * Args:
 *   files: Name and content of each file. Names must be unique.
 *
 * Raises:
 *   Error: when the list is empty, a name repeats, or the zip would pass 4 GB.
 */
export async function makeZip(files: readonly ZipEntry[]): Promise<Blob> {
  if (files.length === 0) throw new Error('There are no files to put in the zip.');
  if (new Set(files.map((f) => f.name)).size !== files.length) {
    throw new Error('A file name appears twice in the zip.');
  }
  const stamp = dosStamp(new Date());
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const headers: Header[] = [];
  let offset = 0;
  for (const file of files) {
    const header: Header = {
      name: encoder.encode(file.name),
      crc: crc32(new Uint8Array(await file.blob.arrayBuffer())),
      size: file.blob.size,
      offset,
    };
    const local = localHeader(header, stamp);
    parts.push(local, file.blob);
    headers.push(header);
    offset += local.length + file.blob.size;
  }
  const directory = headers.map((h) => centralEntry(h, stamp));
  const directorySize = directory.reduce((sum, d) => sum + d.length, 0);
  if (offset + directorySize + 22 > MAX_ZIP_BYTES) {
    throw new Error('These files are too large for one zip (over 4 GB). Choose separate files.');
  }
  parts.push(...directory, endOfDirectory(files.length, directorySize, offset));
  return new Blob(parts, { type: 'application/zip' });
}
