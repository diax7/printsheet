/**
 * The phone shell (390 × 844, touch): one screen with a top bar, the sheet, and a bottom bar whose
 * buttons follow the selection; panels open as bottom sheets that hold the very same controls as
 * on a computer, moved there, never copied.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addImages, collectErrors, designs, openApp, state, typeField } from './helpers';
import { footprint } from '@/model/geometry';
import type { Design } from '@/model/types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let errors: string[] = [];
test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch is sent through the Chromium DevTools protocol');
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

const bottomBar = (page: Page): Locator => page.locator('#phone-bar');
const barButton = (page: Page, name: string): Locator =>
  bottomBar(page).getByRole('button', { name, exact: true });
const sheet = (page: Page, name: string): Locator =>
  page.getByRole('dialog', { name, exact: true });

/** A finger tap on the middle of a design. */
async function tapDesign(page: Page, d: Design): Promise<void> {
  const point = await page.evaluate(
    ([x, y]) =>
      (
        window as unknown as {
          __printsheet: { toClient(a: number, b: number): { x: number; y: number } };
        }
      ).__printsheet.toClient(x ?? 0, y ?? 0),
    [d.xMm, d.yMm],
  );
  await page.touchscreen.tap(point.x, point.y);
  await expect.poll(async () => (await state(page)).selection).toEqual([d.id]);
}

async function barNames(page: Page): Promise<string[]> {
  return bottomBar(page)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''));
}

/** The design's box on the page, in client pixels. */
async function onScreen(page: Page, d: Design): Promise<{ top: number; bottom: number }> {
  const box = footprint(d);
  return page.evaluate(
    ([x, top, bottom]) => {
      const hook = (
        window as unknown as {
          __printsheet: { toClient(a: number, b: number): { x: number; y: number } };
        }
      ).__printsheet;
      return {
        top: hook.toClient(x ?? 0, top ?? 0).y,
        bottom: hook.toClient(x ?? 0, bottom ?? 0).y,
      };
    },
    [box.minX, box.minY, box.maxY],
  );
}

test('one screen: the page never scrolls, the bars sit at the top and bottom', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  const size = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollHeight ?? 0,
    height: innerHeight,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.height);
  // Top bar: logo, film metres, Undo, Redo, Export, all on one row.
  const middles = await Promise.all(
    ['.brand', '#top-film-meters', '#undo', '#redo', '#export'].map(async (selector) => {
      const box = await page.locator(selector).boundingBox();
      return box ? box.y + box.height / 2 : NaN;
    }),
  );
  for (const middle of middles) expect(middle).toBeCloseTo(middles[0] ?? NaN, -1);
  const bar = await bottomBar(page).boundingBox();
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeCloseTo(844, 0);
  await expect(page.locator('.statusbar')).toBeHidden();
  await expect(page.locator('#action-bar')).toBeHidden();
});

test('the bottom bar follows the selection: nothing, one design, several', async ({ page }) => {
  expect(await barNames(page)).toEqual(['Add', 'Designs', 'Arrange', 'Sheet', 'More']);
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Escape');
  const [a] = await designs(page);
  if (!a) throw new Error('no design');
  await tapDesign(page, a);
  await expect
    .poll(() => barNames(page))
    .toEqual(['Duplicate', 'Delete', 'Lock', 'Rotate', 'Size', 'More', 'Deselect']);
  await page.keyboard.press('Control+a');
  await expect
    .poll(() => barNames(page))
    .toEqual(['Duplicate', 'Delete', 'Lock all', 'Align', 'More', 'Deselect']);
  await barButton(page, 'Deselect').click();
  expect((await state(page)).selection).toEqual([]);
  expect(await barNames(page)).toEqual(['Add', 'Designs', 'Arrange', 'Sheet', 'More']);
});

test('every sheet opens with focus on its heading and gives focus back on close', async ({
  page,
}) => {
  for (const name of ['Designs', 'Sheet', 'More']) {
    await barButton(page, name).click();
    const dialog = sheet(page, name);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'false');
    await expect(dialog.getByRole('heading', { name, exact: true })).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(barButton(page, name)).toBeFocused();
  }
  // The close button and the bar button both close it too.
  await barButton(page, 'Sheet').click();
  await sheet(page, 'Sheet').getByRole('button', { name: 'Close' }).click();
  await expect(sheet(page, 'Sheet')).toBeHidden();
  await barButton(page, 'Designs').click();
  await barButton(page, 'Designs').click();
  await expect(sheet(page, 'Designs')).toBeHidden();
  // A sheet is at most about half the screen.
  await barButton(page, 'More').click();
  expect((await sheet(page, 'More').boundingBox())?.height).toBeLessThanOrEqual(844 * 0.55);
});

test('a swipe down on the handle closes a sheet', async ({ page }) => {
  await barButton(page, 'Sheet').click();
  const handle = sheet(page, 'Sheet').locator('.sheet-handle');
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + step * 25 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(sheet(page, 'Sheet')).toBeHidden();
});

test('Size follows a tap on another design and closes on a tap on empty canvas', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Escape');
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');
  await tapDesign(page, a);
  await barButton(page, 'Size').click();
  const sizeSheet = sheet(page, 'Size');
  await expect(sizeSheet).toBeVisible();
  // The size fields are in sight at once, without scrolling the sheet.
  await expect(page.locator('#insp-width')).toBeInViewport();
  await tapDesign(page, b);
  await expect(sizeSheet).toBeVisible();
  await expect(page.locator('#insp-name')).toHaveValue(b.name);
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  await page.touchscreen.tap(stage.x + 8, stage.y + 8);
  await expect.poll(async () => (await state(page)).selection).toEqual([]);
  await expect(sizeSheet).toBeHidden();
});

test('opening a sheet over the chosen design scrolls the design above it', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const [a] = await designs(page);
  if (!a) throw new Error('no design');
  await barButton(page, 'Size').click();
  const sheetTop = (await sheet(page, 'Size').boundingBox())?.y ?? 0;
  await page.keyboard.press('Escape');
  // Move the design down (a short sheet) until the open sheet would cover it.
  await page.locator('#scroller').focus();
  for (let i = 0; i < 200; i++) {
    const d = (await designs(page))[0];
    if (d && (await onScreen(page, d)).bottom > sheetTop + 20) break;
    await page.keyboard.press('Shift+ArrowDown');
  }
  await barButton(page, 'Size').click();
  await expect
    .poll(async () => {
      const d = (await designs(page))[0];
      return d ? (await onScreen(page, d)).bottom : Infinity;
    })
    .toBeLessThanOrEqual(sheetTop);
});

test('closing the last sheet takes its scroll room away without the view going stale', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Size').click();
  const sheetTop = (await sheet(page, 'Size').boundingBox())?.y ?? 0;
  await sheet(page, 'Size').getByRole('button', { name: 'Close' }).click();
  await page.locator('#scroller').focus();
  for (let i = 0; i < 200; i++) {
    const d = (await designs(page))[0];
    if (d && (await onScreen(page, d)).bottom > sheetTop + 20) break;
    await page.keyboard.press('Shift+ArrowDown');
  }
  // Opening Size scrolls into the extra room; closing it must bring the view back with it.
  await barButton(page, 'Size').click();
  await expect
    .poll(() => page.locator('#scroller').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  // Close and measure in the same task, before any scroll event: the canvas must already follow,
  // so a touch that lands before the next frame is measured against the right place.
  const view = await page.locator('#scroller').evaluate((el) => {
    const close = document.querySelector<HTMLElement>('#sheet-size button[aria-label="Close"]');
    close?.click();
    const hook = (
      window as unknown as {
        __printsheet: { toClient(a: number, b: number): { x: number; y: number } };
      }
    ).__printsheet;
    const canvasTop = document.getElementById('sheet-canvas')?.getBoundingClientRect().top ?? 0;
    return {
      closed: Boolean(close),
      inside: el.scrollTop <= el.scrollHeight - el.clientHeight,
      drawnAt: hook.toClient(0, 0).y - canvasTop,
      expected: 48 - el.scrollTop,
    };
  });
  expect(view.closed).toBe(true);
  expect(view.inside).toBe(true);
  // The canvas follows the scroll: the sheet's top edge is drawn 48 px below the content's top.
  expect(view.drawnAt).toBeCloseTo(view.expected, 0);
});

test('the controls move into the sheets and back, in their places, never copied', async ({
  page,
}) => {
  const layout = (): Promise<string[]> =>
    page.evaluate(() =>
      [
        '#inspector',
        '.film',
        'section[aria-labelledby="sheet-heading"]',
        '.designs',
        '#file-actions',
        '#save-status',
        '#busy',
        '#zoom-out',
        '#zoom-value',
        '#zoom-in',
        '#zoom-fit',
        '.bg-picker',
        '#grid-toggle',
        '#about',
      ].map((selector) => {
        const found = document.querySelectorAll(selector);
        const node = found[0];
        const parent = node?.parentElement;
        const index = parent ? [...parent.children].indexOf(node as Element) : -1;
        return `${selector} x${found.length} in ${parent?.className ?? '?'}[${index}]`;
      }),
    );
  // The layout follows a media query whose change event comes at the next frame: wait for the
  // computer layout to be in place before recording it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(bottomBar(page).getByRole('button')).toHaveCount(0);
  const pc = await layout();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(layout).not.toEqual(pc);
  for (const entry of await layout()) expect(entry).toContain(' x1 ');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(layout).toEqual(pc);
  await expect(bottomBar(page).getByRole('button')).toHaveCount(0);

  // While a field has focus nothing moves; it moves once the field is left.
  await page.locator('#sheet-width').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  // Two frames after the query matches, its change event has surely been handled.
  await page.evaluate(async () => {
    while (!matchMedia('(max-width: 820px)').matches) {
      await new Promise((done) => requestAnimationFrame(done));
    }
    for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done));
  });
  await expect(page.locator('#sheet-width')).toBeFocused();
  expect(await layout()).toEqual(pc);
  await page.locator('#sheet-width').blur();
  await expect.poll(layout).not.toEqual(pc);
});

test('typing a size in the Size sheet changes the design', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Size').click();
  await typeField(page, '#insp-width', '12');
  expect((await designs(page))[0]?.widthMm).toBeCloseTo(120, 6);
});

test('the Designs sheet builds a multi-selection with row checkboxes and Select all', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png', 'ell.png']);
  await page.keyboard.press('Escape');
  const ids = (await designs(page)).map((d) => d.id);
  const names = (await designs(page)).map((d) => d.name);
  await barButton(page, 'Designs').click();
  const box = (name: string): Locator =>
    sheet(page, 'Designs').getByRole('checkbox', { name: `Select ${name}`, exact: true });
  await box(names[0] ?? '').click();
  expect((await state(page)).selection).toEqual([ids[0]]);
  // A second tick adds to the selection instead of replacing it.
  await box(names[1] ?? '').click();
  expect((await state(page)).selection).toEqual([ids[0], ids[1]]);
  await expect.poll(() => barNames(page)).toContain('Lock all');
  await box(names[0] ?? '').click();
  expect((await state(page)).selection).toEqual([ids[1]]);
  // The keyboard ticks a box too, and focus stays on it.
  await box(names[2] ?? '').focus();
  await page.keyboard.press('Space');
  expect((await state(page)).selection).toEqual([ids[1], ids[2]]);
  await expect(box(names[2] ?? '')).toBeFocused();
  await sheet(page, 'Designs').getByRole('button', { name: 'Select all' }).click();
  expect((await state(page)).selection).toHaveLength(3);
  await sheet(page, 'Designs').getByRole('button', { name: 'Select none' }).click();
  expect((await state(page)).selection).toEqual([]);
  // A tap on a row (not its box) still chooses that one design.
  await sheet(page, 'Designs')
    .locator('.design-item', { hasText: names[1] ?? '' })
    .locator('.design-name')
    .click();
  expect((await state(page)).selection).toEqual([ids[1]]);
  // A computer shows no boxes.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('checkbox', { name: /^Select / })).toHaveCount(0);
});

test('an open sheet rises above the on-screen keyboard, and the page scrolls back after', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Size').click();
  const sizeSheet = sheet(page, 'Size');
  const bottom = async (): Promise<number> => {
    const box = await sizeSheet.boundingBox();
    return (box?.y ?? 0) + (box?.height ?? 0);
  };
  const resting = await bottom();
  await page.locator('#insp-width').focus();
  // The keyboard takes the lower 344 px: the visual viewport shrinks to 500 px.
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('no visual viewport');
    Object.defineProperty(viewport, 'height', { value: 500, configurable: true });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(bottom).toBeCloseTo(resting - 344, 0);
  // Leaving the field scrolls the page back to the top (iPhone Safari leaves it scrolled).
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    Object.assign(window, { scrollCalls: calls });
    window.scrollTo = ((...args: unknown[]) => calls.push(args)) as typeof window.scrollTo;
  });
  await page.locator('#insp-width').blur();
  expect(
    await page.evaluate(() => (window as unknown as { scrollCalls: unknown[][] }).scrollCalls),
  ).toEqual([[0, 0]]);
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    delete (viewport as unknown as { height?: number }).height;
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(bottom).toBeCloseTo(resting, 0);
});

/** Visible, and a tap would land on it (nothing covers it), without the page scrolling. */
async function reach(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.click({ trial: true });
  expect(await page.evaluate(() => scrollY)).toBe(0);
}

test('every PC control has a path on the phone (the action inventory)', async ({ page }) => {
  // Only phone paths: taps on the bars, sheets and menus; sheets and menus close with their
  // Close button or by tapping their bar button again.
  await addImages(page, ['f-shape.png', 'bordered.png', 'opaque.png']);
  await barButton(page, 'Deselect').click();
  const closeSheet = (name: string): Promise<void> =>
    sheet(page, name).getByRole('button', { name: 'Close' }).click();
  const menu = (name: string): Locator =>
    page.getByRole('menu').getByRole('menuitem', { name, exact: true });

  // Undo, Redo and Export: the top bar.
  await reach(page, page.locator('#undo'));
  await page.locator('#undo').click();
  await reach(page, page.locator('#redo'));
  await page.locator('#redo').click();
  await expect.poll(async () => (await designs(page)).length).toBe(3);
  await reach(page, page.locator('#export'));

  // Add images and Arrange (all): the bottom bar with nothing selected.
  await reach(page, barButton(page, 'Add'));
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    barButton(page, 'Add').click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await reach(page, barButton(page, 'Arrange'));

  // New, Open, Save, zoom, Fit, background, custom colour, grid: More.
  await barButton(page, 'More').click();
  for (const selector of [
    '#new-sheet',
    '#open-project',
    '#save-project',
    '#zoom-in',
    '#zoom-out',
    '#zoom-value',
    '#zoom-fit',
    '[data-bg="white"]',
    '.swatch-custom',
    '#grid-toggle',
    '#about',
  ])
    await reach(page, page.locator(selector));
  await closeSheet('More');

  // Width preset and its menu, width, gap, gap measured between, layout, length: Sheet.
  await barButton(page, 'Sheet').click();
  for (const selector of [
    '#preset',
    '#preset-menu',
    '#sheet-width',
    '#gap',
    '[data-spacing="shape"]',
    '[data-length="fixed"]',
    '[data-layout="split"]',
  ])
    await reach(page, page.locator(selector));
  await page.locator('[data-length="fixed"]').click();
  await reach(page, page.locator('#fixed-length'));
  await page.locator('[data-length="auto"]').click();
  await page.locator('[data-layout="split"]').click();
  await reach(page, page.locator('#page-length'));
  await reach(page, page.locator('[data-last-page="full"]'));
  await page.locator('[data-layout="single"]').click();
  await closeSheet('Sheet');

  // The design list, choosing, ticking several, Select all: Designs.
  await barButton(page, 'Designs').click();
  await reach(page, page.locator('.design-item').first());
  await reach(page, page.locator('.design-check').first());
  await reach(page, page.locator('#select-all'));
  await page.locator('.design-item', { hasText: 'opaque' }).locator('.design-name').click();
  await closeSheet('Designs');

  // One design: Duplicate, Delete, Lock, Rotate in the bar; flip, layer order, copies in More.
  for (const name of ['Duplicate', 'Delete', 'Lock', 'Rotate', 'Deselect'])
    await reach(page, barButton(page, name));
  await barButton(page, 'More').click();
  for (const name of [
    'Flip horizontally',
    'Flip vertically',
    'Bring forward',
    'Send backward',
    'Bring to front',
    'Send to back',
    'Add copies…',
  ])
    await reach(page, menu(name));
  await barButton(page, 'More').click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Size, keep proportions, angle, name, warnings, Move onto the sheet: Size.
  await barButton(page, 'Size').click();
  for (const selector of ['#insp-name', '#insp-width', '#insp-ratio', '#insp-angle', '.issues'])
    await reach(page, page.locator(selector));
  await typeField(page, '#insp-width', '70');
  await reach(page, page.getByRole('button', { name: 'Move onto the sheet' }));
  await closeSheet('Size');

  // Several, chosen with Select all in Designs: Align and Distribute; Arrange selection and
  // allow turning through More. Designs is in the bar while nothing is selected.
  await barButton(page, 'Deselect').click();
  await barButton(page, 'Designs').click();
  await page.locator('#select-all').click();
  await closeSheet('Designs');
  expect((await state(page)).selection).toHaveLength(3);
  for (const name of ['Duplicate', 'Delete', 'Lock all', 'Deselect'])
    await reach(page, barButton(page, name));
  await barButton(page, 'Align').click();
  for (const name of ['Align left', 'Centre vertically', 'Distribute horizontally'])
    await reach(page, menu(name));
  await barButton(page, 'Align').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await barButton(page, 'More').click();
  await reach(page, menu('Arrange selection'));
  await menu('Turning and Distribute…').click();
  await expect(sheet(page, 'Selected designs')).toBeVisible();
  await reach(page, page.getByRole('checkbox', { name: 'Allow quarter turns to save film' }));
  await reach(page, page.getByRole('button', { name: 'Distribute vertically' }));
});

test('row boxes, background swatches and the custom colour take a 44 px finger', async ({
  page,
}) => {
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  test.skip(!coarse, 'this browser does not report a coarse pointer for touch emulation');
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await barButton(page, 'Deselect').click();
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');

  await barButton(page, 'Designs').click();
  const hitArea = (name: string): Locator =>
    sheet(page, 'Designs').locator('.design-item', { hasText: name }).locator('.design-check-hit');
  for (const name of [a.name, b.name]) {
    const box = await hitArea(name).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  // A tap near a box, not on it, still ticks it, and keeps the designs already ticked.
  await sheet(page, 'Designs')
    .getByRole('checkbox', { name: `Select ${a.name}` })
    .click();
  const box = await hitArea(b.name).boundingBox();
  if (!box) throw new Error('no hit area');
  // A mouse click lands exactly on the label's edge (a touch tap there would be moved onto the
  // box itself by Chromium's touch adjustment, which hides the label path).
  await page.mouse.click(box.x + 4, box.y + 4);
  expect((await state(page)).selection).toEqual([a.id, b.id]);
  await sheet(page, 'Designs').getByRole('button', { name: 'Close' }).click();

  // More with nothing selected is the sheet with the view controls.
  await barButton(page, 'Deselect').click();
  await barButton(page, 'More').click();
  for (const selector of [
    '[data-bg="transparent"]',
    '[data-bg="white"]',
    '[data-bg="black"]',
    '.swatch-custom',
  ]) {
    const swatch = await sheet(page, 'More').locator(selector).boundingBox();
    expect(swatch?.width, selector).toBeGreaterThanOrEqual(44);
    expect(swatch?.height, selector).toBeGreaterThanOrEqual(44);
  }
});
