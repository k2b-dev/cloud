import type { WorkflowRunState } from "@k2b/cloud/workflows";
import type { WorkflowRunSummary } from "@k2b/cloud/workflows/store";
import { i18n } from "@k2b/stdlib";
import type { IncomingAutomationBackfillActivity } from "./incoming-automations";

const activityMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      conflict: "Another change prevented this automation from applying its action.",
      backfill: "Backfill",
      dispatched: ({ count }: { count: number }) => `${count} matching message${count === 1 ? "" : "s"} dispatched`,
    },
    de: {
      conflict: "Eine andere Änderung hat verhindert, dass diese Automatisierung ihre Aktion ausführt.",
      backfill: "Nachträgliche Verarbeitung",
      dispatched: ({ count }) => `${count} ${count === 1 ? "passende E-Mail verarbeitet" : "passende E-Mails verarbeitet"}`,
    },
  },
});

export type MailAutomationActivityKind = "automatic_reply" | "incoming_automation" | "workflow" | "backfill";
export type MailAutomationActivityStatus = WorkflowRunState | "completed";

export type MailAutomationActivityItem = {
  id: string;
  kind: MailAutomationActivityKind;
  name: string;
  status: MailAutomationActivityStatus;
  occurredAt: string;
  durationMs: number | null;
  detail: string | null;
  href: string;
};

export type MailAutomationActivityCounts = {
  total: number;
  active: number;
  failed: number;
  backfills: number;
};

const sentenceCase = (value: string): string => {
  const words = value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLocaleLowerCase();
  return words ? `${words[0]?.toLocaleUpperCase()}${words.slice(1)}` : value;
};

const workflowErrorMessage = (run: WorkflowRunSummary, locale?: string): string | null => {
  if (run.resultMessage) return run.resultMessage;
  if (!run.error || typeof run.error !== "object" || Array.isArray(run.error)) return null;
  const message = run.error.message;
  if (typeof message === "string" && message !== "[object Object]") return message;
  const code = run.error.code;
  if (code === "CONFLICT") return activityMessages.resolve([locale ?? "en"]).t.conflict;
  return typeof code === "string" ? sentenceCase(code) : null;
};

export const projectMailWorkflowActivity = (params: {
  mailboxId: string;
  run: WorkflowRunSummary;
  replyWorkflowIds: ReadonlySet<string>;
  incomingAutomationWorkflowIds: ReadonlySet<string>;
  workflowNames?: ReadonlyMap<string, string>;
  locale?: string;
}): MailAutomationActivityItem => {
  const { mailboxId, run, replyWorkflowIds, incomingAutomationWorkflowIds, workflowNames } = params;
  const kind: MailAutomationActivityKind = replyWorkflowIds.has(run.workflowId)
    ? "automatic_reply"
    : incomingAutomationWorkflowIds.has(run.workflowId)
      ? "incoming_automation"
      : "workflow";
  const section = kind === "automatic_reply" ? "replies" : kind === "incoming_automation" ? "incoming" : "workflows";
  return {
    id: `run:${run.id}`,
    kind,
    name: workflowNames?.get(run.workflowId) ?? run.workflowName,
    status: run.state,
    occurredAt: run.createdAt.toISOString(),
    durationMs: run.durationMs,
    detail:
      workflowErrorMessage(run, params.locale) ?? (run.eventType ? sentenceCase(run.eventType.split(".").at(-1) ?? run.eventType) : null),
    href: `/app/mail/${mailboxId}/automations/${section}`,
  };
};

export const projectMailBackfillActivity = (params: {
  mailboxId: string;
  backfill: IncomingAutomationBackfillActivity;
  automationNames: ReadonlyMap<string, string>;
  locale?: string;
}): MailAutomationActivityItem => {
  const { mailboxId, backfill, automationNames } = params;
  const t = activityMessages.resolve([params.locale ?? "en"]).t;
  return {
    id: `backfill:${backfill.automationId}:${backfill.operationId}`,
    kind: "backfill",
    name: `${t.backfill} · ${automationNames.get(backfill.automationId) ?? backfill.name}`,
    status: backfill.status,
    occurredAt: backfill.createdAt,
    durationMs: ["completed", "failed", "canceled"].includes(backfill.status)
      ? Math.max(0, Date.parse(backfill.updatedAt) - Date.parse(backfill.createdAt))
      : null,
    detail: backfill.lastError ?? t.dispatched({ count: backfill.dispatched }),
    href: `/app/mail/${mailboxId}/automations/incoming`,
  };
};

export const summarizeMailAutomationActivity = (items: MailAutomationActivityItem[]): MailAutomationActivityCounts => ({
  total: items.length,
  active: items.filter((item) => ["queued", "running", "waiting"].includes(item.status)).length,
  failed: items.filter((item) => ["failed", "needs_attention"].includes(item.status)).length,
  backfills: items.filter((item) => item.kind === "backfill").length,
});
