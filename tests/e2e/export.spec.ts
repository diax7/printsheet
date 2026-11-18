/**
 * Exports, checked from the outside: real downloads from the app opened from disk, parsed and
 * rendered independently.
 *
 * Ground truth: an oracle in this file rasterises the sheet straight from the model (each output
 * pixel mapped back into its image by the design's position, size, angle and flips). The PNG
 * export and the PDF (drawn by pdf.js, a separate renderer) must both match it. If the app and
 * the oracle shared a mistake, a deliberately wrong oracle would score as well; the test checks
 * that it does not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { decode } from 'fast-png';
import { unzipSync } from 'fflate';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFRef } from 'pdf-lib';
import {
  addImages,
  arrange,
  assetBytes,
  chooseExport,
  collectErrors,
  designs,
  downloadBytes,
  exportFile,
  openApp,
  state,
  typeField,
} from './helpers';
import { splitForExport } from '@/model/pages';
import type { Design } from '@/model/types';

const DPI = 150;

interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray | Uint16Array;
}

/** The oracle: alpha of every output pixel, computed from the model alone. */
function oracleAlpha(
  sheetWidthMm: number,
  heightPx: number,
  list: Design[],
  images: Map<string, Raster>,
  mirror: boolean,
  breakFlip = false,
): Uint8Array {
  const pxPerMm = DPI / 25.4;
  const width = Math.round(sheetWidthMm * pxPerMm);
  const out = new Uint8Array(width * heightPx);
  for (const d of list) {
    const img = images.get(d.assetId);
    if (!img) throw new Error('missing image');
    const rad = (d.angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const reach = Math.hypot(d.widthMm, d.heightMm) / 2;
    const y0 = Math.max(0, Math.floor((d.yMm - reach) * pxPerMm));
    const y1 = Math.min(heightPx, Math.ceil((d.yMm + reach) * pxPerMm));
    for (let py = y0; py < y1; py++) {
      for (let px = 0; px < width; px++) {
        let x = (px + 0.5) / pxPerMm;
        const y = (py + 0.5) / pxPerMm;
        if (mirror) x = sheetWidthMm - x;
        const dx = x - d.xMm;
        const dy = y - d.yMm;
        let lx = dx * cos + dy * sin;
        let ly = -dx * sin + dy * cos;
        if (d.flipX !== breakFlip) lx = -lx;
        if (d.flipY) ly = -ly;
        const u = Math.floor((lx / d.widthMm + 0.5) * img.width);
        const v = Math.floor((ly / d.heightMm + 0.5) * img.height);
        if (u < 0 || v < 0 || u >= img.width || v >= img.height) continue;
        const a = img.data[(v * img.width + u) * 4 + 3] ?? 0;
        if (a > (out[py * width + px] ?? 0)) out[py * width + px] = a;
      }
    }
  }
  return out;
}

function alphaOf(r: Raster): Uint8Array {
  const out = new Uint8Array(r.width * r.height);
  for (let i = 0; i < out.length; i++) out[i] = r.data[i * 4 + 3] ?? 0;
  return out;
}

/** Intersection over union of the "mostly opaque" pixels of two masks of the same width. */
function iou(a: Uint8Array, b: Uint8Array, width: number, height: number, widthB = width): number {
  let inter = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pa = (a[y * width + x] ?? 0) >= 128;
      const pb = (b[y * widthB + x] ?? 0) >= 128;
      if (pa && pb) inter++;
      if (pa || pb) union++;
    }
  }
  return union === 0 ? 1 : inter / union;
}

function mirrorRaster(r: Raster): Uint8Array {
  const alpha = alphaOf(r);
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++)
      out[y * r.width + x] = alpha[y * r.width + (r.width - 1 - x)] ?? 0;
  return out;
}

/** Render a PDF with pdf.js in the browser on a transparent background; returns PNG bytes. */
async function renderWithPdfJs(page: Page, pdf: Buffer): Promise<Raster> {
  const harness = 'http://pdfjs.harness.test';
  const build = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build');
  await page.context().route(`${harness}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'index.html') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><script type="module">
          import * as pdfjs from '${harness}/pdf.mjs';
          pdfjs.GlobalWorkerOptions.workerSrc = '${harness}/pdf.worker.mjs';
          window.renderPdf = async (base64, scale) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const doc = await pdfjs.getDocument({ data: bytes }).promise;
            const pdfPage = await doc.getPage(1);
            const viewport = pdfPage.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: 'rgba(0,0,0,0)' }).promise;
            return canvas.toDataURL('image/png').split(',')[1];
          };
          window.harnessReady = true;
        </script>`,
      });
    }
    return route.fulfill({
      contentType: 'text/javascript',
      body: readFileSync(path.join(build, name)),
    });
  });
  const tab = await page.context().newPage();
  await tab.goto(`${harness}/index.html`);
  await tab.waitForFunction(
    () => (window as unknown as { harnessReady?: boolean }).harnessReady === true,
  );
  const base64 = await tab.evaluate(
    ([b64, scale]) =>
      (window as unknown as { renderPdf(b: string, s: number): Promise<string> }).renderPdf(
        b64 as string,
        scale as number,
      ),
    [pdf.toString('base64'), DPI / 72] as const,
  );
  await tab.close();
  const png = decode(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, data: png.data };
}

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** Four asymmetric "F" designs on a 15 cm sheet: plain, rotated 30°, and rotated 30° with each flip. */
async function buildCrossCheckSheet(page: Page): Promise<void> {
  await typeField(page, '#sheet-width', '15');
  await addImages(page, ['f-shape.png']);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+d');
  // [angle, flip horizontally, flip vertically]
  const setups: Array<[number, boolean, boolean]> = [
    [0, false, false],
    [30, false, false],
    [30, true, false],
    [30, false, true],
  ];
  for (const [i, [angle, flipX, flipY]] of setups.entries()) {
    await page
      .locator('.design-item')
      .nth(setups.length - 1 - i)
      .click();
    await typeField(page, '#insp-width', '4');
    await typeField(page, '#insp-angle', String(angle));
    if (flipX) await page.getByRole('button', { name: 'Flip horizontally' }).click();
    if (flipY) await page.getByRole('button', { name: 'Flip vertically' }).click();
  }
  await page.keyboard.press('Escape');
  await arrange(page);
  await expect(page.locator('.flag.danger')).toHaveCount(0);
}

test('exports a PDF from the file opened on disk, at the exact sheet size', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Control+d');
  const s = await state(page);
  const download = await exportFile(page, { format: 'pdf' });
  expect(download.suggestedFilename()).toMatch(/^printsheet-58cm-0\.\d\dm-\d{4}-\d{2}-\d{2}\.pdf$/);
  const doc = await PDFDocument.load(await downloadBytes(download), { updateMetadata: false });
  const pageOne = doc.getPages()[0];
  const { width, height } = pageOne?.getSize() ?? { width: 0, height: 0 };
  expect(width).toBeCloseTo((580 / 25.4) * 72, 2);
  const lengthMm = Number(await page.locator('#film-meters').textContent()) * 1000;
  expect(height).toBeCloseTo((lengthMm / 25.4) * 72, 0);
  const xobjects = doc.context.lookup(
    pageOne?.node.Resources()?.get(PDFName.of('XObject')) as PDFRef | PDFDict,
  ) as PDFDict;
  // Two distinct images, four designs (Ctrl+D copied both selected): each image embedded once.
  expect(xobjects.entries()).toHaveLength(2);
  expect(s.sheet.designs).toHaveLength(4);
  expect(doc.getProducer()).toBe('PrintSheet');
});

test('exports a PNG at the chosen DPI, with the DPI written into the file', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const download = await exportFile(page, { format: 'png', dpi: 150 });
  const png = decode(await downloadBytes(download));
  expect(png.width).toBe(Math.round((580 * 150) / 25.4));
  expect(png.channels).toBe(4);
  expect(png.resolution).toEqual({
    x: Math.round(150 / 0.0254),
    y: Math.round(150 / 0.0254),
    unit: 1,
  });
  // Transparent background: the corner far from any design is empty.
  expect(png.data[(png.width - 1) * 4 + 3]).toBe(0);
});

test('PNG and PDF (RGB, CMYK, mirrored) match an independent rasterisation of the model', async ({
  page,
}) => {
  test.slow();
  await buildCrossCheckSheet(page);
  const s = await state(page);
  const images = new Map(
    Object.entries(await assetBytes(page)).map(([id, bytes]) => {
      const png = decode(Uint8Array.from(bytes));
      return [id, { width: png.width, height: png.height, data: png.data }];
    }),
  );
  const list = s.sheet.designs;

  const pngExport = decode(
    await downloadBytes(await exportFile(page, { format: 'png', dpi: 150 })),
  );
  const width = pngExport.width;
  const height = pngExport.height;
  const oracle = oracleAlpha(150, height, list, images, false);
  const pngAlpha = alphaOf({ width, height, data: pngExport.data });

  // 1. PNG export vs the oracle, and the oracle can tell a wrong flip apart.
  const pngScore = iou(oracle, pngAlpha, width, height);
  const wrong = iou(oracleAlpha(150, height, list, images, false, true), pngAlpha, width, height);
  expect(pngScore).toBeGreaterThan(0.95);
  expect(wrong).toBeLessThan(pngScore - 0.1);

  // 2. PDF (RGB, lossless and compact) drawn by pdf.js vs the oracle, and its colours vs the
  //    PNG's. Compact stores colour as JPEG, so its colours may differ slightly; its mask is the
  //    same lossless mask, so its shape must match the lossless PDF pixel for pixel.
  const colourDiff = (pdf: Raster): { mean: number; worst: number } => {
    let diff = 0;
    let count = 0;
    let worst = 0;
    for (let y = 0; y < Math.min(height, pdf.height); y++) {
      for (let x = 0; x < Math.min(width, pdf.width); x++) {
        const i = (y * width + x) * 4;
        const j = (y * pdf.width + x) * 4;
        if (pngExport.data[i + 3] !== 255 || pdf.data[j + 3] !== 255) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs((pngExport.data[i + c] ?? 0) - (pdf.data[j + c] ?? 0));
          diff += d;
          worst = Math.max(worst, d);
        }
        count += 3;
      }
    }
    expect(count).toBeGreaterThan(1000);
    return { mean: diff / count, worst };
  };
  const pdfRgb = await renderWithPdfJs(
    page,
    await downloadBytes(
      await exportFile(page, { format: 'pdf', color: 'rgb', compression: 'lossless' }),
    ),
  );
  const common = Math.min(height, pdfRgb.height);
  expect(Math.abs(pdfRgb.width - width)).toBeLessThanOrEqual(1);
  expect(Math.abs(pdfRgb.height - height)).toBeLessThanOrEqual(1);
  expect(
    iou(oracle, alphaOf(pdfRgb), Math.min(width, pdfRgb.width), common, pdfRgb.width),
  ).toBeGreaterThan(0.95);
  expect(colourDiff(pdfRgb).mean).toBeLessThan(6);

  const pdfCompact = await renderWithPdfJs(
    page,
    await downloadBytes(
      await exportFile(page, { format: 'pdf', color: 'rgb', compression: 'compact' }),
    ),
  );
  expect(Array.from(alphaOf(pdfCompact))).toEqual(Array.from(alphaOf(pdfRgb)));
  const compact = colourDiff(pdfCompact);
  expect(compact.mean).toBeLessThan(6);
  // No dark halo: an edge pixel darkened towards the black under transparency would differ by
  // well over 100 on a channel.
  expect(compact.worst).toBeLessThan(60);

  // 3. CMYK PDF: pdf.js converts CMYK its own way, so only the shape is compared here (the
  //    channel values are checked in the unit tests).
  const pdfCmyk = await renderWithPdfJs(
    page,
    await downloadBytes(await exportFile(page, { format: 'pdf', color: 'cmyk' })),
  );
  expect(
    iou(
      oracle,
      alphaOf(pdfCmyk),
      Math.min(width, pdfCmyk.width),
      Math.min(height, pdfCmyk.height),
      pdfCmyk.width,
    ),
  ).toBeGreaterThan(0.95);

  // 4. Mirror: the mirrored PNG is the PNG flipped; the mirrored PDF matches the mirrored oracle.
  const pngMirror = decode(
    await downloadBytes(await exportFile(page, { format: 'png', dpi: 150, mirror: true })),
  );
  expect(
    iou(
      mirrorRaster({ width, height, data: pngExport.data }),
      alphaOf({ width, height, data: pngMirror.data }),
      width,
      height,
    ),
  ).toBeGreaterThan(0.98);
  const pdfMirror = await renderWithPdfJs(
    page,
    await downloadBytes(await exportFile(page, { format: 'pdf', color: 'rgb', mirror: true })),
  );
  const oracleMirror = oracleAlpha(150, height, list, images, true);
  expect(
    iou(
      oracleMirror,
      alphaOf(pdfMirror),
      Math.min(width, pdfMirror.width),
      Math.min(height, pdfMirror.height),
      pdfMirror.width,
    ),
  ).toBeGreaterThan(0.95);
});

test('the default PDF is compact: JPEG colour with the exact transparency mask', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  await page.click('#export');
  await expect(page.locator('[data-group="compression"][data-value="compact"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  const doc = await PDFDocument.load(
    await downloadBytes(await exportFile(page, { format: 'pdf' })),
    { updateMetadata: false },
  );
  const xobjects = doc.context.lookup(
    doc.getPages()[0]?.node.Resources()?.get(PDFName.of('XObject')) as PDFRef | PDFDict,
  ) as PDFDict;
  const [, ref] = xobjects.entries()[0] ?? [];
  const image = doc.context.lookup(ref as PDFRef) as PDFRawStream;
  expect(image.dict.get(PDFName.of('Filter'))).toEqual(PDFName.of('DCTDecode'));
  const mask = doc.context.lookup(image.dict.get(PDFName.of('SMask')) as PDFRef) as PDFRawStream;
  expect(mask.dict.get(PDFName.of('Filter'))).toEqual(PDFName.of('FlateDecode'));
});

test('the file-size choice is hidden for CMYK, which is always lossless', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.click('#export');
  const compact = page.locator('[data-group="compression"][data-value="compact"]');
  await expect(compact).toBeVisible();
  await page.locator('[data-group="color"][data-value="cmyk"]').click();
  await expect(compact).toBeHidden();
  await expect(page.locator('#export-dialog .notice').last()).toContainText('always lossless');
});

test('CMYK PDF stores CMYK pixels with the transparency kept', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const doc = await PDFDocument.load(
    await downloadBytes(await exportFile(page, { format: 'pdf', color: 'cmyk' })),
    { updateMetadata: false },
  );
  const pageOne = doc.getPages()[0];
  const xobjects = doc.context.lookup(
    pageOne?.node.Resources()?.get(PDFName.of('XObject')) as PDFRef | PDFDict,
  ) as PDFDict;
  const [, ref] = xobjects.entries()[0] ?? [];
  const image = doc.context.lookup(ref as PDFRef) as PDFRawStream;
  expect(image.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceCMYK'));
  expect(image.dict.get(PDFName.of('SMask'))).toBeInstanceOf(PDFRef);
});

test('the PDF image-quality limit shrinks a large image', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '0.5');
  const doc = await PDFDocument.load(
    await downloadBytes(await exportFile(page, { format: 'pdf', quality: '300' })),
    { updateMetadata: false },
  );
  const pageOne = doc.getPages()[0];
  const xobjects = doc.context.lookup(
    pageOne?.node.Resources()?.get(PDFName.of('XObject')) as PDFRef | PDFDict,
  ) as PDFDict;
  const [, ref] = xobjects.entries()[0] ?? [];
  const image = doc.context.lookup(ref as PDFRef) as PDFRawStream;
  // 5 mm at 300 DPI is 59 px; the original is 224 px wide.
  expect(Number(image.dict.get(PDFName.of('Width'))?.toString())).toBe(59);
});

test('a PNG too wide for the browser is refused with a way out', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#sheet-width', '160');
  await page.click('#export');
  await page.locator('[data-group="format"][data-value="png"]').click();
  await page.locator('[data-group="dpi"][data-value="600"]').click();
  await expect(page.locator('#export-dialog .notice.danger')).toContainText(
    'lower DPI or export a PDF',
  );
  await expect(page.locator('#export-go')).toBeDisabled();
  await page.locator('[data-group="dpi"][data-value="300"]').click();
  await expect(page.locator('#export-go')).toBeEnabled();
  const designsNow = await designs(page);
  expect(designsNow).toHaveLength(1);
});

test('the export draws overlapping designs in the stacking order shown', async ({ page }) => {
  await addImages(page, ['opaque.png', 'bordered.png']);
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Align left' }).click();
  await page.getByRole('button', { name: 'Align top' }).click();
  const centrePixel = async (): Promise<number[]> => {
    const png = decode(await downloadBytes(await exportFile(page, { format: 'png', dpi: 150 })));
    // Both designs start at the top-left corner; 1 cm in is inside both.
    const p = Math.round((10 * 150) / 25.4);
    const i = (p * png.width + p) * 4;
    return Array.from(png.data.slice(i, i + 3));
  };
  // "bordered" (orange) was added last, so it is on top.
  expect(await centrePixel()).toEqual([250, 180, 0]);
  await page.locator('.design-item', { hasText: 'bordered' }).click();
  await page.getByRole('button', { name: 'Send backward' }).click();
  expect(await centrePixel()).not.toEqual([250, 180, 0]);
});

/** The cross-check sheet split into short sheets, so its designs land on several of them. */
async function buildSplitSheet(page: Page): Promise<void> {
  await buildCrossCheckSheet(page);
  // Gap between rectangles: nested by their real shapes, these few designs fit on one sheet.
  await page.click('[data-spacing="box"]');
  await page.click('[data-layout="split"]');
  await typeField(page, '#page-length', '10');
  await page
    .locator('.toast .toast-action')
    .click({ timeout: 5000 })
    .catch(() => undefined);
  await arrange(page);
  await expect(page.locator('.flag.danger')).toHaveCount(0);
}

test('a split job exports a zip with a PDF per sheet, each matching the model', async ({
  page,
}) => {
  test.slow();
  await buildSplitSheet(page);
  const s = await state(page);
  const { parts } = splitForExport(s.sheet);
  expect(parts.length).toBeGreaterThan(1);
  const images = new Map(
    Object.entries(await assetBytes(page)).map(([id, bytes]) => {
      const png = decode(Uint8Array.from(bytes));
      return [id, { width: png.width, height: png.height, data: png.data }];
    }),
  );

  const download = await exportFile(page, {
    format: 'pdf',
    color: 'rgb',
    compression: 'lossless',
    split: 'zip',
  });
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const files = unzipSync(new Uint8Array(await downloadBytes(download)));
  const names = Object.keys(files);
  expect(names).toHaveLength(parts.length);
  for (const [i, part] of parts.entries()) {
    const name = names[i] ?? '';
    expect(name.endsWith(`-sheet-${i + 1}-of-${parts.length}.pdf`)).toBe(true);
    const rendered = await renderWithPdfJs(page, Buffer.from(files[name] ?? new Uint8Array()));
    const oracle = oracleAlpha(150, rendered.height, part.sheet.designs, images, false);
    const width = Math.round((150 * 150) / 25.4);
    expect(
      iou(
        oracle,
        alphaOf(rendered),
        Math.min(width, rendered.width),
        rendered.height,
        rendered.width,
      ),
    ).toBeGreaterThan(0.95);
  }
});

test('a split job can export one PDF with a page per sheet', async ({ page }) => {
  await buildSplitSheet(page);
  const { parts } = splitForExport((await state(page)).sheet);
  const download = await exportFile(page, { format: 'pdf', split: 'pdf-pages' });
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const doc = await PDFDocument.load(await downloadBytes(download), { updateMetadata: false });
  expect(doc.getPageCount()).toBe(parts.length);
  doc.getPages().forEach((p, i) => {
    const lengthMm = parts[i]?.sheet.settings.fixedLengthMm ?? 0;
    expect(p.getHeight()).toBeCloseTo((lengthMm / 25.4) * 72, 1);
  });
});

test('separate files give a download button per sheet, each its own click', async ({ page }) => {
  await buildSplitSheet(page);
  const { parts } = splitForExport((await state(page)).sheet);
  await chooseExport(page, { format: 'png', dpi: 150, split: 'files' });
  await expect(page.locator('[data-group="split"][data-value="pdf-pages"]')).toBeHidden();
  await page.locator('#export-go').click();
  const buttons = page.locator('#export-files button');
  await expect(buttons).toHaveCount(parts.length, { timeout: 110_000 });
  for (let i = 0; i < parts.length; i++) {
    const [download] = await Promise.all([page.waitForEvent('download'), buttons.nth(i).click()]);
    const name = download.suggestedFilename();
    expect(name.endsWith(`-sheet-${i + 1}-of-${parts.length}.png`)).toBe(true);
    const png = decode(await downloadBytes(download));
    expect(png.width).toBe(Math.round((150 * 150) / 25.4));
  }
});

/** Alpha of one pixel of a canvas read back as RGBA numbers. */
function alphaAt(img: { w: number; data: number[] }, x: number, y: number): number {
  return img.data[(y * img.w + x) * 4 + 3] ?? 0;
}

test('the mirror preview shows the file flipped left to right', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '25');
  await page.click('#export');
  const canvas = page.locator('#export-preview');
  const pixels = (): Promise<{ w: number; data: number[] }> =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      return { w: c.width, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
    });
  await page.locator('[data-group="mirror"][data-value="regular"]').click();
  const regular = await pixels();
  await page.locator('[data-group="mirror"][data-value="mirrored"]').click();
  await expect(canvas).toHaveAttribute('data-mirrored', 'true');
  const mirrored = await pixels();
  const h = regular.data.length / 4 / regular.w;
  let visible = 0;
  let matched = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < regular.w; x++) {
      if (alphaAt(regular, x, y) < 200) continue;
      visible++;
      if (alphaAt(mirrored, regular.w - 1 - x, y) >= 200) matched++;
    }
  }
  expect(visible).toBeGreaterThan(50);
  expect(matched / visible).toBeGreaterThan(0.95);
});
