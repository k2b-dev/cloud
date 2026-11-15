/**
 * The `data-chat-anchor` of a Code version card in the chat. Core's `core.code.chat.list` answers the same anchor, and
 * the card's loading placeholder carries it too, so a jump finds the card while its code still loads.
 */
export const codeVersionCardAnchor = (versionId: string) => `code-version-${versionId}`;
