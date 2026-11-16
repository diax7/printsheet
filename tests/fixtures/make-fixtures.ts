/**
 * Generates the browser-test images. Run with `npm run fixtures`; output goes to
 * tests/fixtures/out (git-ignored), so the repository carries no binary test files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'fast-png';

const OUT = join(process.cwd(), 'tests', 'fixtures', 'out');

type Paint = (x: number, y: number) => [number, number, number, number];

function png(width: number, height: number, paint: Paint): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}

/**
 * An "F" in three colours on a transparent background, with a soft one-pixel alpha edge. It
 * looks different under every flip and rotation, so a wrong transform cannot pass unnoticed.
 */
export const paintF: Paint = (x, y) => {
  const w = 300;
  const h = 400;
  const inStem = x >= 40 && x < 110 && y >= 30 && y < 370;
  const inTop = x >= 40 && x < 260 && y >= 30 && y < 100;
  const inMiddle = x >= 40 && x < 200 && y >= 170 && y < 230;
  if (x >= w || y >= h) return [0, 0, 0, 0];
  if (inTop) return [220, 30, 30, 255];
  if (inMiddle) return [30, 160, 60, 255];
  if (inStem) return [30, 60, 220, 255];
  const nearEdge = x >= 38 && x < 262 && y >= 28 && y < 372 && (x < 112 || y < 102);
  return nearEdge ? [30, 60, 220, 96] : [0, 0, 0, 0];
};

function main(): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'f-shape.png'), png(300, 400, paintF));
  // A 600×300 logo inside a 1000×700 canvas: a 200 px empty border to trim.
  writeFileSync(
    join(OUT, 'bordered.png'),
    png(1000, 700, (x, y) =>
      x >= 200 && x < 800 && y >= 200 && y < 500 ? [250, 180, 0, 255] : [0, 0, 0, 0],
    ),
  );
  writeFileSync(
    join(OUT, 'opaque.png'),
    png(400, 300, (x) => [x % 256, 120, 200, 255]),
  );
  writeFileSync(
    join(OUT, 'empty.png'),
    png(50, 50, () => [0, 0, 0, 0]),
  );
  writeFileSync(
    join(OUT, 'large-8000.png'),
    png(8000, 8000, (x, y) =>
      ((x >> 9) + (y >> 9)) % 2 === 0 ? [200, 40, 120, 255] : [0, 0, 0, 0],
    ),
  );
  // The smallest possible design, and a long hairline that is shrunk hard to fit the sheet.
  writeFileSync(
    join(OUT, 'pixel.png'),
    png(1, 1, () => [20, 20, 20, 255]),
  );
  writeFileSync(
    join(OUT, 'hairline.png'),
    png(16000, 2, () => [0, 0, 0, 255]),
  );
  writeFileSync(join(OUT, 'not-an-image.png'), new TextEncoder().encode('this is not a PNG'));
  console.log(`Fixtures written to ${OUT}`);
}

main();
