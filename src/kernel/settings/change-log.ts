/** One history entry: `area` says what changed (a kernel area or the application's own), `target` to what, and `before`/`after` the values. */
export type Change = {
  seq: number;
  at: number;
  area: string;
  target: string;
  before: string | null;
  after: string | null;
};

/** A page of changes, newest first. */
export type ChangePage = { items: Change[] /** Pass as `before` for the next, older page. */; next?: number };

/** The history kept by the application itself; a write is not part of the change's commit, so a failure is logged and the change stands. */
export interface ChangeLog {
  /** Add a change at the end of the history. */
  record(change: Omit<Change, "seq">): Promise<void>;
  /** Up to `limit` changes older than `before` (the newest when absent), newest first. */
  page(options: { limit: number; before?: number }): Promise<ChangePage>;
}
