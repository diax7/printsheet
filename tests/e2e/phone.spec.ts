/**
 * On a phone the sheet fills the screen between the top and bottom bars. A finger swipe must
 * scroll it, or only the first screenful of a long sheet can ever be seen (reported on an iPhone,
 * 2026-11-18); the page itself must never jump.
 */
import { expect, test, type Page } from '@playwright/test';
import { addImages, arrange, collectErrors, designs, openApp, state, typeField } from './helpers';

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

/** A one-finger swipe upwards from (x, y), the way you scroll down a page. */
async function swipeUp(page: Page, x: number, y: number, distance: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const point = (dy: number): Array<{ x: number; y: number }> => [{ x, y: y - dy }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0) });
  for (let step = 1; step <= 10; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point((distance * step) / 10),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('a finger swipe on the canvas scrolls a long sheet on a phone', async ({ page }) => {
  // A sheet about two metres long: big designs, two to a row.
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Size').click();
  await typeField(page, '#insp-width', '25');
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+d');
  }
  await expect.poll(async () => (await designs(page)).length).toBe(8);
  await page.keyboard.press('Escape');
  await arrange(page, () => barButton(page, 'Arrange').click());
  await expect
    .poll(async () => Number(await page.locator('#film-meters').textContent()))
    .toBeGreaterThan(1.5);
  await page.keyboard.press('Escape');

  const scroller = page.locator('#scroller');
  await scroller.scrollIntoViewIfNeeded();
  const box = await scroller.boundingBox();
  if (!box) throw new Error('The canvas area is not on screen');
  const before = await scroller.evaluate((el) => el.scrollTop);
  // Start on the mat beside the sheet, where no design is.
  await swipeUp(page, box.x + 20, box.y + box.height * 0.8, box.height * 0.5);
  // The sheet's own scroll area moves, not just the page around it.
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 50);
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

test('the canvas lets a finger scroll but not pinch-zoom the page', async ({ page }) => {
  // Until the gestures of phase 3, one finger scrolls the sheet; the page itself must not zoom.
  const actions = await page.evaluate(() =>
    ['.upper-canvas', '.lower-canvas'].map((selector) => {
      const canvas = document.querySelector(selector);
      return canvas ? getComputedStyle(canvas).touchAction : 'missing';
    }),
  );
  expect(actions).toEqual(['pan-x pan-y', 'pan-x pan-y']);
});
