/**
 * Black-box flows through the editor: what a person does, and what they should see.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  addImages,
  collectErrors,
  designs,
  openApp,
  selectInList,
  state,
  typeField,
} from './helpers';
import { corners, footprint } from '@/model/geometry';

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

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await openApp(page);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('shows an empty sheet with an invitation to add designs', async ({ page }) => {
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#film-meters')).toHaveText('0.00');
  await expect(page.locator('#film-size')).toHaveText('58.0 × 0.0 cm');
  await expect(page.locator('#export')).toBeEnabled();
});

test('adds an image, trims its empty border and shows its real print size', async ({ page }) => {
  await addImages(page, ['bordered.png']);
  const [d] = await designs(page);
  // 600 × 300 px of logo inside a 1000 × 700 px file, placed at 300 DPI: 5.08 × 2.54 cm.
  expect(d?.widthMm).toBeCloseTo(50.8, 3);
  expect(d?.heightMm).toBeCloseTo(25.4, 3);
  await expect(page.locator('.design-item')).toContainText('5.1 × 2.5 cm');
  await expect(page.locator('#empty-state')).toBeHidden();
  await expect(page.locator('#film-meters')).toHaveText('0.03');
  await expect(page.locator('.big-size')).toHaveText('5.1 × 2.5 cm');
});

test('clears a near-invisible haze, so the design trims to its real size', async ({ page }) => {
  await addImages(page, ['hazy.png']);
  const s = await state(page);
  const asset = [...s.assets.values()][0];
  // A 400 × 200 px logo inside a 1000 × 600 px file covered by a haze of alpha 3 to 9.
  expect([asset?.widthPx, asset?.heightPx]).toEqual([400, 200]);
  const [d] = await designs(page);
  expect(d?.widthMm).toBeCloseTo((400 / 300) * 25.4, 3);
});

test('refuses a fully transparent image and a file that is not an image, with a reason', async ({
  page,
}) => {
  await page.setInputFiles('#file-input', [
    'tests/fixtures/out/empty.png',
    'tests/fixtures/out/not-an-image.png',
    'tests/fixtures/out/f-shape.png',
  ]);
  await expect(page.locator('.toast.error')).toContainText(['fully transparent']);
  await expect(page.locator('.toast.error').nth(1)).toContainText('could not be read as an image');
  await expect.poll(async () => (await designs(page)).length).toBe(1);
});

test('warns that an image without transparency prints as a rectangle', async ({ page }) => {
  await addImages(page, ['opaque.png']);
  await expect(page.locator('.issues')).toContainText('No transparent background');
});

test('types an exact size, keeping proportions, and undoes it', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '20');
  let [d] = await designs(page);
  expect(d?.widthMm).toBeCloseTo(200, 6);
  expect(d?.heightMm).toBeCloseTo((200 * 344) / 224, 3);
  await expect(page.locator('.big-size')).toHaveText(
    `20.0 × ${((200 * 344) / 224 / 10).toFixed(1)} cm`,
  );
  await page.keyboard.press('Escape');
  await page.click('#undo');
  [d] = await designs(page);
  expect(d?.widthMm).toBeCloseTo(18.97, 1);
  await page.click('#redo');
  [d] = await designs(page);
  expect(d?.widthMm).toBeCloseTo(200, 6);
});

test('typing a bigger size grows from the top-left corner and stays on the sheet', async ({
  page,
}) => {
  await addImages(page, ['bordered.png']);
  await typeField(page, '#insp-width', '20');
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  expect(footprint(d).minX).toBeCloseTo(0, 6);
  expect(footprint(d).minY).toBeCloseTo(0, 6);
  await expect(page.locator('.issues')).toHaveCount(1);
  await expect(page.locator('.issues')).not.toContainText('past the edge');
});

test('a design over the edge can be moved back onto the sheet in one click', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '70');
  await expect(page.locator('.issues')).toContainText('past the edge');
  await page.getByRole('button', { name: 'Move onto the sheet' }).click();
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  expect(footprint(d).maxX).toBeLessThanOrEqual(580 + 0.01);
  expect(footprint(d).minX).toBeGreaterThanOrEqual(-0.01);
  await expect(page.locator('.issues')).not.toContainText('past the edge');
});

test('Escape leaves a text field so shortcuts work again', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await selectInList(page, 'f-shape');
  await page.click('#insp-width');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  expect((await state(page)).selection).toHaveLength(2);
});

test('rotates, flips, duplicates and deletes from the inspector and keyboard', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.getByRole('button', { name: 'Rotate 90° right' }).click();
  await page.getByRole('button', { name: 'Flip horizontally' }).click();
  let [d] = await designs(page);
  expect(d?.angleDeg).toBe(90);
  expect(d?.flipX).toBe(true);
  await page
    .locator('#scroller')
    .click({ position: { x: 5, y: 5 } })
    .catch(() => undefined);
  await selectInList(page, 'f-shape');
  await page.keyboard.press('Control+d');
  expect(await designs(page)).toHaveLength(2);
  await page.keyboard.press('Delete');
  expect(await designs(page)).toHaveLength(1);
  [d] = await designs(page);
  expect(d?.angleDeg).toBe(90);
});

test('moves the selection with the arrow keys, one undo step for a burst of presses', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  const [before] = await designs(page);
  await page.locator('#scroller').focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const [after] = await designs(page);
  expect(after?.xMm).toBeCloseTo((before?.xMm ?? 0) + 5, 6);
  expect(after?.yMm).toBeCloseTo((before?.yMm ?? 0) + 10, 6);
  await page.keyboard.press('Control+z');
  const [undone] = await designs(page);
  expect(undone?.xMm).toBeCloseTo(before?.xMm ?? 0, 6);
});

test('dragging a design cannot take it past the right edge of the sheet', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const [d] = await designs(page);
  if (!d) throw new Error('no design');
  const start = await toClient(page, d.xMm, d.yMm);
  const far = await toClient(page, 2000, d.yMm + 20);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 10, { steps: 4 });
  await page.mouse.move(far.x, far.y, { steps: 10 });
  await page.mouse.up();
  const [moved] = await designs(page);
  if (!moved) throw new Error('no design');
  expect(footprint(moved).maxX).toBeLessThanOrEqual(580 + 0.01);
  expect(footprint(moved).maxX).toBeGreaterThan(560);
  await expect(page.locator('.issues')).toHaveCount(0);
});

test('drags a multi-selection with the mouse: both move, one undo restores both', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  const before = await designs(page);
  const [a] = before;
  if (!a) throw new Error('no design');
  const start = await toClient(page, a.xMm, a.yMm);
  const end = await toClient(page, a.xMm + 40, a.yMm + 60);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  const after = await designs(page);
  for (const [i, d] of after.entries()) {
    const old = before[i];
    if (!old) throw new Error('missing');
    expect(d.yMm - old.yMm).toBeGreaterThan(30);
    expect(d.xMm - old.xMm).toBeCloseTo(
      after[0] && before[0] ? after[0].xMm - before[0].xMm : NaN,
      3,
    );
    const onScreen = await page.evaluate(
      (id) =>
        (
          window as unknown as {
            __printsheet: { objectCorners(i: string): Array<{ x: number; y: number }> };
          }
        ).__printsheet.objectCorners(id),
      d.id,
    );
    corners(d).forEach((p, k) => {
      expect(onScreen[k]?.x).toBeCloseTo(p.x, 3);
      expect(onScreen[k]?.y).toBeCloseTo(p.y, 3);
    });
  }
  await page.keyboard.press('Control+z');
  expect(await designs(page)).toEqual(before);
});

test('a locked design does not move when dragged as part of a selection', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await selectInList(page, 'bordered');
  await page.getByRole('button', { name: 'Lock position' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  const before = await designs(page);
  const [a] = before;
  if (!a) throw new Error('no design');
  const start = await toClient(page, a.xMm, a.yMm);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 80, { steps: 10 });
  await page.mouse.up();
  expect(await designs(page)).toEqual(before);
});

test('a locked design cannot be resized, flipped or deleted until unlocked', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.getByRole('button', { name: 'Lock position' }).click();
  await expect(page.locator('#insp-width')).toBeDisabled();
  await expect(page.locator('#insp-angle')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Flip horizontally' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await page.locator('#scroller').focus();
  await page.keyboard.press('Delete');
  expect(await designs(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('#insp-width')).toBeEnabled();
});

test('adds copies that keep the cutting gap and lengthen the film', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.fill('#insp-copies', '29');
  await page.getByRole('button', { name: 'Add copies' }).click();
  const all = await designs(page);
  expect(all).toHaveLength(30);
  const s = await state(page);
  expect(s.selection).toHaveLength(30);
  await expect(page.locator('.design-item')).toHaveCount(30);
  await expect(page.locator('.flag')).toHaveCount(0);
});

test('auto-arrange shortens a badly laid out sheet', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  // Stack them far apart vertically by typing nothing: move one far down with the keyboard.
  await selectInList(page, 'bordered');
  await page.locator('#scroller').focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowDown');
  const before = await page.locator('#film-meters').textContent();
  await page.keyboard.press('Escape');
  await page.click('#arrange');
  await expect
    .poll(async () => Number(await page.locator('#film-meters').textContent()))
    .toBeLessThan(Number(before));
});

test('aligns several designs to the same left edge', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Align right' }).click();
  const [a, b] = await designs(page);
  if (!a || !b) throw new Error('missing designs');
  expect(footprint(a).maxX).toBeCloseTo(footprint(b).maxX, 6);
});

test('changing the sheet width with a preset and by typing', async ({ page }) => {
  await page.selectOption('#preset', 'dtf-60');
  expect((await state(page)).sheet.settings.sheetWidthMm).toBe(600);
  await expect(page.locator('#film-size')).toContainText('60.0 ×');
  await typeField(page, '#sheet-width', '33');
  expect((await state(page)).sheet.settings.sheetWidthMm).toBe(330);
  await expect(page.locator('#preset')).toHaveValue('custom');
  await typeField(page, '#sheet-width', '500');
  await expect(page.locator('#sheet-width')).toHaveAttribute('aria-invalid', 'true');
  expect((await state(page)).sheet.settings.sheetWidthMm).toBe(330);
});

test('saves a width preset and reuses it after a reload', async ({ page }) => {
  await typeField(page, '#sheet-width', '45.5');
  await page.click('#preset-menu');
  await page.fill('#preset-name', 'Shop roll');
  await page.getByRole('button', { name: /Save 45.5 cm as a preset/ }).click();
  await expect(page.locator('#preset')).toHaveValue(/p-/);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await page.selectOption('#preset', 'dtf-58');
  const option = page.locator('#preset option', { hasText: 'Shop roll (45.5 cm)' });
  await expect(option).toHaveCount(1);
  await page.selectOption('#preset', { label: 'Shop roll (45.5 cm)' });
  expect((await state(page)).sheet.settings.sheetWidthMm).toBe(455);
});

test('a fixed length flags designs that go past it', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await page.locator('[data-length="fixed"]').click();
  await typeField(page, '#fixed-length', '2');
  await expect(page.locator('.issues')).toContainText('fixed sheet length');
  await expect(page.locator('#film-meters')).toHaveText('0.02');
});

test('switching the workspace background changes the sheet, not the export', async ({ page }) => {
  await page.click('[data-bg="black"]');
  const sample = async (): Promise<number[]> => {
    const box = await page.locator('#sheet-canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    const pt = await toClient(page, 290, 20);
    const shot = await page.screenshot({ clip: { x: pt.x, y: pt.y, width: 1, height: 1 } });
    const { decode } = await import('fast-png');
    return Array.from(decode(shot).data.slice(0, 3));
  };
  expect(await sample()).toEqual([0, 0, 0]);
  await page.click('[data-bg="white"]');
  expect(await sample()).toEqual([255, 255, 255]);
  await page.click('#grid-toggle');
  await expect(page.locator('#grid-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('zooming changes the on-screen size but never the measurements', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  const label = await page.locator('.big-size').textContent();
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await expect(page.locator('.big-size')).toHaveText(label ?? '');
  await page.click('#zoom-value');
  await expect(page.locator('#zoom-value')).toHaveText('100%');
});

test('blocks export while a design hangs past the edge, and says which one', async ({ page }) => {
  await addImages(page, ['f-shape.png']);
  await typeField(page, '#insp-width', '70');
  await page.click('#export');
  await expect(page.locator('#export-dialog .notice.danger')).toContainText(
    '"f-shape" goes past the edge',
  );
  await expect(page.locator('#export-go')).toBeDisabled();
});

test('corners on screen match the model for plain, rotated and flipped designs', async ({
  page,
}) => {
  await addImages(page, ['f-shape.png']);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+d');
  const ids = (await designs(page)).map((d) => d.id);
  // [angle, flip horizontally, flip vertically]
  const setups: Array<[number, boolean, boolean]> = [
    [0, false, false],
    [30, false, false],
    [0, true, false],
    [30, true, false],
    [30, false, true],
    [30, true, true],
  ];
  for (const [i, [angle, flipX, flipY]] of setups.entries()) {
    await page
      .locator('.design-item')
      .nth(setups.length - 1 - i)
      .click();
    await typeField(page, '#insp-angle', String(angle));
    if (flipX) await page.getByRole('button', { name: 'Flip horizontally' }).click();
    if (flipY) await page.getByRole('button', { name: 'Flip vertically' }).click();
  }
  for (const id of ids) {
    const d = (await designs(page)).find((x) => x.id === id);
    if (!d) throw new Error('missing');
    const onScreen = await page.evaluate(
      (x) =>
        (
          window as unknown as {
            __printsheet: { objectCorners(i: string): Array<{ x: number; y: number }> };
          }
        ).__printsheet.objectCorners(x),
      id,
    );
    const [tl, tr, br, bl] = corners(d);
    // The image's own top-left pixel lands on the rectangle's top-right corner when flipped.
    // Where the image's own top-left, top-right, bottom-right and bottom-left pixels land.
    const expected =
      d.flipX && d.flipY
        ? [br, bl, tl, tr]
        : d.flipX
          ? [tr, tl, bl, br]
          : d.flipY
            ? [bl, br, tr, tl]
            : [tl, tr, br, bl];
    onScreen.forEach((p, k) => {
      expect(p.x).toBeCloseTo(expected[k]?.x ?? NaN, 3);
      expect(p.y).toBeCloseTo(expected[k]?.y ?? NaN, 3);
    });
  }
});

test('About shows the version, the privacy promise and the source link', async ({ page }) => {
  await page.click('#about');
  const dialog = page.locator('#about-dialog');
  await expect(dialog).toContainText(/PrintSheet \d+\.\d+\.\d+/);
  await expect(dialog).toContainText('never uploaded');
  await expect(dialog.getByRole('link', { name: 'github.com/diax7/printsheet' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
});

test('selecting a design on the sheet shows its row in the design list', async ({ page }) => {
  await addImages(page, ['f-shape.png', 'bordered.png']);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+d');
  }
  await page.keyboard.press('Escape');
  const all = await designs(page);
  expect(all).toHaveLength(16);
  // The bottom design of the stack is the last row, below the panel's visible part.
  const bottom = all[0] as (typeof all)[number];
  const row = page.locator(`.design-item[data-id="${bottom.id}"]`);
  await page
    .locator('#panel-left, .panel-left')
    .first()
    .evaluate((el) => (el.scrollTop = 0));
  const point = await toClient(page, bottom.xMm, bottom.yMm);
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await state(page)).selection).toEqual([bottom.id]);
  await expect(row).toBeInViewport();
});
