/**
 * Centimetre rulers along the top and left of the sheet. They read the canvas's viewport
 * transform, so they line up with the sheet at every zoom and scroll position.
 */
import type { TMat2D } from 'fabric';

const STEPS_MM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** The smallest labelled step that keeps labels at least ~50 px apart. */
function labelStep(scale: number): number {
  return STEPS_MM.find((mm) => mm * scale >= 50 && mm >= 10) ?? 1000;
}

function draw(
  canvas: HTMLCanvasElement,
  horizontal: boolean,
  transform: TMat2D,
  sheetWidthMm: number,
): void {
  const ctx = prepare(canvas);
  if (!ctx) return;
  const length = horizontal ? canvas.clientWidth : canvas.clientHeight;
  const thickness = horizontal ? canvas.clientHeight : canvas.clientWidth;
  const scale = transform[0];
  const offset = horizontal ? transform[4] : transform[5];
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  if (horizontal) {
    // Shade the sheet's width so the printable span is obvious.
    ctx.fillStyle = 'rgba(0, 134, 179, 0.08)';
    ctx.fillRect(offset, 0, sheetWidthMm * scale, thickness);
  }

  const major = labelStep(scale);
  const minor = major / (major >= 100 ? 10 : 5);
  const startMm = Math.floor(-offset / scale / minor) * minor;
  const endMm = (length - offset) / scale;
  ctx.strokeStyle = '#8b948f';
  ctx.fillStyle = '#5f6a65';
  ctx.font = '500 10px Archivo, system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let mm = startMm; mm <= endMm; mm += minor) {
    const pos = Math.round(offset + mm * scale) + 0.5;
    const isMajor = Math.abs(mm / major - Math.round(mm / major)) < 1e-6;
    const tick = isMajor ? thickness : thickness * 0.3;
    if (horizontal) {
      ctx.moveTo(pos, thickness);
      ctx.lineTo(pos, thickness - tick);
    } else {
      ctx.moveTo(thickness, pos);
      ctx.lineTo(thickness - tick, pos);
    }
    if (isMajor) {
      const label = String(Math.round(mm / 10));
      if (horizontal) ctx.fillText(label, pos + 3, 10);
      else {
        ctx.save();
        ctx.translate(10, pos + 3);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'right';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.stroke();
}

export function drawRulers(
  top: HTMLCanvasElement,
  left: HTMLCanvasElement,
  transform: TMat2D,
  sheetWidthMm: number,
): void {
  draw(top, true, transform, sheetWidthMm);
  draw(left, false, transform, sheetWidthMm);
}
