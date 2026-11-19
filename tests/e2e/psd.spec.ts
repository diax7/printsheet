/**
 * Photoshop files: a list of layers and folders to choose from, each chosen row drawn as
 * Photoshop shows it (mask, opacity, clipped layers, merged folders), and clear refusals.
 */
import { decode } from 'fast-png';
import { expect, test, type Page } from '@playwright/test';
import { assetBytes, collectErrors, designs, fixture, openApp, state } from './helpers';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

const picker = (page: Page) => page.locator('#pick-dialog');
const box = (page: Page, label: string) =>
  picker(page).getByRole('checkbox', { name: label, exact: true });

/** Open layers.psd and leave only `labels` ticked (a folder's layers need it opened first). */
async function pickOnly(page: Page, labels: readonly string[]): Promise<void> {
  await page.setInputFiles('#file-input', fixture('layers.psd'));
  await expect(picker(page)).toBeVisible();
  for (const b of await picker(page).getByRole('checkbox').all()) {
    if ((await b.isChecked()) && (await b.isVisible())) await b.uncheck();
  }
  for (const label of labels) await box(page, label).check();
  await picker(page).locator('#pick-add').click();
  await expect.poll(async () => (await designs(page)).length).toBe(labels.length);
}

/** The highest alpha in the one image on the sheet. */
async function maxAlpha(page: Page): Promise<number> {
  const [bytes] = Object.values(await assetBytes(page));
  const png = decode(Uint8Array.from(bytes ?? []));
  let max = 0;
  for (let i = png.channels - 1; i < png.data.length; i += png.channels) {
    max = Math.max(max, png.data[i] ?? 0);
  }
  return max;
}

test('lists layers top first, visible ones ticked, and adds them as PSD designs', async ({
  page,
}) => {
  await page.setInputFiles('#file-input', fixture('layers.psd'));
  await expect(picker(page)).toBeVisible();
  const labels = await picker(page).locator('.pick-row:visible .pick-label').allTextContents();
  expect(labels).toEqual(['Base', 'Pair', 'Faded', 'Off', 'Text', 'Logo', 'Whole image']);
  await expect(box(page, 'Off')).not.toBeChecked();
  await expect(box(page, 'Whole image')).not.toBeChecked();
  await expect(box(page, 'Logo')).toBeChecked();
  await picker(page).getByRole('button', { name: 'Add 5 designs' }).click();
  await expect.poll(async () => (await designs(page)).length).toBe(5);
  const row = page.locator('.design-item', { hasText: 'layers - Logo' });
  await expect(row.locator('.file-type')).toHaveText('PSD');
});

test('opening a folder shows its layers without changing what is ticked', async ({ page }) => {
  await page.setInputFiles('#file-input', fixture('layers.psd'));
  await expect(picker(page)).toBeVisible();
  await expect(box(page, 'Left')).toBeHidden();
  await picker(page).getByRole('button', { name: 'Show 2 layers' }).click();
  await expect(box(page, 'Left')).toBeVisible();
  await expect(box(page, 'Left')).not.toBeChecked();
  await expect(box(page, 'Pair')).toBeChecked();
  await picker(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await designs(page)).toHaveLength(0);
});

test('a layer mask at 50% makes the layer half transparent', async ({ page }) => {
  await pickOnly(page, ['Faded']);
  expect(Math.abs((await maxAlpha(page)) - 128)).toBeLessThanOrEqual(2);
});

test('a folder is added merged into one design covering all its layers', async ({ page }) => {
  await pickOnly(page, ['Pair']);
  const [asset] = (await state(page)).assets;
  // Two 20 px squares, from x 10 to x 80.
  expect(asset).toMatchObject({ widthPx: 70, heightPx: 20 });
});

test('a layer brings the layers clipped to it, cut to its own shape', async ({ page }) => {
  await pickOnly(page, ['Base']);
  const [asset] = (await state(page)).assets;
  expect(asset).toMatchObject({ widthPx: 40, heightPx: 40 });
  const [bytes] = Object.values(await assetBytes(page));
  const png = decode(Uint8Array.from(bytes ?? []));
  // The clipped yellow pattern covers the red base.
  expect(Array.from(png.data.slice(0, 3))).toEqual([240, 200, 20]);
});

/** Add only the rows `labels` from `file`. */
async function addFrom(page: Page, file: string, labels: readonly string[]): Promise<void> {
  await page.setInputFiles('#file-input', fixture(file));
  await expect(picker(page)).toBeVisible();
  for (const b of await picker(page).getByRole('checkbox').all()) {
    if ((await b.isChecked()) && (await b.isVisible())) await b.uncheck();
  }
  for (const label of labels) await box(page, label).check();
  await picker(page).locator('#pick-add').click();
  await expect.poll(async () => (await designs(page)).length).toBe(labels.length);
}

test('a layer clipped in Multiply darkens its base, as in Photoshop', async ({ page }) => {
  await addFrom(page, 'blend.psd', ['Base']);
  const [bytes] = Object.values(await assetBytes(page));
  const png = decode(Uint8Array.from(bytes ?? []));
  // 200,100,50 multiplied by 50% grey; drawn as Normal it would be the grey 128,128,128.
  const [r = 0, g = 0, b = 0] = Array.from(png.data.slice(0, 3));
  expect(Math.abs(r - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(g - 50)).toBeLessThanOrEqual(2);
  expect(Math.abs(b - 25)).toBeLessThanOrEqual(2);
});

test('only the part of a layer on the page is added', async ({ page }) => {
  await addFrom(page, 'blend.psd', ['Edge']);
  const [asset] = (await state(page)).assets;
  // 80 px wide from x 180, on a page 200 px wide.
  expect(asset).toMatchObject({ widthPx: 20, heightPx: 20 });
});

test('the whole image is added as Photoshop saved it', async ({ page }) => {
  await pickOnly(page, ['Whole image']);
  const [asset] = (await state(page)).assets;
  expect(asset).toMatchObject({ widthPx: 200, heightPx: 100 });
});

test('the whole image cannot be ticked when the file does not have it', async ({ page }) => {
  await page.setInputFiles('#file-input', fixture('nocomp.psd'));
  await expect(picker(page)).toBeVisible();
  await expect(box(page, 'Whole image')).toBeDisabled();
  await expect(picker(page)).toContainText('Maximize Compatibility');
});

test('refuses a CMYK file with the menu that fixes it', async ({ page }) => {
  await page.setInputFiles('#file-input', fixture('cmyk.psd'));
  await expect(page.locator('.toast.error')).toContainText('Image > Mode > RGB Color');
  expect(await designs(page)).toHaveLength(0);
});
