import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { makeZip } from '@/export/zip';
import { crc32 } from '@/export/png-stream';

function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) % 256;
  return out;
}

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('makeZip', () => {
  it('holds every file unchanged, readable by an independent unzipper', async () => {
    const a = bytes(70_000, 1);
    const b = bytes(5, 2);
    const zip = await makeZip([
      { name: 'printsheet-sheet-1-of-2.pdf', blob: new Blob([a]) },
      { name: 'printsheet-sheet-2-of-2.pdf', blob: new Blob([b]) },
    ]);
    expect(zip.type).toBe('application/zip');
    const files = await unzip(zip);
    expect(Object.keys(files)).toEqual([
      'printsheet-sheet-1-of-2.pdf',
      'printsheet-sheet-2-of-2.pdf',
    ]);
    expect(files['printsheet-sheet-1-of-2.pdf']).toEqual(a);
    expect(files['printsheet-sheet-2-of-2.pdf']).toEqual(b);
  });

  it('keeps names with Arabic letters (UTF-8 flag set)', async () => {
    const zip = await makeZip([{ name: 'شعار-1.png', blob: new Blob([bytes(10, 3)]) }]);
    const raw = new Uint8Array(await zip.arrayBuffer());
    expect(raw[6]! & 0x08).toBe(0); // no data descriptor
    expect(raw[7]! & 0x08).toBe(0x08); // bit 11: names are UTF-8
    expect(Object.keys(await unzip(zip))).toEqual(['شعار-1.png']);
  });

  it('writes the CRC-32 of each file, so unzippers can check it', async () => {
    const data = bytes(1000, 4);
    const raw = new Uint8Array(
      await (await makeZip([{ name: 'x.png', blob: new Blob([data]) }])).arrayBuffer(),
    );
    const view = new DataView(raw.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(14, true)).toBe(crc32(data));
    expect(view.getUint16(8, true)).toBe(0); // stored, the files are already compressed
  });

  it('refuses an empty list and repeated names', async () => {
    await expect(makeZip([])).rejects.toThrow(/no files/i);
    const f = { name: 'a.pdf', blob: new Blob([bytes(3, 5)]) };
    await expect(makeZip([f, f])).rejects.toThrow(/twice/);
  });
});
