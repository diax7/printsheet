import { describe, expect, it } from 'vitest';
import { baseRenderSize, cropViewBox, retargetSvg } from '@/vector/svg';
import { vectorExportDpi, vectorRenderSize } from '@/vector/render-size';
import { svgSize } from '@/vector/svg-size';
import { MAX_IMPORT_AREA, MAX_IMPORT_SIDE } from '@/image/limits';
import type { Design } from '@/model/types';

function design(assetId: string, widthMm: number, heightMm: number): Design {
  return {
    id: `${assetId}-${widthMm}`,
    assetId,
    name: 'd',
    xMm: 100,
    yMm: 100,
    widthMm,
    heightMm,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
  };
}

describe('svgSize with a viewBox shaped unlike its width and height', () => {
  it('sizes the page as the browser draws it, fitted inside and centred', () => {
    const size = svgSize('<svg width="100mm" height="50mm" viewBox="0 0 100 100"/>');
    expect(size).toMatchObject({ widthMm: 50, heightMm: 50, viewBox: [0, 0, 100, 100] });
  });
});

describe('retargetSvg', () => {
  it('draws the given region at the given pixel size, stretched exactly to it', () => {
    const out = retargetSvg(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" id="art" width="10mm" ' +
        'height=\'5mm\' viewBox="0 0 20 10" preserveAspectRatio="xMinYMin"><rect/></svg>',
      [5, 0, 10, 10],
      400,
      400,
    );
    const root = /<svg[^>]*>/.exec(out)?.[0] ?? '';
    expect(root).toContain('width="400"');
    expect(root).toContain('height="400"');
    expect(root).toContain('viewBox="5 0 10 10"');
    expect(root).toContain('preserveAspectRatio="none"');
    expect(root).toContain('id="art"');
    expect(root).not.toMatch(/10mm|5mm|xMinYMin|0 0 20 10/);
    expect(out).toContain('<rect/></svg>');
  });

  it('rewrites the root tag, not an <svg> written in a comment before it', () => {
    const out = retargetSvg(
      '<!-- <svg width="1"> --><svg width="9mm"><g/></svg>',
      [0, 0, 1, 1],
      8,
      4,
    );
    expect(out).toContain('<!-- <svg width="1"> -->');
    expect(out).toContain('width="8"');
    expect(out).not.toContain('9mm');
  });

  it('works on a root tag that closes itself', () => {
    const out = retargetSvg('<svg viewBox="0 0 1 1"/>', [0, 0, 1, 1], 8, 4);
    expect(out).toMatch(/^<svg\s[^>]*width="8"[^>]*\/>$/);
  });
});

describe('cropViewBox', () => {
  it('maps a crop given as fractions of the page into user units', () => {
    expect(cropViewBox([10, 20, 200, 100], { x: 0.25, y: 0.5, w: 0.5, h: 0.25 })).toEqual([
      60, 70, 100, 25,
    ]);
  });
});

describe('baseRenderSize', () => {
  it('keeps the shape and uses about 16 megapixels', () => {
    const size = baseRenderSize(200, 100);
    expect(size.widthPx / size.heightPx).toBeCloseTo(2, 2);
    expect(size.widthPx * size.heightPx).toBeLessThanOrEqual(16_000_000);
    expect(size.widthPx * size.heightPx).toBeGreaterThan(15_900_000);
  });

  it('never makes a side longer than 8192 px, or shorter than 1 px', () => {
    const thin = baseRenderSize(1000, 1);
    expect(thin.widthPx).toBe(8192);
    expect(thin.heightPx).toBeGreaterThanOrEqual(1);
  });
});

describe('vectorRenderSize', () => {
  it('draws once at the largest copy of the design, on each axis, at the export DPI', () => {
    const designs = [design('v', 100, 50), design('v', 60, 80), design('other', 999, 999)];
    expect(vectorRenderSize(designs, 'v', 600)).toEqual({
      widthPx: Math.ceil((100 / 25.4) * 600),
      heightPx: Math.ceil((80 / 25.4) * 600),
    });
  });

  it('stays within the image limits and says at what DPI it drew', () => {
    const size = vectorRenderSize([design('v', 1000, 1000)], 'v', 600);
    expect(size?.widthPx).toBeLessThanOrEqual(MAX_IMPORT_SIDE);
    expect((size?.widthPx ?? 0) * (size?.heightPx ?? 0)).toBeLessThanOrEqual(MAX_IMPORT_AREA);
    expect(size?.clampedDpi).toBeGreaterThan(200);
    expect(size?.clampedDpi).toBeLessThan(260);
  });

  it('draws at the PNG DPI, or the PDF limit, and at 300 when the PDF keeps originals', () => {
    const base = { pngDpi: 600, pdfMaxDpi: 'original' } as const;
    expect(vectorExportDpi({ ...base, format: 'png' })).toBe(600);
    expect(vectorExportDpi({ ...base, format: 'png', pngDpi: 360 })).toBe(360);
    expect(vectorExportDpi({ ...base, format: 'pdf' })).toBe(300);
    expect(vectorExportDpi({ ...base, format: 'pdf', pdfMaxDpi: 600 })).toBe(600);
  });

  it('gives nothing for a design that is not on the sheet', () => {
    expect(vectorRenderSize([design('a', 10, 10)], 'v', 300)).toBeNull();
  });
});
