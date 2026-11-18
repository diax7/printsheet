/**
 * Arrange: a search for the layout that uses the least film. One greedy placement (largest
 * first, each design in its first free spot) is fast but rarely the best, so many are tried
 * within a time budget: different orders, different turns, different rules for choosing a spot.
 * The shortest result wins.
 *
 * With Rectangles spacing every placement keeps the cutting gap between rectangles. With Real
 * shape spacing the gap is kept between the ink outlines (model/raster), so one design may sit
 * in another's empty corner. Designs are only ever turned, never mirrored: a mirrored design
 * would print mirrored.
 *
 * Turns are quarter turns. On the owner's real job no other angle was ever chosen: a design
 * turned by 15° or 45° takes a larger rectangle, and trying those angles cost most of the time
 * budget. The one case where another angle wins is a design that fits a sheet of a split job
 * neither across nor along, which is laid diagonally.
 *
 * The search is deterministic for a given seed and pass limit, and takes its clock from the
 * caller, so tests do not depend on the machine's speed.
 */
import { fill, type TurnPin } from '@/model/arrange';
import { findIssues, type IssueKind } from '@/model/checks';
import { contentLengthMm, footprint, unionFootprint } from '@/model/geometry';
import { fullMask, type ShapeMask } from '@/model/mask';
import { normalizeAngle } from '@/model/ops';
import { filmLengthMm, offSheetReason } from '@/model/pages';
import { QUARTER_TURNS, shapeDecoder, type Rule } from '@/model/shape-search';
import type { Design, Settings, Sheet } from '@/model/types';

export interface ArrangeProgress {
  /** Layouts tried so far. */
  passes: number;
  /** Film length of the best layout so far, in mm. */
  filmMm: number;
  /**
   * The sheet with the best layout so far, when this pass improved it and it is one Arrange
   * would return (shorter than a valid layout already on the sheet).
   */
  sheet: Sheet | null;
}

export interface SmartArrangeOptions {
  /** May designs be turned. Off: every design keeps its angle. */
  allowRotate: boolean;
  /** Ink masks by asset id, for Real shape spacing. A design without one packs as a rectangle. */
  masks?: ReadonlyMap<string, ShapeMask>;
  /** Longest the search may run, in ms. */
  budgetMs?: number;
  /** Most layouts to try, whatever the clock says. */
  maxPasses?: number;
  /** Different seeds try different layouts; the same seed and pass limit give the same result. */
  seed?: number;
  now?: () => number;
  onProgress?: (progress: ArrangeProgress) => void;
}

export const DEFAULT_BUDGET_MS = 4000;
/** Layouts the rectangle search may try before the shape search starts, and its share of the time. */
const BOX_PASSES = 40;
const BOX_SHARE = 0.1;
/**
 * How much longer (mm) a changed order may make the layout and still often be kept at the start
 * of the search; it falls to zero as the time runs out.
 */
const HEAT_MM = 80;
/** Diagonal angles tried for a design that fits the sheet at no quarter turn. */
const DIAGONAL_STEP_DEG = 15;
const EPS = 1e-6;

type Masks = ReadonlyMap<string, ShapeMask>;

interface Scored {
  placed: Design[];
  /** Designs past the side edge or on no sheet: fitting matters more than length. */
  overflow: number;
  filmMm: number;
  /** The lowest edge, unrounded, so two layouts of the same film length still compare. */
  bottomMm: number;
}

/** What one greedy placement is built from; the search changes one part at a time. */
interface Genome {
  /** Indexes of the moving designs, in the order they are placed. */
  order: number[];
  /** Per design, the turn it must take, or -1 when the placement chooses. */
  pins: number[];
  rule: Rule;
}

interface Search {
  sheet: Sheet;
  moving: Design[];
  fixed: Design[];
  options: SmartArrangeOptions;
  random: () => number;
  deadline: number;
  now: () => number;
  maxPasses: number;
  passes: number;
  best: Scored | null;
  /**
   * The layout as it stands, when it has no placement problem: "Arrange made it worse" must
   * never happen, so only a shorter layout may replace it.
   */
  keep: Scored | null;
  /** No layout can need less film than this; reaching it ends the search. */
  floorMm: number;
}

/** Deterministic pseudo-random numbers (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function score(search: Search, placed: Design[]): Scored {
  const s = search.sheet.settings;
  let overflow = 0;
  for (const d of placed) {
    const box = footprint(d);
    const outside = box.maxX > s.sheetWidthMm + EPS || box.minX < -EPS;
    if (outside || (s.layout === 'split' && offSheetReason(d, s) !== null)) overflow++;
  }
  return {
    placed,
    overflow,
    filmMm: filmLengthMm({ ...search.sheet, designs: [...search.fixed, ...placed] }),
    bottomMm: unionFootprint(placed)?.maxY ?? 0,
  };
}

function isBetter(a: Scored, b: Scored | null): boolean {
  if (!b) return true;
  if (a.overflow !== b.overflow) return a.overflow < b.overflow;
  if (a.filmMm !== b.filmMm) return a.filmMm < b.filmMm;
  return a.bottomMm < b.bottomMm - EPS;
}

function withPlaced(sheet: Sheet, placed: readonly Design[]): Sheet {
  const byId = new Map(placed.map((d) => [d.id, d]));
  return { ...sheet, designs: sheet.designs.map((d) => byId.get(d.id) ?? d) };
}

/** Counts a finished layout and keeps it when it is the best so far. */
function offer(search: Search, placed: Design[]): Scored {
  const scored = score(search, placed);
  search.passes++;
  const improved = isBetter(scored, search.best);
  if (improved) search.best = scored;
  const { keep } = search;
  const worth = improved && (!keep || isBetter(scored, keep));
  search.options.onProgress?.({
    passes: search.passes,
    filmMm: Math.min((search.best as Scored).filmMm, keep?.filmMm ?? Infinity),
    sheet: worth ? withPlaced(search.sheet, placed) : null,
  });
  return scored;
}

/** True when the search should stop: out of passes or time, or nothing shorter can exist. */
function finished(search: Search): boolean {
  if (search.passes >= search.maxPasses || search.now() >= search.deadline) return true;
  const { best } = search;
  return best !== null && best.overflow === 0 && best.filmMm <= search.floorMm;
}

/** Item indexes sorted by a size measure, largest first. */
function orderBy(measure: readonly number[]): number[] {
  return measure
    .map((_, i) => i)
    .toSorted((a, b) => (measure[b] as number) - (measure[a] as number) || a - b);
}

/** A copy of an order with one item moved somewhere else, or two swapped. */
function reorder(order: readonly number[], random: () => number): number[] {
  const next = [...order];
  if (next.length < 2) return next;
  const from = Math.floor(random() * next.length);
  let to = Math.floor(random() * (next.length - 1));
  if (to >= from) to++;
  if (random() < 0.5) {
    [next[from], next[to]] = [next[to] as number, next[from] as number];
  } else {
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as number);
  }
  return next;
}

/** The layout the search is changing: its genome and its cost. */
interface Current {
  genome: Genome;
  cost: number;
}

/**
 * A copy of the current genome with one small change: one design's turn pinned, the rule
 * switched, or two designs reordered.
 */
function mutate(g: Genome, a: Annealing, random: () => number): Genome {
  const r = random();
  if (a.turnCount > 1 && r < a.pinShare) {
    const pins = [...g.pins];
    pins[Math.floor(random() * pins.length)] = Math.floor(random() * (a.turnCount + 1)) - 1;
    return { ...g, pins };
  }
  if (a.rules && r > 0.95) return { ...g, rule: g.rule === 'bottom' ? 'top' : 'bottom' };
  return { ...g, order: reorder(g.order, random) };
}

/** How far through its time or pass limit the search is, from 0 to 1. */
function progress(search: Search, startedAt: number, firstPass: number): number {
  const byTime = (search.now() - startedAt) / Math.max(1, search.deadline - startedAt);
  const byPass = (search.passes - firstPass) / Math.max(1, search.maxPasses - firstPass);
  return Math.min(1, Math.max(byTime, byPass));
}

const costOf = (scored: Scored): number => scored.bottomMm + scored.overflow * 1e7;

interface Annealing {
  starts: readonly Genome[];
  /** Turns a pin may choose from; 1 when designs may not turn. */
  turnCount: number;
  /** Share of changes that pin one design's turn instead of changing the order. */
  pinShare: number;
  /** May the search switch the rule for choosing a spot. */
  rules: boolean;
  decode: (genome: Genome) => Design[] | null;
}

/**
 * Tries layouts until the search is finished, by simulated annealing: first the starting
 * genomes, then small changes to the current one. A change that makes the layout shorter is
 * kept; one that makes it a little longer is sometimes kept too, less and less as time runs
 * out, so the search can leave a dead end.
 */
function anneal(search: Search, a: Annealing): void {
  const startedAt = search.now();
  const firstPass = search.passes;
  let current: Current | null = null;
  // A handful of designs has only a few orders and turns: no need to search for seconds.
  const n = search.moving.length;
  const few = ([1, 1, 2, 6, 24, 120, 720][n] ?? Infinity) * a.turnCount ** Math.min(n, 6) * 2;
  const limit = firstPass + a.starts.length + few;
  for (let pass = 0; search.passes < limit && !finished(search); pass++) {
    const start = a.starts[pass];
    const genome: Genome = start ?? mutate((current as Current).genome, a, search.random);
    const placed = a.decode(genome);
    if (!placed) return;
    const cost = costOf(offer(search, placed));
    const heat = HEAT_MM * (1 - progress(search, startedAt, firstPass)) ** 2;
    const worse = current ? cost - current.cost : -1;
    const lucky = !start && search.random() < Math.exp(-worse / Math.max(heat, 1e-9));
    if (worse <= 0 || lucky) current = { genome, cost };
  }
}

interface Size {
  w: number;
  h: number;
}

function sizes(designs: readonly Design[]): Size[] {
  return designs.map((d) => {
    const box = footprint(d);
    return { w: box.maxX - box.minX, h: box.maxY - box.minY };
  });
}

/**
 * Orders worth starting from: by longest side, by area, by height, by width, and top to bottom
 * as the designs lie now (so arranging again continues from the layout on the sheet).
 */
function startOrders(designs: readonly Design[]): number[][] {
  const size = sizes(designs);
  return [
    orderBy(size.map((s) => Math.max(s.w, s.h) * 1e6 + s.h)),
    orderBy(size.map((s) => s.w * s.h)),
    orderBy(size.map((s) => s.h)),
    orderBy(size.map((s) => s.w)),
    orderBy(designs.map((d) => -footprint(d).minY)),
  ];
}

const PINS: readonly TurnPin[] = ['keep', 'turn'];

/** Rectangles: the rectangle packer over many orders and turns. */
function searchBoxes(search: Search): void {
  const { moving, fixed, sheet } = search;
  const rotate = search.options.allowRotate;
  const free = moving.map(() => -1);
  const starts = startOrders(moving).map((order): Genome => ({
    order,
    pins: free,
    rule: 'bottom',
  }));
  // The plain order without turning stays a candidate, so allowing turns never makes it longer.
  if (rotate) offer(search, fill(moving, fixed, sheet, false, starts[0]?.order));
  const pinsOf = (g: Genome): TurnPin[] => g.pins.map((pin) => PINS[pin] ?? 'free');
  anneal(search, {
    starts,
    turnCount: rotate ? PINS.length : 1,
    pinShare: 0.2,
    rules: false,
    decode: (g) => fill(moving, fixed, sheet, rotate, g.order, pinsOf(g)),
  });
}

/** Real shape: the shape packer over many orders, turns and spot rules. */
function searchShapes(search: Search, masks: Masks): void {
  const { moving, fixed, sheet } = search;
  const turns = search.options.allowRotate ? QUARTER_TURNS : [0];
  const decoder = shapeDecoder({
    sheet,
    moving,
    fixed,
    masks,
    spare: fullMask(),
    turns,
    expired: () => search.now() >= search.deadline,
  });
  const free = moving.map(() => -1);
  const orders = startOrders(moving);
  const starts = orders.flatMap((order): Genome[] => [
    { order, pins: free, rule: 'bottom' },
    { order, pins: free, rule: 'top' },
  ]);
  // First of all one placement with every design at its own angle: a quarter of the work, so a
  // job of hundreds of designs has a nested layout before the time is up.
  starts.unshift({ order: orders[1] as number[], pins: moving.map(() => 0), rule: 'bottom' });
  anneal(search, {
    starts,
    turnCount: turns.length,
    // Pinning turns paid off for rectangles; for shapes no gain could be measured.
    pinShare: 0,
    rules: true,
    decode: (g) => decoder.decode(g.order, g.rule, g.pins),
  });
}

function fitsSheet(d: Design, s: Settings): boolean {
  const box = footprint(d);
  if (box.maxX - box.minX > s.sheetWidthMm + EPS) return false;
  return s.layout !== 'split' || box.maxY - box.minY <= s.pageLengthMm + EPS;
}

/**
 * A design that fits the sheet neither as it is nor turned by 90° is laid diagonally: the first
 * angle, in steps, at which its rectangle fits. A design that fits no way is left alone.
 */
function laidToFit(d: Design, s: Settings): Design {
  const quarter = { ...d, angleDeg: normalizeAngle(d.angleDeg + 90) };
  if (fitsSheet(d, s) || fitsSheet(quarter, s)) return d;
  for (let delta = DIAGONAL_STEP_DEG; delta < 180; delta += DIAGONAL_STEP_DEG) {
    const turned = { ...d, angleDeg: normalizeAngle(d.angleDeg + delta) };
    if (fitsSheet(turned, s)) return turned;
  }
  return d;
}

/**
 * Film no layout can do without, for one long sheet in Auto length: the tallest design's
 * shorter way up, and what is fixed. Zero (never reached) for the other sheet kinds.
 */
function floorOf(search: Pick<Search, 'sheet' | 'moving' | 'fixed' | 'options'>): number {
  const s = search.sheet.settings;
  if (s.layout !== 'single' || s.lengthMode !== 'auto') return 0;
  const turnable = (size: Size): boolean => search.options.allowRotate && size.h <= s.sheetWidthMm;
  const least = sizes(search.moving).map((size) =>
    turnable(size) ? Math.min(size.w, size.h) : size.h,
  );
  const tallest = Math.ceil(Math.max(0, ...least) / 10 - 1e-9) * 10;
  return Math.max(tallest, contentLengthMm(search.fixed));
}

const PLACEMENT: readonly IssueKind[] = ['outside', 'off-sheet', 'too-close', 'past-length'];

/** True when one of the given designs has one of the given problems. */
function hasIssue(
  sheet: Sheet,
  ids: ReadonlySet<string>,
  kinds: readonly IssueKind[],
  masks: Masks | undefined,
): boolean {
  for (const [id, issues] of findIssues(sheet, new Map(), masks)) {
    if (ids.has(id) && issues.some((issue) => kinds.includes(issue.kind))) return true;
  }
  return false;
}

function newSearch(
  sheet: Sheet,
  moving: Design[],
  fixed: Design[],
  options: SmartArrangeOptions,
): Search {
  const now = options.now ?? (() => performance.now());
  return {
    sheet,
    moving,
    fixed,
    options,
    random: seeded(options.seed ?? 1),
    now,
    deadline: now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
    maxPasses: options.maxPasses ?? Infinity,
    passes: 0,
    best: null,
    keep: null,
    floorMm: floorOf({ sheet, moving, fixed, options }),
  };
}

/** Runs the searches for the sheet's spacing and returns the best layout found. */
function bestLayout(search: Search, ids: ReadonlySet<string>): Scored {
  const { sheet } = search;
  const { masks } = search.options;
  const shape = sheet.settings.spacing === 'shape' && masks !== undefined;
  // In Real shape the rectangle search only sets the bar: a few layouts, a small share of the
  // time (on hundreds of designs one rectangle layout already takes a while).
  const { maxPasses, deadline } = search;
  if (shape) {
    search.maxPasses = Math.min(maxPasses, BOX_PASSES);
    search.deadline = search.now() + (deadline - search.now()) * BOX_SHARE;
  }
  searchBoxes(search);
  search.maxPasses = maxPasses;
  search.deadline = deadline;
  const boxes = search.best as Scored;
  if (!shape) return boxes;
  searchShapes(search, masks);
  const found = search.best as Scored;
  // The shape packer and the check share one test, so a found layout never trips the check;
  // should that ever fail, the rectangle layout (which the check always accepts) is used.
  return hasIssue(withPlaced(sheet, found.placed), ids, ['too-close'], masks) ? boxes : found;
}

/**
 * Pack the chosen designs to use the least film.
 *
 * Args:
 *   sheet: The sheet to arrange.
 *   ids: The designs to move, or 'all'. Locked designs and the others stay where they are.
 *   options: Turning, masks for Real shape spacing, and the search limits.
 *
 * Returns:
 *   The sheet with the best layout found. The same sheet object when nothing moves, or when
 *   the designs as they lie have no placement problem and the search found nothing shorter.
 */
export function smartArrange(
  sheet: Sheet,
  ids: readonly string[] | 'all',
  options: SmartArrangeOptions,
): Sheet {
  const wanted = ids === 'all' ? null : new Set(ids);
  const isMoving = (d: Design): boolean => !d.locked && (wanted === null || wanted.has(d.id));
  const current = sheet.designs.filter(isMoving);
  if (current.length === 0) return sheet;
  const lay = (d: Design): Design => (options.allowRotate ? laidToFit(d, sheet.settings) : d);
  const fixed = sheet.designs.filter((d) => !isMoving(d));
  const search = newSearch(sheet, current.map(lay), fixed, options);
  const movingIds = new Set(current.map((d) => d.id));
  const valid = !hasIssue(sheet, movingIds, PLACEMENT, options.masks);
  if (valid) search.keep = score(search, current);
  const best = bestLayout(search, movingIds);
  return search.keep && !isBetter(best, search.keep) ? sheet : withPlaced(sheet, best.placed);
}
