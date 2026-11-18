import { describe, expect, it } from 'vitest';
import { align } from '@/model/align';
import { duplicateDesigns } from '@/model/ops';
import { autoArrange, moveOntoSheets, placeCopies } from '@/model/arrange';
import { findIssues } from '@/model/checks';
import { footprint } from '@/model/geometry';
import { Packer } from '@/model/packer';
import { MAX_PAGES, PAGE_GUTTER_MM, bandsFor, pageOf } from '@/model/pages';
import {
  DEFAULT_SETTINGS,
  type Design,
  type ImageAsset,
  type Settings,
  type Sheet,
} from '@/model/types';

const G = PAGE_GUTTER_MM;

function design(id: string, topMm: number, heightMm = 100, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: 60,
    yMm: topMm + heightMm / 2,
    widthMm: 100,
    heightMm,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
    ...over,
  };
}

function split(designs: Design[], over: Partial<Settings> = {}): Sheet {
  return {
    designs,
    settings: { ...DEFAULT_SETTINGS, layout: 'split', pageLengthMm: 1000, ...over },
  };
}

const noIssues = (s: Sheet): boolean => {
  const issues = findIssues(s, new Map<string, ImageAsset>());
  return [...issues.values()].every((list) => list.every((i) => i.kind !== 'off-sheet'));
};

describe('packing into sheets', () => {
  it('starts a box on the next sheet when it would cross the split', () => {
    const packer = new Packer(580, 5, [], bandsFor(split([]).settings));
    expect(packer.find(580, 600)?.minY).toBe(0);
    packer.add({ minX: 0, minY: 0, maxX: 580, maxY: 600 });
    expect(packer.find(580, 600)?.minY).toBe(1000 + G);
  });

  it('finds no spot for a box taller than a sheet', () => {
    expect(new Packer(580, 5, [], bandsFor(split([]).settings)).find(100, 1001)).toBeNull();
  });

  it('keeps one long sheet unbounded', () => {
    expect(bandsFor(DEFAULT_SETTINGS)).toBeNull();
    expect(new Packer(580, 5).find(100, 9000)?.minY).toBe(0);
  });

  it('Arrange fills sheet 1, then sheet 2, never across a split', () => {
    const s = split([design('a', 0, 600), design('b', 2000, 600), design('c', 4000, 600)], {
      sheetWidthMm: 200,
    });
    const out = autoArrange(s, 'all', { allowRotate: false });
    expect(out.designs.map((d) => pageOf(d, out.settings))).toEqual([0, 1, 2]);
    expect(noIssues(out)).toBe(true);
  });

  it('Arrange turns a design taller than a sheet when rotation is allowed', () => {
    const s = split([design('banner', 0, 1200, { widthMm: 100 })], { sheetWidthMm: 1500 });
    const out = autoArrange(s, 'all', { allowRotate: true });
    expect(pageOf(out.designs[0] as Design, out.settings)).toBe(0);
  });

  it('Add copies continues on the next sheet', () => {
    const s = split([design('a', 0, 400)], { sheetWidthMm: 120 });
    const out = placeCopies(
      s,
      'a',
      3,
      (() => {
        let n = 0;
        return () => `copy${n++}`;
      })(),
    );
    expect(out.sheet.designs.map((d) => pageOf(d, out.sheet.settings))).toEqual([0, 0, 1, 1]);
  });
});

describe('moveOntoSheets', () => {
  it('moves only the designs that cross a split, onto free spots', () => {
    const keep = design('keep', 0, 300);
    const crossing = design('cross', 950, 100, { xMm: 300 });
    const out = moveOntoSheets(split([keep, crossing]), ['cross']);
    expect(out.designs[0]).toEqual(keep);
    const moved = out.designs[1] as Design;
    expect(pageOf(moved, out.settings)).not.toBeNull();
    const a = footprint(keep);
    const b = footprint(moved);
    const apart = b.minX >= a.maxX + 5 || b.minY >= a.maxY + 5 || a.minX >= b.maxX + 5;
    expect(apart).toBe(true);
  });

  it('leaves a sheet with nothing off a sheet unchanged', () => {
    const s = split([design('a', 0)]);
    expect(moveOntoSheets(s, ['a'])).toBe(s);
  });
});

describe('align in a split job', () => {
  it('aligns a single design to its own sheet, not the whole job', () => {
    const s = split([design('a', 1000 + G + 100, 100), design('b', 0, 100)]);
    const bottom = align(s, ['a'], 'bottom');
    expect(footprint(bottom.designs[0] as Design).maxY).toBeCloseTo(2 * 1000 + G, 6);
    const middle = align(s, ['a'], 'middle');
    expect(footprint(middle.designs[0] as Design).minY).toBeCloseTo(1000 + G + 450, 6);
    expect(pageOf(middle.designs[0] as Design, s.settings)).toBe(1);
  });
});

describe('duplicate in a split job', () => {
  it('puts the copy at the top of the next sheet when "below" would cross the split', () => {
    const s = split([design('a', 0, 600, { widthMm: 500 })]);
    const out = duplicateDesigns(s, ['a'], () => 'copy');
    const copy = out.sheet.designs[1] as Design;
    expect(footprint(copy).minY).toBeCloseTo(1000 + G, 6);
    expect(pageOf(copy, s.settings)).toBe(1);
  });

  it('keeps "below" when it fits on the same sheet', () => {
    const s = split([design('a', 0, 300, { widthMm: 500 })]);
    const copy = duplicateDesigns(s, ['a'], () => 'copy').sheet.designs[1] as Design;
    expect(footprint(copy).minY).toBeCloseTo(305, 6);
  });
});

describe('moveOntoSheets with every sheet full', () => {
  it('leaves the sheet unchanged, so the app can say there is no room', () => {
    const full = Array.from({ length: MAX_PAGES }, (_, i) =>
      design(`full${i}`, i * (100 + G), 100, { widthMm: 580, xMm: 290 }),
    );
    const crossing = design('cross', 80, 50, { widthMm: 50, xMm: 30 });
    const s = split([...full, crossing], { pageLengthMm: 100 });
    expect(moveOntoSheets(s, ['cross'])).toBe(s);
  });
});
