import type { MailAutomationLogText } from "./mail-automation-log-messages";
import type { AutomationLogEffect, AutomationLogItem, AutomationLogReason } from "./mail-automation-log-model";

/** One piece of the reason line; `ai` pieces carry ✦ because the AI supplied the value. */
export type LogReasonPart = { text: string; ai: boolean };

const statusName = (status: "needs_action" | "waiting" | "done", t: MailAutomationLogText) =>
  status === "needs_action" ? t.statusNeedsAction : status === "waiting" ? t.statusWaiting : t.statusDone;

const valueText = (value: string | number | boolean, locale: string) =>
  typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : String(value);

const capitalize = (text: string) => (text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text);

export const formatLogEffect = (effect: AutomationLogEffect, t: MailAutomationLogText): string => {
  switch (effect.kind) {
    case "assign":
      return t.effectAssigned({ name: effect.target.name });
    case "unassign":
      return t.effectUnassigned;
    case "tag":
      return t.effectTagged({ name: effect.name });
    case "move":
      return t.effectMoved({ name: effect.folder });
    case "archive":
      return t.effectArchived;
    case "status":
      return t.effectStatus({ name: statusName(effect.status, t) });
    case "read":
      return t.effectRead;
    case "comment":
      return t.effectComment;
    case "summary":
      return t.effectSummary;
  }
};

const assignTarget = (item: Pick<AutomationLogItem, "effects">) =>
  item.effects.find((effect) => effect.kind === "assign")?.target.name ?? "";

/** The bold first line: what happened, in past tense. */
export const formatLogTitle = (item: Pick<AutomationLogItem, "outcome" | "effects">, t: MailAutomationLogText): string => {
  switch (item.outcome) {
    case "assigned":
      return t.assignedTo({ name: assignTarget(item) });
    case "uncertain":
      return t.uncertainTo({ name: assignTarget(item) });
    case "nobody":
      return t.nobody;
    case "skipped":
      return t.skippedAssign;
    case "manual_change":
      return t.manualChange;
    case "failed":
      return t.failed;
    case "effects":
      return capitalize(item.effects.map((effect) => formatLogEffect(effect, t)).join(", "));
  }
};

const formatReason = (reason: AutomationLogReason, t: MailAutomationLogText, locale: string): LogReasonPart[] => {
  switch (reason.kind) {
    case "ai_choice":
      return [{ text: t.kind({ value: reason.value }), ai: true }];
    case "ai_value":
      return [{ text: t.value({ field: capitalize(reason.field), value: valueText(reason.value, locale) }), ai: true }];
    case "comparison":
      return [{ text: reason.met ? reason.text : t.not({ text: reason.text }), ai: false }];
    case "no_target":
      return [{ text: t.noTarget({ name: reason.choice }), ai: false }];
    case "condition":
      return [{ text: reason.text, ai: false }];
    case "skipped_upper_rule":
      return [{ text: t.upperRule({ name: reason.name }), ai: false }];
    case "already_assigned":
      return [{ text: t.alreadyAssigned, ai: false }];
    case "undone_before":
      return [{ text: t.undoneBefore, ai: false }];
    case "manual": {
      const before = reason.before ? t.manualBefore({ before: reason.before.name, rule: reason.before.byRule }) : t.manualBeforeNobody;
      const after = reason.after ? t.manualAfter({ name: reason.after.name }) : t.manualAfterNobody;
      return [{ text: `${before} ${after} ${t.ruleStays}`, ai: false }];
    }
  }
};

/** The quiet second line: why, with ✦ on what the AI supplied. Parts join with " · ". */
export const formatLogReasons = (item: AutomationLogItem, t: MailAutomationLogText, locale: string): LogReasonPart[] => {
  const parts = item.reasons.flatMap((reason) => formatReason(reason, t, locale));
  if (item.outcome === "uncertain") parts.push({ text: t.nothingElse, ai: false });
  if (item.outcome === "failed" && parts.length === 0) parts.push({ text: t.failedWhy, ai: false });
  return parts;
};

export const formatLogTime = (iso: string, locale: string, timeZone?: string) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
