import { describe, expect, it } from 'vitest';
import { decode } from 'jpeg-js';
import { encodeJpegCmyk } from '@/export/jpeg-cmyk';

/** A smooth CMYK test image: four different gradients, 4 bytes per pixel. */
function gradient(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = (x * 255) / Math.max(1, width - 1);
      out[i + 1] = (y * 255) / Math.max(1, height - 1);
      out[i + 2] = ((x + y) * 127) / Math.max(1, width + height - 2);
      out[i + 3] = 40;
    }
  }
  return out;
}

/** Finds a marker segment (FF xx) and returns the offset of its first byte after FF xx. */
function segment(bytes: Uint8Array, marker: number): number {
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error(`no marker at ${i}`);
    if (bytes[i + 1] === marker) return i + 2;
    i += 2 + (bytes[i + 2] ?? 0) * 256 + (bytes[i + 3] ?? 0);
  }
  throw new Error(`marker ${marker.toString(16)} not found`);
}

/** How the reference decoder turns one CMYK ink and K into an RGB channel. */
function toRgb(ink: number, k: number): number {
  return 255 - Math.min(255, Math.round(ink * (1 - k / 255) + k));
}

describe('encodeJpegCmyk', () => {
  it('writes a baseline four-channel JPEG with the Adobe marker (no colour transform)', () => {
    const bytes = encodeJpegCmyk(gradient(20, 12), 20, 12);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect([bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd9]);
    const app14 = segment(bytes, 0xee);
    expect(new TextDecoder().decode(bytes.subarray(app14 + 2, app14 + 7))).toBe('Adobe');
    expect(bytes[app14 + 13]).toBe(0); // transform 0: samples are CMYK, not YCCK
    const sof = segment(bytes, 0xc0);
    const word = (at: number): number => (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0);
    expect([word(sof + 3), word(sof + 5)]).toEqual([12, 20]);
    expect(bytes[sof + 7]).toBe(4);
    for (let c = 0; c < 4; c++) expect(bytes[sof + 9 + c * 3]).toBe(0x11);
  });

  it('keeps every channel within a few levels after an independent decoder reads it back', () => {
    const width = 37; // not a multiple of 8, to cover the padded edge blocks
    const height = 29;
    const cmyk = gradient(width, height);
    const decoded = decode(encodeJpegCmyk(cmyk, width, height), {
      useTArray: true,
      formatAsRGBA: false,
      colorTransform: false,
    });
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    // This decoder reads Adobe CMYK JPEGs (stored inverted) and hands back RGB, computed as
    // R = 255 - (C (1 - K/255) + K), and likewise G from M and B from Y. Compare against the
    // same formula applied to the original CMYK, which checks all four channels.
    let worst = 0;
    let total = 0;
    for (let p = 0; p < width * height; p++) {
      const k = cmyk[p * 4 + 3] ?? 0;
      for (let c = 0; c < 3; c++) {
        const expected = toRgb(cmyk[p * 4 + c] ?? 0, k);
        const diff = Math.abs(expected - (decoded.data[p * 3 + c] ?? 0));
        worst = Math.max(worst, diff);
        total += diff;
      }
    }
    expect(decoded.data.length).toBe(width * height * 3);
    expect(total / (width * height * 3)).toBeLessThan(2);
    expect(worst).toBeLessThan(16);
  });

  it('stays close on hard edges and a varying K channel', () => {
    const width = 48;
    const height = 40;
    const cmyk = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 0; // hard 8 px checkerboard
        cmyk.set([on, 255 - on, (x * 5) % 256, (y * 255) / (height - 1)], (y * width + x) * 4);
      }
    }
    const decoded = decode(encodeJpegCmyk(cmyk, width, height), {
      useTArray: true,
      formatAsRGBA: false,
    });
    let total = 0;
    for (let p = 0; p < width * height; p++) {
      const k = cmyk[p * 4 + 3] ?? 0;
      for (let c = 0; c < 3; c++) {
        total += Math.abs(toRgb(cmyk[p * 4 + c] ?? 0, k) - (decoded.data[p * 3 + c] ?? 0));
      }
    }
    expect(total / (width * height * 3)).toBeLessThan(3);
  });

  it('refuses an image larger than a JPEG can describe', () => {
    expect(() => encodeJpegCmyk(new Uint8Array(65536 * 4), 65536, 1)).toThrow(/65535/);
  });

  it('refuses pixel data of the wrong size', () => {
    expect(() => encodeJpegCmyk(new Uint8Array(10), 2, 2)).toThrow(/size/);
  });
});
