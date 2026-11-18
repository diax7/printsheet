/**
 * A baseline JPEG encoder for CMYK, for the compact CMYK PDF. Browsers and jpeg-js only write
 * three-channel (RGB) JPEGs, so this writes the four-channel kind Photoshop and Acrobat use:
 * an Adobe APP14 marker with transform 0 (the channels are C, M, Y, K as they are, not YCCK),
 * every channel at full resolution (no subsampling), samples stored inverted (255 - value), as
 * Adobe applications write CMYK JPEG. The PDF image then carries Decode [1 0 1 0 1 0 1 0] so
 * every reader turns the samples back.
 *
 * Built from ITU-T T.81 (JPEG): the example quantisation and Huffman tables of Annex K, a float
 * 8×8 DCT, zigzag order, run-length and Huffman coding with byte stuffing.
 */
import { JPEG_QUALITY } from '@/export/jpeg';

/** The Annex K luminance quantisation table, natural (row by row) order. */
const BASE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Natural index of each coefficient in zigzag order. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Annex K luminance DC Huffman table: code counts per length 1..16, then the symbols. */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** Annex K luminance AC Huffman table. */
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const COMPONENTS = 4;

interface Code {
  code: number;
  length: number;
}

/** Canonical Huffman codes from the count-per-length list, indexed by symbol. */
function huffmanCodes(bits: readonly number[], values: readonly number[]): Code[] {
  const codes: Code[] = [];
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < (bits[length - 1] ?? 0); i++) {
      codes[values[k++] ?? 0] = { code, length };
      code++;
    }
    code <<= 1;
  }
  return codes;
}

const DC_CODES = huffmanCodes(DC_BITS, DC_VALUES);
const AC_CODES = huffmanCodes(AC_BITS, AC_VALUES);

/** The quantisation table for a quality from 1 to 100, scaled as the IJG library does. */
function quantTable(quality: number): number[] {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  return BASE_QUANT.map((q) => Math.min(255, Math.max(1, Math.floor((q * scale + 50) / 100))));
}

/** cos((2x + 1) u π / 16) with the DCT normalisation folded in, indexed [u * 8 + x]. */
const COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const c = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++)
      table[u * 8 + x] = (c / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return table;
})();

/** Forward 2D DCT of an 8×8 block, in place (rows, then columns). */
function forwardDct(block: Float64Array, temp: Float64Array): void {
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += (COS[u * 8 + x] ?? 0) * (block[y * 8 + x] ?? 0);
      temp[y * 8 + u] = sum;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += (COS[v * 8 + y] ?? 0) * (temp[y * 8 + u] ?? 0);
      block[v * 8 + u] = sum;
    }
  }
}

/** Collects bytes and bits; 0xFF in the coded data is followed by a stuffed 0x00. */
class Writer {
  private bytes = new Uint8Array(1 << 16);
  private size = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  byte(value: number): void {
    if (this.size === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.size++] = value & 0xff;
  }

  word(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  bits(code: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bitBuffer = (this.bitBuffer << 1) | ((code >> i) & 1);
      if (++this.bitCount === 8) this.flushByte();
    }
  }

  /** Pads the last byte of coded data with 1 bits, as the standard asks. */
  padBits(): void {
    while (this.bitCount !== 0) this.bits(1, 1);
  }

  /** The bytes written, without copying them again. */
  result(): Uint8Array {
    return this.bytes.subarray(0, this.size);
  }

  private flushByte(): void {
    this.byte(this.bitBuffer);
    if (this.bitBuffer === 0xff) this.byte(0);
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
}

/** Bits needed for |value| (the JPEG "category"), and the value as those bits. */
function category(value: number): { size: number; bits: number } {
  let size = 0;
  for (let a = Math.abs(value); a > 0; a >>= 1) size++;
  const bits = value < 0 ? (value - 1) & ((1 << size) - 1) : value;
  return { size, bits };
}

function writeCode(out: Writer, code: Code | undefined): void {
  if (!code) throw new Error('A JPEG symbol has no Huffman code');
  out.bits(code.code, code.length);
}

/** Huffman-codes one quantised block (zigzag order); returns its DC value for the next block. */
function encodeBlock(out: Writer, coefficients: Int32Array, previousDc: number): number {
  const dc = coefficients[0] ?? 0;
  const diff = category(dc - previousDc);
  writeCode(out, DC_CODES[diff.size]);
  if (diff.size) out.bits(diff.bits, diff.size);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const value = coefficients[k] ?? 0;
    if (value === 0) {
      run++;
      continue;
    }
    for (; run > 15; run -= 16) writeCode(out, AC_CODES[0xf0]);
    const ac = category(value);
    writeCode(out, AC_CODES[(run << 4) | ac.size]);
    out.bits(ac.bits, ac.size);
    run = 0;
  }
  if (run > 0) writeCode(out, AC_CODES[0x00]);
  return dc;
}

function writeHeaders(out: Writer, width: number, height: number, quant: readonly number[]): void {
  out.word(0xffd8);
  // APP14 "Adobe": version 100, no flags, transform 0 (the channels are CMYK, not YCCK).
  out.word(0xffee);
  out.word(14);
  for (const c of 'Adobe') out.byte(c.charCodeAt(0));
  out.word(100);
  out.word(0);
  out.word(0);
  out.byte(0);
  out.word(0xffdb);
  out.word(67);
  out.byte(0);
  for (const index of ZIGZAG) out.byte(quant[index] ?? 1);
  out.word(0xffc0);
  out.word(8 + 3 * COMPONENTS);
  out.byte(8);
  out.word(height);
  out.word(width);
  out.byte(COMPONENTS);
  for (let c = 1; c <= COMPONENTS; c++) {
    out.byte(c);
    out.byte(0x11); // full resolution
    out.byte(0);
  }
  out.word(0xffc4);
  out.word(2 + 17 + DC_VALUES.length + 17 + AC_VALUES.length);
  out.byte(0x00);
  for (const n of DC_BITS) out.byte(n);
  for (const v of DC_VALUES) out.byte(v);
  out.byte(0x10);
  for (const n of AC_BITS) out.byte(n);
  for (const v of AC_VALUES) out.byte(v);
  out.word(0xffda);
  out.word(6 + 2 * COMPONENTS);
  out.byte(COMPONENTS);
  for (let c = 1; c <= COMPONENTS; c++) {
    out.byte(c);
    out.byte(0x00);
  }
  out.byte(0);
  out.byte(63);
  out.byte(0);
}

/** Loads one channel of one 8×8 block, inverted and level-shifted; edges repeat the last pixel. */
function loadBlock(
  cmyk: Uint8Array,
  size: { width: number; height: number },
  at: { x: number; y: number; channel: number },
  block: Float64Array,
): void {
  for (let y = 0; y < 8; y++) {
    const row = Math.min(at.y + y, size.height - 1) * size.width;
    for (let x = 0; x < 8; x++) {
      const column = Math.min(at.x + x, size.width - 1);
      block[y * 8 + x] = 255 - (cmyk[(row + column) * 4 + at.channel] ?? 0) - 128;
    }
  }
}

/**
 * Encodes CMYK pixels (4 bytes each, 0 = no ink) as a baseline JPEG, Adobe-style.
 *
 * Args:
 *   cmyk: C, M, Y, K bytes per pixel, row by row.
 *   width: Image width in pixels.
 *   height: Image height in pixels.
 *
 * Returns:
 *   The JPEG bytes; embed with ColorSpace DeviceCMYK and Decode [1 0 1 0 1 0 1 0].
 */
export function encodeJpegCmyk(cmyk: Uint8Array, width: number, height: number): Uint8Array {
  if (cmyk.length !== width * height * 4) {
    throw new Error(`CMYK data size ${cmyk.length} does not match ${width}×${height}`);
  }
  // The frame header holds each side in 16 bits; a larger image would wrap into a broken file.
  if (width > 65535 || height > 65535) {
    throw new Error(`A JPEG side is at most 65535 px, this image is ${width}×${height}`);
  }
  const quant = quantTable(JPEG_QUALITY);
  const out = new Writer();
  writeHeaders(out, width, height, quant);
  const block = new Float64Array(64);
  const temp = new Float64Array(64);
  const coefficients = new Int32Array(64);
  const previousDc = [0, 0, 0, 0];
  const size = { width, height };
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      for (let channel = 0; channel < COMPONENTS; channel++) {
        loadBlock(cmyk, size, { x, y, channel }, block);
        forwardDct(block, temp);
        for (let k = 0; k < 64; k++) {
          const index = ZIGZAG[k] ?? 0;
          coefficients[k] = Math.round((block[index] ?? 0) / (quant[index] ?? 1));
        }
        previousDc[channel] = encodeBlock(out, coefficients, previousDc[channel] ?? 0);
      }
    }
  }
  out.padBits();
  out.word(0xffd9);
  return out.result();
}
