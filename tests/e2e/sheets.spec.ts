/**
 * Split jobs, checked through the interface: switching layout, designs across a split, the
 * one-click fix, Arrange across sheets, undo and reload.
 */
import { expect, test, type Page } from '@playwright/test';
import { addImages, arrange, collectErrors, designs, openApp, state, typeField } from './helpers';
import { footprint } from '@/model/geometry';
import { pageOf } from '@/model/pages';
import type { Design, Settings } from '@/model/types';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function settings(page: Page): Promise<Settings> {
  return (await state(page)).sheet.settings;
}

/** Three copies stacked down a narrow one long sheet (no room beside each other). */
async function stackOfThree(page: Page, widthCm: string): Promise<Design[]> {
  await typeField(page, '#sheet-width', '10');
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', widthCm);
  await page.keyboard.press('Escape');
  await page.locator('.design-item').first().click();
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await designs(page)).length).toBe(3);
  return designs(page);
}

test('splitting flags designs across a split, and one click moves them onto a sheet', async ({
  page,
}) => {
  const stack = await stackOfThree(page, '6');
  const second = footprint(stack[1] as Design);
  await page.click('[data-layout="split"]');
  expect((await settings(page)).layout).toBe('split');
  await expect(page.locator('#split-fields')).toBeVisible();
  await expect(page.locator('#length-mode-field')).toBeHidden();

  // A sheet that ends in the middle of the second design.
  const cut = Math.round((second.minY + second.maxY) / 2);
  await typeField(page, '#page-length', String(cut / 10));
  const toastAction = page.locator('.toast .toast-action');
  await expect(toastAction).toBeVisible();
  const crossing = async (): Promise<number> => {
    const s = await state(page);
    return s.sheet.designs.filter((d) => pageOf(d, s.sheet.settings) === null).length;
  };
  expect(await crossing()).toBeGreaterThan(0);
  await expect(page.locator('.design-item .flag.danger').first()).toBeVisible();

  await toastAction.click();
  await expect.poll(crossing).toBe(0);

  // One undo brings the crossing back, the next the old length, the next one long sheet.
  await page.keyboard.press('Control+z');
  await expect.poll(crossing).toBeGreaterThan(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await settings(page)).layout).toBe('single');
  const back = await designs(page);
  back.forEach((d, i) => expect(d.yMm).toBeCloseTo(stack[i]?.yMm ?? NaN, 6));
});

test('Arrange fills sheet 1, then the next sheets, and the film total adds them up', async ({
  page,
}) => {
  await stackOfThree(page, '6');
  await page.click('[data-layout="split"]');
  const h = footprint((await designs(page))[0] as Design);
  // Room for two designs per sheet, not three, even when Arrange turns them on their side.
  const short = Math.min(h.maxX - h.minX, h.maxY - h.minY);
  const length = Math.ceil((2 * short + 5) / 10) + 1;
  await typeField(page, '#page-length', String(length));
  await arrange(page);
  await expect(page.locator('#busy')).toBeHidden();
  const s = await state(page);
  const pages = s.sheet.designs.map((d) => pageOf(d, s.sheet.settings));
  expect(pages.every((p) => p !== null)).toBe(true);
  expect(new Set(pages).size).toBe(2);
  await expect(page.locator('#film-size')).toContainText('2 sheets');
  const meters = Number(await page.locator('#film-meters').textContent());
  expect(meters).toBeGreaterThan(length / 100);
  expect(meters).toBeLessThanOrEqual((2 * length) / 100 + 1e-9);
});

test('a split job survives a reload', async ({ page }) => {
  await stackOfThree(page, '4');
  await page.click('[data-layout="split"]');
  await page.click('[data-last-page="full"]');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('Restored your last sheet');
  const s = await settings(page);
  expect([s.layout, s.lastPage]).toEqual(['split', 'full']);
  await expect(page.locator('[data-layout="split"]')).toHaveAttribute('aria-checked', 'true');
});

test('warns when the sheets are shorter than the tallest design', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '30');
  await page.click('[data-layout="split"]');
  await typeField(page, '#page-length', '20');
  await expect(page.locator('#page-length-hint')).toContainText('longer than one sheet');
  await page.click('#export');
  await expect(page.locator('#export-dialog .notice.danger')).toContainText(
    'longer than one sheet',
  );
});
