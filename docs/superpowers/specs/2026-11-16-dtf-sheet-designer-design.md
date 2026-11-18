# PrintSheet (DTF sheet designer): design

Date: 2026-11-16. Status: approved v1, amended v2 the same day (owner's follow-up: reliable over
fast, more flexibility and customization, export settings, workspace background, public repo and
hosted link).

## Intent

The owner orders DTF prints from a local print shop. The shop prints on film up to 60 cm wide
(about 58 cm printable), as long as needed, and charges by the meter. The owner wants to hand the
shop a file that is ready to print: every design placed, sized and checked, the owner's logo
included, so the shop just loads it and prints.

The tool is a simplified Canva for this one job, and easier than Canva for it: real print sizes in
cm on everything, the film length in meters always visible, warnings that protect the print, and
an export that keeps full image quality. It should be fast, help organize many designs, and be
flexible for future jobs (other film widths, reusable settings and sheets).

Success: the owner designs a sheet, reads off "1.37 m", exports, sends the file to the shop, and
the print comes out at exactly the sizes shown on screen and as sharp as the source images allow.

## Users

The owner and his team, preparing files for a print shop. Also anyone on the internet, since the
tool is published as a free public web page and repository. No accounts, no server, no ordering,
no pricing.

## Goals

### Sheet

1. Sheet width is any value from 10 to 160 cm (160 cm is wider than any DTF roll and keeps a
   600 DPI PNG within what a browser can draw; amended from 300 cm after review). **Width presets**: built-in "DTF 58 cm" (default)
   and "DTF 60 cm"; the user can save, rename and delete their own presets, remembered in the
   browser.
2. For one long sheet, the length is **Auto** (grows with the content; default) or **Fixed** (a typed length in cm,
   for buying an exact amount of film; designs past it are flagged).
3. cm rulers on top and side, optional 1 cm / 5 cm grid, zoom (buttons, Ctrl + wheel, Fit width,
   100%), scroll and pan for long sheets.
4. **Workspace background**, for viewing only: transparent checkerboard (default), white, black, or
   any custom colour, remembered. The export is always transparent, because a filled background
   would print as a solid block of ink on film; the export dialog says so.

4a. **Layout** (amended v4, 2026-11-18, owner's request): **One long sheet** (as before) or
    **Split into sheets** of a set length (default 100 cm, 10 to 500 cm). The editor shows each
    sheet as its own canvas with mat between them; a design must sit wholly on one sheet (a
    design across a split is flagged and blocks export). Sheets are added as designs need them.
    **Last sheet**: trimmed to its designs (default) or the full length. Arrange and Add copies
    fill sheet 1, then sheet 2. The film total is the sum of the sheet lengths. Switching layout
    or sheet length keeps every design on the same spot of the film (one long sheet is the
    reference), as one undoable step; designs that end up across a split are flagged, with a
    one-click "Move onto a sheet". The 40 mm gap between sheets in the editor is part of the
    saved file format. Up to 50 sheets.
4b. **Spacing** (amended v4 and v5): the cutting gap is measured between **Rectangles**
    (default, the owner's choice of 2026-11-18, confirmed after the Arrange results) or between
    **Real shapes**. Real shapes measures the gap between the designs' ink outlines instead of
    their rectangles, so Arrange can nest designs into each other's empty corners; the "too
    close" check measures the same way, with the same code. Outlines are conservative (never
    smaller than the ink: a 1 mm grid, every cell any visible pixel touches), so a pair that is
    too close is never missed: the measured gap is never larger than the real one, and may be
    up to about 2 mm smaller. The side edges and the splits still use each design's rectangle;
    Real shapes only changes the gap. The choice is saved with the sheet and remembered for new
    sheets. Sheets saved before the choice existed all say Rectangles without anyone having
    chosen it, so they open with Real shapes for as long as the user has never picked a spacing
    in this browser; after that, a saved sheet opens as saved.

### Designs

5. Add images by file picker, drag-and-drop onto the sheet, and paste (Ctrl+V), several at once.
   PNG with transparency is expected; JPG and WebP are accepted with a warning.
6. Fully transparent borders are trimmed on import, so every measurement is the real ink size.
   A fully transparent image is refused with a clear message.
7. Per design: move; resize with handles (aspect locked by default); type width and height in cm
   (one decimal); rotate (90° buttons, free handle, typed angle); flip horizontally or vertically;
   duplicate; "Add copies" (N copies placed in rows with the cutting gap); delete; lock position;
   rename; bring forward / send back.
8. Multi-select (drag a box, Shift+click, Ctrl+A): move, delete, duplicate together; align
   (left, centre, right, top, middle, bottom) and distribute evenly.
9. **Arrange** (rewritten v5; the owner: "the most important feature"): pack all designs (or
   the selection) into the least film. It is a search, not one pass: for about 4 seconds it
   tries many orders and turns (quarter turns, when turning is allowed; never a mirror image)
   and keeps the shortest layout, in a background worker with a progress dialog and a Stop
   button that keeps the best so far. It follows the Spacing setting: with Rectangles the
   rectangles keep the gap; with Real shapes the rectangles may overlap and the ink keeps the
   gap. Locked designs, and unselected ones when a selection is arranged, stay where they are.
   A layout that has no placement problem is only ever replaced by a shorter one, so Arrange
   never makes a good layout worse; arranging again continues from the layout on the sheet.
   One Arrange is one undo step. Add copies and new images still use the quick rectangle
   packer.

### Measurements and checks

10. The selected design shows its print size on the canvas (`30.0 × 50.0 cm`), live while
    resizing. A side list shows **all** designs with thumbnail, name, size in cm, sharpness and
    warnings; clicking a row selects the design. The total film length in meters (`1.37 m`) is
    always visible, with the number of designs.
11. Warnings:
    - Sharpness: effective DPI at the placed size. 300 or more good (green), 150 to 299
      acceptable (amber), under 150 too low (red).
    - No transparency: the image has no transparent pixels.
    - Outside the sheet: a footprint crossing the side edges or the top (dragging past them is
      prevented; typed sizes or rotation can still cause it).
    - Too close to cut: two designs closer than the cutting gap (setting, default 5 mm),
      including overlapping, measured between their rotated rectangles, or between their ink
      outlines with Spacing set to Real shape (4b). Designs on different sheets are never too
      close.
    - Past the fixed length (Fixed mode only).

### Saving and reuse

12. Undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y) for every change to the sheet.
13. The current sheet autosaves in the browser (layout and images). A failure to save is shown,
    never silent.
14. Save project / Open project as one `.printsheet` file, to move a sheet between computers or
    reuse it for a reorder. New sheet (with confirmation).
15. Remembered preferences: presets, background, grid, last export settings. A new sheet keeps the
    current width, length mode and cutting gap.
16a. Limits shared by the editor and by saving, so everything made also reopens: at most 5000
    designs per sheet, sizes from 0.001 mm to 100 m. Opening a damaged project or saved sheet keeps
    every usable design and says how many could not be restored. A locked design cannot be
    resized, flipped, rotated, moved or deleted until it is unlocked.

### Export

16. Export dialog with:
    - Format: **PDF** or **PNG**.
    - Colour (PDF): **RGB** (default) or **CMYK**. CMYK uses a standard press profile
      (FOGRA39) and the dialog says it is a generic conversion; RGB lets the shop's software
      use its own printer profile.
    - PNG resolution: 150, 300 (default), 360 or 600 DPI; DPI written into the file.
    - PDF file size (RGB): **Compact** (default; amended v3, owner's choice after a 69.6 MB
      export) stores colour as JPEG at quality 92 with full colour resolution (4:4:4) and a
      lossless soft mask, with the colour under transparency spread from the design so edges do
      not darken; **Lossless** keeps every pixel. CMYK Compact (v6, 2026-11-18) writes an Adobe-style four-channel CMYK JPEG (APP14 transform 0, inverted samples, Decode [1 0 1 0 1 0 1 0]). Lossless images and
      PNG exports use PNG row filters (Paeth).
    - PDF image quality: keep original resolution (default), or limit to 600 or 300 DPI to make
      large files smaller.
    - Mirror: **Regular** (default) or **Mirrored**, with a small preview of the file as it
      will come out (amended v4).
    - Split sheets (amended v4): **One zip** with a file per sheet (default), **One PDF** with a
      page per sheet (PDF only), or **Separate files**. Empty sheets are left out.
    - File name (default `printsheet-<width>cm-<length>m-<yyyy-mm-dd>`).
    - A summary line: final size in cm, length in meters, number of designs, warnings count.
    - Export is blocked with a message when the sheet is empty, a sheet is longer than 500 cm,
      or a design is past the side edges or across a split.
17. No blank space added at the start or end (except a last sheet set to Full length, by
    choice). Background always transparent.

### Platform

18. Runs fully in the browser. Images never leave the computer; no network requests after the
    page loads. Shipped as one self-contained HTML file that works opened from disk, and hosted
    at `https://printsheet.dhia.app`. Supported browsers: Chrome and Edge on a computer, and
    on phones iPhone Safari and Android Chrome. Up to 820 px wide the editor uses a phone
    layout: one screen with a top bar, the sheet and a bottom bar that follows the selection,
    and the panels as bottom sheets holding the same controls (amended 2026-11-19, editor plan
    rev 2).
19. Fast with many designs: the canvas shows downscaled previews (long side at most 2048 px);
    exports always use the full-resolution originals.
20. Interface in English.

## Non-goals

- Text tool, shapes, background removal, image editing, filters.
- Several separate projects in one file (a project is one job, split into sheets or not).
- Accounts, cloud storage, ordering, pricing.
- Tablets as a target of their own: below 821 px they get the phone layout, wider the
  computer one (with 44 px touch targets on a touch screen).
- Arabic interface (possible later).

## Anti-goals

- The printed size differs from the size shown on screen.
- The export loses resolution (e.g. flattening the PDF into a low-resolution image), or the
  compact mode changes anything visible in print: edges, transparency or colour detail.
- Images uploaded anywhere.
- The CMYK option presented as printer-accurate.
- Silent data loss (a failed autosave, a project file that does not reopen what was saved).

## Constraints

- Geometry stored in millimetres; the screen is only a view. 1 in = 25.4 mm, 1 pt = 25.4/72 mm.
- PDF: each image embedded once at its original (or chosen limit) resolution, placed with a
  transform; transparency kept as a soft mask (RGB and CMYK); never rasterised as a whole.
  Page size limit: 500 cm (PDF's 200 inch page limit).
- PNG: rendered and encoded in horizontal strips so long sheets at high DPI do not exhaust
  memory.
- CMYK profile: FOGRA39L_coated from colord via TeX Live's colorprofiles (zlib licence,
  "free of known copyright restrictions"); its notice ships with the app.
- Licence of the app: MIT. Third-party notices for bundled libraries.

## Approaches considered

| Approach | Trade-off | Decision |
| --- | --- | --- |
| A. Web page that runs fully in the browser (one HTML file, also hosted) | No install, no server, images stay local, free hosting | **Picked by the owner** |
| B. Installed desktop program | Heavy, harder to update | Rejected |
| C. Hosted website with logins | Hosting, accounts, upkeep | Rejected |

## Calls made by Claude (open to correction)

DPI thresholds; new image at its 300 DPI size, shrunk to fit; length rounded up to the cm;
500 cm cap; English UI; gap measured between real shapes for new sheets (v5; rectangles before);
Arrange turns by quarter turns only (other angles never won on the owner's job); background view-only (owner's last
word on it); auto-arrange added back because the owner asked for help organizing; Fixed length
mode; PNG DPI and PDF quality options; MIT licence; FOGRA39 free profile; desktop Chrome/Edge as
the supported target, then phones as well (iPhone Safari, Android Chrome; owner, 2026-11-18).

## Done means

All goals above work in the hosted page and the single file, every automated test passes
(unit, PDF/PNG cross-check, browser flows), and a person can go from images to an exported file
without help. A real print at the shop has not been made by Claude and must be checked by the
owner with a ruler.
