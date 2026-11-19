import { describe, expect, it } from 'vitest';
import { svgSize } from '@/vector/svg-size';

const svg = (attrs: string, before = ''): string =>
  `${before}<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1"/></svg>`;

describe('svgSize', () => {
  it('reads print units', () => {
    expect(svgSize(svg('width="50mm" height="25mm"'))).toMatchObject({ widthMm: 50, heightMm: 25 });
    expect(svgSize(svg('width="5cm" height="2cm"'))).toMatchObject({ widthMm: 50, heightMm: 20 });
    expect(svgSize(svg('width="2in" height="1in"'))?.widthMm).toBeCloseTo(50.8, 6);
    expect(svgSize(svg('width="72pt" height="6pc"'))?.heightMm).toBeCloseTo(25.4, 6);
  });

  it('reads plain numbers and px as 96 per inch', () => {
    expect(svgSize(svg('width="96" height="48px"'))).toMatchObject({
      widthMm: 25.4,
      heightMm: 12.7,
    });
  });

  it('reads px as 72 per inch in an Illustrator file, which writes points as px', () => {
    const size = svgSize(
      svg('width="72px" height="36px"', '<!-- Generator: Adobe Illustrator 27.0.0 -->\n'),
    );
    expect(size).toMatchObject({ widthMm: 25.4, heightMm: 12.7 });
  });

  it('keeps an Illustrator file without a viewBox at full size: its user units are its numbers', () => {
    const size = svgSize(
      svg('width="595px" height="842px"', '<!-- Generator: Adobe Illustrator 27.0.0 -->\n'),
    );
    expect(size?.widthMm).toBeCloseTo(209.9, 1);
    expect(size?.viewBox).toEqual([0, 0, 595, 842]);
  });

  it('takes the size from the viewBox when there is no width and height', () => {
    expect(svgSize(svg('viewBox="0 0 96 48"'))).toMatchObject({
      widthMm: 25.4,
      heightMm: 12.7,
      viewBox: [0, 0, 96, 48],
    });
    expect(svgSize(svg('viewBox="10,20,96,48"'))?.viewBox).toEqual([10, 20, 96, 48]);
  });

  it('takes the missing side from the viewBox shape', () => {
    const size = svgSize(svg('width="50mm" viewBox="0 0 200 100"'));
    expect(size).toMatchObject({ widthMm: 50, heightMm: 25 });
  });

  it('treats a percentage size as missing', () => {
    expect(svgSize(svg('width="100%" height="100%" viewBox="0 0 96 96"'))).toMatchObject({
      widthMm: 25.4,
      heightMm: 25.4,
    });
  });

  it('gives a viewBox in user units when the file has none, so a crop can be mapped into it', () => {
    expect(svgSize(svg('width="96" height="48"'))?.viewBox).toEqual([0, 0, 96, 48]);
    const mm = svgSize(svg('width="25.4mm" height="12.7mm"'));
    expect(mm?.viewBox[2]).toBeCloseTo(96, 6);
    expect(mm?.viewBox[3]).toBeCloseTo(48, 6);
  });

  it('finds the root past a prolog, comments and a doctype, with single quotes', () => {
    const text =
      "﻿<?xml version='1.0'?>\n<!-- a <svg width='1'> in a comment -->\n" +
      "<!DOCTYPE svg>\n<svg xmlns='http://www.w3.org/2000/svg' width='10mm' height='20mm'/>";
    expect(svgSize(text)).toMatchObject({ widthMm: 10, heightMm: 20 });
  });

  it('refuses an SVG with no size at all, or a size of zero', () => {
    expect(svgSize(svg(''))).toBeNull();
    expect(svgSize(svg('width="0" height="10"'))).toBeNull();
    expect(svgSize(svg('viewBox="0 0 0 10"'))).toBeNull();
  });

  it('refuses text that is not an SVG', () => {
    expect(svgSize('not xml at all')).toBeNull();
    expect(svgSize('<html><body></body></html>')).toBeNull();
    expect(svgSize(svg('width="abc" height="def"'))).toBeNull();
  });
});
