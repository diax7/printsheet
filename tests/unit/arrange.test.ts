import { describe, expect, it } from 'vitest';
import { autoArrange, placeCopies } from '@/model/arrange';
import { contentLengthMm, corners, footprint, polygonDistance } from '@/model/geometry';
import { DEFAULT_SETTINGS, type Design, type Sheet } from '@/model/types';

function design(id: string, w: number, h: number, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: 0,
    yMm: 0,
    widthMm: w,
    heightMm: h,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

function sheet(designs: Design[]): Sheet {
  return { designs, settings: { ...DEFAULT_SETTINGS } };
}

/** Deterministic pseudo-random numbers so the property test is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function assertValidLayout(s: Sheet): void {
  const { sheetWidthMm, gapMm } = s.settings;
  for (const d of s.designs) {
    const box = footprint(d);
    expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
    expect(box.maxX).toBeLessThanOrEqual(sheetWidthMm + 1e-6);
  }
  const polys = s.designs.map(corners);
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      expect(polygonDistance(polys[i] ?? [], polys[j] ?? [])).toBeGreaterThanOrEqual(gapMm - 1e-6);
    }
  }
}

describe('autoArrange', () => {
  it('packs designs in rows inside the width with the cutting gap', () => {
    const s = sheet([
      design('a', 200, 100),
      design('b', 200, 50),
      design('c', 200, 80),
      design('d', 300, 40),
    ]);
    const out = autoArrange(s, 'all', { allowRotate: false });
    assertValidLayout(out);
    expect(contentLengthMm(out.designs)).toBeLessThanOrEqual(
      contentLengthMm(stackVertically(s).designs),
    );
  });

  it('starts at the top-left corner', () => {
    const out = autoArrange(sheet([design('a', 100, 100)]), 'all', { allowRotate: false });
    const box = footprint(out.designs[0] as Design);
    expect(box.minX).toBeCloseTo(0, 6);
    expect(box.minY).toBeCloseTo(0, 6);
  });

  it('is deterministic', () => {
    const s = sheet([design('a', 120, 90), design('b', 300, 30), design('c', 50, 200)]);
    const one = autoArrange(s, 'all', { allowRotate: true });
    const two = autoArrange(s, 'all', { allowRotate: true });
    expect(one).toEqual(two);
  });

  it('rotates tall designs when that saves film', () => {
    const designs = [0, 1, 2, 3].map((i) => design(`t${i}`, 60, 500));
    const s = sheet(designs);
    const plain = contentLengthMm(autoArrange(s, 'all', { allowRotate: false }).designs);
    const rotated = autoArrange(s, 'all', { allowRotate: true });
    assertValidLayout(rotated);
    expect(contentLengthMm(rotated.designs)).toBeLessThan(plain);
  });

  it('rotates a design wider than the sheet when it fits turned', () => {
    const out = autoArrange(sheet([design('w', 700, 100)]), 'all', { allowRotate: true });
    assertValidLayout(out);
  });

  it('keeps locked designs in place and packs around them', () => {
    const locked = design('L', 200, 200, { xMm: 100, yMm: 100, locked: true });
    const s = sheet([locked, design('a', 300, 100), design('b', 300, 100), design('c', 100, 100)]);
    const out = autoArrange(s, 'all', { allowRotate: false });
    expect(out.designs.find((d) => d.id === 'L')).toEqual(locked);
    assertValidLayout(out);
  });

  it('arranges only the selection, around the other designs', () => {
    const fixed = design('f', 100, 100, { xMm: 300, yMm: 60 });
    const s = sheet([fixed, design('a', 100, 100), design('b', 100, 100)]);
    const out = autoArrange(s, ['a', 'b'], { allowRotate: false });
    expect(out.designs.find((d) => d.id === 'f')).toEqual(fixed);
    assertValidLayout(out);
  });

  it('keeps every layout valid for random inputs (property test)', () => {
    const rand = rng(42);
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rand() * 12);
      const designs = Array.from({ length: n }, (_, i) =>
        design(`r${i}`, 10 + rand() * 300, 10 + rand() * 300, { angleDeg: rand() < 0.3 ? 90 : 0 }),
      );
      const out = autoArrange(sheet(designs), 'all', { allowRotate: rand() < 0.5 });
      assertValidLayout(out);
      expect(out.designs).toHaveLength(n);
    }
  });
});

describe('placeCopies', () => {
  it('adds N copies that keep the cutting gap from everything', () => {
    let next = 0;
    const s = sheet([design('d1', 80, 60, { xMm: 40, yMm: 30 })]);
    const { sheet: out, newIds } = placeCopies(s, 'd1', 9, () => `c${next++}`);
    expect(newIds).toHaveLength(9);
    expect(out.designs).toHaveLength(10);
    assertValidLayout(out);
    expect(out.designs[0]).toEqual(s.designs[0]);
  });
});

function stackVertically(s: Sheet): Sheet {
  let y = 0;
  return {
    ...s,
    designs: s.designs.map((d) => {
      const placed = { ...d, xMm: d.widthMm / 2, yMm: y + d.heightMm / 2 };
      y += d.heightMm + s.settings.gapMm;
      return placed;
    }),
  };
}
