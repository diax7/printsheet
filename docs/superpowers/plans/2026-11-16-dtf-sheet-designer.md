# PrintSheet Implementation Plan (v2)

> **For agentic workers:** executed inline (superpowers:executing-plans) under the cto-cycle:
> a CTO review after each phase, GO = score >= 90 and no blocker. Steps use `- [ ]`.

**Goal:** A browser tool, shipped as one self-contained HTML file and hosted at
printsheet.dhia.app, for laying out transparent designs on a DTF film sheet with exact cm sizes,
organizing them, and exporting a print-ready PDF (RGB/CMYK) or transparent PNG.

**Architecture:** A pure, framework-free model in millimetres (`Sheet`, `Design`, `ImageAsset`,
`Settings`) held in one store with history; Fabric.js is only the view (1 canvas unit = 1 mm,
zoom via the viewport transform) and reports gestures back to the store; the DOM panels are plain
TypeScript modules subscribed to the store. Exports read the model and the full-resolution asset
bytes, never the screen. Heavy work (PDF/PNG export, CMYK) runs in a Web Worker so the tab stays
responsive.

**Tech Stack:** TypeScript 7, Vite 8 + vite-plugin-singlefile, Fabric.js 7, pdf-lib 1.17,
jsColorEngine 1.7 (CMYK), idb-keyval (autosave), Vitest 5, Playwright 1.65 (browser flows),
pdfjs-dist (test-only, independent PDF renderer), fast-png (test-only), oxlint.

**Spec:** `docs/superpowers/specs/2026-11-16-dtf-sheet-designer-design.md`

## Global Constraints

- Geometry in mm. 1 in = 25.4 mm; 1 pt = 25.4/72 mm. Sizes shown in cm with one decimal.
- Sheet width 100..1600 mm; default preset "DTF 58 cm" = 580 mm; built-in "DTF 60 cm" = 600 mm.
- Cutting gap default 5 mm. DPI levels: >= 300 good, 150..299 ok, < 150 low.
- Length (Auto) = lowest footprint edge rounded up to the next 10 mm; max 5000 mm.
- New image: 300 DPI size, scaled to fit the sheet width.
- Canvas previews: long side <= 2048 px. Exports: originals.
- No network requests after load. Everything bundled into `dist/index.html`.
- No relative `..` imports (alias `@/` = `src/`). Lint and type check with zero warnings.
- Supported: desktop Chrome / Edge. English UI.

## Review Focus

1. Fully transparent PNG → refused with a message, never a 0 × 0 design.
2. Rotated design near an edge → edge, gap and length checks use the rotated footprint.
3. 8000 × 8000 px source → import responsive, PDF embeds it once however many copies.
4. Empty sheet or > 5000 mm → export blocked with a message.
5. Autosave quota exceeded / project file from a future version / corrupt file → visible error,
   current work untouched.
6. PDF vs PNG disagreement (y flip, rotation sign, mirror, soft mask) → caught by rendering the
   PDF with an independent renderer and comparing with the PNG.

## Amendments after CTO plan review (round 1, 80/100)

These override anything below that disagrees.

- **A1 Canvas = viewport (M1).** The Fabric canvas is the size of the visible area only. A
  spacer element inside a scroll container has the sheet's full zoomed size; on scroll, the
  viewport transform is set to `[z, 0, 0, z, -scrollLeft + margin, -scrollTop + margin]`. Rulers
  read the same transform. Nothing ever allocates a canvas the size of the sheet.
- **A2 Sync rules (M2).** (a) On `object:modified`, read each object's absolute transform with
  `calcTransformMatrix()` + `util.qrDecompose`, never `left`/`top` of selection children.
  (b) Multi-selections are move-only (`lockScalingX/Y`, `lockRotation`, no controls); single
  objects get uniform scaling and rotation; `lockScalingFlip: true`. (c) Store→view: when the
  objects being written are inside an ActiveSelection, discard it, write, then rebuild it from
  the same ids. (d) Selection loop guard: compare id sets before acting. (e) One history entry
  per gesture (`object:modified`); arrow-key nudges within 600 ms merge into one entry.
  (f) `originX/originY: 'center'` set explicitly. **Test:** in the browser, every Fabric
  object's `getCoords()` equals `corners(d)` for plain, 30°, flipped and 30° + flipped designs.
- **A3 Canvas limits (M3).** `MAX_WIDTH_MM = 1600`. Constants `MAX_CANVAS_SIDE = 32000` px and
  `STRIP_AREA = 16_777_216` px. PNG export blocked when `width px > MAX_CANVAS_SIDE` ("lower
  the DPI or export a PDF"); strip rows = `floor(STRIP_AREA / widthPx)`. Import refuses images
  over 16384 px on a side or 2^28 px in area. A sentinel pixel is read back after rendering each
  strip that has content, and after each import decode; a blank result throws a clear error.
- **A4 Memory (M4).** `ImageAsset.blob: Blob` (done). PNG export decodes an asset when the strip
  cursor reaches its first design (at the size it is needed, `createImageBitmap(blob,
  { resizeWidth, resizeHeight, resizeQuality: 'high' })`) and closes it after its last row.
- **A5 Project file (M5).** Binary container: `"PSHEET01"` (8 bytes) + u32 header length +
  header JSON (`{ version: 1, sheet, assets: [{ id, name, widthPx, heightPx, hasTransparency,
  offset, size }] }`) + the asset PNG blobs back to back. `parseProject` validates: magic,
  version (newer → "made by a newer PrintSheet"), header length, every number finite and in range,
  offsets inside the file, every `assetId` present; names are only ever shown via `textContent`.
- **A6 Autosave (M6).** IndexedDB keys `asset:<id>` (written once, when added) and `sheet`
  (layout + asset ids, debounced 500 ms). Assets not referenced by the sheet or the undo history
  are deleted after a successful write. `navigator.storage.persist()` requested once. A second
  open tab is detected with a `BroadcastChannel` ping and shown as a warning banner.
- **A7 Cross-check (M7).** Runs over http (`vite preview`), pdfjs-dist renders on a transparent
  background. Legs: (1) ground truth: the PNG's opaque bounding box per placed fixture equals
  `footprint(d)` in px ±1; (2) PDF (RGB) vs PNG: alpha IoU ≥ 0.98 and mean colour within 6/255;
  (3) CMYK: alpha IoU only, plus channels checked in the unit test; (4) mirror oracle: mirrored
  PNG equals the unmirrored PNG flipped; cases include 30° + flipX.
- **A8 Speed (M8).** Done: packer with row sweep, sweep-and-prune checks, `MAX_COPIES = 500`,
  budget tests at 400 designs (arrange < 300 ms, with rotation < 900 ms, checks < 20 ms).
  Algorithm is bottom-left fill, not shelf packing.
- **A9 Edge blocks export (M9).** Done. In Fixed mode an export longer than the fixed length
  says so in the dialog.
- **A10 Worker (minor 1, 2).** `import ExportWorker from '@/export/worker?worker&inline'`, Vite
  `worker.format: 'iife'` set explicitly; client handles `error` and `messageerror`; Cancel
  terminates the worker. Import (decode, trim, encode, preview) also runs in a worker. The first
  Phase 5 browser test is a real export from `file://`.
- **A11 Assets (minor 4, 5, NIT).** Every import is re-encoded through a canvas (8-bit sRGB) on
  purpose. One preview bitmap per asset shared by all copies. Identical imports are deduplicated
  by SHA-256 of the decoded trimmed PNG.
- **A12 Deny by default (minor 8).** `vercel.json` CSP: `default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; worker-src blob:;
  connect-src blob: data:; font-src data:; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`. The ICC profile is inlined and decoded without fetch. e2e asserts
  zero requests leave the page.
- **A13 Public repo (minor 9, 10).** Before going public the history is squashed so no early
  draft with personal details is published; one-job GitHub Actions workflow (lint, types, unit,
  build, Playwright) with actions pinned by SHA, `persist-credentials: false`, least
  privilege; Dependabot monthly with cooldown. THIRD_PARTY_NOTICES says where to get
  jsColorEngine's source (MPL-2.0 §3.2).
- **Ruling: default export format stays PDF** (the owner asked for "one PDF file"); the dialog
  remembers the last choice and its help text says many DTF shops prefer PNG.

## File map

```
index.html                 app shell (toolbar, canvas area, side panel, dialogs)
src/main.ts                boot: load prefs + autosave, mount views
src/styles.css
src/model/types.ts         Sheet, Design, ImageAsset, Settings, Preset, ExportOptions
src/model/units.ts         mm/pt/px conversions, formatting
src/model/geometry.ts      corners, footprint, length, DPI, polygon distance, initial size
src/model/checks.ts        findIssues, exportBlocker
src/model/arrange.ts       auto-arrange (bottom-left fill via src/model/packer.ts), add copies
src/model/align.ts         align and distribute
src/model/ops.ts           pure sheet operations (add, update, remove, duplicate, reorder, flip)
src/store/store.ts         state + subscribe + history integration
src/store/history.ts       undo/redo stack
src/store/persist.ts       autosave (idb-keyval), preferences (localStorage)
src/store/project-file.ts  .printsheet serialize/parse (versioned)
src/image/trim.ts          trim bounds, transparency detection (pure)
src/image/import.ts        decode, trim, preview, asset creation (browser)
src/editor/canvas.ts       Fabric view: sync, gestures, clamp, snap, labels
src/editor/rulers.ts       cm rulers
src/editor/toolbar.ts      zoom, background, grid, add, undo/redo, export button
src/editor/panel.ts        sheet settings, design list, selection inspector
src/editor/export-dialog.ts
src/editor/toast.ts
src/export/pdf.ts          buildPdf (pure, runs in worker and Node tests)
src/export/cmyk.ts         rgbaToCmyk via jsColorEngine + FOGRA39
src/export/png-stream.ts   streaming PNG encoder (pure)
src/export/png.ts          strip renderer (OffscreenCanvas)
src/export/worker.ts       export worker entry
src/export/client.ts       main-thread wrapper for the worker
src/assets/cmyk-profile.icc
tests/unit/*.test.ts       Vitest (Node)
tests/e2e/*.spec.ts        Playwright (Chromium), against dist/index.html via file:// and,
                           after deploy, against the live URL
tests/fixtures/            generated PNG/JPG fixtures (asymmetric shapes, alpha edges)
```

---

## Phase 1: Model core

**Produces** (exact names other phases use):
- `types.ts`: `ImageAsset { id; name; bytes: Uint8Array /* trimmed PNG */; widthPx; heightPx;
  hasTransparency; preview?: Blob }`; `Design { id; assetId; name; xMm; yMm /* centre */;
  widthMm; heightMm; angleDeg; flipX; flipY; locked }` (array order = stacking order);
  `Settings { sheetWidthMm; lengthMode: 'auto'|'fixed'; fixedLengthMm; gapMm }`;
  `Sheet { designs: Design[]; settings: Settings }`; `Preset { id; name; widthMm; builtIn }`;
  `ExportOptions { format: 'pdf'|'png'; color: 'rgb'|'cmyk'; pngDpi: 150|300|360|600;
  pdfMaxDpi: 'original'|600|300; mirror: boolean; fileName: string }`;
  constants `DEFAULT_SETTINGS`, `BUILT_IN_PRESETS`, `MAX_SHEET_LENGTH_MM = 5000`,
  `MIN_WIDTH_MM = 100`, `MAX_WIDTH_MM = 3000`.
- `units.ts`: `mmToPt`, `mmToPx(mm, dpi)`, `pxToMm(px, dpi)`, `formatCm(mm)` → `"30.0"`,
  `formatM(mm)` → `"1.37 m"`.
- `geometry.ts`: `corners(d)`, `footprint(d)`, `contentLengthMm(designs)` (rounded up to 10 mm),
  `sheetLengthMm(sheet)` (auto → content, fixed → fixedLengthMm), `effectiveDpi(d, asset)`,
  `dpiLevel(dpi)`, `polygonDistance(a, b)`, `initialSize(asset, sheetWidthMm)`.
- `checks.ts`: `Issue { kind: 'low-dpi'|'ok-dpi'|'no-transparency'|'outside'|'too-close'|
  'past-length'; otherId? }`, `findIssues(sheet, assets)`, `exportBlocker(sheet)`.
- `ops.ts`: `addDesigns`, `updateDesign`, `removeDesigns`, `duplicateDesigns`,
  `reorder(id, 'forward'|'back'|'front'|'bottom')`, all pure `(sheet, ...) => Sheet`.
- `align.ts`: `align(sheet, ids, edge)`, `distribute(sheet, ids, axis)`.
- `arrange.ts`: `autoArrange(sheet, ids | 'all', { allowRotate })` (shelf packing: sort by
  footprint height desc, fill rows left to right with `gapMm`, rows top to bottom; with rotation,
  rotate a design 90° when that lowers the row height and still fits; locked designs stay and are
  treated as obstacles); `placeCopies(sheet, id, count)`.

**Tests (tests/unit/model.test.ts, ops.test.ts, arrange.test.ts)**, each watched failing first:
units round-trips; length rounding (100 → 100, 100.4 → 110, empty → 0); 90° footprint swap;
effectiveDpi 3000 px over 254 mm → 300; dpiLevel boundaries 300/299/150/149; initialSize fit;
issues: crossing x = width, crossing y = 0, 45° corner crossing x = 0, 3 mm apart with gap 5,
6 mm apart, overlapping, no-transparency, past fixed length; exportBlocker empty / 5010 / 4990;
ops immutability (input sheet unchanged); reorder; align left/centre on rotated designs uses
footprints; arrange: results inside width, pairwise distance >= gap, no overlap with locked
designs, deterministic, total length <= naive stacking, rotation reduces length on a tall/wide
mix; placeCopies count and gap; property test (random designs, 200 runs) that arrange output
always satisfies width + gap invariants.

## Phase 2: Image pipeline

**Produces:** `trimBounds(rgba, w, h)`, `hasTransparentPixels(rgba)`; `importFiles(files:
File[] | Blob[]): Promise<{ assets: ImageAsset[]; errors: string[] }>` (createImageBitmap →
OffscreenCanvas → trim → PNG bytes; preview downscaled to 2048 px; one failure does not stop the
others; errors: `"<name>" is fully transparent`, `"<name>" could not be read as an image`).

**Tests:** trim bounds (inner box, none, full, single pixel, alpha edge at 1); transparency flag;
browser test (Phase 3 e2e) imports a fixture with a 200 px transparent border and shows the
trimmed size.

## Phase 3: Editor shell and canvas

**Produces:** `createStore(initial)` with `get()`, `set(mutator, { record })`, `select(ids)`,
`undo()`, `redo()`, `subscribe(fn)`; `mountCanvas(el, store)`; rulers; toolbar.

Behaviour: sheet as a rectangle with the chosen background (checkerboard pattern for
transparent); canvas sized to the sheet's length + 50 cm room below (auto mode); Fabric images
from previews scaled so `widthMm` matches; clamp so footprints stay within 0..width and y >= 0;
snapping (6 screen px) to sheet edges, other designs' edges and edges + gap; size label above
the selection; multi-select via Fabric ActiveSelection, committed back to individual designs on
`object:modified`; keyboard: arrows 1 mm / Shift 10 mm, Delete, Ctrl+D, Ctrl+A, Ctrl+Z,
Ctrl+Shift+Z, Ctrl+Y, Ctrl+V (paste images), Escape; zoom: buttons, Ctrl+wheel around the
pointer, Fit width, 100% (real size at 96 px/in); drop zone overlay; toasts for errors.

**Tests:** history unit tests (order, cap 200, redo cleared after a new change); e2e flows:
upload fixture → list shows size and the label shows the same size; drag cannot cross edges;
typed width updates the canvas; undo/redo restores; background switch changes the workspace
(screenshot compare of a corner pixel); zoom changes on-screen size but not the cm label.

## Phase 4: Panel, organizing, persistence

**Produces:** side panel (sheet: preset select + save/rename/delete, width, length mode +
fixed length, gap, background, grid; summary: length, designs, warnings; design list; inspector
for the selection: name, W, H, aspect lock, angle, rotate ±90, flip H/V, lock, copies, layer
order, align/distribute for multi-select, arrange); `serializeProject` / `parseProject`
(version 1, assets base64, unknown version → error); autosave debounced 500 ms with visible
"Saved" / "Not saved: <reason>" status; preferences in localStorage.

**Tests:** project round-trip (every field, bytes equal), corrupt and future-version files
throw clear errors; e2e: reload restores the sheet; save project → new sheet → open project →
same designs; preset save/select changes width; fixed length shows past-length warning; copies
N creates N; arrange shortens the sheet; align left aligns footprints.

## Phase 5: Export

**Produces:** `buildPdf(sheet, assets, opts, cmyk?: CmykConverter): Promise<Uint8Array>`;
`rgbaToCmyk`; `encodePng({ width, height, dpi, rowsPerStrip, renderStrip })`;
`renderStripRgba(...)`; worker protocol `{ type: 'export', sheet, assets, opts }` →
`{ type: 'progress', done, total }` / `{ type: 'done', blob, fileName }` / `{ type: 'error',
message }`; export dialog.

PDF details: page = width × length in pt; each asset embedded once per (asset, resolution
limit) — RGB via `embedPng`; CMYK as a Flate image XObject `/DeviceCMYK` 8 bpc with a
`/DeviceGray` `/SMask`; designs drawn with `cm` (translate to centre with y flipped, rotate by
−angle, scale by ±size for flips, translate −0.5); mirror wraps everything in
`[-1 0 0 1 W 0]`; optional downsampling to the chosen max DPI per design's placed size (largest
placement of that asset). PNG: IHDR RGBA 8-bit, pHYs, IDAT via `CompressionStream('deflate')`
fed strip by strip, CRC32, IEND.

**Tests:** unit: page size 580 × 1000 mm → 1644.09 × 2834.65 pt; one XObject for two copies;
placement matrix numbers for a known design (plain, rotated 30°, flipped, mirrored); CMYK
XObject has `/DeviceCMYK` and `/SMask`; white → 0,0,0,0; downsampling reduces pixel count to the
limit; PNG encoder round trip via fast-png incl. pHYs = 11811 px/m at 300 DPI.
**Cross-check (e2e, in Chromium):** build a sheet with an asymmetric fixture (an "F" shape with
soft alpha edges) placed plain, rotated 30°, flipped; export PNG at 150 DPI and PDF (RGB, CMYK,
mirrored); render the PDF with pdf.js at the same DPI; compare alpha masks (IoU >= 0.98) and
mean colour per region (RGB within 6/255). Mirror check: PDF-mirrored equals PNG-mirrored.

## Phase 6: Hardening, docs, deploy

- Stress in the browser: 8000 × 8000 fixture import time and responsiveness; 40 designs drag
  smoothness (frame time); 5 m PNG at 300 DPI completes without crashing; 600 DPI 1 m.
- Visual QA: screenshots of empty state, busy sheet, dialogs, dark background; fix what looks
  wrong. Keyboard focus visible; buttons have labels; contrast.
- README (what it is, how to use, warnings explained, export settings explained, privacy, CMYK
  note, run locally, licence), LICENSE (MIT), THIRD_PARTY_NOTICES (Fabric MIT, pdf-lib MIT,
  jsColorEngine MPL-2.0, idb-keyval Apache-2.0, FOGRA39 zlib).
- Public docs: the spec and plan use neutral wording (no personal details).
- GitHub: public repo `diax7/printsheet`, push `main`. Vercel: project `printsheet`, static
  `dist/`, connected to the repo; domain `printsheet.dhia.app` only after confirming no other
  project owns it. Re-run the e2e suite against the live URL, asserting no request leaves the
  origin.
