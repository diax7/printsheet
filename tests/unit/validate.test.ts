/**
 * Everything the editor can produce must save and reopen: the validation used on restore and on
 * opening a project accepts every sheet the editing operations can make, and one bad design never
 * takes the rest of the sheet down with it.
 */
import { describe, expect, it } from 'vitest';
import { initialSize } from '@/model/geometry';
import { placeCopies, MAX_COPIES } from '@/model/arrange';
import { resizeKeepingCorner, roomForDesigns } from '@/model/ops';
import {
  InvalidSheetError,
  validateSettings,
  validateSheet,
  validateSheetLenient,
} from '@/model/validate';
import {
  DEFAULT_SETTINGS,
  MAX_DESIGNS,
  MAX_SIZE_MM,
  MAX_WIDTH_MM,
  MIN_SIZE_MM,
  MIN_WIDTH_MM,
  type Design,
  type Sheet,
} from '@/model/types';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function design(id: string, over: Partial<Design> = {}): Design {
  return {
    id,
    assetId: 'a1',
    name: id,
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

const ids = new Set(['a1']);

describe('everything the editor can produce reopens', () => {
  it('accepts the placement size of any importable image on any sheet width', () => {
    const rand = rng(7);
    const sides = [1, 2, 3, 16384];
    for (let run = 0; run < 2000; run++) {
      const widthPx = run < 16 ? (sides[run % 4] ?? 1) : 1 + Math.floor(rand() * 16384);
      const heightPx =
        run < 16 ? (sides[Math.floor(run / 4)] ?? 1) : 1 + Math.floor(rand() * 16384);
      const sheetWidthMm = MIN_WIDTH_MM + rand() * (MAX_WIDTH_MM - MIN_WIDTH_MM);
      const size = initialSize({ widthPx, heightPx }, sheetWidthMm);
      const sheet: Sheet = {
        designs: [design('d', { widthMm: size.widthMm, heightMm: size.heightMm })],
        settings: { ...DEFAULT_SETTINGS, sheetWidthMm },
      };
      expect(() => validateSheet(sheet, ids)).not.toThrow();
    }
  });

  it('accepts the smallest and largest sizes the size fields allow', () => {
    for (const [w, h] of [
      [MIN_SIZE_MM, MIN_SIZE_MM],
      [MAX_SIZE_MM, MAX_SIZE_MM],
    ] as const) {
      const s = resizeKeepingCorner(
        { designs: [design('d')], settings: { ...DEFAULT_SETTINGS } },
        'd',
        w,
        h,
      );
      expect(() => validateSheet(s, ids)).not.toThrow();
    }
  });

  it('accepts a sheet filled to the design limit by copies', () => {
    let n = 0;
    let sheet: Sheet = {
      designs: [design('d', { widthMm: 2, heightMm: 2 })],
      settings: { ...DEFAULT_SETTINGS },
    };
    while (roomForDesigns(sheet) > 0) {
      sheet = placeCopies(
        sheet,
        'd',
        Math.min(MAX_COPIES, roomForDesigns(sheet)),
        () => `c${n++}`,
      ).sheet;
    }
    expect(sheet.designs).toHaveLength(MAX_DESIGNS);
    expect(() => validateSheet(sheet, ids)).not.toThrow();
  });
});

describe('roomForDesigns', () => {
  it('counts how many more designs fit under the limit', () => {
    expect(roomForDesigns({ designs: [design('d')], settings: { ...DEFAULT_SETTINGS } })).toBe(
      MAX_DESIGNS - 1,
    );
  });
});

describe('validateSheetLenient', () => {
  const settings = { ...DEFAULT_SETTINGS };

  it('keeps the good designs and counts the bad ones', () => {
    const raw = {
      settings,
      designs: [
        design('ok1'),
        { ...design('bad'), widthMm: -1 },
        design('ok2'),
        'nonsense',
        { ...design('ok1') },
      ],
    };
    const { sheet, dropped } = validateSheetLenient(raw, ids);
    expect(sheet.designs.map((d) => d.id)).toEqual(['ok1', 'ok2']);
    expect(dropped).toBe(3);
  });

  it('drops designs whose image is missing', () => {
    const { sheet, dropped } = validateSheetLenient(
      { settings, designs: [design('d', { assetId: 'gone' })] },
      ids,
    );
    expect(sheet.designs).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('keeps no more than the design limit', () => {
    const designs = Array.from({ length: MAX_DESIGNS + 3 }, (_, i) => design(`d${i}`));
    const { sheet, dropped } = validateSheetLenient({ settings, designs }, ids);
    expect(sheet.designs).toHaveLength(MAX_DESIGNS);
    expect(dropped).toBe(3);
  });

  it('still refuses data with no designs list or broken settings', () => {
    expect(() => validateSheetLenient({ settings }, ids)).toThrow();
    expect(() =>
      validateSheetLenient({ settings: { ...settings, sheetWidthMm: 1e9 }, designs: [] }, ids),
    ).toThrow();
  });
});

describe('validateSettings', () => {
  const old = { sheetWidthMm: 580, lengthMode: 'auto', fixedLengthMm: 1000, gapMm: 5 };

  it('opens settings saved before split sheets with the defaults', () => {
    expect(validateSettings(old)).toEqual({
      ...old,
      layout: 'single',
      pageLengthMm: 1000,
      lastPage: 'trim',
      spacing: 'box',
    });
  });

  it('gives a new sheet rectangle spacing, the owner choice, and keeps a saved choice', () => {
    expect(DEFAULT_SETTINGS.spacing).toBe('box');
    expect(validateSettings(old).spacing).toBe('box');
    expect(validateSettings({ ...old, spacing: 'shape' }).spacing).toBe('shape');
  });

  it('keeps valid split settings', () => {
    const v = { ...old, layout: 'split', pageLengthMm: 500, lastPage: 'full', spacing: 'shape' };
    expect(validateSettings(v)).toEqual(v);
  });

  it.each([
    ['layout', 'pages'],
    ['pageLengthMm', 50],
    ['pageLengthMm', 5001],
    ['lastPage', 'cut'],
    ['spacing', 'pixels'],
  ])('refuses %s = %s', (key, value) => {
    expect(() => validateSettings({ ...old, [key]: value })).toThrow(InvalidSheetError);
  });
});
