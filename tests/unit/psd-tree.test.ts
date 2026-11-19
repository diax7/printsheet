import { describe, expect, it } from 'vitest';
import { initializeCanvas, readPsd, writePsd, type Layer, type PixelData, type Psd } from 'ag-psd';
import { blendOperation, psdRefusal, psdTree, type PsdNode } from '@/image/psd';

// Node has no canvas: ag-psd only needs a way to make pixel buffers.
initializeCanvas(
  () => {
    throw new Error('no canvas in unit tests');
  },
  (width, height) =>
    ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
);

function pixels(width: number, height: number, alpha = 255): PixelData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 40, 40, alpha], i);
  return { width, height, data };
}

function layer(name: string, over: Partial<Layer> = {}): Layer {
  return { name, left: 10, top: 10, right: 30, bottom: 40, imageData: pixels(20, 30), ...over };
}

/** A PSD written and read back by ag-psd, as the import worker reads one. */
function roundTrip(children: Layer[], over: Partial<Psd> = {}): Psd {
  const bytes = writePsd({ width: 200, height: 100, children, ...over });
  return readPsd(new Uint8Array(bytes), { useImageData: true, skipThumbnail: true });
}

const labels = (nodes: PsdNode[]): string[] => nodes.map((n) => n.label);

describe('psdTree', () => {
  it('lists layers top first, visible ones ticked and hidden ones not', () => {
    const tree = psdTree(
      roundTrip([layer('Bottom'), layer('Top'), layer('Off', { hidden: true })]),
    );
    expect(labels(tree)).toEqual(['Off', 'Top', 'Bottom']);
    expect(tree.map((n) => n.checked)).toEqual([false, true, true]);
    expect(tree[1]).toMatchObject({ widthPx: 20, heightPx: 30 });
  });

  it('shows a folder as one row to add merged, with its layers to open and pick, unticked', () => {
    const tree = psdTree(
      roundTrip([{ name: 'Logo set', children: [layer('Mark'), layer('Word')] }]),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ label: 'Logo set', kind: 'folder', checked: true });
    expect(labels(tree[0]?.children ?? [])).toEqual(['Word', 'Mark']);
    expect(tree[0]?.children?.every((c) => !c.checked)).toBe(true);
  });

  it('sizes a folder by the box around its visible layers', () => {
    const tree = psdTree(
      roundTrip([
        {
          name: 'Set',
          children: [
            layer('A', { left: 10, top: 10, right: 30, bottom: 40 }),
            layer('B', { left: 50, top: 20, right: 70, bottom: 30, imageData: pixels(20, 10) }),
            layer('Off', {
              left: 0,
              top: 0,
              right: 200,
              bottom: 100,
              imageData: pixels(200, 100),
              hidden: true,
            }),
          ],
        },
      ]),
    );
    expect(tree[0]).toMatchObject({ widthPx: 60, heightPx: 30 });
  });

  it('measures only what lies on the page, however far a layer reaches outside it', () => {
    const tree = psdTree(
      roundTrip([
        {
          name: 'Far apart',
          children: [
            layer('Near', { left: 10, top: 10, right: 30, bottom: 40 }),
            layer('Away', { left: 900_000, top: 10, right: 900_020, bottom: 40 }),
          ],
        },
        layer('Edge', { left: 180, top: 10, right: 260, bottom: 40, imageData: pixels(80, 30) }),
      ]),
    );
    expect(tree.map((n) => [n.label, n.widthPx, n.heightPx])).toEqual([
      ['Edge', 20, 30],
      ['Far apart', 20, 30],
    ]);
  });

  it('offers a folder whose layers are all hidden only layer by layer', () => {
    const tree = psdTree(
      roundTrip([{ name: 'Hidden set', children: [layer('A', { hidden: true })] }]),
    );
    expect(tree[0]).toMatchObject({ checked: false, disabled: true });
    expect(tree[0]?.notes.join(' ')).toContain('hidden');
    expect(labels(tree[0]?.children ?? [])).toEqual(['A']);
  });

  it('leaves out empty layers, adjustment layers and folders with nothing to print', () => {
    const tree = psdTree(
      roundTrip([
        layer('Art'),
        layer('Clear', { imageData: pixels(20, 30, 0) }),
        { name: 'Empty folder', children: [layer('Nothing', { imageData: pixels(5, 5, 0) })] },
      ]),
    );
    expect(labels(tree)).toEqual(['Art']);
  });

  it('leaves out a layer that prints nothing: opacity 0, or fill 0 with nothing clipped to it', () => {
    const tree = psdTree(
      roundTrip([
        layer('Placeholder', { fillOpacity: 0 }),
        layer('Gone', { opacity: 0 }),
        layer('Frame', { fillOpacity: 0 }),
        layer('Photo', { clipping: true }),
      ]),
    );
    expect(labels(tree)).toEqual(['Frame']);
  });

  it('folds a clipped layer into the layer it is clipped to', () => {
    const tree = psdTree(roundTrip([layer('Base'), layer('Texture', { clipping: true })]));
    expect(labels(tree)).toEqual(['Base']);
  });

  it('says when effects or a vector mask will be left out', () => {
    const tree = psdTree(
      roundTrip([
        layer('Glow', {
          effects: { stroke: [{ enabled: true, size: { units: 'Pixels', value: 3 } }] },
        }),
      ]),
    );
    expect(tree[0]?.notes).toContain('Effects not included');
  });

  it('says when a blend mode cannot be drawn and falls back to Normal', () => {
    const tree = psdTree(roundTrip([layer('Burn', { blendMode: 'linear burn' })]));
    expect(tree[0]?.notes).toContain('Blend mode linear burn drawn as Normal');
  });

  it('notes a layer that covers its whole box, which prints as a block', () => {
    const tree = psdTree(
      roundTrip([
        layer('Background', {
          left: 0,
          top: 0,
          right: 200,
          bottom: 100,
          imageData: pixels(200, 100),
        }),
      ]),
    );
    expect(tree[0]?.notes).toContain('No transparency: prints as a block');
  });

  it('leaves a solid layer covering the whole page unticked: a background wastes film', () => {
    const page = { left: 0, top: 0, right: 200, bottom: 100, imageData: pixels(200, 100) };
    const tree = psdTree(roundTrip([layer('Background', page), layer('Logo')]));
    expect(tree.map((n) => [n.label, n.checked])).toEqual([
      ['Logo', true],
      ['Background', false],
    ]);
  });
});

describe('blendOperation', () => {
  it('maps the blend modes a canvas can draw, and falls back to normal for the rest', () => {
    expect(blendOperation('multiply')).toEqual({ op: 'multiply', drawn: true });
    expect(blendOperation('soft light')).toEqual({ op: 'soft-light', drawn: true });
    expect(blendOperation('linear dodge')).toEqual({ op: 'lighter', drawn: true });
    expect(blendOperation('pass through')).toEqual({ op: 'source-over', drawn: true });
    expect(blendOperation(undefined)).toEqual({ op: 'source-over', drawn: true });
    expect(blendOperation('linear burn')).toEqual({ op: 'source-over', drawn: false });
    expect(blendOperation('dissolve')).toEqual({ op: 'source-over', drawn: false });
  });
});

describe('psdRefusal', () => {
  const ok: Psd = { width: 4000, height: 3000, colorMode: 3, bitsPerChannel: 8, children: [] };

  it('accepts an 8-bit RGB file', () => {
    expect(psdRefusal(ok)).toBeNull();
  });

  it('refuses grayscale too: only RGB files are read here', () => {
    expect(psdRefusal({ ...ok, colorMode: 1 })).toContain('is in Grayscale');
  });

  it('refuses CMYK and other colour modes with the menu to fix it', () => {
    expect(psdRefusal({ ...ok, colorMode: 4 })).toContain('Image > Mode > RGB Color');
    expect(psdRefusal({ ...ok, colorMode: 9 })).toContain('RGB Color');
  });

  it('refuses 16 and 32 bits per channel', () => {
    expect(psdRefusal({ ...ok, bitsPerChannel: 16 })).toContain('8 Bits/Channel');
  });

  it('refuses a document past the size limits', () => {
    expect(psdRefusal({ ...ok, width: 20_000 })).toContain('too large');
    expect(psdRefusal({ ...ok, width: 12_000, height: 12_000 })).toContain('too large');
  });

  it('refuses a file whose layers would not fit in memory once decoded', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      name: `L${i}`,
      left: 0,
      top: 0,
      right: 10_000,
      bottom: 1_000,
    }));
    expect(psdRefusal({ ...ok, width: 10_000, height: 1_000, children: big })).toContain(
      'too many large layers',
    );
  });
});
