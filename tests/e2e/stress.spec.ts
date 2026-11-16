/**
 * Limits: very large images, very long sheets, high resolution and hundreds of designs. Slow by
 * nature; tagged @stress so the quick run can skip them (`npx playwright test --grep-invert @stress`).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  addImages,
  collectErrors,
  designs,
  downloadBytes,
  exportFile,
  openApp,
  selectInList,
  typeField,
} from './helpers';

/** Longest gap between animation frames while `work` runs: how long the page froze. */
async function longestFreeze(page: Page, work: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { psGaps: number[]; psStop: boolean };
    w.psGaps = [];
    w.psStop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      w.psGaps.push(now - last);
      last = now;
      if (!w.psStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await work();
  return page.evaluate(() => {
    const w = window as unknown as { psGaps: number[]; psStop: boolean };
    w.psStop = true;
    return Math.max(0, ...w.psGaps);
  });
}

/** Read the PNG header only (width, height) without decoding gigabytes of pixels. */
function pngHeader(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('imports an 8000 × 8000 px image without freezing the editor @stress', async ({ page }) => {
  test.slow();
  const freeze = await longestFreeze(page, () => addImages(page, ['large-8000.png']));
  const [d] = await designs(page);
  // 8000 px at 300 DPI is 67.7 cm, wider than the 58 cm sheet, so it is shrunk to fit.
  expect(d?.widthMm).toBeCloseTo(580, 3);
  expect(freeze).toBeLessThan(1500);
});

test('exports a 5 m sheet as one 300 DPI PNG @stress', async ({ page }) => {
  test.setTimeout(600_000);
  await addImages(page, ['f-shape.png']);
  await page.locator('[data-length="fixed"]').click();
  await typeField(page, '#fixed-length', '500');
  await selectInList(page, 'f-shape');
  await page.locator('#scroller').focus();
  // Move the design near the far end so the bottom strips have content too.
  for (let i = 0; i < 49; i++) await page.keyboard.press('Shift+ArrowDown');
  const bytes = await downloadBytes(await exportFile(page, { format: 'png', dpi: 300 }));
  const { width, height } = pngHeader(bytes);
  expect(width).toBe(Math.round((580 * 300) / 25.4));
  expect(height).toBe(Math.round((5000 * 300) / 25.4));
});

test('exports a 1 m sheet at 600 DPI @stress', async ({ page }) => {
  test.setTimeout(600_000);
  await addImages(page, ['f-shape.png']);
  await page.locator('[data-length="fixed"]').click();
  await typeField(page, '#fixed-length', '100');
  const bytes = await downloadBytes(await exportFile(page, { format: 'png', dpi: 600 }));
  const { width, height } = pngHeader(bytes);
  expect(width).toBe(Math.round((580 * 600) / 25.4));
  expect(height).toBe(Math.round((1000 * 600) / 25.4));
});

test('handles 400 designs: copies, arrange, select all, move and export @stress', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '2');
  await page.fill('#insp-copies', '399');
  const copyFreeze = await longestFreeze(page, async () => {
    await page.getByRole('button', { name: 'Add copies' }).click();
    await expect(page.locator('#design-count')).toHaveText('400');
  });
  const moveFreeze = await longestFreeze(page, async () => {
    await page.keyboard.press('Control+a');
    await page.locator('#scroller').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await page.click('#arrange');
  });
  expect(await designs(page)).toHaveLength(400);
  await expect(page.locator('.flag.danger')).toHaveCount(0);
  const bytes = await downloadBytes(await exportFile(page, { format: 'pdf' }));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(copyFreeze).toBeLessThan(3000);
  expect(moveFreeze).toBeLessThan(3000);
});

test('exports a PDF with an 8000 px image placed three times @stress', async ({ page }) => {
  test.setTimeout(300_000);
  await addImages(page, ['large-8000.png']);
  await typeField(page, '#insp-width', '15');
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Control+d');
  const bytes = await downloadBytes(await exportFile(page, { format: 'pdf' }));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // One embedded copy of a compressible 8000² image keeps the file far below three copies.
  expect(bytes.length).toBeLessThan(40 * 1024 * 1024);
});
