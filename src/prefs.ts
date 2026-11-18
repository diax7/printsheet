/**
 * Preferences remembered in this browser (not part of the sheet or its undo history): the
 * workspace look, the user's own width presets and the last export settings.
 */
import {
  BUILT_IN_PRESETS,
  MAX_WIDTH_MM,
  MIN_WIDTH_MM,
  type ExportOptions,
  type Preset,
  type Spacing,
} from '@/model/types';

export type Background = 'transparent' | 'white' | 'black' | 'custom';

export interface Prefs {
  background: Background;
  customColor: string;
  grid: boolean;
  allowRotate: boolean;
  /**
   * How the user last chose to measure the cutting gap, or null when they never chose. New
   * sheets follow it; without a choice they measure between real shapes.
   */
  spacing: Spacing | null;
  presets: Preset[];
  exportOptions: Omit<ExportOptions, 'fileName'>;
}

const KEY = 'printsheet:prefs:v1';

export const DEFAULT_PREFS: Prefs = {
  background: 'transparent',
  customColor: '#e8d7c3',
  grid: false,
  allowRotate: true,
  spacing: null,
  presets: [],
  exportOptions: {
    format: 'pdf',
    color: 'rgb',
    pngDpi: 300,
    pdfMaxDpi: 'original',
    pdfCompression: 'compact',
    splitOutput: 'zip',
    mirror: false,
  },
};

function isPreset(v: unknown): v is Preset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    typeof p['name'] === 'string' &&
    p['name'].length > 0 &&
    p['name'].length <= 60 &&
    typeof p['widthMm'] === 'number' &&
    p['widthMm'] >= MIN_WIDTH_MM &&
    p['widthMm'] <= MAX_WIDTH_MM
  );
}

/** Saved preferences, with anything missing or malformed replaced by its default. */
export function loadPrefs(): Prefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    raw = null;
  }
  if (typeof raw !== 'object' || raw === null) return structuredClone(DEFAULT_PREFS);
  const r = raw as Record<string, unknown>;
  const e = (
    typeof r['exportOptions'] === 'object' && r['exportOptions'] !== null ? r['exportOptions'] : {}
  ) as Record<string, unknown>;
  const d = DEFAULT_PREFS.exportOptions;
  return {
    background: ['transparent', 'white', 'black', 'custom'].includes(r['background'] as string)
      ? (r['background'] as Background)
      : DEFAULT_PREFS.background,
    customColor:
      typeof r['customColor'] === 'string' && /^#[0-9a-f]{6}$/i.test(r['customColor'])
        ? r['customColor']
        : DEFAULT_PREFS.customColor,
    grid: r['grid'] === true,
    allowRotate: r['allowRotate'] !== false,
    spacing: r['spacing'] === 'box' || r['spacing'] === 'shape' ? r['spacing'] : null,
    presets: Array.isArray(r['presets'])
      ? r['presets'].filter(isPreset).map((p) => ({ ...p, builtIn: false }))
      : [],
    exportOptions: {
      format: e['format'] === 'png' ? 'png' : e['format'] === 'pdf' ? 'pdf' : d.format,
      color: e['color'] === 'cmyk' ? 'cmyk' : 'rgb',
      pngDpi: [150, 300, 360, 600].includes(e['pngDpi'] as number)
        ? (e['pngDpi'] as ExportOptions['pngDpi'])
        : d.pngDpi,
      pdfMaxDpi: e['pdfMaxDpi'] === 300 || e['pdfMaxDpi'] === 600 ? e['pdfMaxDpi'] : 'original',
      pdfCompression: e['pdfCompression'] === 'lossless' ? 'lossless' : d.pdfCompression,
      splitOutput: (['zip', 'pdf-pages', 'files'] as const).includes(e['splitOutput'] as never)
        ? (e['splitOutput'] as ExportOptions['splitOutput'])
        : d.splitOutput,
      mirror: e['mirror'] === true,
    },
  };
}

/** Save preferences; returns false when the browser refuses (private mode, storage full). */
export function savePrefs(prefs: Prefs): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

export function allPresets(prefs: Prefs): Preset[] {
  return [...BUILT_IN_PRESETS, ...prefs.presets];
}
