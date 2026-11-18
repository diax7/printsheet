/**
 * The PC editor's floating action bar, its menus and the new shortcuts (Space + drag, Alt + drag,
 * "?"), at 1440 × 900. Results are read from the model through `window.__printsheet`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
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
import { footprint, type Box } from '@/model/geometry';
import { pageOf } from '@/model/pages';
import type { Design } from '@/model/types';

async function toClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([px, py]) =>
      (
        window as unknown as {
          __printsheet: { toClient(a: number, b: number): { x: number; y: number } };
        }
      ).__printsheet.toClient(px ?? 0, py ?? 0),
    [x, y],
  );
}

/** The design's footprint on the page, in client pixels. */
async function screenBox(page: Page, d: Design): Promise<Box> {
  const box = footprint(d);
  const a = await toClient(page, box.minX, box.minY);
  const b = await toClient(page, box.maxX, box.maxY);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

async function only(page: Page): Promise<Design> {
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  return d;
}

/** Scroll the sheet's box and wait until the canvas has followed (scroll events come later). */
async function scrollSheet(page: Page, scroll: { top?: number; left?: number }): Promise<void> {
  await page.locator('#scroller').evaluate(async (el, to) => {
    if (to.top !== undefined) el.scrollTop = to.top;
    if (to.left !== undefined) el.scrollLeft = to.left;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, scroll);
}

const bar = (page: Page): Locator => page.locator('#action-bar');
const barButton = (page: Page, name: string): Locator =>
  bar(page).getByRole('button', { name, exact: true });
const menuItem = (page: Page, name: string): Locator =>
  page.getByRole('menu').getByRole('menuitem', { name, exact: true });

async function barBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await bar(page).boundingBox();
  if (!box) throw new Error('the bar is not shown');
  return box;
}

/** The designs from left to right on the sheet. */
const byLeft = (list: Design[]): Design[] =>
  list.toSorted((a, b) => footprint(a).minX - footprint(b).minX);

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('the bar appears below a selected design, centred, without taking focus', async ({ page }) => {
  await expect(bar(page)).toBeHidden();
  await addImages(page, ['f-shape.png']);
  await expect(bar(page)).toBeVisible();
  // Away from the sheet's left edge, where the bar would be held inside the view.
  await page
    .locator('#inspector')
    .getByRole('button', { name: 'Centre horizontally on the sheet' })
    .click();
  const d = await only(page);
  const design = await screenBox(page, d);
  const box = await barBox(page);
  expect(box.y).toBeGreaterThan(design.maxY);
  expect(box.y).toBeLessThan(design.maxY + 40);
  expect(box.x + box.width / 2).toBeCloseTo((design.minX + design.maxX) / 2, -1);
  await expect(bar(page).getByRole('button')).toHaveText([
    'Duplicate',
    'Delete',
    'Lock',
    'Rotate 90°',
    'Flip',
    'More',
  ]);
  expect(await page.evaluate(() => document.activeElement?.closest('#action-bar'))).toBeNull();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
});

/**
 * One design, scrolled so it ends 20 px above the bottom of the visible sheet, where the bar has
 * no room below it. Returns the design's box on the page.
 */
async function designAtTheBottom(page: Page): Promise<Box> {
  await addImages(page, ['f-shape.png']);
  // At 100% the sheet is long enough on screen to put the design at the bottom of the view.
  await page.click('#zoom-value');
  await scrollSheet(page, { left: 0, top: 0 });
  await page.locator('#scroller').focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowDown');
  const scroller = page.locator('#scroller');
  const view = await scroller.boundingBox();
  if (!view) throw new Error('no scroller');
  const before = await screenBox(page, await only(page));
  const clientHeight = await scroller.evaluate((el) => el.clientHeight);
  const scrollTop = await scroller.evaluate((el) => el.scrollTop);
  await scrollSheet(page, { top: scrollTop + before.maxY - (view.y + clientHeight - 20) });
  const design = await screenBox(page, await only(page));
  expect(design.maxY).toBeCloseTo(view.y + clientHeight - 20, 0);
  return design;
}

test('near the bottom of the view the bar flips above, clear of the size label', async ({
  page,
}) => {
  const design = await designAtTheBottom(page);
  await expect
    .poll(async () => (await barBox(page)).y + (await barBox(page)).height)
    .toBeLessThanOrEqual(design.minY - 72 + 0.5);
  await expect(bar(page)).toHaveAttribute('data-side', 'above');
});

test('with the bar flipped above, More opens upward and leaves the design in sight', async ({
  page,
}) => {
  const design = await designAtTheBottom(page);
  await expect(bar(page)).toHaveAttribute('data-side', 'above');
  await barButton(page, 'More').click();
  const menu = await page.getByRole('menu').boundingBox();
  if (!menu) throw new Error('no menu');
  // The menu ends above the design: nothing of it covers the selection.
  expect(menu.y + menu.height).toBeLessThanOrEqual(design.minY);
  expect(menu.y + menu.height).toBeLessThanOrEqual((await barBox(page)).y);
});

test('the bar hides while dragging and when the design is scrolled out of view', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const d = await only(page);
  const start = await toClient(page, d.xMm, d.yMm);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 30, { steps: 5 });
  await expect(bar(page)).toBeHidden();
  await page.mouse.up();
  await expect(bar(page)).toBeVisible();
  await page.click('#zoom-value');
  await scrollSheet(page, { top: 1e6 });
  const moved = await screenBox(page, await only(page));
  const view = await page.locator('#scroller').boundingBox();
  expect(moved.maxY).toBeLessThan(view?.y ?? 0);
  await expect(bar(page)).toBeHidden();
});

test('the wheel over the bar scrolls the sheet, and Ctrl+wheel zooms it', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.click('#zoom-value');
  await scrollSheet(page, { left: 0, top: 0 });
  const box = await barBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.locator('#scroller').evaluate((el) => el.scrollTop)).toBe(120);
  const box2 = await barBox(page);
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect(page.locator('#zoom-value')).not.toHaveText('100%');
});

test('each button of the one-design bar does what it says, one undo step each', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const original = await only(page);

  await barButton(page, 'Rotate 90°').click();
  expect((await only(page)).angleDeg).toBe(90);
  await barButton(page, 'Flip').click();
  expect((await only(page)).flipX).toBe(true);
  await page.keyboard.press('Control+z');
  expect((await only(page)).flipX).toBe(false);
  expect((await only(page)).angleDeg).toBe(90);

  await barButton(page, 'Lock').click();
  expect((await only(page)).locked).toBe(true);
  for (const name of ['Delete', 'Rotate 90°', 'Flip'])
    await expect(barButton(page, name)).toBeDisabled();
  await barButton(page, 'Unlock').click();
  expect((await only(page)).locked).toBe(false);

  await barButton(page, 'Duplicate').click();
  const all = await designs(page);
  expect(all).toHaveLength(2);
  expect((await state(page)).selection).toEqual([all[1]?.id]);
  await barButton(page, 'Delete').click();
  expect((await designs(page)).map((d) => d.id)).toEqual([original.id]);
});

test('More: flip vertically, layer order and add copies', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');
  await selectInList(page, 'f-shape');
  const order = async (): Promise<string[]> => (await designs(page)).map((d) => d.id);

  await barButton(page, 'More').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await menuItem(page, 'Flip vertically').click();
  await expect(page.getByRole('menu')).toBeHidden();
  expect((await designs(page)).find((d) => d.id === a.id)?.flipY).toBe(true);

  const steps: Array<[string, string[]]> = [
    ['Bring forward', [b.id, a.id]],
    ['Send backward', [a.id, b.id]],
    ['Bring to front', [b.id, a.id]],
    ['Send to back', [a.id, b.id]],
  ];
  for (const [name, expected] of steps) {
    await barButton(page, 'More').click();
    await menuItem(page, name).click();
    expect(await order()).toEqual(expected);
  }

  await barButton(page, 'More').click();
  await menuItem(page, 'Add copies…').click();
  const dialog = page.locator('#copies-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#copies-count').fill('3');
  await dialog.getByRole('button', { name: 'Add copies' }).click();
  await expect(dialog).toBeHidden();
  expect(await designs(page)).toHaveLength(5);
});

test('More offers to move a design past the edge back onto the sheet', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'More').click();
  await expect(menuItem(page, 'Move onto the sheet')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await typeField(page, '#insp-width', '70');
  await barButton(page, 'More').click();
  await menuItem(page, 'Move onto the sheet').click();
  const box = footprint(await only(page));
  expect(box.maxX).toBeLessThanOrEqual(580 + 0.01);
  expect(box.minX).toBeGreaterThanOrEqual(-0.01);
});

test('More offers to move a design across a split onto a sheet', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.locator('[data-layout="split"]').click();
  await typeField(page, '#page-length', '10');
  await page.locator('#scroller').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowDown');
  const settings = (await state(page)).sheet.settings;
  expect(pageOf(await only(page), settings)).toBeNull();
  await barButton(page, 'More').click();
  await menuItem(page, 'Move onto a sheet').click();
  expect(pageOf(await only(page), settings)).not.toBeNull();
});

test('several selected: Lock all, Align, Duplicate, Delete and Arrange selection', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Control+a');
  await expect(bar(page).getByRole('button')).toHaveText([
    'Duplicate',
    'Delete',
    'Lock all',
    'Align',
    'More',
  ]);
  await barButton(page, 'Align').click();
  await menuItem(page, 'Align right').click();
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');
  expect(footprint(a).maxX).toBeCloseTo(footprint(b).maxX, 6);
  await barButton(page, 'Align').click();
  await expect(menuItem(page, 'Distribute horizontally')).toBeDisabled();
  await page.keyboard.press('Escape');

  await barButton(page, 'Lock all').click();
  expect((await designs(page)).every((d) => d.locked)).toBe(true);
  await barButton(page, 'Unlock all').click();
  expect((await designs(page)).some((d) => d.locked)).toBe(false);

  await barButton(page, 'Duplicate').click();
  expect(await designs(page)).toHaveLength(4);
  await barButton(page, 'Delete').click();
  expect(await designs(page)).toHaveLength(2);

  await page.keyboard.press('Control+a');
  await arrange(page, async () => {
    await barButton(page, 'More').click();
    await menuItem(page, 'Arrange selection').click();
  });
});

test('Align menu: Distribute spaces three designs evenly', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png', 'ell.png']);
  const middle = byLeft(await designs(page))[1];
  if (!middle) throw new Error('missing designs');
  // Make the gaps unequal first.
  await selectInList(page, middle.name);
  await page.locator('#scroller').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+a');
  await barButton(page, 'Align').click();
  await expect(menuItem(page, 'Distribute horizontally')).not.toHaveAttribute('title');
  await menuItem(page, 'Distribute horizontally').click();
  const [a, b, c] = byLeft(await designs(page)).map(footprint);
  if (!a || !b || !c) throw new Error('missing designs');
  expect(b.minX - a.maxX).toBeCloseTo(c.minX - b.maxX, 6);
  expect((await designs(page)).find((d) => d.id === middle.id)?.xMm).not.toBeCloseTo(
    middle.xMm + 3,
    6,
  );
});

test('right-click on a design selects it and opens More; elsewhere the browser keeps it', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Escape');
  const [a] = await designs(page);
  if (!a) throw new Error('no design');
  await page.evaluate(() =>
    window.addEventListener('contextmenu', (e) => {
      (window as unknown as { lastMenuPrevented: boolean }).lastMenuPrevented = e.defaultPrevented;
    }),
  );
  const prevented = (): Promise<boolean> =>
    page.evaluate(() => (window as unknown as { lastMenuPrevented: boolean }).lastMenuPrevented);

  const point = await toClient(page, a.xMm, a.yMm);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await prevented()).toBe(true);
  expect((await state(page)).selection).toEqual([a.id]);
  await menuItem(page, 'Bring to front').click();
  expect((await designs(page)).at(-1)?.id).toBe(a.id);

  const empty = await toClient(page, 400, 200);
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  expect(await prevented()).toBe(false);
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('keyboard: Alt+F10 and Tab reach the bar, arrows move along it, Escape comes back', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const before = await only(page);
  await page.keyboard.press('Alt+F10');
  await expect(barButton(page, 'Duplicate')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(barButton(page, 'Delete')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(barButton(page, 'More')).toBeFocused();
  // The arrows moved focus along the bar, not the design.
  expect(await only(page)).toEqual(before);
  await expect(bar(page).locator('[tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(menuItem(page, 'Flip vertically')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menuItem(page, 'Bring forward')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(barButton(page, 'More')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scroller')).toBeFocused();
  expect((await state(page)).selection).toEqual([before.id]);

  // Tab from the sheet goes to the bar, onto the button used last.
  await page.keyboard.press('Tab');
  await expect(barButton(page, 'More')).toBeFocused();
});

test('Space + drag pans the sheet without selecting or moving anything', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) await page.click('#zoom-in');
  const scroller = page.locator('#scroller');
  await scrollSheet(page, { left: 0, top: 0 });
  const before = await designs(page);
  const [a] = before;
  if (!a) throw new Error('no design');
  const start = await toClient(page, a.xMm, a.yMm);
  // A zoom button had focus; a click on the sheet takes it, so Space pans instead of zooming.
  await page.mouse.click(start.x, start.y);
  expect((await state(page)).selection).toEqual([a.id]);
  const zoom = await page.locator('#zoom-value').textContent();
  await page.keyboard.down('Space');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 100, start.y - 10, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeCloseTo(100, -1);
  expect(await designs(page)).toEqual(before);
  expect((await state(page)).selection).toEqual([a.id]);
  await expect(page.locator('#zoom-value')).toHaveText(zoom ?? '');
});

test('Alt + drag leaves a copy in place and moves the design; one undo takes both back', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const before = await designs(page);
  const d = before[0];
  if (!d) throw new Error('no design');
  const start = await toClient(page, d.xMm, d.yMm);
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 10, { steps: 6 });
  await page.mouse.move(start.x + 120, start.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const after = await designs(page);
  expect(after).toHaveLength(2);
  const moved = after.find((x) => x.id === d.id);
  const copy = after.find((x) => x.id !== d.id);
  expect(moved?.xMm).toBeGreaterThan(d.xMm + 20);
  expect(copy).toMatchObject({ xMm: d.xMm, yMm: d.yMm, widthMm: d.widthMm, locked: false });
  expect((await state(page)).selection).toEqual([d.id]);
  await page.keyboard.press('Control+z');
  expect(await designs(page)).toEqual(before);
});

test('after an Alt + drag copy, the next Alt release stays with the page, once', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  // Windows Chrome moves focus to its own menu when Alt is let go and the page does not keep it.
  await page.evaluate(() => {
    const seen: boolean[] = [];
    Object.assign(window, { altReleases: seen });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') seen.push(e.defaultPrevented);
    });
  });
  const d = await only(page);
  const start = await toClient(page, d.xMm, d.yMm);
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await designs(page)).length).toBe(2);
  await page.keyboard.press('Alt');
  const releases = await page.evaluate(
    () => (window as unknown as { altReleases: boolean[] }).altReleases,
  );
  expect(releases).toEqual([true, false]);
});

test('Alt on a corner handle still scales from the centre, without a copy', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const d = await only(page);
  const box = footprint(d);
  const corner = await toClient(page, box.maxX, box.maxY);
  await page.keyboard.down('Alt');
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 20, corner.y + 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const after = await designs(page);
  expect(after).toHaveLength(1);
  expect(after[0]?.widthMm).toBeGreaterThan(d.widthMm * 1.2);
  expect(after[0]?.xMm).toBeCloseTo(d.xMm, 0);
  expect(after[0]?.yMm).toBeCloseTo(d.yMm, 0);
});

test('"?" opens the shortcuts list, but not while typing', async ({ page }) => {
  await expect(page.locator('#inspector .kbd-list')).toHaveCount(0);
  await page.keyboard.press('?');
  const dialog = page.locator('#shortcuts-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Space+drag');
  await expect(dialog).toContainText('Ctrl+Y');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.locator('#show-shortcuts').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await addImages(page, ['f-shape.png']);
  await page.locator('#insp-name').fill('');
  await page.locator('#insp-name').pressSequentially('What?');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#insp-name')).toHaveValue('What?');
});

test.describe('at 1000 px wide', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('New, Open and Save move into a File menu instead of disappearing', async ({ page }) => {
    await expect(page.locator('#new-sheet')).toBeHidden();
    await page.click('#file-menu');
    await expect(page.locator('#file-menu')).toHaveAttribute('aria-expanded', 'true');
    for (const id of ['#new-sheet', '#open-project', '#save-project'])
      await expect(page.locator(id)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#save-project')).toBeHidden();
    await expect(page.locator('#file-menu')).toBeFocused();
    await page.click('#file-menu');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#open-project'),
    ]);
    expect(chooser.isMultiple()).toBe(false);
    await expect(page.locator('#open-project')).toBeHidden();
  });

  test('the bar still fits beside the panels', async ({ page }) => {
    await addImages(page, ['f-shape.png']);
    const box = await barBox(page);
    const view = await page.locator('#scroller').boundingBox();
    if (!view) throw new Error('no scroller');
    expect(box.x).toBeGreaterThanOrEqual(view.x);
    expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width);
  });
});

test('at 1440 px the file buttons sit in the bar and the film length is in sight', async ({
  page,
}) => {
  await expect(page.locator('#file-menu')).toBeHidden();
  await expect(page.locator('#new-sheet')).toBeVisible();
  await addImages(page, ['f-shape.png']);
  await expect(page.locator('#top-film-meters')).toHaveText(
    (await page.locator('#film-meters').textContent()) ?? '',
  );
});

test('every top-bar control stays in reach from 821 to 1440 px wide', async ({ page }) => {
  for (const width of [1440, 1261, 1260, 1101, 1100, 1000, 900, 821]) {
    await page.setViewportSize({ width, height: 800 });
    const clipped = await page
      .locator('.topbar .toolbar')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clipped, `${width} px`).toBeLessThanOrEqual(0);
    await expect(page.locator('#export'), `${width} px`).toBeInViewport({ ratio: 1 });
  }
});

test.describe('with a touch screen in the PC layout', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true });

  test('the bar and its menu get 44 px targets', async ({ page }) => {
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, 'this browser does not report a coarse pointer for touch emulation');
    await addImages(page, ['f-shape.png']);
    const button = await barButton(page, 'Duplicate').boundingBox();
    expect(button?.height).toBeGreaterThanOrEqual(44);
    await barButton(page, 'More').click();
    const item = await menuItem(page, 'Flip vertically').boundingBox();
    expect(item?.height).toBeGreaterThanOrEqual(44);
  });
});
