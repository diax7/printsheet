/**
 * PDF files and PDF-compatible Illustrator files come in as vectors: each page at its own size,
 * a list to choose pages from when there are several, and clear refusals for files that cannot
 * be drawn.
 */
import { expect, test, type Page } from '@playwright/test';
import { decode } from 'fast-png';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import {
  addImages,
  collectErrors,
  designs,
  downloadBytes,
  exportFile,
  fixture,
  openApp,
  selectInList,
  typeField,
} from './helpers';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

const row = (page: Page, name: string) => page.locator('.design-item', { hasText: name });
const picker = (page: Page) => page.locator('#pick-dialog');

/** The pixel width of the one image in an exported PDF's first page. */
async function pdfImageWidth(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const xobjects = doc.context.lookup(
    doc.getPages()[0]?.node.Resources()?.get(PDFName.of('XObject')) as PDFRef | PDFDict,
  ) as PDFDict;
  const [, ref] = xobjects.entries()[0] ?? [];
  const image = doc.context.lookup(ref as PDFRef) as PDFRawStream;
  return Number(image.dict.get(PDFName.of('Width'))?.toString());
}

test('adds a one-page PDF at its real size, as a vector that stays one after a reload', async ({
  page,
}) => {
  await addImages(page, ['corner.pdf']);
  const [d] = await designs(page);
  // The 100 × 60 mm page's empty 10 mm border is trimmed away.
  expect(d?.widthMm).toBeCloseTo(80, 0);
  expect(d?.heightMm).toBeCloseTo(40, 0);
  await expect(row(page, 'corner').locator('.file-type')).toHaveText('PDF');
  await expect(row(page, 'corner').locator('.dpi')).toHaveText('Vector');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(row(page, 'corner').locator('.dpi')).toHaveText('Vector');
});

test('prints a PDF page at the export DPI, far past the image made when it was added', async ({
  page,
}) => {
  await addImages(page, ['corner.pdf']);
  await selectInList(page, 'corner');
  await typeField(page, '#insp-width', '20');
  const width = await pdfImageWidth(
    await downloadBytes(await exportFile(page, { format: 'pdf', quality: '600' })),
  );
  // 200 mm at 600 DPI is 4724 px; the image made when it was added is about 4130 px wide.
  expect(width).toBeGreaterThanOrEqual(4724);
  expect(width).toBeLessThanOrEqual(4726);
});

test('prints exactly the inked part of a page, its empty border still trimmed', async ({
  page,
}) => {
  await addImages(page, ['corner.pdf']);
  await selectInList(page, 'corner');
  await typeField(page, '#insp-width', '20');
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  const dpi = 600;
  const png = decode(await downloadBytes(await exportFile(page, { format: 'png', dpi })));
  // Alpha at a point given in millimetres inside the 200 × 100 mm design.
  const alpha = (xMm: number, yMm: number): number => {
    const x = Math.round(((d.xMm - d.widthMm / 2 + xMm) / 25.4) * dpi);
    const y = Math.round(((d.yMm - d.heightMm / 2 + yMm) / 25.4) * dpi);
    return png.data[(y * png.width + x) * png.channels + 3] ?? -1;
  };
  // The L: a full-width top half and the bottom-left quarter, reaching every edge of the design.
  for (const [x, y] of [
    [3, 3],
    [197, 3],
    [3, 97],
    [97, 97],
    [197, 47],
  ] as const) {
    expect(alpha(x, y), `ink at ${x}, ${y} mm`).toBe(255);
  }
  for (const [x, y] of [
    [103, 97],
    [150, 75],
    [197, 53],
  ] as const) {
    expect(alpha(x, y), `empty at ${x}, ${y} mm`).toBe(0);
  }
});

test('asks which pages to add from a PDF with several, all ticked to start', async ({ page }) => {
  await page.setInputFiles('#file-input', fixture('pages.pdf'));
  await expect(picker(page)).toBeVisible();
  const boxes = picker(page).getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  await expect(picker(page).locator('.pick-thumb[src]')).toHaveCount(3);
  await boxes.nth(1).uncheck();
  await picker(page).getByRole('button', { name: 'Add 2 designs' }).click();
  await expect.poll(async () => (await designs(page)).length).toBe(2);
  await expect(row(page, 'pages - page 1')).toBeVisible();
  await expect(row(page, 'pages - page 3')).toBeVisible();
  expect((await designs(page)).map((x) => Math.round(x.widthMm)).toSorted()).toEqual([30, 50]);
});

test('adds nothing from a PDF when its page list is cancelled', async ({ page }) => {
  await page.setInputFiles('#file-input', [fixture('pages.pdf'), fixture('f-shape.png')]);
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await designs(page)).length).toBe(1);
  await expect(row(page, 'f-shape')).toBeVisible();
});

test('reads a PDF-compatible Illustrator file, and refuses one saved without PDF content', async ({
  page,
}) => {
  await page.setInputFiles('#file-input', [fixture('placeholder.ai'), fixture('corner.ai')]);
  await expect.poll(async () => (await designs(page)).length).toBe(1);
  await expect(row(page, 'corner').locator('.file-type')).toHaveText('AI');
  await expect(page.locator('.toast.error').filter({ hasText: 'placeholder' })).toContainText(
    'Create PDF Compatible File',
  );
});

test('warns when a PDF uses fonts it does not carry, and opens PDFs one after another', async ({
  page,
}) => {
  await addImages(page, ['corner.pdf']);
  await addImages(page, ['text.pdf']);
  await expect(page.locator('.toast.error').filter({ hasText: 'text' })).toContainText(
    'fonts that are not inside the file',
  );
});
