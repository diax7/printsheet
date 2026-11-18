import { describe, expect, it } from 'vitest';
import { placeCopies } from '@/model/arrange';
import { findIssues } from '@/model/checks';
import { bandOf } from '@/model/pages';
import type { ImageAsset, Sheet } from '@/model/types';
import { design, SHAPES, sheetOf } from './shapes';

const NO_ASSETS = new Map<string, ImageAsset>();

const closeIds = (s: Sheet, masks: typeof SHAPES | 'none' = SHAPES): string[] =>
  [...findIssues(s, NO_ASSETS, masks === 'none' ? undefined : masks)]
    .filter(([, issues]) => issues.some((i) => i.kind === 'too-close'))
    .map(([id]) => id)
    .toSorted();

/** Two L shapes, the second turned half a turn and tucked into the first one's empty corner. */
const nested = [
  design('a', 'l', 60, 60, { yMm: 60 }),
  design('b', 'l', 60, 60, { angleDeg: 180, xMm: 55, yMm: 35 }),
];

describe('too close with Real shape spacing', () => {
  it('measures between ink: a nested pair is fine in Real shape and flagged in Rectangles', () => {
    expect(closeIds(sheetOf(nested, { spacing: 'shape' }))).toEqual([]);
    expect(closeIds(sheetOf(nested, { spacing: 'box' }))).toEqual(['a', 'b']);
  });

  it('still flags ink that is closer than the gap', () => {
    const close = [nested[0], { ...nested[1], xMm: 40, yMm: 70 }] as typeof nested;
    const issues = findIssues(sheetOf(close), NO_ASSETS, SHAPES);
    expect(issues.get('a')).toEqual([{ kind: 'too-close', otherId: 'b' }]);
    expect(issues.get('b')).toEqual([{ kind: 'too-close', otherId: 'a' }]);
  });

  it('counts a design without a mask as its whole rectangle', () => {
    // A small design in the middle of a ring: fine, until the ring's mask is missing.
    const pair = [
      design('ring', 'ring', 100, 100),
      design('dot', 'l', 30, 30, { xMm: 50, yMm: 50 }),
    ];
    expect(closeIds(sheetOf(pair))).toEqual([]);
    const noRing = new Map([['l', SHAPES.get('l')]]) as typeof SHAPES;
    expect(closeIds(sheetOf(pair), noRing)).toEqual(['dot', 'ring']);
    // The other way round the ring still has its hole, but the dot fills its rectangle: with
    // 20 mm of ring and a 30 mm dot in a 60 mm hole, 15 mm of room is left either way.
    const noDot = new Map([['ring', SHAPES.get('ring')]]) as typeof SHAPES;
    expect(closeIds(sheetOf(pair), noDot)).toEqual([]);
    expect(closeIds(sheetOf(pair, { gapMm: 16 }), noDot)).toEqual(['dot', 'ring']);
    // No masks at all (they are still being read): plain rectangles.
    expect(closeIds(sheetOf(nested), 'none')).toEqual(['a', 'b']);
  });

  it('never looks at ink when the rectangles already keep the gap', () => {
    // Rectangles exactly a gap apart, off the grid: a cell-based measure alone would warn early.
    const apart = [
      design('a', 'ring', 40.3, 40.3, { xMm: 30.37, yMm: 30.11 }),
      design('b', 'ring', 40.3, 40.3, { xMm: 30.37 + 45.3, yMm: 30.11 }),
    ];
    expect(closeIds(sheetOf(apart))).toEqual([]);
    const copies = placeCopies(sheetOf([design('a', 'ring', 33.7, 21.9)]), 'a', 40, () =>
      crypto.randomUUID(),
    );
    expect(closeIds(copies.sheet)).toEqual([]);
  });

  it('never calls designs on different sheets too close', () => {
    const settings = { layout: 'split', pageLengthMm: 100 } as const;
    const second = bandOf(1, { ...sheetOf([]).settings, ...settings }).top;
    const pair = [
      design('a', 'l', 60, 60, { yMm: 70 }),
      design('b', 'l', 60, 60, { yMm: second + 30 }),
    ];
    expect(closeIds(sheetOf(pair, { ...settings, gapMm: 100 }))).toEqual([]);
  });

  it('keeps outside and off-sheet on the rectangle', () => {
    // The L has no ink in its top-right corner, yet the rectangle is over the right edge.
    const over = design('a', 'l', 60, 60, { xMm: 560 });
    expect(findIssues(sheetOf([over]), NO_ASSETS, SHAPES).get('a')).toEqual([{ kind: 'outside' }]);
  });

  it('answers again from memory for the same sheet, and afresh when the masks change', () => {
    const sheet = sheetOf(nested);
    const first = findIssues(sheet, NO_ASSETS, SHAPES);
    expect(findIssues(sheet, NO_ASSETS, SHAPES)).toBe(first);
    const later = new Map(SHAPES);
    expect(findIssues(sheet, NO_ASSETS, later)).not.toBe(first);
    expect(findIssues(sheet, NO_ASSETS, undefined).size).toBe(2);
  });
});
