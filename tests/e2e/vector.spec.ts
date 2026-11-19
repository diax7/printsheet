/**
 * SVG files come in as vectors: at the size written in the file, sharp at any size, drawn afresh
 * at print size for every export, and kept as vectors across a reload and a project file.
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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

test('adds an SVG at the size written in it, as a vector', async ({ page }) => {
  await addImages(page, ['corner.svg']);
  const [d] = await designs(page);
  // The 50 mm page's empty 5 mm border is trimmed away.
  expect(d?.widthMm).toBeCloseTo(40, 0);
  expect(d?.heightMm).toBeCloseTo(40, 0);
  await expect(row(page, 'corner').locator('.file-type')).toHaveText('SVG');
  await expect(row(page, 'corner').locator('.dpi')).toHaveText('Vector');
  await expect(row(page, 'corner').locator('.flag')).toHaveCount(0);
  await selectInList(page, 'corner');
  await expect(page.locator('#inspector .hint').first()).toContainText('Vector, sharp at any size');
});

test('an SVG with only a viewBox takes its shape from the viewBox', async ({ page }) => {
  await addImages(page, ['wide-viewbox.svg']);
  const [d] = await designs(page);
  expect((d?.widthMm ?? 0) / (d?.heightMm ?? 1)).toBeCloseTo(2, 2);
});

test('prints a vector at the export DPI, far past the image made when it was added', async ({
  page,
}) => {
  await addImages(page, ['corner.svg']);
  await selectInList(page, 'corner');
  await typeField(page, '#insp-width', '20');
  // 200 mm at 600 DPI is 4724 px. The image made when it was added is about 3200 px wide.
  const width = await pdfImageWidth(
    await downloadBytes(await exportFile(page, { format: 'pdf', quality: '600' })),
  );
  expect(width).toBeGreaterThanOrEqual(4724);
  expect(width).toBeLessThanOrEqual(4726);
});

test('stays a vector after a reload and a project file, and still prints at full size', async ({
  page,
}, info) => {
  await addImages(page, ['corner.svg']);
  await selectInList(page, 'corner');
  await typeField(page, '#insp-width', '20');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(row(page, 'corner').locator('.dpi')).toHaveText('Vector');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#save-project'),
  ]);
  const file = path.join(info.outputDir, download.suggestedFilename());
  await download.saveAs(file);
  await page.click('#new-sheet');
  await page.getByRole('button', { name: 'Start new sheet' }).click();
  await expect.poll(async () => (await designs(page)).length).toBe(0);
  await page.setInputFiles('#project-input', file);
  await expect(row(page, 'corner').locator('.dpi')).toHaveText('Vector');
  const width = await pdfImageWidth(
    await downloadBytes(await exportFile(page, { format: 'pdf', quality: '600' })),
  );
  expect(width).toBeGreaterThanOrEqual(4724);
});

test('warns about live text, refuses a broken or sizeless SVG, and adds the rest', async ({
  page,
}) => {
  await page.setInputFiles('#file-input', [
    fixture('live-text.svg'),
    fixture('broken.svg'),
    fixture('no-size.svg'),
    fixture('corner.svg'),
  ]);
  await expect.poll(async () => (await designs(page)).length).toBe(2);
  const toasts = page.locator('.toast');
  await expect(toasts.filter({ hasText: 'broken' })).toContainText('could not be drawn');
  await expect(toasts.filter({ hasText: 'no-size' })).toContainText('has no size');
  await expect(toasts.filter({ hasText: 'live text' })).toContainText('Convert text to outlines');
});
