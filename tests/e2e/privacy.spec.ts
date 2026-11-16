/**
 * The outsider's view: images must never leave the computer. Whatever the app does, it may not
 * make a single network request beyond loading its own page.
 */
import { expect, test } from '@playwright/test';
import { addImages, appUrl, exportFile, openApp } from './helpers';

test('makes no network request while importing, editing and exporting', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (url === appUrl()) return;
    requests.push(url);
  });
  await openApp(page);
  await addImages(page, ['f-shape.png', 'bordered.png']);
  await page.keyboard.press('Control+a');
  await page.click('#arrange');
  await exportFile(page, { format: 'pdf', color: 'cmyk' });
  await exportFile(page, { format: 'png', dpi: 150 });
  expect(requests).toEqual([]);
});
