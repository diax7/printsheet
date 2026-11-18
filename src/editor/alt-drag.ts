/**
 * Alt + drag duplicates, as in Canva and Figma: the dragged designs move and copies stay where
 * they started (`moveLeavingCopies`, committed by the canvas when the drag ends). Alt is read
 * when the drag starts, so letting go of Alt mid-drag does not change the outcome, and only a
 * drag of the selection's body counts: Alt on a corner handle keeps Fabric's scale-from-centre.
 */
import type { Canvas, TMat2D } from 'fabric';
import { roomForDesigns } from '@/model/ops';
import type { Design } from '@/model/types';
import type { Store } from '@/store/store';

export interface AltDrag {
  /** True from the start of an Alt + drag until the mouse is let go. */
  leaving(): boolean;
}

let altReleaseKept = false;

/**
 * Windows Chrome moves focus to its own menu bar when Alt is let go without another key, so the
 * Alt release that ends an Alt + drag copy is kept from it (once).
 */
function keepNextAltRelease(): void {
  if (altReleaseKept) return;
  altReleaseKept = true;
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt') return;
    event.preventDefault();
    altReleaseKept = false;
    window.removeEventListener('keyup', onKeyUp, true);
  };
  window.addEventListener('keyup', onKeyUp, true);
}

/** Follows Alt + drag gestures on the canvas. */
export function mountAltDrag(canvas: Canvas, store: Store): AltDrag {
  let leaving = false;
  canvas.on('before:transform', ({ e, transform }) => {
    leaving = transform.action === 'drag' && e.altKey;
  });
  canvas.on('object:modified', () => {
    // A copy is made only when the sheet has room for it (else the designs just move).
    const room = roomForDesigns(store.get().sheet) >= canvas.getActiveObjects().length;
    if (leaving && room) keepNextAltRelease();
  });
  canvas.on('mouse:up', () => {
    leaving = false;
  });
  return { leaving: () => leaving };
}

/** Draws designs at their stored place: the copies an Alt + drag leaves behind, while it runs. */
export function drawStayingCopies(
  ctx: CanvasRenderingContext2D,
  v: TMat2D,
  retina: number,
  items: ReadonlyArray<{ d: Design; image: CanvasImageSource }>,
): void {
  ctx.save();
  ctx.setTransform(retina * v[0], 0, 0, retina * v[3], retina * v[4], retina * v[5]);
  for (const { d, image } of items) {
    ctx.save();
    ctx.translate(d.xMm, d.yMm);
    ctx.rotate((d.angleDeg * Math.PI) / 180);
    ctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    ctx.drawImage(image, -d.widthMm / 2, -d.heightMm / 2, d.widthMm, d.heightMm);
    ctx.restore();
  }
  ctx.restore();
}
