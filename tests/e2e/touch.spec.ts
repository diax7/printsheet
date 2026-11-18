/**
 * Finger gestures on the sheet (390 × 844, touch, sent through the Chromium DevTools protocol):
 * one finger pans, taps choose, long presses open the menu; two fingers pinch to zoom; a finger
 * on the chosen design or its handles moves, scales or rotates it.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
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

interface Spot {
  x: number;
  y: number;
}

const barButton = (page: Page, name: string): Locator =>
  page.locator('#phone-bar').getByRole('button', { name, exact: true });

async function toClient(page: Page, x: number, y: number): Promise<Spot> {
  return page.evaluate(
    ([px, py]) =>
      (
        window as unknown as { __printsheet: { toClient(a: number, b: number): Spot } }
      ).__printsheet.toClient(px ?? 0, py ?? 0),
    [x, y],
  );
}

/** The scene point (mm) under a page point. */
async function toScene(page: Page, at: Spot): Promise<Spot> {
  const origin = await toClient(page, 0, 0);
  const unit = await toClient(page, 1, 1);
  return { x: (at.x - origin.x) / (unit.x - origin.x), y: (at.y - origin.y) / (unit.y - origin.y) };
}

type TouchType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';

async function touch(cdp: CDPSession, type: TouchType, points: Spot[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

/** One finger from `from` to `to` in `steps` moves. */
async function drag(page: Page, from: Spot, to: Spot, steps = 10): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++)
    await touch(cdp, 'touchMove', [
      { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
    ]);
  await touch(cdp, 'touchEnd', []);
}

/** Scrolls the sheet to its top-left corner and waits for the canvas to follow. */
async function scrollHome(page: Page): Promise<void> {
  await page.locator('#scroller').evaluate(async (el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function scrollOf(page: Page): Promise<Spot> {
  return page.locator('#scroller').evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
}

async function zoomIn(page: Page, times: number): Promise<void> {
  await barButton(page, 'More').click();
  for (let i = 0; i < times; i++) await page.locator('#zoom-in').click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Close' }).click();
}

async function tapOn(page: Page, d: Design): Promise<void> {
  const at = await toClient(page, d.xMm, d.yMm);
  await page.touchscreen.tap(at.x, at.y);
}

/** A design made 25 cm wide, so it is big enough on screen to grab by its middle. */
async function oneBigDesign(page: Page): Promise<Design> {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Size').click();
  await typeField(page, '#insp-width', '25');
  await page.getByRole('dialog', { name: 'Size' }).getByRole('button', { name: 'Close' }).click();
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  return d;
}

test('one finger pans the sheet, on empty canvas and on a design that is not chosen', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await barButton(page, 'Deselect').click();
  // Close enough that the sheet scrolls both ways.
  await zoomIn(page, 8);
  const before = await designs(page);
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  // On the mat, away from every design, starting from the top-left corner of the sheet.
  await scrollHome(page);
  const start = await scrollOf(page);
  // Away from the messages at the bottom.
  const from = { x: stage.x + stage.width - 30, y: stage.y + stage.height * 0.55 };
  await drag(page, from, { x: from.x - 80, y: from.y - 200 });
  const panned = await scrollOf(page);
  expect(panned.y - start.y).toBeCloseTo(200, -1);
  expect(panned.x - start.x).toBeCloseTo(80, -1);
  // On a design that is not chosen: the view moves, the design does not, nothing is chosen.
  const d = before[1];
  if (!d) throw new Error('no design');
  await scrollHome(page);
  const on = await toClient(page, d.xMm, d.yMm);
  const scrollBefore = await scrollOf(page);
  await drag(page, on, { x: on.x - 10, y: on.y - 150 });
  expect((await scrollOf(page)).y - scrollBefore.y).toBeGreaterThan(100);
  expect(await designs(page)).toEqual(before);
  expect((await state(page)).selection).toEqual([]);
});

test('a finger reaches the end of a long sheet', async ({ page }) => {
  await oneBigDesign(page);
  for (let i = 0; i < 3; i++) {
    await barButton(page, 'Duplicate').click();
  }
  await barButton(page, 'Deselect').click();
  await zoomIn(page, 3);
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  const end = await page.locator('#scroller').evaluate((el) => el.scrollHeight - el.clientHeight);
  for (let i = 0; i < 20 && (await scrollOf(page)).y < end - 1; i++) {
    const from = { x: stage.x + 12, y: stage.y + stage.height - 40 };
    await drag(page, from, { x: from.x, y: stage.y + 40 }, 6);
  }
  expect((await scrollOf(page)).y).toBeGreaterThanOrEqual(end - 1);
});

test('a tap chooses a design, a tap on empty canvas lets go and leaves the fields', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await barButton(page, 'Deselect').click();
  const [a] = await designs(page);
  if (!a) throw new Error('no design');
  await tapOn(page, a);
  await expect.poll(async () => (await state(page)).selection).toEqual([a.id]);
  // Typing in the Size sheet, then a tap on the canvas: the field lets go of the keyboard.
  await barButton(page, 'Size').click();
  await page.locator('#insp-name').focus();
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  await page.touchscreen.tap(stage.x + stage.width - 12, stage.y + 12);
  await expect.poll(async () => (await state(page)).selection).toEqual([]);
  await expect(page.locator('#scroller')).toBeFocused();
});

test('a finger on the chosen design moves it, and one undo puts it back', async ({ page }) => {
  const d = await oneBigDesign(page);
  await tapOn(page, d);
  const from = await toClient(page, d.xMm, d.yMm);
  await drag(page, from, { x: from.x + 40, y: from.y + 60 });
  const [moved] = await designs(page);
  expect((moved?.xMm ?? 0) - d.xMm).toBeGreaterThan(20);
  expect((moved?.yMm ?? 0) - d.yMm).toBeGreaterThan(30);
  await page.locator('#undo').click();
  expect((await designs(page))[0]).toEqual(d);
});

test('a small design at fit zoom moves under a finger instead of scaling', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  const from = await toClient(page, d.xMm, d.yMm);
  await drag(page, from, { x: from.x + 30, y: from.y + 40 });
  const [moved] = await designs(page);
  expect(moved?.widthMm).toBeCloseTo(d.widthMm, 6);
  expect((moved?.xMm ?? 0) - d.xMm).toBeGreaterThan(20);
});

test('a finger on the rotate handle turns the design instead of panning', async ({ page }) => {
  const d = await oneBigDesign(page);
  await tapOn(page, d);
  const top = await toClient(page, d.xMm, footprint(d).minY);
  // Fabric draws the rotate handle 40 px above the middle of the top edge.
  const handle = { x: top.x, y: top.y - 40 };
  const scroll = await scrollOf(page);
  await drag(page, handle, { x: handle.x + 120, y: handle.y + 100 });
  const [turned] = await designs(page);
  expect(turned?.angleDeg).toBeGreaterThan(20);
  expect(await scrollOf(page)).toEqual(scroll);
});

test('two fingers pinch to zoom around their midpoint', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Deselect').click();
  await zoomIn(page, 2);
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  const mid = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
  const before = await toScene(page, mid);
  const zoom = await page.locator('#zoom-value').textContent();
  const cdp = await page.context().newCDPSession(page);
  const at = (gap: number): Spot[] => [
    { x: mid.x - gap, y: mid.y },
    { x: mid.x + gap, y: mid.y },
  ];
  await touch(cdp, 'touchStart', at(40).slice(0, 1));
  await touch(cdp, 'touchStart', at(40));
  for (let gap = 50; gap <= 120; gap += 10) await touch(cdp, 'touchMove', at(gap));
  await touch(cdp, 'touchEnd', at(120).slice(0, 1));
  await touch(cdp, 'touchEnd', []);
  const after = await toScene(page, mid);
  await expect(page.locator('#zoom-value')).not.toHaveText(zoom ?? '');
  expect(
    Number.parseInt((await page.locator('#zoom-value').textContent()) ?? '0', 10),
  ).toBeGreaterThan(Number.parseInt(zoom ?? '0', 10) * 2.5);
  // The spot under the fingers' midpoint stays under it (within a millimetre).
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
});

test('a pinch begun on the chosen design leaves it where it was and commits nothing', async ({
  page,
}) => {
  const d = await oneBigDesign(page);
  await tapOn(page, d);
  const from = await toClient(page, d.xMm, d.yMm);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= 5; i++) await touch(cdp, 'touchMove', [{ x: from.x + i * 8, y: from.y }]);
  const second = { x: from.x + 40, y: from.y + 120 };
  await touch(cdp, 'touchStart', [{ x: from.x + 40, y: from.y }, second]);
  for (let i = 1; i <= 5; i++)
    await touch(cdp, 'touchMove', [
      { x: from.x + 40 - i * 6, y: from.y - i * 6 },
      { x: second.x + i * 6, y: second.y + i * 6 },
    ]);
  await touch(cdp, 'touchEnd', [second]);
  await touch(cdp, 'touchEnd', []);
  // The model is unchanged, and so is the design on screen.
  await expect.poll(async () => (await designs(page))[0]).toEqual(d);
  const corners = await page.evaluate(
    (id) =>
      (
        window as unknown as { __printsheet: { objectCorners(i: string): Spot[] } }
      ).__printsheet.objectCorners(id),
    d.id,
  );
  const box = footprint(d);
  expect(Math.min(...corners.map((c) => c.x))).toBeCloseTo(box.minX, 3);
  expect(Math.min(...corners.map((c) => c.y))).toBeCloseTo(box.minY, 3);
  // Nothing was committed: undo takes back the last real change (the typed width).
  await page.locator('#undo').click();
  expect((await designs(page))[0]?.widthMm).not.toBeCloseTo(250, 3);
});

test('a long press on a design chooses it and opens its menu, which acts on it', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await barButton(page, 'Deselect').click();
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');
  await tapOn(page, a);
  await expect.poll(async () => (await state(page)).selection).toEqual([a.id]);
  const at = await toClient(page, b.xMm, b.yMm);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [at]);
  await page.waitForTimeout(800);
  await touch(cdp, 'touchEnd', []);
  await expect(page.getByRole('menu')).toBeVisible();
  expect((await state(page)).selection).toEqual([b.id]);
  await page.getByRole('menuitem', { name: 'Flip horizontally' }).click();
  const after = await designs(page);
  expect(after.find((d) => d.id === b.id)?.flipX).toBe(true);
  expect(after.find((d) => d.id === a.id)?.flipX).toBe(false);
});

test('a touch never opens the browser menu or the right-click menu; a mouse still does', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  await barButton(page, 'Deselect').click();
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  const at = await toClient(page, d.xMm, d.yMm);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [at]);
  // What Android sends during a long press.
  const prevented = await page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector('.upper-canvas');
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x ?? 0,
        clientY: y ?? 0,
      });
      canvas?.dispatchEvent(event);
      return event.defaultPrevented;
    },
    [at.x, at.y],
  );
  await touch(cdp, 'touchEnd', []);
  expect(prevented).toBe(true);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
});

/**
 * One finger from `from` to `to`, with each touch event sent BEFORE its pointer event (the order
 * WebKit may use; Chromium sends pointer events first). Built by hand in the page.
 */
async function dragTouchFirst(page: Page, from: Spot, to: Spot, steps = 6): Promise<void> {
  await page.evaluate(
    ({ start, end, count }) => {
      const target = document.querySelector('.upper-canvas');
      if (!target) throw new Error('no canvas');
      const send = (kind: 'start' | 'move' | 'end', x: number, y: number): void => {
        const finger = new Touch({ identifier: 7, target, clientX: x, clientY: y });
        const live = kind === 'end' ? [] : [finger];
        target.dispatchEvent(
          new TouchEvent(`touch${kind}`, {
            bubbles: true,
            cancelable: true,
            touches: live,
            targetTouches: live,
            changedTouches: [finger],
          }),
        );
        const pointer = { start: 'pointerdown', move: 'pointermove', end: 'pointerup' }[kind];
        target.dispatchEvent(
          new PointerEvent(pointer, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: kind === 'move' ? -1 : 0,
            buttons: kind === 'end' ? 0 : 1,
          }),
        );
      };
      send('start', start.x, start.y);
      for (let i = 1; i <= count; i++)
        send(
          'move',
          start.x + ((end.x - start.x) * i) / count,
          start.y + ((end.y - start.y) * i) / count,
        );
      send('end', end.x, end.y);
    },
    { start: from, end: to, count: steps },
  );
}

test('touch events first: a drag starting on a design that is not chosen pans', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await barButton(page, 'Deselect').click();
  await zoomIn(page, 8);
  await scrollHome(page);
  const before = await designs(page);
  const d = before[1];
  if (!d) throw new Error('no design');
  const on = await toClient(page, d.xMm, d.yMm);
  const scroll = await scrollOf(page);
  await dragTouchFirst(page, on, { x: on.x - 10, y: on.y - 150 });
  expect((await scrollOf(page)).y - scroll.y).toBeGreaterThan(100);
  expect(await designs(page)).toEqual(before);
  expect((await state(page)).selection).toEqual([]);
});

test('touch events first: the chosen design moves on two drags in a row', async ({ page }) => {
  const d = await oneBigDesign(page);
  await tapOn(page, d);
  const first = await toClient(page, d.xMm, d.yMm);
  await dragTouchFirst(page, first, { x: first.x + 30, y: first.y + 40 });
  const [once] = await designs(page);
  if (!once) throw new Error('no design');
  expect(once.xMm - d.xMm).toBeGreaterThan(15);
  const second = await toClient(page, once.xMm, once.yMm);
  await dragTouchFirst(page, second, { x: second.x + 30, y: second.y + 40 });
  const [twice] = await designs(page);
  expect((twice?.xMm ?? 0) - once.xMm).toBeGreaterThan(15);
});

test('a drag cut off by the browser leaves the design where it was, and the next drag works', async ({
  page,
}) => {
  const d = await oneBigDesign(page);
  await tapOn(page, d);
  const from = await toClient(page, d.xMm, d.yMm);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [{ x: from.x + i * 10, y: from.y }]);
  await touch(cdp, 'touchCancel', []);
  // The store did not change, and the design is drawn where the store has it.
  await expect.poll(async () => (await designs(page))[0]).toEqual(d);
  await expect
    .poll(async () => {
      const corners = await page.evaluate(
        (id) =>
          (
            window as unknown as { __printsheet: { objectCorners(i: string): Spot[] } }
          ).__printsheet.objectCorners(id),
        d.id,
      );
      return Math.min(...corners.map((c) => c.x));
    })
    .toBeCloseTo(footprint(d).minX, 3);
  // A normal drag afterwards moves it, as one undo step.
  await drag(page, from, { x: from.x + 40, y: from.y + 60 });
  const [moved] = await designs(page);
  expect((moved?.xMm ?? 0) - d.xMm).toBeGreaterThan(20);
  await page.locator('#undo').click();
  expect((await designs(page))[0]).toEqual(d);
});

test('a cut-off drag where Touch cannot be built (as on iPhone Safari) leaves touch working', async ({
  page,
}) => {
  const d = await oneBigDesign(page);
  for (let i = 0; i < 3; i++) await barButton(page, 'Duplicate').click();
  await barButton(page, 'Deselect').click();
  await scrollHome(page);
  await tapOn(page, d);
  await expect.poll(async () => (await state(page)).selection).toEqual([d.id]);
  // Safari has the Touch interface but no usable constructor.
  await page.evaluate(() => {
    Object.defineProperty(window, 'Touch', {
      configurable: true,
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page, so it is defined there.
      value: function Touch(): never {
        throw new TypeError('Illegal constructor');
      },
    });
  });
  const from = await toClient(page, d.xMm, d.yMm);
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [{ x: from.x + i * 10, y: from.y }]);
  await touch(cdp, 'touchCancel', []);

  // One finger on the mat pans (it is not taken for a second finger of a pinch).
  const stage = await page.locator('#scroller').boundingBox();
  if (!stage) throw new Error('no stage');
  const zoom = await page.locator('#zoom-value').textContent();
  const scroll = await scrollOf(page);
  const mat = { x: stage.x + 12, y: stage.y + stage.height - 160 };
  await drag(page, mat, { x: mat.x, y: mat.y - 200 });
  // The view scrolls with the finger as far as the sheet allows (a pinch would zoom instead).
  const room = await page.locator('#scroller').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(room).toBeGreaterThan(40);
  expect((await scrollOf(page)).y - scroll.y).toBeCloseTo(Math.min(200, room - scroll.y), -1);
  await expect(page.locator('#zoom-value')).toHaveText(zoom ?? '');

  // The chosen design is where the store has it, and a normal drag moves it as one step.
  await scrollHome(page);
  expect((await designs(page))[0]).toEqual(d);
  const again = await toClient(page, d.xMm, d.yMm);
  await drag(page, again, { x: again.x + 40, y: again.y + 60 });
  const [moved] = await designs(page);
  expect((moved?.xMm ?? 0) - d.xMm).toBeGreaterThan(20);
  await page.locator('#undo').click();
  expect((await designs(page))[0]).toEqual(d);
});
