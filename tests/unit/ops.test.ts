import { describe, expect, it } from 'vitest';
import {
  addDesign,
  duplicateDesigns,
  moveOntoSheet,
  removeDesigns,
  resizeKeepingCorner,
  reorder,
  rotateBy,
  updateDesign,
} from '@/model/ops';
import { align, distribute } from '@/model/align';
import { footprint, polygonDistance, corners } from '@/model/geometry';
import { DEFAULT_SETTINGS, type Design, type Sheet } from '@/model/types';

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

function sheet(designs: Design[]): Sheet {
  return { designs, settings: { ...DEFAULT_SETTINGS } };
}

let counter = 0;
const newId = (): string => `n${++counter}`;

describe('ops', () => {
  it('never mutates the input sheet', () => {
    const s = sheet([design('d1')]);
    const frozen = JSON.stringify(s);
    updateDesign(s, 'd1', { xMm: 200 });
    removeDesigns(s, ['d1']);
    duplicateDesigns(s, ['d1'], newId);
    reorder(s, 'd1', 'front');
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('adds a design at the end of the stack', () => {
    const s = addDesign(sheet([design('d1')]), design('d2'));
    expect(s.designs.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('updates only the named design', () => {
    const s = updateDesign(sheet([design('d1'), design('d2')]), 'd2', { widthMm: 40 });
    expect(s.designs[0]?.widthMm).toBe(100);
    expect(s.designs[1]?.widthMm).toBe(40);
  });

  it('removes several designs', () => {
    const s = removeDesigns(sheet([design('d1'), design('d2'), design('d3')]), ['d1', 'd3']);
    expect(s.designs.map((d) => d.id)).toEqual(['d2']);
  });

  it('duplicates beside the original, keeping the cutting gap, when there is room', () => {
    const { sheet: s, newIds } = duplicateDesigns(sheet([design('d1')]), ['d1'], newId);
    expect(newIds).toHaveLength(1);
    const copy = s.designs.find((d) => d.id === newIds[0]);
    expect(copy?.assetId).toBe('a1');
    expect(copy?.xMm).toBeCloseTo(155, 6);
    expect(copy?.yMm).toBeCloseTo(50, 6);
    expect(copy?.locked).toBe(false);
  });

  it('duplicates below the original when there is no room on the right', () => {
    const s0 = sheet([design('d1', { xMm: 500 })]);
    const { sheet: s, newIds } = duplicateDesigns(s0, ['d1'], newId);
    const copy = s.designs.find((d) => d.id === newIds[0]);
    expect(copy?.xMm).toBeCloseTo(500, 6);
    expect(copy?.yMm).toBeCloseTo(155, 6);
  });

  it('moves a design forward, back, to the front and to the bottom', () => {
    const s = sheet([design('a'), design('b'), design('c')]);
    expect(reorder(s, 'a', 'forward').designs.map((d) => d.id)).toEqual(['b', 'a', 'c']);
    expect(reorder(s, 'c', 'back').designs.map((d) => d.id)).toEqual(['a', 'c', 'b']);
    expect(reorder(s, 'a', 'front').designs.map((d) => d.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(s, 'c', 'bottom').designs.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    expect(reorder(s, 'c', 'forward').designs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('rotates by 90 degrees and normalises the angle to 0..360', () => {
    const s = rotateBy(sheet([design('d1', { angleDeg: 300 })]), ['d1'], 90);
    expect(s.designs[0]?.angleDeg).toBe(30);
    const back = rotateBy(sheet([design('d1')]), ['d1'], -90);
    expect(back.designs[0]?.angleDeg).toBe(270);
  });

  it('does not move or rotate a locked design', () => {
    const s = rotateBy(sheet([design('d1', { locked: true })]), ['d1'], 90);
    expect(s.designs[0]?.angleDeg).toBe(0);
  });
});

describe('resizeKeepingCorner', () => {
  it('keeps the top-left of the footprint in place', () => {
    const s = resizeKeepingCorner(sheet([design('d1', { xMm: 100, yMm: 100 })]), 'd1', 200, 50);
    const box = footprint(s.designs[0] as Design);
    expect(box.minX).toBeCloseTo(50, 6);
    expect(box.minY).toBeCloseTo(50, 6);
    expect(s.designs[0]?.widthMm).toBe(200);
  });

  it('slides left to stay on the sheet when it would cross the right edge', () => {
    const s = resizeKeepingCorner(sheet([design('d1', { xMm: 500, yMm: 100 })]), 'd1', 200, 100);
    const box = footprint(s.designs[0] as Design);
    expect(box.maxX).toBeCloseTo(580, 6);
  });

  it('stops at the left edge when wider than the sheet', () => {
    const s = resizeKeepingCorner(sheet([design('d1')]), 'd1', 700, 100);
    expect(footprint(s.designs[0] as Design).minX).toBeCloseTo(0, 6);
  });
});

describe('moveOntoSheet', () => {
  it('moves a design back inside the edges', () => {
    const s = moveOntoSheet(sheet([design('d1', { xMm: 600, yMm: -20 })]), ['d1']);
    const box = footprint(s.designs[0] as Design);
    expect(box.maxX).toBeCloseTo(580, 6);
    expect(box.minY).toBeCloseTo(0, 6);
  });

  it('shrinks a design wider than the sheet to the sheet width, keeping proportions', () => {
    const s = moveOntoSheet(sheet([design('d1', { widthMm: 700, heightMm: 350 })]), ['d1']);
    const d = s.designs[0] as Design;
    expect(d.widthMm).toBeCloseTo(580, 6);
    expect(d.heightMm).toBeCloseTo(290, 6);
    expect(footprint(d).minX).toBeCloseTo(0, 6);
  });

  it('shrinks a rotated design by its footprint', () => {
    const s = moveOntoSheet(sheet([design('d1', { widthMm: 700, heightMm: 100, angleDeg: 30 })]), [
      'd1',
    ]);
    const box = footprint(s.designs[0] as Design);
    expect(box.maxX - box.minX).toBeCloseTo(580, 6);
    expect(box.minX).toBeCloseTo(0, 6);
  });

  it('leaves designs already on the sheet alone', () => {
    const s0 = sheet([design('d1', { xMm: 300, yMm: 300 })]);
    expect(moveOntoSheet(s0, ['d1']).designs[0]).toEqual(s0.designs[0]);
  });
});

describe('align and distribute', () => {
  it('aligns the left edges of footprints, rotated ones included', () => {
    const s = sheet([
      design('a', { xMm: 100, yMm: 100 }),
      design('b', { xMm: 300, yMm: 300, widthMm: 100, heightMm: 20, angleDeg: 90 }),
    ]);
    const out = align(s, ['a', 'b'], 'left');
    const lefts = out.designs.map((d) => footprint(d).minX);
    expect(lefts[0]).toBeCloseTo(50, 6);
    expect(lefts[1]).toBeCloseTo(50, 6);
  });

  it('centres horizontally on the selection', () => {
    const s = sheet([design('a', { xMm: 100 }), design('b', { xMm: 300, widthMm: 50 })]);
    const out = align(s, ['a', 'b'], 'center');
    expect(out.designs[0]?.xMm).toBeCloseTo(187.5, 6);
    expect(out.designs[1]?.xMm).toBeCloseTo(187.5, 6);
  });

  it('aligns a single design to the sheet', () => {
    const s = sheet([design('a', { xMm: 100 })]);
    expect(align(s, ['a'], 'right').designs[0]?.xMm).toBeCloseTo(530, 6);
    expect(align(s, ['a'], 'center').designs[0]?.xMm).toBeCloseTo(290, 6);
  });

  it('distributes horizontally with equal gaps between footprints', () => {
    const s = sheet([
      design('a', { xMm: 50 }),
      design('b', { xMm: 160, widthMm: 50 }),
      design('c', { xMm: 450 }),
    ]);
    const out = distribute(s, ['a', 'b', 'c'], 'horizontal');
    const [a, b, c] = out.designs.map(corners);
    const gap1 = polygonDistance(a ?? [], b ?? []);
    const gap2 = polygonDistance(b ?? [], c ?? []);
    expect(gap1).toBeCloseTo(gap2, 6);
    expect(out.designs[0]?.xMm).toBe(50);
    expect(out.designs[2]?.xMm).toBe(450);
  });

  it('leaves locked designs where they are', () => {
    const s = sheet([design('a', { xMm: 100, locked: true }), design('b', { xMm: 300 })]);
    const out = align(s, ['a', 'b'], 'left');
    expect(out.designs[0]?.xMm).toBe(100);
  });
});
