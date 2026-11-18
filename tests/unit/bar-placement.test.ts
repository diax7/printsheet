import { describe, expect, it } from 'vitest';
import { BELOW_GAP_PX, EDGE_PX, placeBar, type Rect } from '@/editor/bar-placement';

const AREA = { width: 800, height: 600 };
const BAR = { width: 300, height: 40 };
const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});

describe('placeBar', () => {
  it('puts the bar below the selection, centred on it', () => {
    const box = rect(300, 100, 500, 200);
    const place = placeBar({ box, reach: box, bar: BAR, area: AREA });
    expect(place).toEqual({ left: 250, top: 200 + BELOW_GAP_PX, side: 'below' });
  });

  it('keeps clear of handles that reach further down than the design', () => {
    // A design turned upside down has its rotate handle under it.
    const box = rect(300, 100, 500, 200);
    const reach = rect(300, 100, 500, 245);
    const place = placeBar({ box, reach, bar: BAR, area: AREA });
    expect(place?.top).toBe(245 + BELOW_GAP_PX);
  });

  it('flips above when there is no room below, clearing the size label and rotate handle', () => {
    const box = rect(300, 480, 500, 570);
    const place = placeBar({ box, reach: box, bar: BAR, area: AREA });
    expect(place?.side).toBe('above');
    // The bar's bottom edge sits the clearance above the selection's top.
    expect((place?.top ?? 0) + BAR.height).toBe(480 - 72);
  });

  it('above, also clears handles that stick out further than the label clearance', () => {
    const box = rect(300, 480, 500, 570);
    const reach = rect(300, 380, 500, 570);
    const place = placeBar({ box, reach, bar: BAR, area: AREA });
    expect((place?.top ?? 0) + BAR.height).toBe(380 - BELOW_GAP_PX);
  });

  it('uses the bottom of the view when neither side has room (a very tall selection)', () => {
    const box = rect(300, 20, 500, 590);
    const place = placeBar({ box, reach: box, bar: BAR, area: AREA });
    expect(place).toEqual({ left: 250, top: AREA.height - EDGE_PX - BAR.height, side: 'inside' });
  });

  it('stays inside the view on the left and the right', () => {
    const left = placeBar({
      box: rect(-50, 100, 40, 200),
      reach: rect(-50, 100, 40, 200),
      bar: BAR,
      area: AREA,
    });
    expect(left?.left).toBe(EDGE_PX);
    const right = placeBar({
      box: rect(760, 100, 900, 200),
      reach: rect(760, 100, 900, 200),
      bar: BAR,
      area: AREA,
    });
    expect(right?.left).toBe(AREA.width - EDGE_PX - BAR.width);
  });

  it('starts at the left edge when the view is narrower than the bar', () => {
    const box = rect(100, 100, 200, 200);
    const place = placeBar({ box, reach: box, bar: BAR, area: { width: 200, height: 600 } });
    expect(place?.left).toBe(EDGE_PX);
  });

  it('is hidden when the selection is scrolled fully out of view', () => {
    const cases = [
      rect(300, -200, 500, -1),
      rect(300, 601, 500, 700),
      rect(-300, 100, -1, 200),
      rect(801, 100, 900, 200),
    ];
    for (const box of cases) expect(placeBar({ box, reach: box, bar: BAR, area: AREA })).toBeNull();
  });

  it('still shows for a selection only partly in view', () => {
    const box = rect(300, -100, 500, 50);
    expect(placeBar({ box, reach: box, bar: BAR, area: AREA })?.side).toBe('below');
  });
});
