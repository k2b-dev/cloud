import { z } from "zod";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../../contracts";

export type MailDraftJournal = {
  revision: number;
  content: DraftEditableContent;
  confirmedContent?: DraftEditableContent;
  confirmedDigest?: string;
  pendingSave?: { revision: number; content: DraftEditableContent };
};

export const mailDraftJournalKey = (mailboxId: string, draftId: string): string => `cloud:mail:draft:${mailboxId}:${draftId}`;

const mailDraftJournalSchema = z.object({
  revision: z.number().int().nonnegative(),
  content: draftEditableContentInputSchema,
  confirmedContent: draftEditableContentInputSchema.optional(),
  confirmedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  pendingSave: z.object({ revision: z.number().int().positive(), content: draftEditableContentInputSchema.optional() }).optional(),
});

export const serializeMailDraftContent = (content: DraftEditableContent): string => {
  const { signatureTemplateId, ...rest } = content;
  return JSON.stringify({ ...rest, signatureTemplateId: signatureTemplateId ?? null });
};

/** An exact pending write can reuse the current input instead of storing the body twice. */
export const serializeMailDraftJournal = (journal: MailDraftJournal): string =>
  JSON.stringify({
    ...journal,
    pendingSave: journal.pendingSave
      ? {
          revision: journal.pendingSave.revision,
          ...(serializeMailDraftContent(journal.pendingSave.content) === serializeMailDraftContent(journal.content)
            ? {}
            : { content: journal.pendingSave.content }),
        }
      : undefined,
  });

type DraftJournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const readMailDraftJournal = (storage: DraftJournalStorage, key: string): MailDraftJournal | null => {
  const stored = storage.getItem(key);
  if (!stored) return null;
  try {
    const { pendingSave, ...journal } = mailDraftJournalSchema.parse(JSON.parse(stored));
    return pendingSave
      ? { ...journal, pendingSave: { revision: pendingSave.revision, content: pendingSave.content ?? journal.content } }
      : journal;
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
  confirmedDigest?: string;
}): boolean => {
  const journal = readMailDraftJournal(config.storage, config.key);
  if (!journal || serializeMailDraftContent(journal.content) === serializeMailDraftContent(config.savedContent)) {
    config.storage.removeItem(config.key);
    return false;
  }
  config.storage.setItem(
    config.key,
    JSON.stringify({
      revision: config.revision,
      content: journal.content,
      ...(config.confirmedDigest ? { confirmedDigest: config.confirmedDigest } : { confirmedContent: config.savedContent }),
    } satisfies MailDraftJournal),
  );
  return true;
};
