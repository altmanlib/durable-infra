import { appDocFamily, checkpoint } from "../app-docs.ts";

/** Session-scoped map from conversation key to conversation ID, written in the same commit that creates the conversation. */
export const ChannelMap = appDocFamily<{ conversationId: number }, number>({
  kind: "app.channel",
  version: 1,
  initial: (conversationId) => ({ conversationId }),
  checkpoint: checkpoint.every(50),
});
