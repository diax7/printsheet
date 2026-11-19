/**
 * Generates the browser-test images. Run with `npm run fixtures`; output goes to
 * tests/fixtures/out (git-ignored), so the repository carries no binary test files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'fast-png';
import jpeg from 'jpeg-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

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

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function write(name: string, text: string): void {
  writeFileSync(join(OUT, name), new TextEncoder().encode(text));
}

/** Vector test files: text, so they are written as they would be saved by a design app. */
function writeSvgFixtures(): void {
  // A 50 mm page with a 40 mm L inset 5 mm on every side: the border is trimmed away, so the
  // design is 40 mm. One corner stays empty, so it is not a solid block.
  write(
    'corner.svg',
    `<svg ${SVG_NS} width="50mm" height="50mm" viewBox="0 0 100 100">` +
      '<rect x="10" y="10" width="80" height="40" fill="#1e3cdc"/>' +
      '<rect x="10" y="50" width="40" height="40" fill="#1e3cdc"/></svg>',
  );
  // No width or height: the shape comes from the viewBox (2:1), not the browser's 300 × 150.
  write(
    'wide-viewbox.svg',
    `<svg ${SVG_NS} viewBox="0 0 200 100"><rect width="200" height="100" fill="#d22"/></svg>`,
  );
  write(
    'live-text.svg',
    `<svg ${SVG_NS} width="60mm" height="20mm" viewBox="0 0 60 20">` +
      '<text x="2" y="15" font-size="12" fill="#222">Hello</text></svg>',
  );
  write('broken.svg', `<svg ${SVG_NS} width="10mm" height="10mm"><rect width="5"`);
  write('no-size.svg', `<svg ${SVG_NS}><rect width="5" height="5"/></svg>`);
}

const PT_PER_MM = 72 / 25.4;

/**
 * A page of `widthMm` × `heightMm` with nothing painted but an L of blue shapes inset by
 * `insetMm`, so its empty border is trimmed and a corner stays transparent.
 */
function drawCorner(doc: PDFDocument, widthMm: number, heightMm: number, insetMm: number): void {
  const page = doc.addPage([widthMm * PT_PER_MM, heightMm * PT_PER_MM]);
  const inset = insetMm * PT_PER_MM;
  const w = page.getWidth() - 2 * inset;
  const h = page.getHeight() - 2 * inset;
  const blue = rgb(0.12, 0.24, 0.86);
  page.drawRectangle({ x: inset, y: inset + h / 2, width: w, height: h / 2, color: blue });
  page.drawRectangle({ x: inset, y: inset, width: w / 2, height: h / 2, color: blue });
}

/** PDF and Illustrator test files, made with pdf-lib: real PDFs, with transparent pages. */
async function writePdfFixtures(): Promise<void> {
  const one = await PDFDocument.create();
  // A 100 × 60 mm page with a 10 mm empty border: the design is 80 × 40 mm.
  drawCorner(one, 100, 60, 10);
  const oneBytes = await one.save();
  writeFileSync(join(OUT, 'corner.pdf'), oneBytes);
  // A PDF-compatible Illustrator file is a PDF inside.
  writeFileSync(join(OUT, 'corner.ai'), oneBytes);

  const three = await PDFDocument.create();
  for (const size of [40, 50, 60]) drawCorner(three, size, size, 5);
  writeFileSync(join(OUT, 'pages.pdf'), await three.save());

  // What Illustrator writes when PDF content is not saved: one page with this sentence.
  const placeholder = await PDFDocument.create();
  const font = await placeholder.embedFont(StandardFonts.Helvetica);
  placeholder
    .addPage([300, 100])
    .drawText('This is an Adobe Illustrator File that was saved without PDF Content.', {
      x: 5,
      y: 50,
      size: 7,
      font,
    });
  writeFileSync(join(OUT, 'placeholder.ai'), await placeholder.save());

  // Text in a font the file does not carry (Helvetica is never embedded by pdf-lib).
  const text = await PDFDocument.create();
  const helvetica = await text.embedFont(StandardFonts.Helvetica);
  text.addPage([200, 60]).drawText('Hello', { x: 10, y: 20, size: 30, font: helvetica });
  writeFileSync(join(OUT, 'text.pdf'), await text.save());
}

async function main(): Promise<void> {
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
  // A 400×200 logo inside a 1000×600 canvas covered by a near-invisible haze (alpha 3, with
  // specks at 9), the kind background-removal tools leave: it must trim to the logo.
  writeFileSync(
    join(OUT, 'hazy.png'),
    png(1000, 600, (x, y) => {
      if (x >= 300 && x < 700 && y >= 200 && y < 400) return [255, 255, 255, 255];
      return [240, 240, 240, (x * 7 + y * 13) % 97 === 0 ? 9 : 3];
    }),
  );
  // An L, 900 px square with arms 180 px thick: three quarters of its rectangle is empty, so two
  // of them nest when the cutting gap is measured between real shapes.
  writeFileSync(
    join(OUT, 'ell.png'),
    png(900, 900, (x, y) => (x < 180 || y >= 720 ? [20, 110, 200, 255] : [0, 0, 0, 0])),
  );
  writeFileSync(join(OUT, 'not-an-image.png'), new TextEncoder().encode('this is not a PNG'));
  // A photo with no transparency, as a JPEG, for its file-type badge.
  const photo = { width: 200, height: 120, data: new Uint8Array(200 * 120 * 4) };
  for (let i = 0; i < photo.data.length; i += 4) photo.data.set([200, (i / 4) % 200, 60, 255], i);
  writeFileSync(join(OUT, 'photo.jpg'), jpeg.encode(photo, 90).data);
  // An EPS header and nothing more: enough to be recognised and refused.
  writeFileSync(
    join(OUT, 'logo.eps'),
    new TextEncoder().encode('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\n'),
  );
  writeSvgFixtures();
  await writePdfFixtures();
  console.log(`Fixtures written to ${OUT}`);
}

await main();
