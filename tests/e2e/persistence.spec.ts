/**
 * Work must never be lost silently: autosave across reloads, project files that reopen exactly,
 * a confirmation before anything is thrown away, and a warning when two tabs are open.
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addImages,
  collectErrors,
  designs,
  openApp,
  selectInList,
  state,
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

test('restores the sheet after the page is reloaded', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await selectInList(page, 'f-shape');
  await typeField(page, '#insp-width', '12');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  const before = await state(page);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('#save-status')).toHaveText('Restored your last sheet');
  const after = await state(page);
  expect(after.sheet).toEqual(before.sheet);
  await expect(page.locator('.design-item')).toHaveCount(2);
});

test('saves a project file and opens it again exactly', async ({ page }, info) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await selectInList(page, 'bordered');
  await page.getByRole('button', { name: 'Rotate 90° right' }).click();
  await typeField(page, '#gap', '3');
  const before = await state(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#save-project'),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.printsheet$/);
  const file = path.join(info.outputDir, download.suggestedFilename());
  await download.saveAs(file);

  await page.click('#new-sheet');
  await page.getByRole('button', { name: 'Start new sheet' }).click();
  await expect.poll(async () => (await designs(page)).length).toBe(0);

  await page.setInputFiles('#project-input', file);
  await expect(page.locator('.design-item')).toHaveCount(2);
  const after = await state(page);
  expect(after.sheet).toEqual(before.sheet);
  expect(after.assets.map((a) => a.id).toSorted()).toEqual(
    before.assets.map((a) => a.id).toSorted(),
  );
});

test('a 1 px image and a hairline survive a reload and a project round trip', async ({
  page,
}, info) => {
  await addImages(page, ['f-shape.png', 'pixel.png', 'hairline.png']);
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  const before = await state(page);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('.design-item')).toHaveCount(3);
  expect((await state(page)).sheet).toEqual(before.sheet);

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
  await expect(page.locator('.design-item')).toHaveCount(3);
  expect((await state(page)).sheet).toEqual(before.sheet);
});

test('a tiny typed size still saves and reopens', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '0.005');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('.design-item')).toHaveCount(1);
});

test('says so clearly when the browser has no room to save', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(
      this: IDBObjectStore,
      ...args: Parameters<typeof original>
    ) {
      if ((window as unknown as { failSaves?: boolean }).failSaves) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.evaluate(() => {
    (window as unknown as { failSaves?: boolean }).failSaves = true;
  });
  await addImages(page, ['f-shape.png']);
  await expect(page.locator('#save-status')).toContainText('out of storage space');
  await expect(page.locator('.toast.error')).toContainText('out of storage space');
});

test('asks before replacing the sheet, and keeps it on cancel', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.click('#new-sheet');
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await designs(page)).toHaveLength(1);
});

test('refuses a file that is not a project, and keeps the current sheet', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.setInputFiles('#project-input', {
    name: 'fake.printsheet',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a project at all'),
  });
  await expect(page.locator('.toast.error')).toContainText('not a PrintSheet project');
  expect(await designs(page)).toHaveLength(1);
});

test('keeps an image that undo can bring back, across a reload', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await addImages(page, ['bordered.png']);
  await selectInList(page, 'bordered');
  await page.keyboard.press('Delete');
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('.design-item')).toHaveCount(2);
});

test('a new sheet in one tab does not destroy the sheet another tab is saving', async ({
  page,
  context,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  const other = await context.newPage();
  await openApp(other);
  await expect(other.locator('.design-item')).toHaveCount(2);
  await other.click('#new-sheet');
  await other.getByRole('button', { name: 'Start new sheet' }).click();
  await expect(other.locator('.design-item')).toHaveCount(0);
  await other.waitForTimeout(900);
  await other.close();
  // The first tab keeps working and saves again.
  await selectInList(page, 'f-shape');
  await typeField(page, '#insp-width', '9');
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('.design-item')).toHaveCount(2);
  await expect(page.locator('#save-status')).toHaveText('Restored your last sheet');
});

test('warns when PrintSheet is open in a second tab', async ({ page, context }) => {
  const second = await context.newPage();
  await openApp(second);
  await expect(page.locator('#tab-banner')).toBeVisible();
  await expect(second.locator('#tab-banner')).toBeVisible();
  await second.close();
});
