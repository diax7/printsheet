# PrintSheet

Lay out your designs on a DTF film sheet with exact sizes in centimetres, see how many meters of
film you need, and export one print-ready PDF or PNG for your printer or print shop.

**Use it now: https://printsheet.dhia.app**

It runs entirely in your browser. Your images are never uploaded anywhere: there is no server, no
account and no tracking. The page cannot even make network requests (its security policy blocks
them).

## What it does

- **A sheet the width of your film.** 58 cm by default; any width from 10 to 160 cm. Save your own
  width presets (for example "Shop roll, 57 cm").
- **The film length, always in view.** The sheet grows as you add designs and the left panel shows
  the meters you need, like `1.37 m`. Or set a fixed length when you buy an exact amount.
- **Real sizes everywhere.** Select a design and its print size shows on it (`30.0 × 50.0 cm`),
  live while you resize. Type an exact width or height. The list shows every design with its size.
- **Empty borders trimmed.** Transparent space around an image is cut off when you add it, so the
  size you see is the size of the ink.
- **Organise quickly.** Drag, resize, rotate (snaps every 15°), flip, duplicate, add many copies at
  once, lock, align, distribute, and **Arrange** to pack everything tightly and save film.
- **Warnings that protect the print:**
  - sharpness: green at 300 DPI or more, amber from 150 to 299, red below 150;
  - an image with no transparent background (it would print as a solid rectangle);
  - a design past the edge of the sheet (export is blocked until it is fixed; one click moves it
    back);
  - designs closer than your cutting gap (5 mm by default);
  - designs past a fixed length.
- **Workspace background:** transparent checkerboard, white, black or any colour, so you can judge
  your designs on the shirt colour. This is for viewing only; exports are always transparent.
- **Undo and redo**, automatic saving in your browser, and project files (`.printsheet`) to keep a
  sheet for a reorder or move it to another computer.

## How to use it

1. Open https://printsheet.dhia.app in Chrome or Edge on a computer.
2. Set the sheet width to what your printer or print shop can print (check with them).
3. Add your designs: **Add images**, drag files onto the sheet, or paste with Ctrl+V. Transparent
   PNG files at 300 DPI give the best result.
4. Place them: drag, or type exact sizes on the right. Click **Arrange** to pack them.
5. Fix anything marked in red or amber.
6. Click **Export**, choose the settings below, and send the file to your printer.

## Export settings

| Setting | Options | Advice |
| --- | --- | --- |
| Format | PDF, PNG | Ask your print shop. Many DTF shops ask for PNG. |
| Colour (PDF) | RGB, CMYK | Use **RGB** unless told otherwise. The printer's own software (its RIP) converts colours with that printer's profile. CMYK here uses a standard press profile (FOGRA39), not your printer's. |
| Resolution (PNG) | 150, 300, 360, 600 DPI | 300 is the usual print quality. The DPI is written into the file, so it opens at the right size. |
| Image quality (PDF) | Original, up to 600 DPI, up to 300 DPI | The PDF keeps every image at full resolution by default. Lower it only to make a very large file smaller. |
| Mirror | On, off | DTF is printed mirrored, but the printer's software usually does it. Only turn it on if your shop asks. |

The PDF is exactly the sheet size, holds each image once (however many copies you placed), and
keeps transparency, so only your designs get ink. One sheet can be up to 5 m long (the PDF limit);
for a longer job, make a second sheet.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+V | Paste an image |
| Ctrl+A | Select everything |
| Ctrl+D | Duplicate |
| Delete | Remove (locked designs are kept) |
| Arrow keys | Move 1 mm (with Shift: 1 cm) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+wheel, Ctrl+= / Ctrl+− | Zoom |
| Ctrl+0 | Fit the sheet width |
| Ctrl+S | Save a project file |
| Escape | Leave a text field, or clear the selection |

## Use it offline

Download `printsheet.html` from the [latest release](https://github.com/diax7/printsheet/releases/latest) (or build it, below) and open it
from your computer. Everything works the same, without an internet connection.

## Development

Requires Node.js 22.12 or later.

```bash
npm ci
npm run dev          # local editor at http://localhost:5173
npm test             # unit tests (Vitest)
npm run e2e          # build, then browser tests (Playwright, Chromium): opened from disk, and
                     # served with the hosted page's security headers
npm run build        # dist/index.html, one self-contained file
npm run lint && npm run typecheck && npm run format:check
```

`npx playwright test --grep @stress` runs the slow tests (an 8000 px image, a 5 m sheet at
300 DPI, 400 designs). `npm run serve` serves the build with the same security headers as the
hosted page (`vercel.json`).

How it is built: the sheet is a plain model in millimetres; the canvas (Fabric.js) only draws it.
Exports are made from the model in a background worker: the PDF with pdf-lib (each image embedded
once and placed with a transform), the PNG rendered in strips and streamed through the browser's
compressor so long sheets fit in memory. The browser tests compare the exported PNG and PDF (drawn
by pdf.js) with an independent rasterisation of the model. Design notes are in `docs/`.

## Licence

MIT, see [LICENSE](LICENSE). Bundled libraries, the Archivo typeface and the FOGRA39 colour profile
keep their own licences, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
