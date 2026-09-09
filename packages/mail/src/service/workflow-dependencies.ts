import { logger } from "@k2b/cloud/services";
import type { WorkflowDependency } from "@k2b/cloud/workflows";
import { wakeWorkflowRunsWaitingOn } from "@k2b/cloud/workflows/store";

const log = logger("mail:workflow-dependencies");
const MAIL_WORKFLOW_DEPENDENCY_RECHECK_MS = 30_000;

export const mailWorkflowDependencyDeadline = (now = new Date()): string =>
  new Date(now.getTime() + MAIL_WORKFLOW_DEPENDENCY_RECHECK_MS).toISOString();

/**
 * Dependency wake-up is a latency hint. Mail dependencies carry a deadline,
 * so the kernel rechecks their durable state even when this notification is
 * lost.
 */
export const publishMailWorkflowDependency = async (input: { mailboxId: string; dependency: WorkflowDependency }): Promise<void> => {
  try {
    await wakeWorkflowRunsWaitingOn({ appId: "mail", ...input.dependency });
  } catch (error) {
    log.warn("Failed to wake Mail workflow dependency", {
      mailboxId: input.mailboxId,
      kind: input.dependency.kind,
      key: input.dependency.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
