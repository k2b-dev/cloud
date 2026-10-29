import { z } from "zod";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../../contracts";

export type MailDraftJournal = { revision: number; content: DraftEditableContent };

export const mailDraftJournalKey = (mailboxId: string, draftId: string): string => `cloud:mail:draft:${mailboxId}:${draftId}`;

const mailDraftJournalSchema = z.object({
  revision: z.number().int().nonnegative(),
  content: draftEditableContentInputSchema,
});

export const serializeMailDraftContent = (content: DraftEditableContent): string => {
  const { signatureTemplateId, ...rest } = content;
  return JSON.stringify({ ...rest, signatureTemplateId: signatureTemplateId ?? null });
};

type DraftJournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const readMailDraftJournal = (storage: DraftJournalStorage, key: string): MailDraftJournal | null => {
  const stored = storage.getItem(key);
  if (!stored) return null;
  try {
    return mailDraftJournalSchema.parse(JSON.parse(stored));
  } catch {
    storage.removeItem(key);
    return null;
  }
};

export const advanceMailDraftJournalAfterSave = (config: {
  storage: DraftJournalStorage;
  key: string;
  revision: number;
  savedContent: DraftEditableContent;
}): boolean => {
  const journal = readMailDraftJournal(config.storage, config.key);
  if (!journal || serializeMailDraftContent(journal.content) === serializeMailDraftContent(config.savedContent)) {
    config.storage.removeItem(config.key);
    return false;
  }
  config.storage.setItem(config.key, JSON.stringify({ revision: config.revision, content: journal.content } satisfies MailDraftJournal));
  return true;
};
