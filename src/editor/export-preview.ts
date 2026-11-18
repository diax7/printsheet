/**
 * A small picture of the exported file in the export dialog: the first sheet with its designs,
 * drawn from the on-screen previews, flipped left to right when Mirrored is chosen, so the owner
 * sees exactly which way round the file comes out.
 */
import { splitForExport } from '@/model/pages';
import { contentLengthMm, sheetLengthMm } from '@/model/geometry';
import type { Sheet } from '@/model/types';
import { readyPreview } from '@/image/previews';
import { el } from '@/editor/dom';

const MAX_WIDTH_PX = 220;
const MAX_HEIGHT_PX = 260;
/** A longer file shows only its top, so the preview stays wide enough to tell left from right. */
const MAX_SHOWN_MM = 600;

/** Draws the sheet onto the canvas, mirrored or not. */
function drawPreview(canvas: HTMLCanvasElement, sheet: Sheet, mirror: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const widthMm = sheet.settings.sheetWidthMm;
  const scale = canvas.width / widthMm;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (mirror) ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
  for (const d of sheet.designs) {
    ctx.save();
    ctx.translate(d.xMm * scale, d.yMm * scale);
    ctx.rotate((d.angleDeg * Math.PI) / 180);
    ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    const w = d.widthMm * scale;
    const h = d.heightMm * scale;
    const preview = readyPreview(d.assetId);
    if (preview) {
      ctx.drawImage(preview.canvas, -w / 2, -h / 2, w, h);
    } else {
      // Same red mark as the editor uses for an image it cannot show; the file still has it.
      ctx.fillStyle = 'rgba(184, 50, 42, 0.35)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }
}

export interface ExportPreview {
  element: HTMLElement;
  update(mirror: boolean): void;
}

/** The preview of the first file the export makes (the first sheet of a split job). */
export function exportPreview(sheet: Sheet): ExportPreview {
  const { parts } = splitForExport(sheet);
  const first = parts[0]?.sheet ?? sheet;
  const fullMm = Math.max(sheetLengthMm(first), contentLengthMm(first.designs), 1);
  const lengthMm = Math.min(fullMm, MAX_SHOWN_MM);
  const widthMm = first.settings.sheetWidthMm;
  const scale = Math.min(MAX_WIDTH_PX / widthMm, MAX_HEIGHT_PX / lengthMm);
  const canvas = el('canvas', {
    class: 'export-preview-canvas',
    width: String(Math.max(1, Math.round(widthMm * scale))),
    height: String(Math.max(1, Math.round(lengthMm * scale))),
    role: 'img',
    'aria-label': 'Preview of the exported file',
    id: 'export-preview',
  });
  const caption = el('p', { class: 'hint' });
  const element = el('div', { class: 'export-preview' }, canvas, caption);
  return {
    element,
    update(mirror) {
      canvas.dataset['mirrored'] = String(mirror);
      drawPreview(canvas, first, mirror);
      const how = mirror ? 'Mirrored: flipped left to right.' : 'Regular: as on screen.';
      const which = parts.length > 1 ? `File 1 (sheet ${parts[0]?.sheetNumber ?? 1}). ` : '';
      const top = fullMm > MAX_SHOWN_MM ? 'Top of the file. ' : '';
      caption.textContent = `${which}${top}${how}`;
    },
  };
}
