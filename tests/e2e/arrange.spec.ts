/**
 * Arrange and the Spacing setting, as a person uses them: the gap measured between real shapes
 * or rectangles, the search with its progress dialog and Stop, and one undo step for it all.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  addImages,
  arrange,
  collectErrors,
  designs,
  openApp,
  selectInList,
  state,
  typeField,
} from './helpers';
import { corners, polygonDistance } from '@/model/geometry';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

const meters = async (page: Page): Promise<number> =>
  Number(await page.locator('#film-meters').textContent());

/**
 * Copies of the L (7.62 cm square, three quarters empty) on a sheet 10 cm wide, with the gap
 * measured between real shapes, so the Ls can nest (rectangles are the default).
 */
async function ells(page: Page, count: number): Promise<void> {
  await typeField(page, '#sheet-width', '10');
  await page.click('[data-spacing="shape"]');
  await addImages(page, ['ell.png']);
  if (count > 1) {
    await page.fill('#insp-copies', String(count - 1));
    await page.getByRole('button', { name: 'Add copies' }).click();
    await expect(page.locator('#design-count')).toHaveText(String(count));
  }
  await page.keyboard.press('Escape');
}

test('a new sheet measures the gap between rectangles, and remembers another choice', async ({
  page,
}) => {
  await expect(page.locator('[data-spacing="box"]')).toHaveAttribute('aria-checked', 'true');
  expect((await state(page)).sheet.settings.spacing).toBe('box');
  await page.click('[data-spacing="shape"]');
  await expect(page.locator('[data-spacing="shape"]')).toHaveAttribute('aria-checked', 'true');
  expect((await state(page)).sheet.settings.spacing).toBe('shape');
  // The choice is one undo step on the sheet, and the default for the next new sheet.
  await page.keyboard.press('Control+z');
  expect((await state(page)).sheet.settings.spacing).toBe('box');
  await page.keyboard.press('Control+y');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  expect((await state(page)).sheet.settings.spacing).toBe('shape');
});

test('a sheet saved before there was a choice opens exactly as saved, with rectangles', async ({
  page,
}) => {
  // A new sheet saves with rectangles, the default, without the user choosing anything.
  await addImages(page, ['ell.png']);
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  // As the app before this choice left things: a sheet saved as rectangles, and no choice made.
  await page.evaluate(() => {
    const key = 'printsheet:prefs:v1';
    const prefs = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    delete prefs['spacing'];
    localStorage.setItem(key, JSON.stringify(prefs));
  });
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('Restored your last sheet');
  expect((await state(page)).sheet.settings.spacing).toBe('box');
  await expect(page.locator('[data-spacing="box"]')).toHaveAttribute('aria-checked', 'true');
});

test('Arrange says why when it has to make a sheet longer', async ({ page }) => {
  await ells(page, 2);
  await page.click('[data-spacing="box"]');
  // Overlap the two designs by hand: select both and align them to the same top edge.
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Align top' }).click();
  await page.keyboard.press('Escape');
  expect(await meters(page)).toBe(0.08);
  await arrange(page);
  expect(await meters(page)).toBe(0.16);
  await expect(page.locator('.toast', { hasText: 'Arranged' })).toContainText(
    '8 cm longer: some designs were closer than the cutting gap',
  );
});

test('Arrange nests real shapes into less film than rectangles need', async ({ page }) => {
  await ells(page, 2);
  await page.click('[data-spacing="box"]');
  await arrange(page);
  // Two 7.62 cm squares cannot share a 10 cm row: stacked with the 5 mm gap.
  expect(await meters(page)).toBe(0.16);
  await page.click('[data-spacing="shape"]');
  await arrange(page);
  expect(await meters(page)).toBeLessThan(0.13);
  await expect(page.locator('.flag')).toHaveCount(0);
  const [a, b] = await designs(page);
  // The rectangles overlap; only the ink keeps the gap. Neither design was mirrored.
  expect(polygonDistance(corners(a!), corners(b!))).toBe(0);
  expect([a?.flipX, a?.flipY, b?.flipX, b?.flipY]).toEqual([false, false, false, false]);
  // Measured between rectangles, the same layout is too close.
  await page.click('[data-spacing="box"]');
  await expect(page.locator('.flag')).toHaveCount(2);
  await page.click('[data-spacing="shape"]');
  await expect(page.locator('.flag')).toHaveCount(0);
});

test('Arrange is one undo step and never makes a good layout longer', async ({ page }) => {
  await ells(page, 2);
  const before = await designs(page);
  await arrange(page);
  const arranged = await designs(page);
  expect(arranged).not.toEqual(before);
  // Arranging the result again finds nothing shorter and moves nothing.
  await arrange(page);
  expect(await designs(page)).toEqual(arranged);
  await page.keyboard.press('Control+z');
  expect(await designs(page)).toEqual(before);
});

test('a long Arrange shows its progress, and Stop keeps the best layout so far', async ({
  page,
}) => {
  await ells(page, 14);
  await selectInList(page, 'ell');
  await page.keyboard.press('Escape');
  const before = await designs(page);
  const film = await meters(page);
  await page.click('#arrange');
  const dialog = page.locator('#arrange-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#arrange-status')).toContainText(/Tried \d+ layouts/);
  // Stop once a shorter layout exists; before that, Stop rightly keeps the sheet as it was.
  await expect
    .poll(async () => {
      const text = (await dialog.locator('#arrange-status').textContent()) ?? '';
      return Number(/Shortest so far: ([\d.]+) m/.exec(text)?.[1] ?? Infinity);
    })
    .toBeLessThan(film);
  await dialog.locator('#arrange-stop').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'Arranged' })).toHaveCount(1);
  expect(await meters(page)).toBeLessThan(film);
  await expect(page.locator('.flag')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await designs(page)).toEqual(before);
});

test('a result for a sheet that changed meanwhile is dropped', async ({ page }) => {
  await ells(page, 14);
  // Start Arrange and undo the copies in the same instant, before the dialog can block edits.
  await page.evaluate(() => {
    document.getElementById('arrange')?.click();
    document.getElementById('undo')?.click();
  });
  await expect(page.locator('.toast.error')).toContainText('The sheet changed while Arrange');
  await expect(page.locator('#arrange-dialog')).toBeHidden();
  expect(await designs(page)).toHaveLength(1);
  // The dropped result left no undo step behind: redo still brings the copies back.
  await page.keyboard.press('Control+y');
  expect(await designs(page)).toHaveLength(14);
});

test('a sheet restored after a reload gets its shapes back', async ({ page }) => {
  await ells(page, 2);
  await arrange(page);
  const film = await meters(page);
  expect(film).toBeLessThan(0.13);
  await expect(page.locator('#save-status')).toHaveText('Saved in this browser');
  await page.reload();
  await expect(page.locator('#save-status')).toHaveText('Restored your last sheet');
  // Masks are not saved: they are read again from the image, and until then the nested pair
  // is measured by its rectangles.
  await expect.poll(async () => (await state(page)).masks.length).toBe(1);
  await expect(page.locator('.flag')).toHaveCount(0);
  expect(await meters(page)).toBe(film);
  await arrange(page);
  expect(await meters(page)).toBeLessThanOrEqual(film);
});

test('Arrange selection moves only the selected designs', async ({ page }) => {
  await ells(page, 4);
  await page.keyboard.press('Control+a');
  const all = await designs(page);
  // Deselect the design at the top of the sheet (the last row: the list shows the front first)
  // by Shift+clicking its row, then arrange the three below it.
  await page
    .locator('.design-item')
    .last()
    .click({ modifiers: ['Shift'] });
  expect((await state(page)).selection).not.toContain(all[0]?.id);
  expect((await state(page)).selection).toHaveLength(3);
  const done = page.locator('.toast', { hasText: 'Arranged' });
  await page.getByRole('button', { name: 'Arrange selection' }).click();
  await expect(done).toHaveCount(1);
  const after = await designs(page);
  expect(after.find((d) => d.id === all[0]?.id)).toEqual(all[0]);
  expect(after).not.toEqual(all);
  await expect(page.locator('.flag')).toHaveCount(0);
});

test('a second Arrange click while one runs says so instead of doing nothing', async ({ page }) => {
  await ells(page, 14);
  // Two clicks in a row, before the progress dialog (after 300 ms) covers the button.
  await page.evaluate(() => {
    const button = document.getElementById('arrange') as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(page.locator('.toast', { hasText: 'Arrange is already running.' })).toBeVisible();
  await page.locator('#arrange-stop').click();
  await expect(page.locator('#arrange-dialog')).toBeHidden();
});

test('Escape stops Arrange and keeps the best layout so far', async ({ page }) => {
  await ells(page, 14);
  const before = await meters(page);
  await page.click('#arrange');
  await expect(page.locator('#arrange-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#arrange-dialog')).toBeHidden();
  await expect(page.locator('.toast', { hasText: /Arrange|Arranged/ }).first()).toBeVisible();
  expect(await meters(page)).toBeLessThanOrEqual(before);
});
