import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import { workflowMessages } from "./messages";

export const automaticTriggerSummary = (plan: WorkflowBoundPlan, locale = "en"): string | null => {
  const t = workflowMessages.resolve([locale]).t;
  const labels = plan.triggers.flatMap((trigger) => {
    if (trigger.kind === "schedule") {
      return [t.scheduleTriggerSummary({ cron: String(trigger.config.cron ?? ""), timezone: String(trigger.config.timezone ?? "UTC") })];
    }
    if (trigger.kind === "recordEvent") {
      return [
        t.recordTriggerSummary({
          event: String(trigger.config.event ?? "updated"),
          ...(typeof trigger.config.table === "string" ? { table: trigger.config.table } : {}),
        }),
      ];
    }
    return [];
  });
  return labels.length > 0 ? labels.join("\n") : null;
};

export const shouldConfirmAutomaticTriggers = (
  workflow: { enabled: boolean; plan: WorkflowBoundPlan } | undefined,
  nextPlan: WorkflowBoundPlan,
  nextEnabled: boolean,
): boolean => {
  if (!nextEnabled) return false;
  const nextTriggers = automaticTriggerSummary(nextPlan);
  if (!nextTriggers) return false;
  if (!workflow?.enabled) return true;
  const automaticTriggers = (plan: WorkflowBoundPlan) =>
    plan.triggers.filter((trigger) => trigger.kind === "schedule" || trigger.kind === "recordEvent");
  return JSON.stringify(automaticTriggers(nextPlan)) !== JSON.stringify(automaticTriggers(workflow.plan));
};
