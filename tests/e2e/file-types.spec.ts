/**
 * Every design says what kind of file it came from, and files this tool cannot open are refused
 * with a way forward instead of a generic error.
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { addImages, collectErrors, designs, fixture, openApp, selectInList } from './helpers';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

const badge = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.design-item', { hasText: name }).locator('.file-type');

test('shows the file type of each design, in its row and in the inspector', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'photo.jpg']);
  await expect(badge(page, 'f-shape')).toHaveText('PNG');
  await expect(badge(page, 'photo')).toHaveText('JPG');
  await selectInList(page, 'photo');
  await expect(page.locator('#inspector .file-type')).toHaveText('JPG');
});

test('refuses an EPS file with what to do instead, and still adds the others', async ({ page }) => {
  await page.setInputFiles('#file-input', [fixture('logo.eps'), fixture('f-shape.png')]);
  await expect(page.locator('.toast.error')).toContainText(
    "EPS files can't be opened here. Save it as SVG or PDF",
  );
  await expect.poll(async () => (await designs(page)).length).toBe(1);
});

test('the file type survives a reload and a project file', async ({ page }, info) => {
  await addImages(page, ['photo.jpg']);
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(badge(page, 'photo')).toHaveText('JPG');

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
  await expect(badge(page, 'photo')).toHaveText('JPG');
});
