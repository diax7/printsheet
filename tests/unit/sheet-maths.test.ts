import { describe, expect, it } from 'vitest';
import { dragCloses, revealOffset, scrollWithoutRoom, sheetLift } from '@/editor/sheet-maths';

describe('sheetLift', () => {
  it('is zero while no keyboard covers the page', () => {
    expect(sheetLift(844, 844, 0)).toBe(0);
  });

  it('is the height the keyboard covers', () => {
    expect(sheetLift(844, 508, 0)).toBe(336);
  });

  it('counts a visual viewport scrolled down by the browser', () => {
    expect(sheetLift(844, 508, 40)).toBe(296);
  });

  it('never goes below zero (pinch zoom makes the visual viewport small, not covered)', () => {
    expect(sheetLift(844, 900, 0)).toBe(0);
    expect(sheetLift(844, 400, 600)).toBe(0);
  });
});

describe('dragCloses', () => {
  it('closes a sheet pulled down a third of its height, or 100 px on a tall sheet', () => {
    expect(dragCloses(99, 300)).toBe(false);
    expect(dragCloses(100, 300)).toBe(true);
    expect(dragCloses(100, 420)).toBe(true);
    expect(dragCloses(99, 420)).toBe(false);
  });

  it('keeps the sheet for a small or upward drag', () => {
    expect(dragCloses(10, 420)).toBe(false);
    expect(dragCloses(-200, 420)).toBe(false);
  });
});

describe('revealOffset', () => {
  // A view from y 60 to 780 with a sheet whose top edge is at 420.
  const view = { top: 60, sheetTop: 420 };

  it('is zero when the design already sits above the sheet', () => {
    expect(revealOffset({ top: 100, bottom: 300 }, view)).toBe(0);
  });

  it('scrolls a covered design up until it ends above the sheet', () => {
    // 16 px clear of the sheet: 600 - (420 - 16).
    expect(revealOffset({ top: 500, bottom: 600 }, view)).toBe(196);
  });

  it('keeps the top of a design taller than the room in view', () => {
    // Its top goes to 16 px under the view's top, not above it.
    expect(revealOffset({ top: 300, bottom: 900 }, view)).toBe(224);
  });
});

describe('scrollWithoutRoom', () => {
  // 2000 px of content of which 400 px is the extra room, seen through a 700 px window.
  it('keeps a scroll position that still fits once the room goes', () => {
    expect(scrollWithoutRoom(500, 2000, 400, 700)).toBe(500);
  });

  it('brings a scroll position into the room back to the new end', () => {
    expect(scrollWithoutRoom(1300, 2000, 400, 700)).toBe(900);
  });

  it('is zero when the content is shorter than the window', () => {
    expect(scrollWithoutRoom(200, 900, 400, 700)).toBe(0);
  });
});
