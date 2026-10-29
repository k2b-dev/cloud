import type { DraftEditableContent } from "../../contracts";
import { draftRecipientConfirmation } from "../../lib/draft-document";

/** Every awaited dialog covers one exact sender/recipient inventory. */
export const confirmSharedDraftRecipients = async (options: {
  changed: () => boolean;
  content: () => DraftEditableContent;
  confirm: (content: DraftEditableContent) => Promise<boolean | undefined>;
  accepted: () => void;
  signal: AbortSignal;
}): Promise<boolean> => {
  while (options.changed()) {
    options.signal.throwIfAborted();
    const content = options.content(),
      inventory = draftRecipientConfirmation(content);
    if (!(await options.confirm(content))) return false;
    options.signal.throwIfAborted();
    if (inventory !== draftRecipientConfirmation(options.content())) continue;
    options.accepted();
  }
  return true;
};
