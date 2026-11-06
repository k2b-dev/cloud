import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";

/** The draft of one chat's composer in the Cloud app: restore after mounting, keep on every input, remove once sent. */
export const composerDraft = (accountId: string, conversationId: string) => {
  const field = `chat.composer:${conversationId}`;
  return {
    restore: (): string => pwaDrafts.read(accountId, field) ?? "",
    /** False when the browser could not keep the text after the app closes; say so where the person types. */
    keep: (text: string): boolean => pwaDrafts.write(accountId, field, text),
    sent: (): void => pwaDrafts.remove(accountId, field),
  };
};
