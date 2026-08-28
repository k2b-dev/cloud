import type { MailActionId } from "./mail-actions";

export const MAIL_BULK_CONCURRENCY = 4;
export const MAIL_BULK_NO_PROVIDER_PLACEMENT = "mail_bulk_no_provider_placement";
export const MAIL_BULK_QUEUE_FAILED = "mail_bulk_queue_failed";

export type MailBulkTarget = {
  conversationId: string;
  label: string;
  sourceFolderIds: readonly string[];
};

type MailBulkFailure = {
  conversationId: string;
  label: string;
  message: string;
  submittedPlacements: number;
};

type MailBulkResult = {
  succeededConversationIds: string[];
  failures: MailBulkFailure[];
};

export const executeMailBulkAction = async (params: {
  actionId: MailActionId;
  targets: readonly MailBulkTarget[];
  submit: (target: MailBulkTarget, sourceFolderId: string) => Promise<void>;
  concurrency?: number;
}): Promise<MailBulkResult> => {
  const concurrency = Math.min(Math.max(Math.floor(params.concurrency ?? MAIL_BULK_CONCURRENCY), 1), MAIL_BULK_CONCURRENCY);
  const results: Array<{
    target: MailBulkTarget;
    error: unknown;
    submittedPlacements: number;
  }> = new Array(params.targets.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const target = params.targets[index];
      if (!target) return;
      let submittedPlacements = 0;
      try {
        if (target.sourceFolderIds.length === 0) throw new Error(MAIL_BULK_NO_PROVIDER_PLACEMENT);
        for (const sourceFolderId of target.sourceFolderIds) {
          await params.submit(target, sourceFolderId);
          submittedPlacements += 1;
        }
        results[index] = { target, error: null, submittedPlacements };
      } catch (error) {
        results[index] = { target, error, submittedPlacements };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, params.targets.length) }, () => worker()));
  const succeededConversationIds: string[] = [];
  const failures: MailBulkFailure[] = [];
  for (const result of results) {
    if (!result.error) {
      succeededConversationIds.push(result.target.conversationId);
      continue;
    }
    failures.push({
      conversationId: result.target.conversationId,
      label: result.target.label,
      message: result.error instanceof Error ? result.error.message : MAIL_BULK_QUEUE_FAILED,
      submittedPlacements: result.submittedPlacements,
    });
  }
  return { succeededConversationIds, failures };
};
