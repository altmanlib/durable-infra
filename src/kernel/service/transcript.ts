import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, defineEntry, type EntryRecord, UserEntry, type UserInput } from "@earendil-works/pi-durable";

/** A message recorded without an answer (`AgentService.record`), such as an unaddressed group message; the model sees it as a user message. */
export const ChatMessageEntry = defineEntry<{ at: number; backfill?: boolean }>("chat.message");

/** Where a conversation's context now starts (`AgentService.keepRecent`); earlier entries stay in storage. */
export const WindowEntry = defineEntry<{ kept: number }>("chat.window");

/** Who wrote an input, where a conversation has more than one person, such as a group. Channel-neutral. */
export type Speaker = {
  /** Stable ID within the channel, such as an open_id. */
  id: string;
  /** Display name; may change and is not unique. */
  name?: string;
  /** Extra facts such as a username; keys are lowercase and never `id` or `name`. Facts only, never permissions. */
  attributes?: Record<string, string>;
};

export const MAX_SPEAKER_ATTRIBUTES = 8;
export const MAX_ATTRIBUTE_VALUE = 200;

const ATTRIBUTE_KEY = /^[a-z][a-z_]*$/;

export type HistoryLine = {
  role: "user" | "assistant";
  text: string;
  /** Present on user lines that were submitted with a speaker. */
  speaker?: Speaker;
};

const SPEAKER_TAG = /^<speaker((?: [a-z][a-z_]*="[^"]*")+)\/>$/;
const TAG_ATTRIBUTE = /([a-z][a-z_]*)="([^"]*)"/g;

const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeAttribute = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The speaker as the conversation holds it: values cut to the limit, empty ones dropped; throws on invalid keys. */
export function normalizeSpeaker(speaker: Speaker): Speaker {
  const entries = Object.entries(speaker.attributes ?? {});
  if (entries.length > MAX_SPEAKER_ATTRIBUTES) throw new RangeError(`a speaker has at most ${MAX_SPEAKER_ATTRIBUTES} attributes`);
  const attributes: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ATTRIBUTE_KEY.test(key) || key === "id" || key === "name") throw new RangeError(`speaker attribute key not allowed: ${key}`);
    attributes[key] = [...value].slice(0, MAX_ATTRIBUTE_VALUE).join("");
  }
  const result: Speaker = { id: speaker.id };
  if (speaker.name !== undefined) result.name = speaker.name;
  if (entries.length > 0) result.attributes = attributes;
  return result;
}

/** A user input's content: plain text, or with a speaker, a speaker tag then the text (two parts, made only here). */
export function userContent(text: string, speaker?: Speaker): UserInput {
  if (!speaker) return text;
  const pairs: [string, string][] = [["id", speaker.id]];
  if (speaker.name !== undefined) pairs.push(["name", speaker.name]);
  pairs.push(...Object.entries(speaker.attributes ?? {}));
  const attributes = pairs.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join("");
  return [
    { type: "text", text: `<speaker${attributes}/>` },
    { type: "text", text },
  ];
}

/** The speaker and the text of a user message made by `userContent`; undefined when it has no speaker. */
export function splitSpeaker(message: Message | undefined): { speaker: Speaker; text: string } | undefined {
  if (message?.role !== "user" || typeof message.content === "string" || message.content.length !== 2) return undefined;
  const [tag, body] = message.content;
  if (tag?.type !== "text" || body?.type !== "text") return undefined;
  const match = SPEAKER_TAG.exec(tag.text);
  if (!match) return undefined;
  const pairs = [...(match[1] ?? "").matchAll(TAG_ATTRIBUTE)].map((pair) => [pair[1] ?? "", unescapeAttribute(pair[2] ?? "")] as const);
  const [first, ...rest] = pairs;
  if (first?.[0] !== "id") return undefined;
  const speaker: Speaker = { id: first[1] };
  const attributes: Record<string, string> = {};
  for (const [key, value] of rest) {
    if (key === "name" && speaker.name === undefined && Object.keys(attributes).length === 0) speaker.name = value;
    else if (key === "id" || key === "name" || Object.hasOwn(attributes, key)) return undefined;
    else attributes[key] = value;
  }
  if (Object.keys(attributes).length > 0) speaker.attributes = attributes;
  return { speaker, text: body.text };
}

/** Plain text of a user or assistant message; thinking and tool calls are skipped. */
export function messageText(message: Message | undefined): string | undefined {
  if (!message) return undefined;
  if (message.role === "user" && typeof message.content === "string") return message.content;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const texts: string[] = [];
  for (const part of message.content) {
    if (typeof part !== "string" && part.type === "text") texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/** Plain assistant text of a transcript entry, or undefined for other kinds. */
export function assistantText(entry: EntryRecord | undefined): string | undefined {
  if (!entry || !AssistantEntry.is(entry)) return undefined;
  return messageText(entry.model?.[0]);
}

/** Newest-first entries converted to chronological user/assistant lines. */
export function historyLines(entries: readonly EntryRecord[]): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const entry of [...entries].reverse()) {
    const role = UserEntry.is(entry) || ChatMessageEntry.is(entry) ? "user" : AssistantEntry.is(entry) ? "assistant" : undefined;
    if (!role) continue;
    const spoken = role === "user" ? splitSpeaker(entry.model?.[0]) : undefined;
    if (spoken) {
      if (spoken.text) lines.push({ role, text: spoken.text, speaker: spoken.speaker });
      continue;
    }
    const text = messageText(entry.model?.[0]);
    if (text) lines.push({ role, text });
  }
  return lines;
}
