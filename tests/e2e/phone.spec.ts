/**
 * On a phone the sheet fills the screen between the top and bottom bars, and the page itself must
 * never jump. Finger gestures on the sheet (panning to the end of a long sheet included) are in
 * touch.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { addImages, collectErrors, designs, openApp, state } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const barButton = (page: Page, name: string): ReturnType<Page['locator']> =>
  page.locator('#phone-bar').getByRole('button', { name, exact: true });

let errors: string[] = [];
test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch is sent through the Chromium DevTools protocol');
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('the zoom buttons can be reached on a phone, in More', async ({ page }) => {
  await barButton(page, 'More').click();
  for (const id of ['#zoom-out', '#zoom-in', '#zoom-fit']) {
    await expect(page.locator(id)).toBeInViewport();
  }
});

test('the canvas fills most of the phone screen, not a small window', async ({ page }) => {
  const height = await page
    .locator('#scroller')
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(844 * 0.8);
});

test('tapping a design keeps the page where it is (no jump to the list)', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    document.getElementById('scroller')?.scrollIntoView({ block: 'start' }),
  );
  const design = (await designs(page))[0];
  if (!design) throw new Error('no design');
  const point = await page.evaluate(
    ([x, y]) =>
      (
        window as unknown as {
          __printsheet: { toClient(x: number, y: number): { x: number; y: number } };
        }
      ).__printsheet.toClient(x, y),
    [design.xMm, design.yMm] as const,
  );
  const before = await page.evaluate(() => window.scrollY);
  await page.touchscreen.tap(point.x, point.y);
  await expect.poll(async () => (await state(page)).selection).toEqual([design.id]);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('the "Nothing selected" help and shortcuts are not shown on a phone', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).selection).toEqual([]);
  await expect(page.locator('#inspector')).toBeHidden();
  // A selected design still gets its size controls, in the Size sheet.
  await barButton(page, 'Designs').click();
  await page.locator('.design-item').first().click();
  await barButton(page, 'Size').click();
  await expect(page.locator('#insp-width')).toBeVisible();
});

test('Escape in the right-click menu gives focus back to the sheet, as the bar is hidden', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const d = (await designs(page))[0];
  if (!d) throw new Error('no design');
  await page.evaluate(() =>
    document.getElementById('scroller')?.scrollIntoView({ block: 'start' }),
  );
  const point = await page.evaluate(
    ([x, y]) =>
      (
        window as unknown as {
          __printsheet: { toClient(x: number, y: number): { x: number; y: number } };
        }
      ).__printsheet.toClient(x, y),
    [d.xMm, d.yMm] as const,
  );
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('#scroller')).toBeFocused();
});

test('the canvas keeps every finger to itself, so a pinch zooms the sheet, not the page', async ({
  page,
}) => {
  const actions = await page.evaluate(() =>
    ['.upper-canvas', '.lower-canvas'].map((selector) => {
      const canvas = document.querySelector(selector);
      return canvas ? getComputedStyle(canvas).touchAction : 'missing';
    }),
  );
  expect(actions).toEqual(['none', 'none']);
});
