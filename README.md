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
- **Split into sheets.** Cut a long job into sheets of a set length, for example 1 m each. Every
  sheet shows as its own canvas, no design may cross a split (one click moves those that do onto
  a sheet), and the last sheet is trimmed to its designs or kept full length, as you choose.
- **Real sizes everywhere.** Select a design and its print size shows on it (`30.0 × 50.0 cm`),
  live while you resize. Type an exact width or height. The list shows every design with its size.
- **Empty borders trimmed.** Transparent space around an image is cut off when you add it, so the
  size you see is the size of the ink.
- **Organise quickly.** Drag, resize, rotate (snaps every 15°), flip, duplicate, add many copies at
  once, lock, align and distribute.
- **Arrange: the least film, found for you.** One click packs the designs (all of them, or the
  ones you selected) into the shortest sheet it can find. For about four seconds it tries
  hundreds of layouts, with different orders and quarter turns, and keeps the shortest; you see
  the best length so far and can stop at any time and keep it. It never mirrors a design, it
  leaves locked designs alone, and it never replaces a good layout with a longer one. Click it
  again to let it look further. One undo puts everything back.
- **The cutting gap, between rectangles or real shapes.** By default the gap is kept between
  the rectangles around the designs. Set **Gap measured between** to **Real shapes** in the sheet
  settings and the gap is kept between the designs themselves instead, so Arrange fits one design
  into the empty corner of another, as you would by hand, and uses much less film. Any visible
  pixel counts as part of the design, however faint, and the outline is measured on a 1 mm grid
  that never errs on the tight side. The app remembers your choice for new sheets.
- **Warnings that protect the print:**
  - sharpness: green at 300 DPI or more, amber from 150 to 299, red below 150;
  - an image with no transparent background (it would print as a solid rectangle);
  - a design past the edge of the sheet (export is blocked until it is fixed; one click moves it
    back);
  - designs closer than your cutting gap (5 mm by default), measured the way you chose: between
    real shapes or between rectangles;
  - designs past a fixed length.
- **Workspace background:** transparent checkerboard, white, black or any colour, so you can judge
  your designs on the shirt colour. This is for viewing only; exports are always transparent.
- **Undo and redo**, automatic saving in your browser, and project files (`.printsheet`) to keep a
  sheet for a reorder or move it to another computer.

## How to use it

1. Open https://printsheet.dhia.app in Chrome or Edge on a computer, or in Safari or Chrome on a
   phone (the phone layout keeps the tools in a bar at the bottom).
2. Set the sheet width to what your printer or print shop can print (check with them).
3. Add your designs: **Add images**, drag files onto the sheet, or paste with Ctrl+V. Transparent
   PNG files at 300 DPI give the best result.
4. Place them: drag, or type exact sizes on the right. Click **Arrange** to pack them into the
   least film.
5. Fix anything marked in red or amber.
6. Click **Export**, choose the settings below, and send the file to your printer.

## Export settings

| Setting | Options | Advice |
| --- | --- | --- |
| Format | PDF, PNG | Ask your print shop. Many DTF shops ask for PNG. |
| Colour (PDF) | RGB, CMYK | Use **RGB** unless told otherwise. The printer's own software (its RIP) converts colours with that printer's profile. CMYK here uses a standard press profile (FOGRA39), not your printer's. |
| File size (PDF) | Compact, Lossless | **Compact** (the default) stores colours as high-quality JPEG (quality 92, full colour resolution) and keeps transparency and every edge exact: about a quarter of the lossless size, easy to send by WhatsApp or email. **Lossless** keeps every pixel. In CMYK, Compact writes a four-channel CMYK JPEG, the kind Photoshop and Acrobat use. |
| Resolution (PNG) | 150, 300, 360, 600 DPI | 300 is the usual print quality. The DPI is written into the file, so it opens at the right size. |
| Image quality (PDF) | Original, up to 600 DPI, up to 300 DPI | The PDF keeps every image at its full resolution by default. A limit only shrinks images placed above it, so it helps only when your images are sharper than the print needs. |
| Mirror | Regular, Mirrored | DTF is printed mirrored, but the printer's software usually does it. Only choose Mirrored if your shop asks. A small preview shows the file the way it will come out. |
| Sheets (split jobs) | One zip, One PDF, Separate files | One zip holds a file per sheet (easiest to send). One PDF has a page per sheet. Separate files gives a download button per sheet. Empty sheets are left out. |

The PDF is exactly the sheet size, holds each image once (however many copies you placed), and
keeps transparency exact, so only your designs get ink. Lossless images and PNG files use PNG row
filters, so they are about a third smaller than plain compression with the same pixels. One file
can be up to 5 m long (the PDF limit); for a longer job, choose **Split into sheets**.

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
