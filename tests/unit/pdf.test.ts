import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decode, encode } from 'fast-png';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFRef, type PDFObject } from 'pdf-lib';
import { buildPdf, type PixelSource } from '@/export/pdf';
import { createCmykConverter } from '@/export/cmyk';
import { corners } from '@/model/geometry';
import { mmToPt } from '@/model/units';
import {
  DEFAULT_SETTINGS,
  type Design,
  type ExportOptions,
  type ImageAsset,
  type Sheet,
} from '@/model/types';

function pngBytes(w: number, h: number, alpha = 255): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([255, 255, 255, alpha], i * 4);
  return encode({ width: w, height: h, data, channels: 4, depth: 8 });
}

function asset(id: string, w = 40, h = 20, hasTransparency = true): ImageAsset {
  return {
    id,
    name: `${id}.png`,
    blob: new Blob([new Uint8Array(pngBytes(w, h, hasTransparency ? 128 : 255))], {
      type: 'image/png',
    }),
    widthPx: w,
    heightPx: h,
    hasTransparency,
  };
}

function design(id: string, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: 60,
    yMm: 40,
    widthMm: 100,
    heightMm: 50,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

/** Node pixel source: decode the PNG, resize by nearest neighbour when asked. */
const nodePixels: PixelSource = async (a, width, height) => {
  const png = decode(new Uint8Array(await a.blob.arrayBuffer()));
  const src = png.data;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / width));
      const sy = Math.min(png.height - 1, Math.floor((y * png.height) / height));
      for (let c = 0; c < 4; c++)
        out[(y * width + x) * 4 + c] = src[(sy * png.width + sx) * 4 + c] ?? 0;
    }
  }
  return out;
};

const OPTS: Pick<ExportOptions, 'color' | 'pdfMaxDpi' | 'mirror' | 'fileName'> = {
  color: 'rgb',
  pdfMaxDpi: 'original',
  mirror: false,
  fileName: 'test',
};

function sheet(designs: Design[], over: Partial<Sheet['settings']> = {}): Sheet {
  return {
    designs,
    settings: { ...DEFAULT_SETTINGS, lengthMode: 'fixed', fixedLengthMm: 1000, ...over },
  };
}

async function build(s: Sheet, assets: ImageAsset[], opts: Partial<typeof OPTS> = {}) {
  const map = new Map(assets.map((a) => [a.id, a]));
  const bytes = await buildPdf(s, map, { ...OPTS, ...opts }, { pixels: nodePixels });
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function lookup(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

/** Every image XObject on the first page, by resource name. */
function images(doc: PDFDocument): Map<string, PDFRawStream> {
  const page = doc.getPages()[0];
  const resources = page?.node.Resources();
  const xobjects = lookup(doc, resources?.get(PDFName.of('XObject'))) as PDFDict | undefined;
  const result = new Map<string, PDFRawStream>();
  for (const [name, ref] of xobjects?.entries() ?? []) {
    result.set(name.asString(), lookup(doc, ref) as PDFRawStream);
  }
  return result;
}

/** The six numbers of every `cm` operator in the page content, in order. */
function matrices(doc: PDFDocument): number[][] {
  const page = doc.getPages()[0];
  const contents = lookup(doc, page?.node.get(PDFName.of('Contents')));
  const streams = contents instanceof PDFRawStream ? [contents] : [];
  if (!(contents instanceof PDFRawStream)) {
    for (const ref of (contents as unknown as { asArray(): PDFObject[] }).asArray()) {
      streams.push(lookup(doc, ref) as PDFRawStream);
    }
  }
  const text = streams
    .map((s) => {
      const filter = s.dict.get(PDFName.of('Filter'));
      return Buffer.from(filter ? inflateSync(s.contents) : s.contents).toString('latin1');
    })
    .join('\n');
  return [...text.matchAll(/((?:-?[\d.]+\s+){6})cm/g)].map((m) =>
    (m[1] ?? '').trim().split(/\s+/).map(Number),
  );
}

/** Map a point of the image's unit square through a PDF matrix. */
function apply(m: number[], u: number, v: number): { x: number; y: number } {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m;
  return { x: a * u + c * v + e, y: b * u + d * v + f };
}

/** Combine the mirror matrix (if any) with the design matrix, as the PDF does. */
function combined(ms: number[][]): number[] {
  if (ms.length === 1) return ms[0] ?? [];
  const [a1 = 0, b1 = 0, c1 = 0, d1 = 0, e1 = 0, f1 = 0] = ms[0] ?? [];
  const [a2 = 0, b2 = 0, c2 = 0, d2 = 0, e2 = 0, f2 = 0] = ms[1] ?? [];
  return [
    a2 * a1 + b2 * c1,
    a2 * b1 + b2 * d1,
    c2 * a1 + d2 * c1,
    c2 * b1 + d2 * d1,
    e2 * a1 + f2 * c1 + e1,
    e2 * b1 + f2 * d1 + f1,
  ];
}

/**
 * Where the image's top-left, top-right, bottom-right and bottom-left pixels land, in mm from
 * the sheet's top-left: the unit square's v = 1 edge is the image's first row.
 */
function landedCorners(m: number[], pageHeightPt: number): Array<{ x: number; y: number }> {
  const toMm = (p: { x: number; y: number }) => ({
    x: (p.x * 25.4) / 72,
    y: ((pageHeightPt - p.y) * 25.4) / 72,
  });
  return [apply(m, 0, 1), apply(m, 1, 1), apply(m, 1, 0), apply(m, 0, 0)].map(toMm);
}

function expectCorners(
  actual: Array<{ x: number; y: number }>,
  expected: Array<{ x: number; y: number }>,
): void {
  actual.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i]?.x ?? NaN, 3);
    expect(p.y).toBeCloseTo(expected[i]?.y ?? NaN, 3);
  });
}

describe('buildPdf', () => {
  it('makes a page exactly the sheet width by the sheet length', async () => {
    const doc = await build(sheet([design('d1')], { sheetWidthMm: 580 }), [asset('a1')]);
    const { width, height } = doc.getPages()[0]?.getSize() ?? { width: 0, height: 0 };
    expect(width).toBeCloseTo(mmToPt(580), 2);
    expect(height).toBeCloseTo(mmToPt(1000), 2);
    expect(width).toBeCloseTo(1644.09, 1);
  });

  it('embeds an image once however many copies are placed, and skips unused images', async () => {
    const s = sheet([
      design('d1'),
      design('d2', { xMm: 300 }),
      design('d3', { assetId: 'a2', xMm: 450 }),
    ]);
    const doc = await build(s, [asset('a1'), asset('a2'), asset('unused')]);
    expect(images(doc).size).toBe(2);
    expect(matrices(doc)).toHaveLength(3);
  });

  it('draws only images that exist in the page resources', async () => {
    const s = sheet([design('d1'), design('d2', { assetId: 'a2', xMm: 300 })]);
    const doc = await build(s, [asset('a1'), asset('a2')]);
    const page = doc.getPages()[0];
    const contents = lookup(doc, page?.node.get(PDFName.of('Contents')));
    const parts =
      contents instanceof PDFRawStream
        ? [contents]
        : (contents as unknown as { asArray(): PDFObject[] })
            .asArray()
            .map((r) => lookup(doc, r) as PDFRawStream);
    const text = parts
      .map((p) => Buffer.from(inflateSync(p.contents)).toString('latin1'))
      .join('\n');
    const drawn = [...text.matchAll(/\/(\S+)\s+Do/g)].map((m) => `/${m[1]}`);
    expect(drawn).toHaveLength(2);
    expect(drawn.toSorted()).toEqual([...images(doc).keys()].toSorted());
  });

  it('places an unrotated design exactly where the model says', async () => {
    const d = design('d1');
    const doc = await build(sheet([d]), [asset('a1')]);
    const m = matrices(doc)[0] ?? [];
    expect(m[0]).toBeCloseTo(mmToPt(100), 3);
    expect(m[3]).toBeCloseTo(mmToPt(50), 3);
    expect(m[4]).toBeCloseTo(mmToPt(10), 3);
    expect(m[5]).toBeCloseTo(mmToPt(1000 - 65), 3);
    expectCorners(landedCorners(m, mmToPt(1000)), corners(d));
  });

  it('places a rotated design with its corners on the model corners', async () => {
    const d = design('d1', { angleDeg: 30, xMm: 200, yMm: 300 });
    const doc = await build(sheet([d]), [asset('a1')]);
    expectCorners(landedCorners(matrices(doc)[0] ?? [], mmToPt(1000)), corners(d));
  });

  it('flips a design horizontally around its own centre', async () => {
    const d = design('d1', { flipX: true, angleDeg: 30, xMm: 200, yMm: 300 });
    const doc = await build(sheet([d]), [asset('a1')]);
    const [tl, tr, br, bl] = corners(d);
    expectCorners(
      landedCorners(matrices(doc)[0] ?? [], mmToPt(1000)),
      [tr, tl, bl, br].map((p) => p ?? { x: 0, y: 0 }),
    );
  });

  it('flips a design vertically around its own centre', async () => {
    const d = design('d1', { flipY: true });
    const doc = await build(sheet([d]), [asset('a1')]);
    const [tl, tr, br, bl] = corners(d);
    expectCorners(
      landedCorners(matrices(doc)[0] ?? [], mmToPt(1000)),
      [bl, br, tr, tl].map((p) => p ?? { x: 0, y: 0 }),
    );
  });

  it('mirrors the whole sheet left to right', async () => {
    const d = design('d1', { angleDeg: 30, xMm: 200, yMm: 300 });
    const doc = await build(sheet([d], { sheetWidthMm: 580 }), [asset('a1')], { mirror: true });
    const landed = landedCorners(combined(matrices(doc)), mmToPt(1000));
    expectCorners(
      landed,
      corners(d).map((p) => ({ x: 580 - p.x, y: p.y })),
    );
  });

  it('writes RGB pixels with a soft mask for transparency', async () => {
    const doc = await build(sheet([design('d1')]), [asset('a1', 40, 20)]);
    const [img] = [...images(doc).values()];
    expect(img?.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceRGB'));
    expect(img?.dict.get(PDFName.of('Width'))?.toString()).toBe('40');
    const mask = lookup(doc, img?.dict.get(PDFName.of('SMask'))) as PDFRawStream;
    expect(mask.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceGray'));
    const alpha = inflateSync(mask.contents);
    expect(alpha.length).toBe(40 * 20);
    expect(alpha[0]).toBe(128);
  });

  it('leaves out the soft mask for an image without transparency', async () => {
    const doc = await build(sheet([design('d1')]), [asset('a1', 40, 20, false)]);
    const [img] = [...images(doc).values()];
    expect(img?.dict.get(PDFName.of('SMask'))).toBeUndefined();
  });

  it('reduces image resolution to the chosen limit at the largest placed size', async () => {
    const big = asset('a1', 3000, 1500);
    const s = sheet([
      design('d1', { widthMm: 100, heightMm: 50 }),
      design('d2', { widthMm: 50, heightMm: 25, xMm: 300 }),
    ]);
    const map = new Map([[big.id, big]]);
    const bytes = await buildPdf(s, map, { ...OPTS, pdfMaxDpi: 300 }, { pixels: nodePixels });
    const [img] = [...images(await PDFDocument.load(bytes, { updateMetadata: false })).values()];
    expect(Number(img?.dict.get(PDFName.of('Width'))?.toString())).toBe(1181);
    expect(Number(img?.dict.get(PDFName.of('Height'))?.toString())).toBe(591);
  });

  it('never enlarges an image that is already below the limit', async () => {
    const doc = await build(sheet([design('d1')]), [asset('a1', 40, 20)], { pdfMaxDpi: 300 });
    const [img] = [...images(doc).values()];
    expect(img?.dict.get(PDFName.of('Width'))?.toString()).toBe('40');
  });

  it('writes CMYK pixels with the soft mask kept', async () => {
    const profile = new Uint8Array(readFileSync('src/assets/cmyk-profile.icc'));
    const toCmyk = await createCmykConverter(profile);
    const map = new Map([['a1', asset('a1', 4, 2)]]);
    const bytes = await buildPdf(
      sheet([design('d1')]),
      map,
      { ...OPTS, color: 'cmyk' },
      { pixels: nodePixels, toCmyk },
    );
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const [img] = [...images(doc).values()];
    expect(img?.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceCMYK'));
    expect(img?.dict.get(PDFName.of('SMask'))).toBeDefined();
    const cmyk = inflateSync(img?.contents ?? new Uint8Array());
    expect(cmyk.length).toBe(4 * 2 * 4);
    expect(Array.from(cmyk.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('refuses CMYK without a converter', async () => {
    const map = new Map([['a1', asset('a1')]]);
    await expect(
      buildPdf(sheet([design('d1')]), map, { ...OPTS, color: 'cmyk' }, { pixels: nodePixels }),
    ).rejects.toThrow(/CMYK/);
  });

  it('refuses a design whose image is missing', async () => {
    await expect(
      buildPdf(sheet([design('d1')]), new Map(), OPTS, { pixels: nodePixels }),
    ).rejects.toThrow(/missing/);
  });

  it('records the title and the producing app', async () => {
    const doc = await build(sheet([design('d1')]), [asset('a1')], { fileName: 'job-42' });
    expect(doc.getTitle()).toBe('job-42');
    expect(doc.getProducer()).toBe('PrintSheet');
  });
});
