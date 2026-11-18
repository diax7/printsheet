import { describe, expect, it } from 'vitest';
import { detectFormat } from '@/image/format';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const WEBP = text('RIFF\x10\x00\x00\x00WEBPVP8 ');
const GIF = text('GIF89a\x01\x00');
const PSD = bytes(0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0);
const PSB = bytes(0x38, 0x42, 0x50, 0x53, 0, 2, 0, 0);

describe('detectFormat', () => {
  it('reads raster formats from their first bytes', () => {
    expect(detectFormat(PNG, 'a.png')).toBe('png');
    expect(detectFormat(JPEG, 'a.jpeg')).toBe('jpg');
    expect(detectFormat(WEBP, 'a.webp')).toBe('webp');
    expect(detectFormat(GIF, 'a.gif')).toBe('gif');
  });

  it('trusts the bytes over the file name', () => {
    expect(detectFormat(PNG, 'photo.jpg')).toBe('png');
    expect(detectFormat(JPEG, 'logo.png')).toBe('jpg');
  });

  it('tells an Illustrator file from a PDF by its name, both being PDF inside', () => {
    expect(detectFormat(text('%PDF-1.7\n'), 'art.pdf')).toBe('pdf');
    expect(detectFormat(text('%PDF-1.6\n'), 'Art.AI')).toBe('ai');
  });

  it('finds SVG after a byte order mark, an XML prolog, comments and a doctype', () => {
    expect(detectFormat(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg')).toBe('svg');
    expect(
      detectFormat(
        text(
          '﻿<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator 27 -->\n' +
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>',
        ),
        'a.svg',
      ),
    ).toBe('svg');
  });

  it('reads a Photoshop file', () => {
    expect(detectFormat(PSD, 'layers.psd')).toBe('psd');
  });

  it('refuses EPS, text or binary, with a way forward', () => {
    const eps = detectFormat(text('%!PS-Adobe-3.0 EPSF-3.0\n'), 'logo.eps');
    expect(eps).toEqual({ refuse: expect.stringContaining('Save it as SVG or PDF') });
    expect(detectFormat(bytes(0xc5, 0xd0, 0xd3, 0xc6, 0, 0), 'logo.eps')).toEqual(eps);
  });

  it('refuses an Illustrator file saved as PostScript', () => {
    expect(detectFormat(text('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator'), 'old.ai')).toEqual({
      refuse: expect.stringContaining('Create PDF Compatible File'),
    });
  });

  it('refuses a Large Document (PSB) file', () => {
    expect(detectFormat(PSB, 'big.psb')).toEqual({
      refuse: expect.stringContaining('Save it as PSD'),
    });
  });

  it('refuses a compressed SVG', () => {
    expect(detectFormat(bytes(0x1f, 0x8b, 8, 0), 'logo.svgz')).toEqual({
      refuse: expect.stringContaining('plain SVG'),
    });
  });

  it('leaves bytes it does not know to the image decoder', () => {
    expect(detectFormat(text('BM6\x00\x00\x00'), 'old.bmp')).toBe('unknown');
    expect(detectFormat(bytes(), 'empty.png')).toBe('unknown');
    expect(detectFormat(bytes(1, 2, 3, 4, 5, 6, 7, 8), 'noise.bin')).toBe('unknown');
  });
});
