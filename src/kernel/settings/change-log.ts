/**
 * One change made from the console, or by an application on an operator's behalf. For a prompt, `before` and `after` are
 * texts and null is the built-in default. For an allowlist, `target` is the channel and they are the user IDs,
 * comma-separated; null is no list (the very first). For an action on a conversation, `target` is its key, `before` is null
 * and `after` names the action (reset, compact, abort). A channel's own change (`channel`) has the channel name and a name
 * of its choosing in `target`, as `<channel>/<name>`. Conversations moved to the configured model at open (`model`) have
 * how many moved in `target`, and `before` and `after` are the models as `<provider>/<modelId>`. A conversation moved to
 * another model by a person (`conversation-model`) has its key in `target`; `before` is null when it had no model.
 *
 * `area` is a string: the kernel writes the areas above, and an application may write its own through
 * `Settings.record`, such as the changes an operator makes to accounts.
 */
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

/**
 * Where the history of changes is kept when the application keeps it itself, such as in its business database. The kernel
 * only asks for it: a write here is never part of the Durable commit of the change it describes, so a failure is logged
 * and the change stands. Without one, the history is a Durable document written in the same commit as the change.
 */
export interface ChangeLog {
  /** Add a change at the end of the history. */
  record(change: Omit<Change, "seq">): Promise<void>;
  /** Up to `limit` changes older than `before` (the newest when absent), newest first. */
  page(options: { limit: number; before?: number }): Promise<ChangePage>;
}
