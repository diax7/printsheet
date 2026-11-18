import { describe, expect, it } from 'vitest';
import { autoArrange } from '@/model/arrange';
import { findIssues } from '@/model/checks';
import { corners, footprint, polygonDistance } from '@/model/geometry';
import { filmLengthMm, pageOf } from '@/model/pages';
import { fullMask } from '@/model/mask';
import { QUARTER_TURNS, shapeDecoder } from '@/model/shape-search';
import { smartArrange, type SmartArrangeOptions } from '@/model/smart-arrange';
import type { Design, Sheet } from '@/model/types';
import { design, L_SHAPE, maskOf, rng, SHAPES, sheetOf } from './shapes';

/** A search that never looks at the clock: the same passes on every machine. */
const steady = (
  maxPasses: number,
  over: Partial<SmartArrangeOptions> = {},
): SmartArrangeOptions => ({
  allowRotate: true,
  masks: SHAPES,
  maxPasses,
  now: () => 0,
  ...over,
});

const tooClose = (s: Sheet): string[] =>
  [...findIssues(s, new Map(), SHAPES)]
    .filter(([, issues]) => issues.some((i) => i.kind === 'too-close'))
    .map(([id]) => id);

function assertInside(s: Sheet): void {
  for (const d of s.designs) {
    const box = footprint(d);
    expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
    expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
    expect(box.maxX).toBeLessThanOrEqual(s.settings.sheetWidthMm + 1e-6);
  }
}

const KINDS = ['l', 'ring', 'slash', 'wedge'] as const;

function randomDesigns(rand: () => number, n: number): Design[] {
  return Array.from({ length: n }, (_, i) =>
    design(
      `d${i}`,
      KINDS[Math.floor(rand() * KINDS.length)] as string,
      20 + rand() * 90,
      20 + rand() * 90,
      {
        xMm: rand() * 500,
        yMm: rand() * 800,
        angleDeg: rand() < 0.3 ? Math.floor(rand() * 24) * 15 : 0,
        flipX: rand() < 0.2,
      },
    ),
  );
}

describe('one shape placement', () => {
  // Arrange falls back to rectangles should a shape layout ever trip the check, which would
  // hide a packer that disagrees with the check. The placement itself is tested here.
  it('never trips the too-close check (property)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed + 500);
      const all = randomDesigns(rand, 5 + Math.floor(rand() * 12));
      const fixed = all.filter((_, i) => i % 6 === 5);
      const moving = all.filter((_, i) => i % 6 !== 5);
      const gapMm = [0.5, 2, 5, 7.5, 12][seed % 5] as number;
      const split = seed % 3 === 0;
      const sheet = sheetOf(
        all,
        split ? { gapMm, layout: 'split', pageLengthMm: 487.5 } : { gapMm },
      );
      const decoder = shapeDecoder({
        sheet,
        moving,
        fixed,
        masks: SHAPES,
        spare: fullMask(),
        turns: QUARTER_TURNS,
        expired: () => false,
      });
      const order = moving.map((_, i) => i).toSorted(() => rand() - 0.5);
      const pins = moving.map(() => Math.floor(rand() * 5) - 1);
      const placed = decoder.decode(order, seed % 2 ? 'bottom' : 'top', pins) as Design[];
      const after = { ...sheet, designs: [...fixed, ...placed] };
      const movedIds = new Set(moving.map((d) => d.id));
      expect(
        tooClose(after).filter((id) => movedIds.has(id)),
        `seed ${seed}`,
      ).toEqual([]);
      for (const d of placed) {
        const box = footprint(d);
        expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
        expect(box.maxX).toBeLessThanOrEqual(sheet.settings.sheetWidthMm + 1e-6);
        if (split) expect(pageOf(d, sheet.settings), `seed ${seed} ${d.id}`).not.toBeNull();
      }
    }
  });

  it('stops part-way when the time is up', () => {
    const moving = randomDesigns(rng(1), 6);
    let calls = 0;
    const decoder = shapeDecoder({
      sheet: sheetOf(moving),
      moving,
      fixed: [],
      masks: SHAPES,
      spare: fullMask(),
      turns: [0],
      expired: () => ++calls > 3,
    });
    expect(decoder.decode([0, 1, 2, 3, 4, 5], 'bottom', [])).toBeNull();
  });
});

describe('Arrange with Real shape spacing', () => {
  it('nests two L shapes into less film than their rectangles need', () => {
    const designs = [design('a', 'l', 300, 300), design('b', 'l', 300, 300)];
    const boxes = smartArrange(sheetOf(designs, { spacing: 'box' }), 'all', steady(200));
    const shapes = smartArrange(sheetOf(designs), 'all', steady(200));
    expect(filmLengthMm(boxes)).toBe(610);
    expect(filmLengthMm(shapes)).toBeLessThan(450);
    expect(tooClose(shapes)).toEqual([]);
    assertInside(shapes);
    // The rectangles overlap: that is the whole point.
    const [a, b] = shapes.designs as [Design, Design];
    expect(polygonDistance(corners(a), corners(b))).toBe(0);
  });

  it('finds a nest with only a millimetre to spare', () => {
    // Two Ls 76.2 mm square with arms a fifth thick, on a sheet 100 mm wide: the second fits
    // beside the first one's upright only between 22 and 23.8 mm from the left edge.
    const ell = maskOf('#....', '#....', '#....', '#....', '#####');
    const designs = [design('a', 'e', 76.2, 76.2), design('b', 'e', 76.2, 76.2)];
    const before = sheetOf(designs, { sheetWidthMm: 100 });
    const after = smartArrange(before, 'all', steady(100, { masks: new Map([['e', ell]]) }));
    expect(filmLengthMm(after)).toBeLessThan(130);
    expect(findIssues(after, new Map(), new Map([['e', ell]])).size).toBe(0);
  });

  it('never trips the too-close check, whatever the shapes (property)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const designs = randomDesigns(rand, 4 + Math.floor(rand() * 14));
      // Some stay where they are, as obstacles off the grid.
      const fixed = designs.map((d, i) => (i % 5 === 4 ? { ...d, locked: true } : d));
      const gapMm = [0, 2, 5, 7.5][seed % 4] as number;
      const before = sheetOf(fixed, { gapMm });
      const lockedClose = new Set(
        tooClose(before).filter((id) => before.designs.find((d) => d.id === id)?.locked),
      );
      const after = smartArrange(before, 'all', steady(25, { seed }));
      const flagged = tooClose(after).filter((id) => !lockedClose.has(id));
      expect(flagged, `seed ${seed}`).toEqual([]);
      for (const d of after.designs.filter((x) => !x.locked)) {
        const box = footprint(d);
        expect(box.minX).toBeGreaterThanOrEqual(-1e-6);
        expect(box.maxX).toBeLessThanOrEqual(after.settings.sheetWidthMm + 1e-6);
        expect(box.minY).toBeGreaterThanOrEqual(-1e-6);
      }
      for (const d of after.designs.filter((x) => x.locked)) {
        expect(d).toBe(before.designs.find((x) => x.id === d.id));
      }
    }
  });

  it('is never longer than the rectangle search on the same designs', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const designs = randomDesigns(rng(seed + 40), 10);
      const boxes = smartArrange(sheetOf(designs, { spacing: 'box' }), 'all', steady(40, { seed }));
      const shapes = smartArrange(sheetOf(designs), 'all', steady(80, { seed }));
      expect(filmLengthMm(shapes)).toBeLessThanOrEqual(filmLengthMm(boxes));
    }
  });

  it('turns designs by quarter turns only and never flips them', () => {
    const rand = rng(3);
    const before = sheetOf(randomDesigns(rand, 12));
    const after = smartArrange(before, 'all', steady(40));
    for (const d of after.designs) {
      const was = before.designs.find((x) => x.id === d.id) as Design;
      expect((((d.angleDeg - was.angleDeg) % 90) + 90) % 90).toBeCloseTo(0, 6);
      expect([d.flipX, d.flipY, d.widthMm, d.heightMm]).toEqual([
        was.flipX,
        was.flipY,
        was.widthMm,
        was.heightMm,
      ]);
    }
  });

  it('keeps every angle when turning is off', () => {
    const before = sheetOf(randomDesigns(rng(5), 10));
    const after = smartArrange(before, 'all', steady(40, { allowRotate: false }));
    expect(after.designs.map((d) => d.angleDeg)).toEqual(before.designs.map((d) => d.angleDeg));
    expect(tooClose(after)).toEqual([]);
  });

  it('moves only the chosen designs, around the others', () => {
    const designs = randomDesigns(rng(9), 8).map((d, i) => ({
      ...d,
      xMm: 60 + (i % 4) * 130,
      yMm: 60 + Math.floor(i / 4) * 300,
    }));
    const before = sheetOf(designs);
    const after = smartArrange(before, ['d1', 'd2', 'd6'], steady(40));
    for (const d of after.designs) {
      if (!['d1', 'd2', 'd6'].includes(d.id))
        expect(d).toBe(before.designs.find((x) => x.id === d.id));
    }
    const moved = new Set(['d1', 'd2', 'd6']);
    expect(tooClose(after).filter((id) => moved.has(id))).toEqual([]);
  });

  it('keeps each design on one sheet of a split job', () => {
    const designs = Array.from({ length: 9 }, (_, i) =>
      design(`d${i}`, KINDS[i % 4] as string, 250, 280),
    );
    const before = sheetOf(designs, { layout: 'split', pageLengthMm: 705 });
    const after = smartArrange(before, 'all', steady(40));
    for (const d of after.designs) expect(pageOf(d, after.settings)).not.toBeNull();
    expect(tooClose(after)).toEqual([]);
    expect(new Set(after.designs.map((d) => pageOf(d, after.settings))).size).toBeGreaterThan(1);
  });

  it('packs a design without a mask as its rectangle', () => {
    const designs = [design('a', 'unknown', 300, 300), design('b', 'unknown', 300, 300)];
    const after = smartArrange(sheetOf(designs), 'all', steady(60));
    const [a, b] = after.designs as [Design, Design];
    expect(polygonDistance(corners(a), corners(b))).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(filmLengthMm(after)).toBe(610);
  });

  it('gives the same layout for the same seed and pass limit', () => {
    const before = sheetOf(randomDesigns(rng(21), 12));
    const one = smartArrange(before, 'all', steady(50, { seed: 4 }));
    const two = smartArrange(before, 'all', steady(50, { seed: 4 }));
    expect(two.designs).toEqual(one.designs);
  });

  it('stops when the time is up and still returns a full layout', () => {
    let t = 0;
    const before = sheetOf(randomDesigns(rng(22), 30));
    const after = smartArrange(before, 'all', {
      allowRotate: true,
      masks: SHAPES,
      budgetMs: 50,
      now: () => (t += 5),
    });
    expect(after.designs).toHaveLength(30);
    expect(tooClose(after)).toEqual([]);
    assertInside(after);
  });
});

describe('Arrange with Rectangles spacing', () => {
  it('is never longer than one plain Arrange (property)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const before = sheetOf(randomDesigns(rng(seed + 100), 6 + seed * 2), { spacing: 'box' });
      const plain = autoArrange(before, 'all', { allowRotate: true });
      const smart = smartArrange(before, 'all', steady(120, { seed }));
      expect(filmLengthMm(smart)).toBeLessThanOrEqual(filmLengthMm(plain));
      const polys = smart.designs.map(corners);
      for (let i = 0; i < polys.length; i++) {
        for (let j = i + 1; j < polys.length; j++) {
          expect(polygonDistance(polys[i] ?? [], polys[j] ?? [])).toBeGreaterThanOrEqual(5 - 1e-6);
        }
      }
      assertInside(smart);
    }
  });

  it('finds the order one plain Arrange misses', () => {
    // Largest first puts the 400 wide design alone on a row; the pairs 290 + 280 fit side by side.
    const designs = [
      design('a', 'x', 400, 100),
      design('b', 'x', 290, 200),
      design('c', 'x', 280, 200),
      design('d', 'x', 170, 100),
    ];
    const before = sheetOf(designs, { spacing: 'box' });
    const smart = smartArrange(before, 'all', steady(300, { allowRotate: false }));
    expect(filmLengthMm(smart)).toBe(310);
  });
});

describe('Arrange, whatever the spacing', () => {
  it('leaves a valid layout alone when it finds nothing shorter', () => {
    const before = sheetOf(
      [design('a', 'l', 300, 300), design('b', 'l', 300, 300, { xMm: 150, yMm: 455 })],
      {
        spacing: 'box',
      },
    );
    expect(smartArrange(before, 'all', steady(100))).toBe(before);
  });

  it('replaces a layout with a placement problem even when it gets longer', () => {
    const before = sheetOf([design('a', 'l', 300, 300), design('b', 'l', 300, 300)], {
      spacing: 'box',
    });
    const after = smartArrange(before, 'all', steady(100));
    expect(after).not.toBe(before);
    expect(filmLengthMm(after)).toBe(610);
  });

  it('returns the same sheet when nothing may move', () => {
    const before = sheetOf([design('a', 'l', 100, 100, { locked: true })]);
    expect(smartArrange(before, 'all', steady(10))).toBe(before);
    expect(smartArrange(before, [], steady(10))).toBe(before);
  });

  it('lays a design too long for a sheet both ways diagonally', () => {
    // 70 cm long on sheets 58 cm wide and 60 cm long: it fits neither across nor along.
    const split = { layout: 'split', pageLengthMm: 600 } as const;
    for (const spacing of ['box', 'shape'] as const) {
      const before = sheetOf([design('long', 'slash', 700, 30)], { ...split, spacing });
      const after = smartArrange(before, 'all', steady(20));
      const [d] = after.designs as [Design];
      expect(d.angleDeg % 90).not.toBe(0);
      assertInside(after);
      expect(findIssues(after, new Map(), SHAPES).get('long') ?? []).toEqual([]);
    }
    const before = sheetOf([design('long', 'slash', 700, 30)], split);
    const kept = smartArrange(before, 'all', steady(20, { allowRotate: false }));
    expect(kept.designs[0]?.angleDeg).toBe(0);
  });

  it('reports each shorter layout as it finds it', () => {
    const seen: number[] = [];
    let last = 0;
    smartArrange(sheetOf(randomDesigns(rng(31), 14)), 'all', {
      ...steady(60),
      onProgress: (p) => {
        expect(p.passes).toBe(last + 1);
        last = p.passes;
        if (p.sheet) seen.push(filmLengthMm(p.sheet));
      },
    });
    expect(last).toBeGreaterThan(10);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual(seen.toSorted((a, b) => b - a));
  });

  it('uses the L shape mask it is given, not the name', () => {
    const masks = new Map([['x', L_SHAPE]]);
    const designs = [design('a', 'x', 300, 300), design('b', 'x', 300, 300)];
    const after = smartArrange(sheetOf(designs), 'all', steady(200, { masks }));
    expect(filmLengthMm(after)).toBeLessThan(450);
  });
});
