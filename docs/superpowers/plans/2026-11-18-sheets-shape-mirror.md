# Split sheets, shape spacing, mirror preview: implementation plan (rev 2)

**Goal:** split a job into sheets of a set length, optionally measure the cutting gap on the
ink outline (and nest by it), and choose Regular or Mirrored export with a preview.

**Spec:** `docs/superpowers/specs/2026-11-16-dtf-sheet-designer-design.md`, goals 2, 4a, 4b, 11,
16, 17 and non-goals (amended v4, 2026-11-18).

**Owner's answers (2026-11-18):** split export offers all three (zip, one PDF with pages,
separate files); last sheet offers both (trim, full); spacing defaults to rectangles.

**Rev 2** answers CTO plan review 1 (80/100): M1 to M7 and m1 to m11 are folded in below.

## Global constraints

- Model stays in mm and pure (no DOM) under `src/model/`; Node unit tests for every model rule.
- Every y-to-sheet calculation lives in `src/model/pages.ts`; no caller does its own arithmetic.
- Functions ≤ 100 lines, complexity ≤ 8; absolute `@/` imports; oxlint, oxfmt, tsc clean.
  `drawBackground` and `openExportDialog` are already over 100 lines: this work extracts from
  them (below) instead of growing them. Turning on oxlint's line and complexity rules repo-wide
  is deferred: `mountCanvas` and `mountPanel` are closure modules far over the limit, a refactor
  of its own.
- Old autosaves and `.printsheet` files open as before (defaults). A split project is written as
  version 2, which older builds refuse instead of misreading (m1).
- No network, CSP unchanged. One new runtime format (zip, by hand, store only, already written:
  `src/export/zip.ts` + test, reviewed with Phase 2, not committed in Phase 1). Dev dependency
  `fflate` only as an independent zip reader in tests.

## Rulings (open to the owner)

| Ruling | Why | Cost if wrong |
| --- | --- | --- |
| Sheets live in model space with a 40 mm gutter, frozen as file format | Drag, snap, hit tests and Fabric sync stay unchanged | Changing it later needs a file migration |
| A design must lie wholly inside one sheet, else `off-sheet`; blocks export; one-click "Move onto a sheet" | "The split itself should not have any design on it" | none |
| Empty sheets are left out; exported files are numbered 1..K of K; the summary says which sheet was empty | A gap in numbering looks like a lost file to the shop | none |
| Sheets appear automatically, plus one empty sheet after the last used one; no sheet-count input | "Whatever number of canvases I need" | owner may want a count |
| Max 50 sheets; past that a design is `off-sheet` and the blocker says why | Bounds memory, files and loops | raise later |
| Spacing is a sheet setting, saved with the sheet | It decides what the check reports for that sheet | none |
| Shape gap: one shared collision primitive for check and packer (below) | Consistent by construction; a too-close pair is never missed | over-warns by about 1 to 2 mm |
| Only the Arrange buttons nest by shape; Add copies and new images use rectangles | Rectangles are conservative and synchronous | slightly more film for copies |
| Deploy after Phase 2; Phase 3 starts with a go/no-go spike | Split and mirror are useful alone; shape packing is unproven | none |
| Mirror is Regular / Mirrored (segmented) with a preview of sheet 1 | Owner asked to see the result | none |

## Phase 1: sheets in the model and the editor

### Model

- `Settings` gains `layout: 'single' | 'split'`, `pageLengthMm` (100 to 5000, default 1000),
  `lastPage: 'trim' | 'full'`, `spacing: 'box' | 'shape'`. `validateSettings` fills defaults
  when a key is absent and rejects bad values. `persist.ts` and `project-file.ts` write version 2
  when `layout === 'split'`, read 1 and 2.
- `pages.ts`, all bounded by `MAX_PAGES = 50` (never by design y; a crafted file can put y at
  1,000,000 mm):
  - `PAGE_GUTTER_MM = 40`, `bandOf(i, s) = { top: i * (L + G), bottom: top + L }`.
  - `pageOf(design, s)`: the sheet whose band holds the whole footprint, else null.
  - `pageCount(sheet)`, `pageLengths(sheet)`: per sheet; the last used one is
    `min(L, ceil-to-cm(content))` when trimmed, `L` when full; empty sheets 0.
  - `filmLengthMm(sheet)`: one long sheet as today; split = sum of `pageLengths`.
  - **`toSplit(sheet, L)`**: each design moves down by `k * G`, where `k = floor(topEdge / L)`
    is the sheet holding its top edge in film coordinates, crossing a split or not.
  - **`toSingle(sheet)`**: each design moves up by `k * G`, where `k` is the band of
    `L + G` holding its top edge (a top edge in a gutter belongs to the sheet above).
  - **Sheet length change** = `toSingle` then `toSplit` with the new length: a design keeps its
    film position (at 80 cm on a sheet shrunk to 50 cm it moves to sheet 2 at 30 cm).
  - Layout or length changes commit settings and designs together, as one undo step.
  - `moveOntoSheets(sheet, ids)`: places the given off-sheet designs in the first free spots of
    the band packer, everything else fixed (the one-click fix).
- `checks.ts`: `off-sheet` (split only); `past-length` only for one long sheet in Fixed mode;
  too-close pairs only within one sheet; `exportBlocker` names designs across a split, a design
  taller than a sheet ("X is 120 cm tall, longer than one sheet (100 cm). Make the sheets longer
  or the design smaller."), and designs past sheet 50; the 5 m message says "Split into sheets".
- `packer.ts`: optional bands; candidate rows start at each band top; a box never crosses a
  band bottom; nothing past band 50. Bitset rows are allocated per band only when used (m4).

### Call sites that change meaning in split layout (M2)

`main.ts` `placeNewDesigns` (bands, fallback) and the Arrange toast (film total) ·
`align.ts` single-design alignment to its own sheet · `ops.ts` `duplicateDesigns` (band-aware
via the packer when "below" leaves the sheet) and `moveOntoSheet` (+ `off-sheet`) ·
`arrange.ts` `lengthOf` (film total) and `fill` (bands) · `actions.ts` `placeCopies` · every
Fixed-mode reader (`checks.ts`, `align.ts`, `canvas.ts` view length and cut line,
`export-dialog.ts` notes) ignores Fixed in split · `inspector.ts` `ISSUE_TEXT` `off-sheet` and
its "Move onto a sheet" button · `export/worker.ts` blocker per part · `panel.ts` film box.

### Editor

- Settings panel: Layout (One long sheet / Split into sheets); in split: Sheet length (cm), with
  a hint when it is shorter than the tallest design, and Last sheet (Trim to designs / Full
  length); Length (Auto / Fixed) only for one long sheet. Film box: total metres and "3 sheets".
- On switching to split: a toast "4 designs cross a split" with **Move them onto a sheet**.
- Canvas: `drawSheet(ctx, band, length, label)` extracted from `drawBackground`; each sheet its
  own film rectangle, cut line and label ("Sheet 2 · 1.00 m"); mat in the gutters; one empty
  sheet after the last. Sheet tops and ends join the snap targets.
- Rulers: `drawRulers` takes the settings; labels count centimetres from each sheet's top; no
  labels over a gutter.

### Tests

Unit: `toSplit`/`toSingle` round trip is the identity (property, random designs); length A to B
to A is the identity when nothing crosses; the crossing design at film 2990 to 3010 ends up
flagged, not hidden on sheet 3; a top edge in a gutter; trimmed length clamp with a
non-whole-cm sheet; 50-sheet cap; crafted y = 1e6 stays fast; validate defaults and version 2;
checks per sheet; arrange and add copies per sheet; align within a sheet. E2E: switch layout,
crossing flagged, Move onto a sheet, Arrange fills sheet 1 then 2, undo restores, reload keeps it.

## Phase 2: export of sheets, zip, mirror preview (then deploy)

- `pages.ts` `splitForExport(sheet)`: each non-empty sheet as a one-long-sheet `Sheet`
  (designs shifted to its top, fixed length from `pageLengths`), numbered 1..K.
- `buildPdf(pages: Sheet[], ...)`: one page per sheet, each image embedded once at its largest
  placement over all pages, one XObject name per page pointing at the shared ref.
- `ExportOptions.splitOutput: 'zip' | 'pdf-pages' | 'files'` (PNG: zip or files), defaulted and
  validated in `prefs.ts`.
- Worker contract: `done` carries `files: { name, blob }[]`. The worker builds the zip and the
  multi-page PDF itself; for separate files it returns one entry per sheet. Progress reads
  "Sheet 2 of 3: adding images 40%". `pngBlocker` / `pngSize` per part. Names
  `<name>-sheet-2-of-3.pdf`.
- **Separate files (M6):** no burst of downloads. The dialog lists "Download sheet 1 of 3"
  buttons, one per file; each click is a user gesture, so Chrome never asks to allow multiple
  downloads and nothing can be dropped silently.
- Export dialog, extracted into `summaryText`, `splitOutputRow`, `mirrorRow`: the split choice
  shows with 2+ sheets; the summary uses the film total and names an empty sheet left out;
  Mirror is Regular / Mirrored with `mirrorPreview` (sheet 1 drawn from the previews, failed
  previews as the canvas placeholder, flipped when mirrored).

Tests: unit (zip already; `splitForExport` numbering with an empty middle sheet; multi-page PDF
geometry; prefs default). E2E: zip of 2 PDFs read back with fflate, each cross-checked with
pdf.js against the oracle for its sheet; one 2-page PDF; separate-file buttons give 2 downloads;
PNG zip; the preview flips; zip opens in Windows (checked by hand once, done for the writer).

Then: README, CTO GO, deploy to printsheet.dhia.app, live check.

## Phase 3: shape spacing

### Step 0: go/no-go spike (local only, never committed)

Raster packer as a Node test over the owner's 17 real images. Bar: at least 5% less film than
rectangles on that set, and under 2 s for 200 designs. Also report how many masks are close to
their full rectangle (faint halos). Below the bar: stop, report to the owner, ship rectangles
only. An alpha threshold for faint pixels is the owner's call (it trades a missed gap for film).

### The shared primitive (M5)

- One grid for the whole sheet, anchored at the sheet's top-left, cell `C = 1 mm`.
- Masks: `ShapeMask { cols, rows, cells: Uint8Array /* 1 byte per cell */, sum: Uint32Array }`,
  long side ≤ 512, a cell set when any pixel under it has alpha > 0 (max-pooled from the full
  image, never from the 2048 px preview). Computed in the import worker at import; for restored
  assets the same code runs lazily in that worker (full decode, the same cost as an import).
  Cached in memory by asset id (`src/image/masks.ts`).
- `poseCells(design, mask)`: the design's conservative cells in the global grid. For each grid
  cell in the footprint, map its square back into mask space and test the bounding mask cells
  with the summed-area table: set if any ink can touch it. Cost is proportional to the design's
  area in cells, not to the mask size.
- Distance between two cells = the distance between their squares:
  `C * hypot(max(0, |di| - 1), max(0, |dj| - 1))`, never more than the real ink distance.
- Too close ⇔ some pair of cells is closer than the gap. The check tests it directly with an
  offset table; the packer tests the same predicate (its candidate dilated by the offset table
  against the occupancy). The packer places footprints on cell corners, so the check rasterises
  them identically: its output can never trip the check.
- Invariants: `outside` and `off-sheet` stay rectangle-based; the packer rotates (0/90/180/270
  when rotation is allowed) and never flips.

### Check performance and freshness (M4)

- Pose cells cached by (assetId, x, y, w, h, angle, flips, mask version); pair results cached by
  both keys; `findIssues` memoised by sheet identity and masks version (`WeakMap`).
- The store gains a masks version: a mask landing re-renders the issues (no history entry).
- Shape mode falls back to rectangles for a pair until both masks are ready (over-warns).
- `perf.test.ts` gains a shape case: 400 designs, warm under 20 ms, cold under 1 s.

### Shape Arrange (M4)

- The two Arrange buttons (toolbar, inspector) run the shape packer in a worker. While it runs a
  busy dialog with Stop blocks editing; the result is also discarded if the sheet is no longer
  the snapshot that was sent.
- Occupancy as bitset rows per band, allocated when used; skip-ahead per row with a
  last-occupied index; candidates bottom-left per band, then the next band.

### Tests

Unit: `poseCells` covers every ink pixel at every 15° and with flips (brute force); measured
distance ≤ exact distance between mask cell squares (property, random small masks and poses);
packer output passes the check (property, random shapes); two L shapes nest shorter than
rectangles; bands respected. E2E: two interlocking designs not flagged in Real shape where
rectangles are; Arrange in Real shape gives a shorter sheet; stress 200 designs under 2 s.

## Review focus

1. Old saves and project files open unchanged; layout and length switches are one undo; the
   round trip is the identity.
2. A design across a split, taller than a sheet or past sheet 50 can never reach an export.
3. The shape check never reports a gap larger than the real ink distance.
4. Shape Arrange output never trips the shape check and never crosses a sheet end; a stale
   result never overwrites newer edits.
5. Multi-file export: numbering 1..K, nothing dropped, zip opens in Windows.

## Done means

Each phase passes unit and browser tests in both projects (file and served with CSP) with a CTO
GO; README and spec say what the app does; deploy after Phase 2 and again after Phase 3.

## Backlog (from the reviews)

- Turn on oxlint `max-lines-per-function` (100) and `complexity` (8) repo-wide. Blocked by two
  closure modules far over the limit, `mountCanvas` (`src/editor/canvas.ts`) and `mountPanel`
  (`src/editor/panel.ts`); splitting them is a refactor of its own (CTO review, 2026-11-18).
- The autosave version gate (refuse a newer saved format) has no unit test: Node has no
  IndexedDB. It runs through the same path as the project-file gate, which is tested.
