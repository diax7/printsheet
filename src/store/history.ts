/**
 * Undo/redo as a stack of immutable snapshots. Snapshots share unchanged objects, so keeping
 * many of them is cheap; image bytes live outside the snapshots, in the asset map.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(
    private current: T,
    private readonly limit = 200,
  ) {}

  get present(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Record a new state; the redo steps are dropped. */
  push(next: T): void {
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
  }

  /** Replace the present without recording a step (e.g. while a drag is in progress). */
  replace(next: T): void {
    this.current = next;
  }

  undo(): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(this.current);
    this.current = previous;
    return previous;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    return next;
  }

  /** Every state undo or redo can reach, the present included. */
  all(): T[] {
    return [...this.past, this.current, ...this.future];
  }

  /** Forget every step and start from `state` (a new or opened sheet). */
  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.current = state;
  }
}
