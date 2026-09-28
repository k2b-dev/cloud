import type { MailDraft } from "../../contracts";

export type ClosedMailDraft = MailDraft & { state: Exclude<MailDraft["state"], "draft"> };

export type MailDraftLifecycleTransition = {
  draft: ClosedMailDraft;
  hasUnsavedChanges: boolean;
};

export const isClosedMailDraft = (draft: MailDraft): draft is ClosedMailDraft => draft.state !== "draft";

export const reconcileMailDraftLifecycle = (
  current: MailDraftLifecycleTransition | null,
  draft: MailDraft,
  hasUnsavedChanges: boolean,
): MailDraftLifecycleTransition | null =>
  isClosedMailDraft(draft)
    ? {
        draft,
        hasUnsavedChanges: current?.hasUnsavedChanges ?? hasUnsavedChanges,
      }
    : current;
