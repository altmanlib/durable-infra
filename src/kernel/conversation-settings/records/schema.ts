/** The settings table's types, as Kysely queries them; the migrations create the table and must stay in step. */

/** One setting of a conversation. */
export type SettingTable = {
  /** The conversation's channel key, such as `<channel>:<id>`. */
  conversation_key: string;
  /** A registered setting's name, such as `gitea.repo`. */
  name: string;
  /** The text its check gave back: already validated and normalized. */
  value: string;
  /** ms since epoch. */
  updated_at: number;
  /** Who changed it last, as the speaker's id; empty when it was not known. */
  updated_by: string;
};

export type SettingSchema = {
  conversation_setting: SettingTable;
};
