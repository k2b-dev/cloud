type CodePermission = { operation: string; target: { type: string; id: string | null } | null };
/**
 * Whether a version writes to its bound chat. The manifest records the bound chat and a chat chosen at run time alike
 * (`chat.send`, id null); a version that creates chats of its own may write only to those, so nobody claims it lacks
 * one. Should it still use the bound chat, the run fails with `chat_unbound` and says so.
 * `codeUsesBoundChatCondition` in `chat-binding.ts` is its SQL form.
 */
export const codeUsesBoundChat = (permissions: readonly CodePermission[]) =>
  permissions.some(
    (permission) =>
      permission.operation === "core.ai.chat.send" && permission.target?.type === "core.ai.chat" && permission.target.id === null,
  ) && !permissions.some((permission) => permission.operation === "core.ai.chat.create");
