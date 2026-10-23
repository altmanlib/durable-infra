import type { Kysely } from "kysely";

import type { SettingSchema } from "./schema.ts";

/** A setting as it is stored. */
export type StoredSetting = { name: string; value: string; updatedAt: number; updatedBy: string };
/** What `remove` came to; either way the setting is not set any more. */
export type SettingRemoveResult = "cleared" | "missing";

export type SettingRowsOptions = { now?: () => number };

/** Per-conversation setting rows; a conversation reaches only its own. Names and values are checked upstream; write failures throw. */
export class SettingRows {
  readonly #db: Kysely<SettingSchema>;
  readonly #now: () => number;

  constructor(db: Kysely<SettingSchema>, options: SettingRowsOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  /** The conversation's settings, by name. */
  async list(conversationKey: string): Promise<StoredSetting[]> {
    const rows = await this.#db
      .selectFrom("conversation_setting")
      .select(["name", "value", "updated_at", "updated_by"])
      .where("conversation_key", "=", conversationKey)
      .orderBy("name")
      .execute();
    return rows.map((row) => ({ name: row.name, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by }));
  }

  /** The stored text of that setting, or `undefined` when the conversation has not set it. */
  async read(conversationKey: string, name: string): Promise<string | undefined> {
    const row = await this.#db
      .selectFrom("conversation_setting")
      .select("value")
      .where("conversation_key", "=", conversationKey)
      .where("name", "=", name)
      .executeTakeFirst();
    return row?.value;
  }

  /** Sets it, replacing what it was, with a fresh time and writer. Throws when the write fails. */
  async write(conversationKey: string, name: string, value: string, updatedBy: string): Promise<void> {
    const row = { value, updated_at: this.#now(), updated_by: updatedBy };
    await this.#db
      .insertInto("conversation_setting")
      .values({ conversation_key: conversationKey, name, ...row })
      .onConflict((conflict) => conflict.columns(["conversation_key", "name"]).doUpdateSet(row))
      .execute();
  }

  /** Removes the setting; `missing` when it was not set. Throws when the write fails. */
  async remove(conversationKey: string, name: string): Promise<SettingRemoveResult> {
    const result = await this.#db
      .deleteFrom("conversation_setting")
      .where("conversation_key", "=", conversationKey)
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0 ? "cleared" : "missing";
  }
}
