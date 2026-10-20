// Fixed text people read in Gitea: what the issue tool adds at the end of an issue it files.

/** The signature under an issue's body: who asked for it, when that is known. */
export const issueSignature = (asker: string | undefined): string => (asker ? `---\n由机器人代 ${asker} 在群聊中创建` : "---\n由机器人在群聊中创建");
