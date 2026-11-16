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
2. Sheet length is **Auto** (grows with the content; default) or **Fixed** (a typed length in cm,
   for buying an exact amount of film; designs past it are flagged).
3. cm rulers on top and side, optional 1 cm / 5 cm grid, zoom (buttons, Ctrl + wheel, Fit width,
   100%), scroll and pan for long sheets.
4. **Workspace background**, for viewing only: transparent checkerboard (default), white, black, or
   any custom colour, remembered. The export is always transparent, because a filled background
   would print as a solid block of ink on film; the export dialog says so.

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
9. **Auto-arrange**: pack all designs (or the selection) top to bottom within the sheet width with
   the cutting gap, optionally allowing 90° rotation, to save film. Undoable.

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
      including overlapping, measured between their rotated rectangles.
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
    - PDF image quality: keep original resolution (default), or limit to 600 or 300 DPI to make
      large files smaller.
    - Mirror (off by default).
    - File name (default `printsheet-<width>cm-<length>m-<yyyy-mm-dd>`).
    - A summary line: final size in cm, length in meters, number of designs, warnings count.
    - Export is blocked with a message when the sheet is empty or longer than 500 cm.
17. No blank space added at the start or end. Background always transparent.

### Platform

18. Runs fully in the browser. Images never leave the computer; no network requests after the
    page loads. Shipped as one self-contained HTML file that works opened from disk, and hosted
    at `https://printsheet.dhia.app`. Chrome and Edge on desktop are the supported browsers.
19. Fast with many designs: the canvas shows downscaled previews (long side at most 2048 px);
    exports always use the full-resolution originals.
20. Interface in English.

## Non-goals

- Text tool, shapes, background removal, image editing, filters.
- Several sheets in one project.
- Accounts, cloud storage, ordering, pricing.
- Phones and tablets (the page must not break on them, but editing targets desktop).
- Arabic interface (possible later).

## Anti-goals

- The printed size differs from the size shown on screen.
- The export loses resolution (e.g. flattening the PDF into a low-resolution image).
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
500 cm cap; English UI; gap measured on rectangles not pixels; background view-only (owner's last
word on it); auto-arrange added back because the owner asked for help organizing; Fixed length
mode; PNG DPI and PDF quality options; MIT licence; FOGRA39 free profile; desktop Chrome/Edge as
the supported target.

## Done means

All goals above work in the hosted page and the single file, every automated test passes
(unit, PDF/PNG cross-check, browser flows), and a person can go from images to an exported file
without help. A real print at the shop has not been made by Claude and must be checked by the
owner with a ruler.
