/**
 * A streaming PNG encoder. The image is rendered in horizontal strips; each strip is filtered
 * and pushed through the browser's zlib compressor, and only compressed bytes are kept. That lets
 * a 5 m sheet at 600 DPI be written without ever holding its raw pixels (gigabytes) in memory.
 */
import { filterPaeth } from '@/export/png-filter';

export interface EncodePngOptions {
  width: number;
  height: number;
  /** Written to the pHYs chunk so viewers and print software open the file at print size. */
  dpi: number;
  rowsPerStrip: number;
  /** Returns `rows` rows of RGBA pixels starting at row `y0` (width × rows × 4 bytes). */
  renderStrip: (y0: number, rows: number) => Promise<Uint8ClampedArray>;
  onProgress?: (doneRows: number, totalRows: number) => void;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** IDAT chunks are cut at this size; any size is valid PNG. */
const MAX_IDAT_BYTES = 1 << 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return c;
}

export function crc32(bytes: Uint8Array): number {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  let c = crcUpdate(0xffffffff, typeBytes);
  c = crcUpdate(c, data);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function header(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 6; // colour type: RGBA
  return data;
}

function physicalSize(dpi: number): Uint8Array {
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  const perMetre = Math.round(dpi / 0.0254);
  view.setUint32(0, perMetre);
  view.setUint32(4, perMetre);
  data[8] = 1; // unit: metre
  return data;
}

/** Collects compressed bytes and cuts them into IDAT chunks. */
async function collectIdat(
  readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pendingBytes === 0) return;
    const data = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const part of pending) {
      data.set(part, offset);
      offset += part.length;
    }
    chunks.push(chunk('IDAT', data));
    pending = [];
    pendingBytes = 0;
  };
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending.push(value);
    pendingBytes += value.length;
    if (pendingBytes >= MAX_IDAT_BYTES) flush();
  }
  flush();
  return chunks;
}

export async function encodePng(options: EncodePngOptions): Promise<Blob> {
  const { width, height, dpi, rowsPerStrip, renderStrip, onProgress } = options;
  if (!(width > 0 && height > 0 && Number.isInteger(width) && Number.isInteger(height))) {
    throw new Error(`Invalid PNG size ${width}×${height}`);
  }
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  const idat = collectIdat(compressor.readable);

  try {
    // The filter of a strip's first row looks at the last row of the strip before it.
    let above: Uint8ClampedArray | null = null;
    for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, height - y0);
      const pixels = await renderStrip(y0, rows);
      if (pixels.length !== width * rows * 4) {
        throw new Error(
          `Rendered strip at row ${y0} has ${pixels.length} bytes, expected ${width * rows * 4}`,
        );
      }
      await writer.write(filterPaeth(pixels, width, rows, 4, above));
      above = pixels.slice((rows - 1) * width * 4);
      onProgress?.(y0 + rows, height);
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await idat.catch(() => undefined);
    throw error;
  }

  const parts: BlobPart[] = [
    SIGNATURE,
    chunk('IHDR', header(width, height)),
    chunk('pHYs', physicalSize(dpi)),
  ];
  parts.push(...(await idat), chunk('IEND', new Uint8Array()));
  return new Blob(parts, { type: 'image/png' });
}
