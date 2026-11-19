import { describe, expect, it } from 'vitest';
import { mmToPt, mmToPx, pxToMm, formatCm, formatM } from '@/model/units';
import {
  contentLengthMm,
  dpiLevel,
  effectiveDpi,
  footprint,
  initialSize,
  polygonDistance,
  sheetLengthMm,
  corners,
} from '@/model/geometry';
import { exportBlocker, findIssues } from '@/model/checks';
import { DEFAULT_SETTINGS, type Design, type ImageAsset, type Sheet } from '@/model/types';

function asset(over: Partial<ImageAsset> = {}): ImageAsset {
  return {
    id: 'a1',
    name: 'logo.png',
    blob: new Blob(),
    widthPx: 3000,
    heightPx: 1500,
    hasTransparency: true,
    ...over,
  };
}

/** A vector image whose file says it prints at `w` × `h` mm. */
function vectorAsset(w: number, h: number): ImageAsset {
  return asset({
    widthPx: 4000,
    heightPx: 2000,
    vector: {
      type: 'svg',
      sourceId: 's',
      blob: new Blob([]),
      page: 1,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      sizeMm: { w, h },
    },
  });
}

function design(over: Partial<Design> = {}): Design {
  return {
    id: 'd1',
    assetId: 'a1',
    name: 'logo',
    xMm: 50,
    yMm: 50,
    widthMm: 100,
    heightMm: 100,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

function sheet(designs: Design[], over: Partial<Sheet['settings']> = {}): Sheet {
  return { designs, settings: { ...DEFAULT_SETTINGS, ...over } };
}

describe('units', () => {
  it('converts between mm, points and pixels exactly', () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 10);
    expect(mmToPx(25.4, 300)).toBeCloseTo(300, 10);
    expect(pxToMm(300, 300)).toBeCloseTo(25.4, 10);
  });

  it('formats centimetres with one decimal and meters with two', () => {
    expect(formatCm(300)).toBe('30.0');
    expect(formatCm(123.45)).toBe('12.3');
    expect(formatM(1370)).toBe('1.37 m');
    expect(formatM(0)).toBe('0.00 m');
  });
});

describe('geometry', () => {
  it('rounds the content length up to the next centimetre', () => {
    expect(contentLengthMm([design()])).toBe(100);
    expect(contentLengthMm([design({ yMm: 50.4 })])).toBe(110);
    expect(contentLengthMm([])).toBe(0);
  });

  it('uses the fixed length in fixed mode', () => {
    const s = sheet([design()], { lengthMode: 'fixed', fixedLengthMm: 1000 });
    expect(sheetLengthMm(s)).toBe(1000);
    expect(sheetLengthMm(sheet([design()]))).toBe(100);
  });

  it('swaps the footprint of a design rotated by 90 degrees', () => {
    const fp = footprint(design({ widthMm: 100, heightMm: 20, angleDeg: 90 }));
    expect(fp.maxX - fp.minX).toBeCloseTo(20, 9);
    expect(fp.maxY - fp.minY).toBeCloseTo(100, 9);
  });

  it('returns four corners around the centre', () => {
    const c = corners(design({ xMm: 10, yMm: 20, widthMm: 4, heightMm: 2 }));
    expect(c).toHaveLength(4);
    expect(c.map((p) => p.x).toSorted((a, b) => a - b)).toEqual([8, 8, 12, 12]);
  });

  it('computes effective DPI from the placed size, worst axis', () => {
    expect(effectiveDpi(design({ widthMm: 254, heightMm: 127 }), asset())).toBeCloseTo(300, 6);
    expect(effectiveDpi(design({ widthMm: 254, heightMm: 254 }), asset())).toBeCloseTo(150, 6);
  });

  it('classifies DPI at the 300 and 150 boundaries', () => {
    expect(dpiLevel(300)).toBe('good');
    expect(dpiLevel(299.9)).toBe('ok');
    expect(dpiLevel(150)).toBe('ok');
    expect(dpiLevel(149.9)).toBe('low');
  });

  it('places a new image at its 300 DPI size, shrunk to fit the width', () => {
    const fits = initialSize(asset({ widthPx: 6000, heightPx: 3000 }), 580);
    expect(fits.widthMm).toBeCloseTo(508, 6);
    expect(fits.heightMm).toBeCloseTo(254, 6);
    const wide = initialSize(asset({ widthPx: 9000, heightPx: 3000 }), 580);
    expect(wide.widthMm).toBeCloseTo(580, 6);
    expect(wide.heightMm).toBeCloseTo(193.333, 2);
  });

  it('places a vector at the size written in its file, shrunk to fit the width', () => {
    expect(initialSize(vectorAsset(80, 40), 580)).toEqual({ widthMm: 80, heightMm: 40 });
    expect(initialSize(vectorAsset(1160, 580), 580)).toEqual({ widthMm: 580, heightMm: 290 });
  });

  it('measures zero distance for overlapping polygons and the gap otherwise', () => {
    const a = corners(design({ xMm: 50, yMm: 50 }));
    const b = corners(design({ xMm: 153, yMm: 50 }));
    const c = corners(design({ xMm: 120, yMm: 50 }));
    expect(polygonDistance(a, b)).toBeCloseTo(3, 9);
    expect(polygonDistance(a, c)).toBe(0);
  });
});

describe('checks', () => {
  const assets = new Map([['a1', asset()]]);

  it('flags a design crossing the right edge', () => {
    const issues = findIssues(sheet([design({ xMm: 560 })]), assets);
    expect(issues.get('d1')?.map((i) => i.kind)).toContain('outside');
  });

  it('flags a design crossing the top', () => {
    const issues = findIssues(sheet([design({ yMm: 40 })]), assets);
    expect(issues.get('d1')?.map((i) => i.kind)).toContain('outside');
  });

  it('flags a rotated design whose corner crosses the left edge', () => {
    const issues = findIssues(sheet([design({ xMm: 60, angleDeg: 45 })]), assets);
    expect(issues.get('d1')?.map((i) => i.kind)).toContain('outside');
  });

  it('flags two designs closer than the cutting gap, and not at 6 mm', () => {
    const near = sheet([design(), design({ id: 'd2', xMm: 153 })], { gapMm: 5 });
    expect(findIssues(near, assets).get('d2')).toContainEqual({ kind: 'too-close', otherId: 'd1' });
    const far = sheet([design(), design({ id: 'd2', xMm: 156 })], { gapMm: 5 });
    expect(findIssues(far, assets).get('d2') ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'too-close' }),
    );
  });

  it('flags overlapping designs as too close', () => {
    const s = sheet([design(), design({ id: 'd2', xMm: 90 })]);
    expect(findIssues(s, assets).get('d1')).toContainEqual({ kind: 'too-close', otherId: 'd2' });
  });

  it('flags an image without transparency', () => {
    const opaque = new Map([['a1', asset({ hasTransparency: false })]]);
    const kinds = findIssues(sheet([design()]), opaque)
      .get('d1')
      ?.map((i) => i.kind);
    expect(kinds).toContain('no-transparency');
  });

  it('flags low and acceptable sharpness', () => {
    const low = findIssues(
      sheet([design({ widthMm: 600, heightMm: 300, xMm: 300, yMm: 150 })]),
      assets,
    );
    expect(low.get('d1')?.map((i) => i.kind)).toContain('low-dpi');
    const ok = findIssues(
      sheet([design({ widthMm: 400, heightMm: 200, xMm: 200, yMm: 100 })]),
      assets,
    );
    expect(ok.get('d1')?.map((i) => i.kind)).toContain('ok-dpi');
  });

  it('never flags the sharpness of a vector, which is drawn afresh at print size', () => {
    const vectors = new Map(
      [...assets].map(([id, a]) => [
        id,
        {
          ...a,
          vector: {
            type: 'svg' as const,
            sourceId: 's',
            blob: new Blob([]),
            page: 1,
            crop: { x: 0, y: 0, w: 1, h: 1 },
            sizeMm: { w: 10, h: 10 },
          },
        },
      ]),
    );
    const big = findIssues(
      sheet([design({ widthMm: 600, heightMm: 300, xMm: 300, yMm: 150 })]),
      vectors,
    );
    expect(big.get('d1')?.map((i) => i.kind) ?? []).not.toContain('low-dpi');
    expect(big.get('d1')?.map((i) => i.kind) ?? []).not.toContain('ok-dpi');
  });

  it('flags designs past a fixed length', () => {
    const s = sheet([design({ yMm: 980 })], { lengthMode: 'fixed', fixedLengthMm: 1000 });
    expect(
      findIssues(s, assets)
        .get('d1')
        ?.map((i) => i.kind),
    ).toContain('past-length');
  });

  it('gives a clean design no issues', () => {
    const s = sheet([design({ widthMm: 254, heightMm: 127, xMm: 200, yMm: 100 })]);
    expect(findIssues(s, assets).get('d1') ?? []).toEqual([]);
  });

  it('blocks export for an empty sheet and over 5 m, not at 4.99 m', () => {
    expect(exportBlocker(sheet([]))).toMatch(/empty/i);
    expect(exportBlocker(sheet([design({ yMm: 4960 })]))).toMatch(/5 m/);
    expect(exportBlocker(sheet([design({ yMm: 4940 })]))).toBeNull();
  });

  it('blocks export while a design crosses the sheet edge, naming it', () => {
    const s = sheet([
      design({ name: 'Big logo', xMm: 560 }),
      design({ id: 'd2', name: 'Fine', xMm: 300 }),
    ]);
    const message = exportBlocker(s);
    expect(message).toMatch(/Big logo/);
    expect(message).not.toMatch(/Fine/);
  });

  it('does not block export for warnings that still print correctly', () => {
    const s = sheet([design({ xMm: 100 }), design({ id: 'd2', xMm: 202 })]);
    expect(exportBlocker(s)).toBeNull();
  });
});
