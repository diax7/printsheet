import { describe, expect, it } from 'vitest';
import { footprint } from '@/model/geometry';
import {
  MAX_PAGES,
  PAGE_GUTTER_MM,
  bandOf,
  changePageLength,
  filmLengthMm,
  pageCount,
  pageLengths,
  pageOf,
  splitForExport,
  toSingle,
  toSplit,
} from '@/model/pages';
import { DEFAULT_SETTINGS, type Design, type Settings, type Sheet } from '@/model/types';

const G = PAGE_GUTTER_MM;

function design(id: string, topMm: number, heightMm = 100, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
    xMm: 100,
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

function sheet(designs: Design[], over: Partial<Settings> = {}): Sheet {
  return { designs, settings: { ...DEFAULT_SETTINGS, ...over } };
}

function split(designs: Design[], over: Partial<Settings> = {}): Sheet {
  return sheet(designs, { layout: 'split', pageLengthMm: 1000, ...over });
}

const top = (d: Design | undefined): number => (d ? footprint(d).minY : NaN);

describe('sheet bands', () => {
  it('puts sheet i at i × (length + gutter)', () => {
    const s = split([]).settings;
    expect(bandOf(0, s)).toEqual({ top: 0, bottom: 1000 });
    expect(bandOf(2, s)).toEqual({ top: 2 * (1000 + G), bottom: 2 * (1000 + G) + 1000 });
  });

  it('finds the sheet holding the whole design, or none', () => {
    const s = split([]).settings;
    expect(pageOf(design('a', 0), s)).toBe(0);
    expect(pageOf(design('a', 900), s)).toBe(0);
    expect(pageOf(design('a', 950), s)).toBeNull(); // 950 to 1050 crosses the split
    expect(pageOf(design('a', 1000 + G / 2), s)).toBeNull(); // starts in the gutter
    expect(pageOf(design('a', 1000 + G), s)).toBe(1);
    expect(pageOf(design('a', -1), s)).toBeNull();
    expect(pageOf(design('a', MAX_PAGES * (1000 + G)), s)).toBeNull(); // past the last sheet
  });
});

describe('pageCount and pageLengths', () => {
  it('counts sheets up to the last one any design starts on', () => {
    expect(pageCount(split([]))).toBe(0);
    expect(pageCount(split([design('a', 0), design('b', 2 * (1000 + G) + 10)]))).toBe(3);
  });

  it('gives full sheets, the last trimmed to its designs, empty sheets 0', () => {
    const s = split([design('a', 0, 900), design('b', 2 * (1000 + G), 395)]);
    expect(pageLengths(s)).toEqual([1000, 0, 400]);
    expect(filmLengthMm(s)).toBe(1400);
    expect(pageLengths({ ...s, settings: { ...s.settings, lastPage: 'full' } })).toEqual([
      1000, 0, 1000,
    ]);
  });

  it('never trims the last sheet longer than the sheet itself', () => {
    const s = split([design('a', 0, 1234.5)], { pageLengthMm: 1234.5 });
    expect(pageLengths(s)).toEqual([1234.5]);
  });

  it('ignores designs that cross a split when measuring', () => {
    expect(pageLengths(split([design('a', 0, 300), design('b', 950)]))).toEqual([300]);
  });

  it('stays fast for a design placed absurdly far down', () => {
    const s = split([design('a', 999_000)]);
    const started = performance.now();
    expect(pageCount(s)).toBe(MAX_PAGES);
    expect(pageLengths(s).length).toBe(MAX_PAGES);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('measures one long sheet as before', () => {
    expect(filmLengthMm(sheet([design('a', 0, 1234)]))).toBe(1240);
  });
});

describe('switching layout', () => {
  it('moves each design by the gutters above the sheet holding its top edge', () => {
    const out = toSplit(sheet([design('a', 10), design('b', 1500), design('c', 2990, 20)]), 1000);
    expect(out.settings.layout).toBe('split');
    expect(out.settings.pageLengthMm).toBe(1000);
    expect(top(out.designs[0])).toBeCloseTo(10, 6);
    expect(top(out.designs[1])).toBeCloseTo(1500 + G, 6);
    // Film 2990 to 3010 crosses the third split. It moves with sheet 3's gutters, so it still
    // crosses and is flagged, instead of landing hidden inside sheet 3.
    expect(top(out.designs[2])).toBeCloseTo(2990 + 2 * G, 6);
    expect(pageOf(out.designs[2] as Design, out.settings)).toBeNull();
  });

  it('round-trips one long sheet through split and back unchanged', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const designs = Array.from({ length: 6 }, (_, i) =>
        design(`d${i}`, ((seed * 7919 + i * 104729) % 600_000) / 100, 10 + ((i * 37) % 300)),
      );
      const back = toSingle(toSplit(sheet(designs), 500 + (seed % 7) * 100));
      expect(back.settings.layout).toBe('single');
      back.designs.forEach((d, i) => expect(d.yMm).toBeCloseTo(designs[i]?.yMm ?? NaN, 6));
    }
  });

  it('gives a design whose top is in a gutter to the sheet above', () => {
    const s = split([design('a', 1000 + G / 2)]);
    expect(top(toSingle(s).designs[0])).toBeCloseTo(1000 + G / 2, 6);
    const lower = split([design('a', 1000 + G + 5)]);
    expect(top(toSingle(lower).designs[0])).toBeCloseTo(1005, 6);
  });

  it('keeps film positions when the sheet length changes', () => {
    // At 80 cm on sheet 1, a sheet shrunk to 50 cm moves it to sheet 2 at 30 cm.
    const out = changePageLength(split([design('a', 800, 100)]), 500);
    expect(out.settings.pageLengthMm).toBe(500);
    expect(top(out.designs[0])).toBeCloseTo(500 + G + 300, 6);
    expect(pageOf(out.designs[0] as Design, out.settings)).toBe(1);
  });

  it('returns to the same layout after changing the length there and back', () => {
    const original = split([design('a', 100), design('b', 1000 + G + 200), design('c', 3 * 1040)]);
    const back = changePageLength(changePageLength(original, 700), 1000);
    back.designs.forEach((d, i) => expect(d.yMm).toBeCloseTo(original.designs[i]?.yMm ?? NaN, 6));
  });

  it('leaves a design over the top edge where it is, both ways', () => {
    const over = design('a', -30);
    expect(top(toSplit(sheet([over]), 1000).designs[0])).toBeCloseTo(-30, 6);
    expect(top(toSingle(split([over])).designs[0])).toBeCloseTo(-30, 6);
  });

  it('moves a design starting in a gutter to the next sheet on a split, single, split trip', () => {
    // Top edge in the gutter after sheet 1: it belongs to sheet 1 on the way back, so the
    // return trip puts it at the top of sheet 2.
    const inGutter = split([design('a', 1000 + G / 2, 20)]);
    const back = toSplit(toSingle(inGutter), 1000);
    expect(top(back.designs[0])).toBeCloseTo(1000 + G / 2 + G, 6);
  });

  it('never shifts a design more than the last sheet allows', () => {
    const out = toSplit(sheet([design('a', 900_000)]), 100);
    expect(top(out.designs[0]) - 900_000).toBeCloseTo((MAX_PAGES - 1) * G, 6);
  });
});

describe('splitForExport', () => {
  it('gives one long sheet as a single part, unchanged', () => {
    const s = sheet([design('a', 0)]);
    const { parts, empty } = splitForExport(s);
    expect(parts).toEqual([{ number: 1, of: 1, sheetNumber: 1, sheet: s }]);
    expect(empty).toEqual([]);
  });

  it('gives each non-empty sheet as a one-long-sheet part, numbered 1..K, empty ones named', () => {
    const s = split([design('a', 10, 900), design('c', 2 * (1000 + G) + 5, 300)]);
    const { parts, empty } = splitForExport(s);
    expect(parts.map((p) => [p.number, p.of, p.sheetNumber])).toEqual([
      [1, 2, 1],
      [2, 2, 3],
    ]);
    expect(empty).toEqual([2]);
    const second = parts[1]?.sheet as Sheet;
    expect(second.settings).toMatchObject({
      layout: 'single',
      lengthMode: 'fixed',
      fixedLengthMm: 310,
    });
    expect(top(second.designs[0])).toBeCloseTo(5, 6);
    expect(parts[0]?.sheet.settings.fixedLengthMm).toBe(1000);
  });

  it('keeps the last sheet full length when asked', () => {
    const s = split([design('a', 0, 200)], { lastPage: 'full' });
    expect(splitForExport(s).parts[0]?.sheet.settings.fixedLengthMm).toBe(1000);
  });
});

describe('splitForExport keeps every design', () => {
  it('puts every design of a split job into exactly one part, past an empty sheet too', () => {
    const designs = [design('a', 0, 400), design('b', 500, 400), design('c', 2 * (1000 + G), 300)];
    const { parts } = splitForExport(split(designs));
    expect(parts.flatMap((p) => p.sheet.designs.map((d) => d.id)).toSorted()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
