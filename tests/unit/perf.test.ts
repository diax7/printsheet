/**
 * Speed budgets for the operations that run on the main thread. A 58 cm × 1 m sheet of 3 cm
 * logos holds about 400 designs, so that is the size these budgets are measured at.
 */
import { describe, expect, it } from 'vitest';
import { autoArrange, placeCopies, MAX_COPIES } from '@/model/arrange';
import { findIssues } from '@/model/checks';
import { smartArrange } from '@/model/smart-arrange';
import { DEFAULT_SETTINGS, type Design, type ImageAsset, type Sheet } from '@/model/types';
import { SHAPES } from './shapes';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomSheet(n: number, seed: number): Sheet {
  const rand = rng(seed);
  const designs: Design[] = Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    assetId: 'a1',
    name: `d${i}`,
    xMm: rand() * 580,
    yMm: rand() * 2000,
    widthMm: 20 + rand() * 120,
    heightMm: 20 + rand() * 120,
    // One in five rotated, so the rotated-footprint branches are part of the budget.
    angleDeg: rand() < 0.2 ? 30 : 0,
    flipX: false,
    flipY: false,
    locked: false,
  }));
  // These budgets are for rectangles; the Real shape cases set their own spacing.
  return { designs, settings: { ...DEFAULT_SETTINGS, spacing: 'box' } };
}

/** Shared CI runners are slower and noisier than a desktop; budgets stretch there. */
const BUDGET_FACTOR = process.env['CI'] ? 3 : 1;

/**
 * Best of three runs: other test files share the CPU, and the fastest run is the one least
 * disturbed by them, so it measures the code rather than the machine's load.
 */
function time(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

const assets = new Map<string, ImageAsset>([
  [
    'a1',
    { id: 'a1', name: 'a', blob: new Blob(), widthPx: 3000, heightPx: 3000, hasTransparency: true },
  ],
]);

describe('performance budgets (400 designs)', () => {
  it('auto-arranges 400 designs in under 300 ms', () => {
    const s = randomSheet(400, 1);
    autoArrange(randomSheet(50, 9), 'all', { allowRotate: false });
    expect(time(() => autoArrange(s, 'all', { allowRotate: false }))).toBeLessThan(
      300 * BUDGET_FACTOR,
    );
  });

  it('auto-arranges 400 designs with rotation in under 900 ms', () => {
    const s = randomSheet(400, 2);
    expect(time(() => autoArrange(s, 'all', { allowRotate: true }))).toBeLessThan(
      900 * BUDGET_FACTOR,
    );
  });

  it('checks 400 designs for issues in under 20 ms', () => {
    const s = autoArrange(randomSheet(400, 3), 'all', { allowRotate: false });
    findIssues(s, assets);
    expect(time(() => findIssues(s, assets))).toBeLessThan(20 * BUDGET_FACTOR);
  });

  it('checks 400 designs for issues in Real shape in under 1 s cold and 20 ms warm', () => {
    const kinds = [...SHAPES.keys()];
    const boxes = autoArrange(randomSheet(400, 5), 'all', { allowRotate: false });
    // Pulled 30% closer together, so hundreds of pairs have overlapping rectangles and the ink
    // really is measured.
    const crowded = (): Sheet => ({
      designs: boxes.designs.map((d, i) => ({
        ...d,
        assetId: kinds[i % kinds.length] as string,
        xMm: d.xMm * 0.7 + 0.137,
        yMm: d.yMm * 0.7 + 0.291,
      })),
      settings: { ...boxes.settings, spacing: 'shape' },
    });
    const sheet = crowded();
    const start = performance.now();
    const issues = findIssues(sheet, assets, SHAPES);
    expect(performance.now() - start).toBeLessThan(1000 * BUDGET_FACTOR);
    expect(issues.size).toBeGreaterThan(100);
    expect(time(() => findIssues(sheet, assets, SHAPES))).toBeLessThan(20 * BUDGET_FACTOR);
    // A new sheet object with the same designs (a move elsewhere): the rasters are remembered.
    expect(time(() => findIssues({ ...sheet }, assets, SHAPES))).toBeLessThan(100 * BUDGET_FACTOR);
  });

  it('arranges 200 designs in Real shape within its time budget', () => {
    const kinds = [...SHAPES.keys()];
    const base = randomSheet(200, 6);
    const sheet: Sheet = {
      designs: base.designs.map((d, i) => ({ ...d, assetId: kinds[i % kinds.length] as string })),
      settings: { ...base.settings, spacing: 'shape' },
    };
    const start = performance.now();
    const out = smartArrange(sheet, 'all', { allowRotate: true, masks: SHAPES, budgetMs: 2000 });
    // The budget is checked between designs, so the overrun is one placement at most.
    expect(performance.now() - start).toBeLessThan(2000 + 500 * BUDGET_FACTOR);
    const close = [...findIssues(out, assets, SHAPES).values()].flat();
    expect(close.filter((i) => i.kind === 'too-close')).toEqual([]);
  });

  it('adds copies up to the cap and no further', () => {
    let n = 0;
    const s: Sheet = {
      designs: [
        {
          id: 'd',
          assetId: 'a1',
          name: 'd',
          xMm: 15,
          yMm: 15,
          widthMm: 30,
          heightMm: 30,
          angleDeg: 0,
          flipX: false,
          flipY: false,
          locked: false,
        },
      ],
      settings: { ...DEFAULT_SETTINGS },
    };
    let result: ReturnType<typeof placeCopies> | undefined;
    const ms = time(() => {
      result = placeCopies(s, 'd', MAX_COPIES + 50, () => `c${n++}`);
    });
    expect(result?.newIds).toHaveLength(MAX_COPIES);
    expect(ms).toBeLessThan(1500 * BUDGET_FACTOR);
  });
});
