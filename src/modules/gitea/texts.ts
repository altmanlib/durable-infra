// Fixed text people read in Gitea: what the issue tools add under a filed
// issue or a posted comment.

/** The signature under an issue's body: who asked for it, when that is known. */
export const issueSignature = (asker: string | undefined): string => (asker ? `---\n由机器人代 ${asker} 在群聊中创建` : "---\n由机器人在群聊中创建");

/** The signature under a comment: who asked for it, when that is known. */
export const commentSignature = (asker: string | undefined): string => (asker ? `---\n由机器人代 ${asker} 在群聊中评论` : "---\n由机器人在群聊中评论");
