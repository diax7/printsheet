/**
 * Shared helpers for the browser tests. Tests drive the app like a person (clicks, typing, file
 * pickers, keyboard) and read the model through the read-only `window.__printsheet` hook to check
 * the result.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Download, type Page } from '@playwright/test';
import type { AppState } from '@/store/store';
import type { Design } from '@/model/types';

export const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'out');
export const fixture = (name: string): string => path.join(FIXTURES, name);

export const APP_URL =
  process.env['PRINTSHEET_URL'] ??
  pathToFileURL(path.join(process.cwd(), 'dist', 'index.html')).href;

/** Console errors and uncaught exceptions seen on the page; tests assert it stays empty. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** The page under test: a deployed copy if PRINTSHEET_URL is set, else this project's own. */
export function appUrl(): string {
  return process.env['PRINTSHEET_URL'] ?? test.info().project.use.baseURL ?? APP_URL;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto(appUrl());
  await page.waitForSelector('body[data-ready="true"]');
}

type SerialState = Omit<AppState, 'assets' | 'masks'> & {
  /** Ids of the images whose ink mask is ready. */
  masks: string[];
  assets: Array<{
    id: string;
    name: string;
    widthPx: number;
    heightPx: number;
    hasTransparency: boolean;
  }>;
};

export async function state(page: Page): Promise<SerialState> {
  return page.evaluate(() => {
    const s = (window as unknown as { __printsheet: { state(): AppState } }).__printsheet.state();
    return {
      sheet: s.sheet,
      selection: [...s.selection],
      masks: [...s.masks.keys()],
      assets: [...s.assets.values()].map(({ id, name, widthPx, heightPx, hasTransparency }) => ({
        id,
        name,
        widthPx,
        heightPx,
        hasTransparency,
      })),
    };
  });
}

export async function designs(page: Page): Promise<Design[]> {
  return (await state(page)).sheet.designs;
}

export async function addImages(
  page: Page,
  names: string[],
  expectedTotal?: number,
): Promise<void> {
  const before = (await designs(page)).length;
  await page.setInputFiles('#file-input', names.map(fixture));
  const total = expectedTotal ?? before + names.length;
  await expect.poll(async () => (await designs(page)).length).toBe(total);
}

/** The trimmed PNG bytes of every image, by asset id (for checks done in Node). */
export async function assetBytes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(async () => {
    const s = (window as unknown as { __printsheet: { state(): AppState } }).__printsheet.state();
    const out: Record<string, number[]> = {};
    for (const a of s.assets.values())
      out[a.id] = Array.from(new Uint8Array(await a.blob.arrayBuffer()));
    return out;
  });
}

/** Select one design by clicking its row in the list. */
export async function selectInList(page: Page, name: string): Promise<void> {
  await page.locator('.design-item', { hasText: name }).first().click();
}

/** Type a value into an inspector field and commit it. */
export async function typeField(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.fill(value);
  await input.press('Enter');
  await input.blur();
}

export interface ExportChoices {
  format: 'pdf' | 'png';
  color?: 'rgb' | 'cmyk';
  dpi?: number;
  quality?: 'original' | '600' | '300';
  compression?: 'compact' | 'lossless';
  split?: 'zip' | 'pdf-pages' | 'files';
  mirror?: boolean;
}

/** Open the export dialog and set the options by clicking, as a person would. */
export async function chooseExport(page: Page, options: ExportChoices): Promise<void> {
  await page.click('#export');
  const dialog = page.locator('#export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-group="format"][data-value="${options.format}"]`).click();
  if (options.color)
    await dialog.locator(`[data-group="color"][data-value="${options.color}"]`).click();
  if (options.compression)
    await dialog.locator(`[data-group="compression"][data-value="${options.compression}"]`).click();
  if (options.dpi) await dialog.locator(`[data-group="dpi"][data-value="${options.dpi}"]`).click();
  if (options.quality)
    await dialog.locator(`[data-group="quality"][data-value="${options.quality}"]`).click();
  if (options.split)
    await dialog.locator(`[data-group="split"][data-value="${options.split}"]`).click();
  const mirror = options.mirror ? 'mirrored' : 'regular';
  await dialog.locator(`[data-group="mirror"][data-value="${mirror}"]`).click();
}

/** Open the export dialog, set options by clicking, export, and return the download. */
export async function exportFile(page: Page, options: ExportChoices): Promise<Download> {
  await chooseExport(page, options);
  const dialog = page.locator('#export-dialog');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 110_000 }),
    dialog.locator('#export-go').click(),
  ]);
  await expect(dialog).toBeHidden();
  return download;
}

export async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Click Arrange (or start it another way, with `trigger`) and wait until it is done. Arrange
 * searches in a worker for up to a few seconds, commits the layout (or keeps the one on the sheet
 * when it finds nothing shorter) and then says "Arranged"; an earlier "Arranged" message is
 * waited out first, so it cannot be mistaken for this one.
 */
export async function arrange(
  page: Page,
  trigger: () => Promise<void> = () => page.click('#arrange'),
): Promise<void> {
  const done = page.locator('.toast', { hasText: 'Arranged' });
  // Close earlier Arrange messages (some stay 12 s), so this run's message is the only one.
  for (const close of await done.locator('button[aria-label="Dismiss"]').all()) await close.click();
  await expect(done).toHaveCount(0);
  await trigger();
  await expect(done).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#arrange-dialog')).toBeHidden();
}
