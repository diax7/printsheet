import { describe, expect, it } from 'vitest';
import { exportBlocker, findIssues } from '@/model/checks';
import { MAX_PAGES, PAGE_GUTTER_MM, bandOf, fallbackTop } from '@/model/pages';
import {
  DEFAULT_SETTINGS,
  type Design,
  type ImageAsset,
  type Settings,
  type Sheet,
} from '@/model/types';

const G = PAGE_GUTTER_MM;
const assets = new Map<string, ImageAsset>();

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

function split(designs: Design[], over: Partial<Settings> = {}): Sheet {
  return {
    designs,
    settings: { ...DEFAULT_SETTINGS, layout: 'split', pageLengthMm: 1000, ...over },
  };
}

const kinds = (s: Sheet, id: string): string[] =>
  (findIssues(s, assets).get(id) ?? []).map((i) => i.kind);

describe('checks on split sheets', () => {
  it('flags a design across a split, only in a split job', () => {
    const crossing = design('a', 950);
    expect(kinds(split([crossing]), 'a')).toContain('off-sheet');
    expect(kinds({ ...split([crossing]), settings: DEFAULT_SETTINGS }, 'a')).not.toContain(
      'off-sheet',
    );
  });

  it('ignores the fixed length of one long sheet in a split job', () => {
    const s = split([design('a', 0, 900)], { lengthMode: 'fixed', fixedLengthMm: 100 });
    expect(kinds(s, 'a')).not.toContain('past-length');
  });

  it('never calls designs on different sheets too close', () => {
    // 1 mm above the end of sheet 1, and at the top of sheet 2: 41 mm apart, gap 50 mm.
    const s = split([design('a', 899), design('b', 1000 + G)], { gapMm: 50 });
    expect(kinds(s, 'a')).not.toContain('too-close');
    const same = split([design('a', 0), design('b', 120)], { gapMm: 50 });
    expect(kinds(same, 'a')).toContain('too-close');
  });

  it('blocks export for a design across a split, naming it', () => {
    expect(exportBlocker(split([design('ok', 0), design('logo', 950)]))).toMatch(
      /"logo" crosses a split between sheets/,
    );
  });

  it('explains a design taller than one sheet', () => {
    expect(exportBlocker(split([design('logo', 950), design('banner', 1040, 1200)]))).toBe(
      '"banner" is 120.0 cm tall, longer than one sheet (100.0 cm). Make the sheets longer or the design smaller.',
    );
  });

  it('explains a design past the last sheet', () => {
    const far = design('far', bandOf(MAX_PAGES, split([]).settings).top + 10);
    expect(exportBlocker(split([far]))).toMatch(/past sheet 50/);
  });

  it('lets a split job be longer than 5 m in total', () => {
    const designs = Array.from({ length: 7 }, (_, i) => design(`d${i}`, i * (1000 + G), 900));
    expect(exportBlocker(split(designs))).toBeNull();
  });
});

describe('fallbackTop', () => {
  it('is the next empty sheet, or past the last sheet when all are in use', () => {
    const s = split([design('a', 0)]);
    expect(fallbackTop(s)).toBe(1000 + G);
    const last = split([design('z', (MAX_PAGES - 1) * (1000 + G))]);
    expect(fallbackTop(last)).toBe(MAX_PAGES * (1000 + G));
    expect(exportBlocker(split([design('far', fallbackTop(last))]))).toMatch(/past sheet 50/);
  });
});
