# Vector and Photoshop files: implementation plan

> For agentic workers: build phase by phase; each phase is tested, CTO-reviewed and released on
> its own (the release steps in the 2026-11-19 editor plan). Steps are TDD: the failing test
> first.

**Goal.** PrintSheet accepts SVG, PDF, AI (PDF-compatible) and PSD files, keeps vectors sharp
in every export, and shows each design's file type.

**Spec.** `docs/superpowers/plans/2026-11-18-roadmap.md` item 3, with the owner's answers of
2026-11-19:
- **PSD:** pick from a list. Visible layers start ticked and hidden ones unticked. A folder can
  be added merged or opened. "Whole image as one design" is offered too.
- **Layer effects:** the layer is added without them, and its row says so.
- **Order:** this item comes before quantity, presets and the Photo Editor.

**Architecture.** Every vector design keeps a normal PNG `blob` (a base render), so the screen,
trim, ink mask, autosave and Arrange work unchanged. The original file travels beside it in
`asset.vector`, and every export re-renders it at the placed print size just before the export
worker starts. PSD layers become ordinary PNG images inside the import worker.

**Tech.**
- **pdfjs-dist 6.5.438:** moves from a dev dependency to a runtime one. Its worker is inlined
  as a blob worker, which the policy already allows (`worker-src blob:`).
- **ag-psd 34.2.0:** MIT. Published 2026-11-11, so it is past the 7-day wait. Two dependencies,
  pako and base64-js. `npm audit`: 0.

## Spike results (2026-11-19, throwaway branch, real single-file build)

- **pdf.js in Chromium:** renders served under the hosted policy and from disk, with no console
  errors, using `isEvalSupported: false` and `useSystemFonts: true`, and without wasm, cmap or
  font URLs.
- **Transparency:** `background: 'rgba(0,0,0,0)'` keeps the page transparent (corner alpha 0).
  Unembedded Helvetica text renders.
- **SVG:** draws to a canvas and reads back in Chromium and WebKit, with no taint.
- **SVG without width and height:** an SVG with only a viewBox reports 300×150. Its shape must
  come from the viewBox.
- **ag-psd in the browser:** reads with `useImageData: true` and needs no canvas. It gives the
  layers, the `hidden` flag, folders (`children`) and the composite image (`imageData`).
- **Structure-only read:** `skipLayerImageData` with `skipCompositeImageData` reads only the
  structure, for limits before decoding.
- **Bundle:** 1.67 MB grows to 3.65 MB. That is the cost of both libraries; one HTML file
  cannot load them lazily. It is measured live after each release.

## Real Photoshop files (owner's, 2026-11-19; local only, never committed)

Nine real files were read with ag-psd 34.2.0: logos, mockups, 1.4 to 224 MB, 1320×884 to
11257×6990 px.
- **Mode:** all are 8-bit RGB.
- **Resolution:** 8 of 9 are saved at 72 ppi. That is Photoshop's default and not the print
  size, so **PSD designs are placed like any image (`PLACEMENT_DPI`), not by the file's
  resolution.**
- **Layer kinds:** text layers and smart objects carry their pixels; adjustment layers carry
  none.
- **Composite:** every file has one.
- **Common features:** effects (up to 13 layers in one logo file), masks, clipping, and the
  blend modes multiply, screen, soft light, color and linear burn. Linear burn has no canvas
  equivalent, so it falls back to Normal with a note.
- **Memory:** the 224 MB mockup took 1.5 GB to read in Node and the 11257×6990 logo file
  0.6 GB, so **files over 300 MB are refused** (*"This PSD is too large to open here (over
  300 MB). Save a copy with fewer layers, or export the layers you need as PNG."*). Any
  out-of-memory error is caught and reported for that file.
- **Node shim:** in Node (unit tests), `initializeCanvas` needs an ImageData maker. The browser
  worker has one built in.

## Global constraints

- **Security policy:** keep it as it is, with no new network access; never `unsafe-eval` or
  wasm.
- **Limits:**
  - Every image the app makes stays within `MAX_IMPORT_SIDE` 16384 and `MAX_IMPORT_AREA`
    100 MP.
  - Every main-thread render reuses the blank-pixel check. iPhone canvases fail silently and
    blank.
- **Errors:** one bad file never stops the others (the existing `errors[]`). Every refusal says
  what to do instead.
- **Code:** no em dashes in copy. Absolute `@/` imports. oxfmt and oxlint clean. Functions of
  100 lines or less.
- **Saved data:** old saved sheets and project files still open. A file with a vector or a
  format writes the next project version only when it has to (as `formatVersion` does now).

## Data model (Phase A and B)

```ts
type FileFormat = 'png' | 'jpg' | 'webp' | 'gif' | 'svg' | 'pdf' | 'ai' | 'psd';
interface VectorSource {
  type: 'svg' | 'pdf';            // AI is read as PDF
  blob: Blob;                     // the original file, untouched
  page: number;                   // 1-based; 1 for SVG
  crop: { x: number; y: number; w: number; h: number }; // trimmed ink box, 0..1 of the page
  sizeMm: { w: number; h: number }; // physical size of the cropped artwork, from the file
}
interface ImageAsset { ...; format?: FileFormat; vector?: VectorSource }
```

- **No `format`:** an asset saved before this change has no badge.
- **Vector ids:** `vec-<hash of trimmed base render>`, so a vector never merges with a PNG of
  the same pixels.

---

## Phase A: file types, badges, clear refusals (released alone)

**Files.** Create `src/image/format.ts` and `tests/unit/format.test.ts`. Modify:
- `src/model/types.ts`
- `src/image/import.ts`
- `src/store/persist.ts`
- `src/store/project-file.ts`
- `src/editor/panel.ts`
- `src/editor/inspector.ts`
- `index.html` (the `accept` list)
- `src/styles.css`
- `tests/e2e/import.spec.ts` (or the existing import spec)

**What it does.**
- **`detectFormat(head: Uint8Array, fileName: string): FileFormat | { refuse: string }`.** It
  reads the first bytes, not the file name. The name only tells AI from PDF; both start with
  `%PDF`.
  - **EPS** (`%!PS-Adobe` with `EPSF`, or the DOS EPS binary header `C5 D0 D3 C6`) is refused:
    *"EPS files can't be opened here. Save it as SVG or PDF and add it again."*
  - **PostScript AI** (`%!PS` with a `.ai` name) is refused: *"This Illustrator file is too old
    to open. In Illustrator, save it with "Create PDF Compatible File" ticked, or as SVG or
    PDF."*
  - **PSB** (`8BPS` version 2) is refused: *"Large Document (PSB) files can't be opened here.
    Save it as PSD."*
  - **Unknown** keeps today's message.
- **Badge.** Each design row and the inspector show a small badge with the format (SVG, PDF,
  AI, PSD, PNG, JPG, WEBP). It is a plain label with no colour coding.
- **Accept list.** The file picker's accept list is widened in the phase that adds each type
  (`.svg` in B, `.pdf,.ai` in C, `.psd` in D). Until then a dropped SVG, PDF, AI or PSD gives
  today's "not a supported image" message. Nothing on screen announces a feature that is not
  there yet.
- **Saving.** `format` is saved in autosave and project files; it is plain metadata.

**Tests.**
- **Unit `format.test.ts`:**
  - PNG, JPEG, WEBP and GIF heads are detected;
  - `%PDF` with `.ai` gives ai, and with `.pdf` gives pdf;
  - EPS text and EPS binary heads are refused with the EPS message;
  - `%!PS` with `.ai` is refused;
  - `8BPS` version 2 is refused;
  - an empty file and random bytes are refused;
  - the extension never overrides the bytes (a PNG named `.jpg` is png).
- **E2E:**
  - adding a PNG and a JPG shows the PNG and JPG badges;
  - an EPS fixture gives the EPS message and adds nothing;
  - the badge survives a reload and a project round trip;
  - a project file from before this change opens with no badges and no error.

## Phase B: SVG

**Files.** Create `src/vector/svg.ts`, `src/vector/render.ts`, `src/vector/export-render.ts`,
`tests/unit/svg-size.test.ts` and `tests/e2e/vector.spec.ts`. Modify:
- `src/image/import.ts`
- `src/image/import-worker.ts` (return the trim box)
- `src/model/geometry.ts` (`initialSize`)
- `src/model/checks.ts`
- `src/editor/panel.ts`
- `src/editor/export-dialog.ts`
- `src/store/persist.ts`
- `src/store/project-file.ts` (vector blob plus metadata, version 3 only when needed)
- `tests/fixtures/make-fixtures.ts`

**What it does.**
- **`svgSize(text): { widthMm: number; heightMm: number } | null`.** Units come from `width`
  and `height` in mm, cm, in, pt, pc or px (96 px per inch, CSS). The aspect ratio comes from
  the `viewBox` when width and height are missing or in `%`. With no width and height, the size
  is the viewBox at 96 px per inch. With no viewBox and no usable size, the file is refused:
  *"This SVG has no size. Give it a width and height or a viewBox and add it again."* The size is
  read with `DOMParser`, never by drawing first.
- **`renderSvg(source: Blob, crop, widthPx, heightPx): Promise<ImageBitmap | HTMLCanvasElement>`**
  runs on the main thread. The `<img>` sandbox runs no scripts and loads nothing external.
  - It first writes an explicit width and height (the viewBox shape) on the root element,
    because of the 300×150 trap.
  - It draws the cropped region at the asked size.
  - It applies the blank-pixel check.
- **Import.**
  1. The main thread renders a base raster with the longest side at 4096 px, clamped to the
     limits.
  2. That PNG goes through the existing worker path (haze, trim, mask, hash). The worker now
     also returns the trim box in base-render pixels.
  3. `crop` becomes the trim box divided by the base size. `sizeMm` is `svgSize` times `crop`.
- **Initial size.** `initialSize` uses `vector.sizeMm` when present: the artwork arrives at its
  real size, scaled down to the sheet width if needed.
- **Warnings at import.** An SVG that has live `<text>` or a link to an external image gets one
  toast for all the files added together: *"2 SVG files have live text: fonts may look
  different. Convert text to outlines for an exact print."* Linked images use *"...link images
  that are not inside the file; they are left out."*
- **Checks.** A vector design never gets `low-dpi` or `ok-dpi`. Its row shows "Vector, sharp at
  any size" where the DPI is.
- **`renderVectorsForExport(sheet, assets, options, signal): Promise<ImageAsset[]>`.** This is
  in `export-render.ts`, called in `export-dialog` just before `startExport`, with progress
  "Drawing vectors".
  - **Size.** For each vector asset in use, it renders a raster at the largest placed size
    among that asset's designs, at the export's DPI: PNG 300; PDF the chosen limit, with
    `original` meaning 300.
  - **Workers untouched.** The rendered raster replaces the asset for this export only (same
    id, new `blob` and `widthPx`/`heightPx`). The export workers do not change, and they never
    enlarge, so this size is exactly what they need.
  - **Limits.** Past the limits, the render is clamped, and a note in the export dialog says
    *"<name> was drawn at <N> DPI, the most this browser can hold."*
  - **Stop export.** Stop works during this step through `signal`.

**Tests.**
- **Unit `svg-size`:**
  - mm, cm, in and pt units;
  - viewBox only;
  - width without height (shape from the viewBox);
  - a `%` size;
  - no size at all (refused);
  - garbage XML (refused).
- **E2E `vector.spec`:**
  - **Badge and row:** an SVG of a 50 mm square adds a design about 50 mm wide with the SVG
    badge and "Vector, sharp at any size".
  - **Sharp at size:** after resizing to 400 mm and a PNG export at 300 DPI, the exported
    pixels across an edge go from ink to empty within 2 px. The base render alone would give a
    blurred ramp more than 4 px wide (this would catch a missing re-render).
  - **viewBox-only:** it gets the viewBox's shape, not 2:1.
  - **Reload:** after a reload, the design is still a vector (badge, row) and still exports
    sharp.
  - **Project file:** the project round trip keeps the vector.
  - **Live text:** an SVG with live text shows the toast.
  - **Error:** a broken SVG gives a message and the other files in the same drop are added.
  - **PDF export:** the export at a chosen limit draws vectors at that limit (image size in
    the PDF, read with pdf-lib).

## Phase C: PDF and AI (pdf.js)

**Files.** Create `src/vector/pdf.ts`, `src/vector/pdf-worker.ts` (one line: imports the pdf.js
worker) and `src/editor/pick-dialog.ts`. Modify:
- `src/vector/render.ts`
- `src/image/import.ts`
- `src/editor/dom.ts` if needed
- the fixtures
- `tests/e2e/vector.spec.ts`

**What it does.**
- **Loading pdf.js.** pdf.js loads with `isEvalSupported: false`, `useSystemFonts: true` and
  `useWasm: false`, with no URLs. Its worker uses the inline `?worker&inline` port. A document
  is opened once per file and closed after import or after an export render.
- **Page size.** The page size comes from the crop box in points (1 pt = 0.3528 mm). Rendering
  uses `background: 'rgba(0,0,0,0)'`. Crop and size work as for SVG.
- **Multi-page PDF.** It opens the picker (below) with one row per page, all ticked, each with a
  thumbnail and its size in cm. A single page skips the picker.
- **AI saved without PDF content.** When page 1's text contains "saved without PDF Content",
  the file is refused: *"This Illustrator file was saved without PDF content. In Illustrator,
  save it with "Create PDF Compatible File" ticked, or as SVG or PDF."*
- **Other refusals:**
  - an encrypted PDF: *"This PDF is password-protected..."*;
  - a page that renders blank (fonts or images pdf.js cannot draw without network or wasm):
    *"Page N of <name> came out empty..."*;
  - a pdf.js failure carries its message.
- **`pick-dialog.ts`, used by Phase D too.**
  `pickItems(title: string, items: PickItem[]): Promise<PickItem['id'][] | null>`, where
  `PickItem = { id; label; detail; thumbUrl; note?; checked; disabled?; children?: PickItem[] }`.
  - **Layout.** On a PC it is a dialog with a list. On a phone it is the existing bottom sheet.
  - **Choosing.** Every row has a checkbox, a thumbnail, a label and a detail. A row with
    children can be opened.
  - **Count.** The Add button counts what is ticked: "Add 3 designs".
  - **Cancel.** Cancel adds nothing.

**Tests (E2E).**
- **One page:** a one-page PDF with a blue rectangle on a transparent page adds a design at the
  page's real size (for example an 80 mm rectangle comes in at 80 mm). It has the PDF badge and
  is sharp at a large size (the same edge check).
- **Several pages:** a 3-page PDF opens the picker with 3 rows ticked. Unticking one and
  pressing "Add 2 designs" adds 2.
- **AI badge:** a `.ai` with PDF content gets the AI badge.
- **AI without PDF content:** a `.ai` whose text has the placeholder sentence is refused with
  the Illustrator message.
- **Encrypted:** a password-protected PDF is refused.
- **Security policy:** under the "served" project, there are no console errors.
- **Cancel:** cancelling the picker adds nothing.

## Phase D: PSD

**Files.** Create `src/image/psd.ts` (worker side) and `tests/unit/psd-tree.test.ts`. Modify:
- `src/image/import-worker.ts` (new request kinds `psd-list` and `psd-take`)
- `src/image/import.ts`
- `src/editor/pick-dialog.ts` (folder rows)
- the fixtures (PSDs written with ag-psd in Node)
- a new `tests/e2e/psd.spec.ts`

**What it does.**
- **Structure read first.** `readPsd(bytes, { skipLayerImageData, skipCompositeImageData,
  skipThumbnail })` checks the limits first. It refuses:
  - a document over 16384 px per side or 100 MP;
  - a file over 300 MB;
  - colour modes other than RGB and Grayscale: *"This PSD is in CMYK. In Photoshop choose Image
    > Mode > RGB Color and save again."*;
  - 16 and 32 bits: *"...Image > Mode > 8 Bits/Channel..."*.
- **Full read.** Then `readPsd(bytes, { useImageData: true, skipThumbnail: true })`. The parsed
  PSD stays in the worker under a token until `psd-take` or cancel, then is dropped.
- **`psd-list` returns a tree of `PickItem` data:** label, thumbnail as a small PNG, pixel size, ticked when visible, and notes.
  - **Notes:**
    - "Effects not included" for a layer with effects;
    - "Adjustment layers not included" on a folder that holds one;
    - "Blend mode <X> drawn as Normal" for a mode a canvas cannot do.
  - **Rows not shown:** empty layers and adjustment layers.
  - **Folders:** a folder row means "this folder merged"; its children can be opened and ticked
    one by one.
  - **Whole image:** a "Whole image as one design" row comes last, unticked. It is disabled
    when the PSD has no composite: *"Save with Maximize Compatibility to add the whole image."*
- **`psd-take(ids)` makes one PNG per chosen item.** These PNGs then go through the normal
  import path: haze, trim, mask, hash and the "PSD" format. Each design is named
  `<file> - <layer>`.
  - **A layer:** its pixels, with opacity and fill opacity, and its layer mask unless disabled
    (with the mask's default colour outside the mask's bounds).
  - **A folder:** its visible children drawn bottom to top onto a document-sized canvas, each
    with its own mask and opacity and its blend mode mapped to the canvas operation. Clipped
    layers are drawn `source-atop` onto their base layer's own buffer. The folder's opacity
    and mask apply last. Pass-through is treated as normal.
  - **Whole image:** the composite.
- **Placed size.** It is placed like any image (`PLACEMENT_DPI`). The file's resolution is
  ignored, because real files are almost all at 72 ppi.
- **One layer.** A PSD with one usable layer and no folders skips the picker.

**Tests.**
- **Unit `psd-tree`, on structures written by ag-psd in the test:**
  - visible layers come out ticked and hidden ones unticked;
  - a folder row with children;
  - an empty layer is left out;
  - an adjustment layer is left out and its folder gets the note;
  - the effects note;
  - the unsupported blend note;
  - the CMYK, 16-bit and over-limit refusals.
- **Unit, blend mapping:** each PSD blend mode goes to a canvas operation, and unknown modes go
  to normal with a note.
- **E2E `psd.spec`:**
  - the picker shows the layers with the hidden one unticked;
  - Add puts 2 designs on the sheet with the PSD badge;
  - a layer with a 50% opacity mask comes in at half alpha;
  - a merged folder of two layers becomes one design covering both;
  - a clipped layer shows only inside its base;
  - "Whole image" adds the composite;
  - a PSD with no composite has that row disabled;
  - a CMYK PSD is refused with its message.
- **Real Photoshop file.** Fixtures written by ag-psd and read by ag-psd only check the library
  against itself. The owner is asked for one real Photoshop file, which is tested locally and
  never committed (public repo).

## Revisions after the CTO plan review (83/100). Where they differ, these replace the phase text above

**Required.**
- **R1, DPI per export (M1).**
  - **Rule.** A vector is rendered at the export's own DPI: `options.pngDpi` (150, 300, 360 or
    600) for PNG, and `pdfMaxDpi` for PDF, where `original` means 300. The export dialog says
    "Vectors are drawn at 300 DPI" when `original` is chosen.
  - **`vectorRenderSize(asset, designs, dpi): { widthPx; heightPx; clampedDpi? }`** is a pure
    function in `src/vector/render-size.ts`. It takes the largest copy on both axes, clamps to
    the limits, and is unit-tested.
- **R2, a sharpness test that can fail (M2).**
  - **Unit.** `vectorRenderSize` is unit-tested.
  - **E2E.** A 400 mm SVG design exported as PDF at the 600 limit embeds an image about
    9449 px wide, read with pdf-lib. The 4096 base would give 4096.
  - **Edge test.** If an edge test is kept, it uses at least a 3x upscale.
  - **Proof.** Each test is run once with the re-render switched off, and the failure is
    recorded in the phase report.
- **R3, haze (M3).** Re-rendered pixels go through `clearFaintPixels` before the blank check, so
  the print matches the screen and the ink mask.
- **R4, one copy of each source file (M4).**
  - **Asset field.** `VectorSource` holds `sourceId` (a hash of the original bytes) instead of
    `blob`.
  - **Where sources live.** The sources live once each:
    - autosave key `source:<id>`;
    - project header `sources[]`, with its own byte ranges inside `checkNoOverlap`;
    - in memory, a `Map<sourceId, Blob>` beside the assets.
  - **Clean-up.** Autosave clean-up keeps the sources of the assets it keeps.
  - **Vector ids.** `vec-<sourceId>-p<page>` (this also covers the id nit).
- **R5, PSD clipping (M5).**
  - **Rows.** Clipped layers fold into their base layer's row and never get a row of their own.
  - **Drawing.** The base's opacity and mask apply to the whole clip group. Fill opacity applies
    only to the base's own pixels. Each clipped layer draws `source-atop` onto the base buffer
    with its own opacity.
- **R6, vector masks (M6), settled with the owner's real files.** In two logo files, all 11 shape
  layers already store the drawn shape (49% opaque, 1% soft edge). A vector mask on a pixel
  layer without `vectorFill` gets the note "Vector mask not included"; there is no path drawing.

**Recommended, taken.**
- **R7, export dialog busy state (m1).** One busy handle covers "Drawing vectors" and the
  export. Its `cancel` aborts the render, then the worker. Export stays disabled, and Escape or
  Cancel stop both.
- **R8, versions (m2).**
  - **`formatVersion(sheet, assets)`** is `max(split ? 2 : 1, anyVector ? 3 : 1)`, and
    `PROJECT_VERSION` becomes 3.
  - **`checkEntry`** validates `format` (the enum) in Phase A and the vector fields in Phase B:
    - `type` is one of the enum values;
    - `page` is an integer of at least 1;
    - `crop` is within 0..1 with w and h above 0;
    - `sizeMm` is finite and within `MIN_SIZE_MM`..`MAX_SIZE_MM`;
    - `sourceId` names a source in the header.
  - **Release note.** Rolling back to an older build refuses a v3 autosave; this goes in the
    release notes.
- **R9, SVG render (m3).** The root gets the target pixel size as width and height, and a
  `viewBox` set to the crop region with `preserveAspectRatio="none"`. It is drawn at 0,0. A
  SecurityError on read (a tainted canvas, `<foreignObject>` in Safari) becomes *"<name> can't be
  drawn here (it contains embedded HTML)."*
- **R10, pdf.js (m4).**
  - **Options:** `stopAtErrors: true` and `intent: 'print'`, with the print optional-content
    config.
  - **Page size:** from `page.getViewport({ scale: 1 })`.
  - **Passwords:** only a `PasswordException` is refused.
  - **Fonts:** a toast when fonts are not embedded.
  - **Test file:** an embedded-font PDF in the "served" tests.
- **R11, phone canvas limits (m5).**
  - **Retry.** A blank re-render is halved and retried, down to the base size, with the "drawn
    at N DPI" note.
  - **WebKit check.** Each phase runs a local WebKit check (import, export) before release.
    There is no WebKit in CI, since it adds minutes for one browser that is checked by hand
    anyway; this is a ruling.
- **R12, PSD decode budget (m6).** The structure read adds up the layer and mask areas × 4. Over
  1 GB, the file is refused: *"This PSD has too many large layers to open here..."*.
- **R13, unknown files (m8).** `detectFormat` returns `unknown` for bytes it does not name, and
  those go to the decoder as today (BMP, AVIF and ICO keep working). Only the named cases are
  refused.
- **R14, file lists and boundaries (m9).**
  - **Inspector.** `inspector.ts` shows the vector text in place of the DPI line.
  - **Orchestration.** The `main.ts` orchestration (toasts, the `MAX_DESIGNS` cut) is in
    phases B to D.
  - **Boundary.** The picker reaches `importFiles` as a `pick` callback from `main.ts`, so
    `src/image` never imports `src/editor`.
- **R15, picker (m10, m12).**
  - **Modal everywhere.** The picker is a modal `<dialog>` on every screen, styled as a sheet
    on phones. Closing it means Cancel.
  - **Long lists.** Thumbnails render a few at a time.
  - **Add count.** The count respects the room left under `MAX_DESIGNS`.
  - **Background note.** A PSD row without transparency gets "No transparency: prints as a
    block".
- **R16, Illustrator SVG (m11).** An SVG with the `Adobe Illustrator` generator comment reads
  `px` as 72 per inch.
- **R17, SVG detection (m13).** Detection handles a BOM, an `<?xml` prolog, leading comments and
  a DOCTYPE. `.svgz` (`1F 8B`) is refused: *"Compressed SVG (.svgz) can't be opened. Save it as
  a plain SVG."*

**Nits, taken.**
- GIF gets a badge.
- The base render is sized by area: 16 MP, longest side at most 8192.
- Thumbnail object URLs are revoked.
- **Ruling:** pdf-lib `embedPage` (a native vector inside the PDF export) is not used, because
  it would bypass the CMYK and soft-mask paths.

**Stale.** The CTO's conflict note about `editor/ux` and `arrange/shape-nesting` no longer
applies: both are merged into build/v1.

## Review focus (what the tests above do not fully pin)

1. **Memory on a phone.** A large PDF page or PSD decoded in Safari can fail without an error.
   Every render path has the blank check and a clear message, and the import reports it per
   file.
2. **A sheet with many vector copies at export.** The render happens once per asset, at the
   largest copy, never once per copy.
3. **Undo after adding a PSD's layers.** One undo removes all the designs added together, as
   for a multi-file drop today.
4. **Two tabs, or an old build reading a version 3 autosave.** The old build refuses it,
   untouched, through the existing newer-version guard.
5. **Fonts in SVG and PDF.** An export on another computer can substitute fonts. The import
   toast says so; the app cannot fix it.

## Ruling for the owner

- **Sharpness on screen.** The roadmap says vectors are sharp "on screen and in every export".
  Every export is sharp. On screen, a vector is drawn like any image (up to 2048 px per side),
  so at very high zoom it softens. Re-rendering on zoom costs memory and code for no print
  difference. **Cost if wrong:** the owner sees a soft edge at 400% zoom and thinks the print
  will be soft. The row's "Vector, sharp at any size" answers that.
