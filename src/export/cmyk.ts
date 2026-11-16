/**
 * RGB → CMYK through a standard press profile (FOGRA39, coated offset). This is a generic
 * conversion, not the print shop's printer profile; the export dialog says so.
 */
import { Profile, Transform, eIntent } from 'jscolorengine';

/** Converts RGBA pixels to CMYK bytes (4 per pixel); alpha is dropped and kept separately. */
export type CmykConverter = (rgba: Uint8ClampedArray) => Uint8Array;

export async function createCmykConverter(profileBytes: Uint8Array): Promise<CmykConverter> {
  const profile = new Profile();
  await profile.loadPromise(profileBytes);
  if (!profile.loaded) {
    throw new Error(`The CMYK colour profile could not be read: ${String(profile.lastError)}`);
  }
  const transform = new Transform({ buildLut: true, dataFormat: 'int8', BPC: true });
  transform.create('*sRGB', profile, eIntent.relative);
  return (rgba) => {
    const out = transform.array(rgba, true, false);
    return out instanceof Uint8Array ? out : Uint8Array.from(out);
  };
}
