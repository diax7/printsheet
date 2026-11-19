import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, PROJECT_MAGIC } from '@/store/project-file';
import { DEFAULT_SETTINGS, type Design, type ImageAsset, type Sheet } from '@/model/types';

function asset(id: string, bytes: number[]): ImageAsset {
  return {
    id,
    name: `${id} <b>name</b>.png`,
    blob: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    widthPx: 120,
    heightPx: 80,
    hasTransparency: id !== 'a2',
  };
}

const designs: Design[] = [
  {
    id: 'd1',
    assetId: 'a1',
    name: 'Logo',
    xMm: 10.5,
    yMm: 20.25,
    widthMm: 30,
    heightMm: 20,
    angleDeg: 30,
    flipX: true,
    flipY: false,
    locked: true,
  },
  {
    id: 'd2',
    assetId: 'a2',
    name: 'Back print',
    xMm: 200,
    yMm: 300,
    widthMm: 250,
    heightMm: 300,
    angleDeg: 0,
    flipX: false,
    flipY: true,
    locked: false,
  },
  {
    id: 'd3',
    assetId: 'a1',
    name: 'Logo copy',
    xMm: 50,
    yMm: 20,
    widthMm: 30,
    heightMm: 20,
    angleDeg: 0,
    flipX: false,
    flipY: false,
    locked: false,
  },
];

const sheet: Sheet = {
  designs,
  settings: {
    ...DEFAULT_SETTINGS,
    sheetWidthMm: 600,
    lengthMode: 'fixed',
    fixedLengthMm: 1500,
    gapMm: 3,
  },
};
const assets = new Map([
  ['a1', asset('a1', [1, 2, 3, 4, 5])],
  ['a2', asset('a2', [9, 8, 7])],
]);

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

/** Rebuild a file from a header object, so tests can tamper with it. */
async function withHeader(
  file: Blob,
  edit: (header: Record<string, unknown>) => void,
): Promise<Blob> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buffer.buffer);
  const headerLength = view.getUint32(8);
  const header = JSON.parse(
    new TextDecoder().decode(buffer.subarray(12, 12 + headerLength)),
  ) as Record<string, unknown>;
  edit(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length);
  return new Blob([buffer.subarray(0, 8), length, json, buffer.subarray(12 + headerLength)]);
}

/** The version number written into a project file's header. */
async function versionOf(file: Blob): Promise<unknown> {
  let version: unknown;
  await withHeader(file, (h) => {
    version = h['version'];
  });
  return version;
}

describe('project file', () => {
  it('reopens exactly what was saved', async () => {
    const file = await serializeProject(sheet, assets);
    const opened = await parseProject(file);
    expect(opened.sheet).toEqual(sheet);
    expect(opened.dropped).toBe(0);
    expect([...opened.assets.keys()]).toEqual(['a1', 'a2']);
    for (const [id, original] of assets) {
      const copy = opened.assets.get(id);
      expect(copy?.name).toBe(original.name);
      expect(copy?.widthPx).toBe(120);
      expect(copy?.hasTransparency).toBe(original.hasTransparency);
      expect(copy?.blob.type).toBe('image/png');
      expect(await bytesOf(copy?.blob ?? new Blob())).toEqual(await bytesOf(original.blob));
    }
  });

  it('keeps the file type of each image, and none for an image added before file types', async () => {
    const typed = new Map(assets).set('a1', { ...asset('a1', [1, 2, 3]), format: 'jpg' as const });
    const opened = await parseProject(await serializeProject(sheet, typed));
    expect(opened.assets.get('a1')?.format).toBe('jpg');
    expect(opened.assets.get('a2')).not.toHaveProperty('format');
  });

  it('drops a file type it does not know, and still opens the project', async () => {
    const typed = new Map(assets).set('a1', { ...asset('a1', [1, 2, 3]), format: 'jpg' as const });
    const file = await withHeader(await serializeProject(sheet, typed), (h) => {
      const list = h['assets'] as Array<Record<string, unknown>>;
      if (list[0]) list[0]['format'] = '<script>';
    });
    const opened = await parseProject(file);
    expect(opened.assets.get('a1')).not.toHaveProperty('format');
  });

  it('saves only images the sheet uses', async () => {
    const extra = new Map(assets).set('unused', asset('unused', [42]));
    const opened = await parseProject(await serializeProject(sheet, extra));
    expect(opened.assets.has('unused')).toBe(false);
  });

  it('starts with the PrintSheet signature', async () => {
    const file = await serializeProject(sheet, assets);
    expect(new TextDecoder().decode(new Uint8Array(await file.slice(0, 8).arrayBuffer()))).toBe(
      PROJECT_MAGIC,
    );
  });

  it('refuses a file that is not a PrintSheet project', async () => {
    await expect(parseProject(new Blob(['hello world, not a project']))).rejects.toThrow(
      /not a PrintSheet project/,
    );
    await expect(parseProject(new Blob([]))).rejects.toThrow(/not a PrintSheet project/);
  });

  it('refuses a file cut short', async () => {
    const file = await serializeProject(sheet, assets);
    await expect(parseProject(file.slice(0, file.size - 2))).rejects.toThrow(/damaged/);
    await expect(parseProject(file.slice(0, 14))).rejects.toThrow(/damaged/);
  });

  it('writes version 2 for a split job, so older copies refuse it instead of misreading it', async () => {
    const splitSheet: Sheet = { ...sheet, settings: { ...sheet.settings, layout: 'split' } };
    expect(await versionOf(await serializeProject(sheet, assets))).toBe(1);
    const file = await serializeProject(splitSheet, assets);
    expect(await versionOf(file)).toBe(2);
    expect((await parseProject(file)).sheet.settings.layout).toBe('split');
  });

  it('refuses a project from a newer version', async () => {
    const file = await withHeader(await serializeProject(sheet, assets), (h) => {
      h['version'] = 99;
    });
    await expect(parseProject(file)).rejects.toThrow(/newer version/);
  });

  it('refuses an image stored outside the file', async () => {
    const file = await withHeader(await serializeProject(sheet, assets), (h) => {
      const list = h['assets'] as Array<Record<string, unknown>>;
      if (list[0]) list[0]['offset'] = 1e9;
    });
    await expect(parseProject(file)).rejects.toThrow(/damaged/);
  });

  it('opens the rest of the sheet when one design points at a missing image', async () => {
    const file = await withHeader(await serializeProject(sheet, assets), (h) => {
      const s = h['sheet'] as { designs: Array<Record<string, unknown>> };
      if (s.designs[0]) s.designs[0]['assetId'] = 'nope';
    });
    const opened = await parseProject(file);
    expect(opened.sheet.designs.map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(opened.dropped).toBe(1);
  });

  it('opens the rest of the sheet when one design has impossible numbers', async () => {
    for (const bad of [-5, 'NaN']) {
      const file = await withHeader(await serializeProject(sheet, assets), (h) => {
        const s = h['sheet'] as { designs: Array<Record<string, unknown>> };
        if (s.designs[0]) s.designs[0]['widthMm'] = bad;
      });
      const opened = await parseProject(file);
      expect(opened.sheet.designs).toHaveLength(2);
      expect(opened.dropped).toBe(1);
    }
  });

  it('refuses image entries that overlap or repeat, so a small file cannot claim huge images', async () => {
    const file = await serializeProject(sheet, assets);
    const repeated = await withHeader(file, (h) => {
      const list = h['assets'] as Array<Record<string, unknown>>;
      const first = list[0];
      if (first) for (let i = 0; i < 50; i++) list.push({ ...first, id: `copy${i}` });
    });
    await expect(parseProject(repeated)).rejects.toThrow(/damaged/);
    const sameId = await withHeader(file, (h) => {
      const list = h['assets'] as Array<Record<string, unknown>>;
      if (list[1] && list[0]) list[1]['id'] = list[0]['id'];
    });
    await expect(parseProject(sameId)).rejects.toThrow(/damaged/);
  });

  it('refuses broken sheet settings', async () => {
    for (const edit of [
      (s: { designs: Array<Record<string, unknown>>; settings: Record<string, unknown> }) => {
        s.settings['sheetWidthMm'] = 50000;
      },
      (s: { designs: Array<Record<string, unknown>>; settings: Record<string, unknown> }) => {
        s.settings['lengthMode'] = 'sideways';
      },
    ]) {
      const file = await withHeader(await serializeProject(sheet, assets), (h) =>
        edit(h['sheet'] as never),
      );
      await expect(parseProject(file)).rejects.toThrow(/damaged/);
    }
  });

  it('refuses a header that is not valid JSON', async () => {
    const magic = new TextEncoder().encode(PROJECT_MAGIC);
    const json = new TextEncoder().encode('{"version":1,');
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, json.length);
    await expect(parseProject(new Blob([magic, length, json]))).rejects.toThrow(/damaged/);
  });
});

describe('project file with vector designs', () => {
  const source = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>'], {
    type: 'image/svg+xml',
  });
  const vectorAsset = (id: string, page: number): ImageAsset => ({
    ...asset(id, [7, 7, 7]),
    format: 'pdf',
    vector: {
      type: 'pdf',
      sourceId: 'src-1',
      blob: source,
      page,
      crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
      sizeMm: { w: 80, h: 40 },
    },
  });
  const vectors = new Map([
    ['a1', vectorAsset('a1', 1)],
    ['a2', vectorAsset('a2', 2)],
  ]);

  it('keeps each vector and stores a source file shared by two pages only once', async () => {
    const file = await serializeProject(sheet, vectors);
    const plain = await serializeProject(sheet, assets);
    expect(file.size - plain.size).toBeLessThan(source.size + 600);
    const opened = await parseProject(file);
    const one = opened.assets.get('a1')?.vector;
    const two = opened.assets.get('a2')?.vector;
    expect(one).toMatchObject({
      type: 'pdf',
      sourceId: 'src-1',
      page: 1,
      sizeMm: { w: 80, h: 40 },
    });
    expect(two?.page).toBe(2);
    expect(one?.crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 });
    expect(one?.blob).toBe(two?.blob);
    expect(await one?.blob.text()).toBe(await source.text());
  });

  it('writes version 3 only when the sheet uses a vector', async () => {
    expect(await versionOf(await serializeProject(sheet, vectors))).toBe(3);
    expect(await versionOf(await serializeProject(sheet, assets))).toBe(1);
  });

  it('refuses a vector whose source is not in the file', async () => {
    const file = await withHeader(await serializeProject(sheet, vectors), (h) => {
      h['sources'] = [];
    });
    await expect(parseProject(file)).rejects.toThrow(/damaged/);
  });

  it('refuses a vector with an impossible crop, page or size', async () => {
    for (const tamper of [
      (v: Record<string, unknown>) => (v['crop'] = { x: 0.9, y: 0, w: 0.5, h: 1 }),
      (v: Record<string, unknown>) => (v['crop'] = { x: 0, y: 0, w: 0, h: 1 }),
      (v: Record<string, unknown>) => (v['page'] = 0),
      (v: Record<string, unknown>) => (v['type'] = 'eps'),
      (v: Record<string, unknown>) => (v['sizeMm'] = { w: Number.NaN, h: 1 }),
    ]) {
      const file = await withHeader(await serializeProject(sheet, vectors), (h) => {
        const list = h['assets'] as Array<Record<string, unknown>>;
        tamper(list[0]?.['vector'] as Record<string, unknown>);
      });
      await expect(parseProject(file)).rejects.toThrow(/damaged/);
    }
  });

  it('refuses a source whose bytes overlap an image', async () => {
    const file = await withHeader(await serializeProject(sheet, vectors), (h) => {
      const list = h['sources'] as Array<Record<string, unknown>>;
      const images = h['assets'] as Array<Record<string, unknown>>;
      if (list[0]) list[0]['offset'] = images[0]?.['offset'];
    });
    await expect(parseProject(file)).rejects.toThrow(/damaged/);
  });
});
