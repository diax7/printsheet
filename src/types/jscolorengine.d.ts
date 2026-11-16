/** The small part of jsColorEngine this app uses (the package ships no type definitions). */
declare module 'jscolorengine' {
  export class Profile {
    loaded: boolean;
    lastError: unknown;
    loadPromise(data: Uint8Array | string): Promise<Profile>;
  }

  export interface TransformOptions {
    buildLut?: boolean;
    dataFormat?: 'int8' | 'int16' | 'float' | 'object';
    BPC?: boolean;
  }

  export class Transform {
    constructor(options?: TransformOptions);
    create(from: Profile | string, to: Profile | string, intent: number): void;
    /** Converts packed pixels; the flags say whether input and output carry an alpha byte. */
    array(
      data: ArrayLike<number>,
      inputHasAlpha: boolean,
      outputHasAlpha: boolean,
    ): Uint8Array | number[];
  }

  export const eIntent: {
    perceptual: number;
    relative: number;
    saturation: number;
    absolute: number;
  };
}
