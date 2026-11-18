import { describe, expect, it } from 'vitest';
import { defaultFileName, outputKind, partFileName } from '@/export/output';
import { DEFAULT_SETTINGS, type Design, type Sheet } from '@/model/types';

describe('outputKind', () => {
  it('is a single file when there is one part, whatever was chosen', () => {
    expect(outputKind({ format: 'pdf', splitOutput: 'files' }, 1)).toBe('single');
    expect(outputKind({ format: 'png', splitOutput: 'zip' }, 1)).toBe('single');
  });

  it('follows the choice for several parts', () => {
    expect(outputKind({ format: 'pdf', splitOutput: 'zip' }, 3)).toBe('zip');
    expect(outputKind({ format: 'pdf', splitOutput: 'pdf-pages' }, 3)).toBe('pdf-pages');
    expect(outputKind({ format: 'pdf', splitOutput: 'files' }, 3)).toBe('files');
    expect(outputKind({ format: 'png', splitOutput: 'files' }, 3)).toBe('files');
  });

  it('makes a zip of PNGs when one PDF with pages was chosen (a PNG has no pages)', () => {
    expect(outputKind({ format: 'png', splitOutput: 'pdf-pages' }, 2)).toBe('zip');
  });
});

describe('partFileName', () => {
  it('numbers the sheets of a split job, and leaves a single file as it is', () => {
    expect(partFileName('job', { number: 2, of: 3 }, 'pdf')).toBe('job-sheet-2-of-3.pdf');
    expect(partFileName('job', { number: 1, of: 1 }, 'png')).toBe('job.png');
  });
});

/** A plain design `heightMm` tall whose top edge is at `yMm`. */
function design(yMm: number, heightMm: number): Design {
  return {
    id: 'd',
    assetId: 'a',
    name: 'd',
    xMm: 100,
    yMm: yMm + heightMm / 2,
    widthMm: 100,
    heightMm,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
  };
}

describe('defaultFileName', () => {
  const day = new Date(2026, 10, 18);

  it('names the real file length when designs go past a fixed length', () => {
    const sheet: Sheet = {
      designs: [design(0, 1200)],
      settings: { ...DEFAULT_SETTINGS, lengthMode: 'fixed', fixedLengthMm: 1000 },
    };
    expect(defaultFileName(sheet, day)).toBe('printsheet-58cm-1.20m-2026-11-18');
  });

  it('names the film total of a split job', () => {
    const sheet: Sheet = {
      designs: [design(0, 900), design(1040, 300)],
      settings: { ...DEFAULT_SETTINGS, layout: 'split', pageLengthMm: 1000 },
    };
    expect(defaultFileName(sheet, day)).toBe('printsheet-58cm-1.30m-2026-11-18');
  });
});
