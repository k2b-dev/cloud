import type { DotStripTone } from "@k2b/ui";
import type { WorkflowTryItem } from "../../contracts";
import type { MailWorkflowDryRunText } from "./mail-workflow-dry-run-messages";

type Effect = WorkflowTryItem["effects"][number];
type Fact = WorkflowTryItem["facts"][number];

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Values the rule's conditions read, in plain words. `false` for bulk mail and attachments says nothing and is left out. */
export const formatDryRunFact = (fact: Fact, t: MailWorkflowDryRunText): string | null => {
  const field = fact.path.replace(/^(inputs|trigger)\.[^.]+\./u, (prefix) =>
    prefix.includes("conversation") ? "conversation." : "message.",
  );
  const value = fact.value;
  if (field.endsWith(".textLength") && typeof value === "number") return t.factChars({ count: value });
  if (field.endsWith(".messageCount") && typeof value === "number") return t.factMessages({ count: value });
  if (field.endsWith(".attachmentCount") && typeof value === "number") return t.factAttachments({ count: value });
  if (field.endsWith(".isBulk")) return value === true ? t.factBulk : null;
  if (field.endsWith(".hasAttachments")) return value === true ? t.factHasAttachments : null;
  if (value === null || value === "") return null;
  return `${fact.path.split(".").at(-1)}: ${String(value)}`;
};

const statusLabel = (status: string | null, t: MailWorkflowDryRunText) =>
  status === "needs_action"
    ? t.statusNeedsAction
    : status === "waiting"
      ? t.statusWaiting
      : status === "done"
        ? t.statusDone
        : (status ?? "");

export const formatDryRunEffect = (effect: Effect, t: MailWorkflowDryRunText): string => {
  const params = effect.params;
  const label = (() => {
    switch (effect.kind) {
      case "summarizeConversation":
        return params.mode !== "replace" && params.existingSummary === true ? t.effectSummarizeRolling : t.effectSummarize;
      case "assignConversation": {
        const name = text(params.user) ?? text(params.group);
        return name ? t.effectAssignUser({ name }) : t.effectAssignNobody;
      }
      case "addLocalTag":
        return t.effectTag({ tag: text(params.tag) ?? "" });
      case "moveMessage":
        return t.effectMove({ folder: text(params.folder) ?? "" });
      case "archiveMessage":
        return t.effectArchive;
      case "trashMessage":
        return t.effectTrash;
      case "junkMessage":
        return t.effectJunk;
      case "addFlag":
        return params.flag === "seen" ? t.effectMarkRead : t.effectOther({ kind: effect.kind });
      case "setConversationStatus":
        return t.effectStatus({ status: statusLabel(text(params.status), t) });
      case "aiClassify":
      case "aiClassifyMany":
        return t.effectClassify;
      case "aiExtractData":
        return t.effectExtract;
      case "aiGenerateText":
        return t.effectGenerate;
      case "addComment":
        return t.effectComment;
      case "createDraft":
      case "createReplyDraft":
        return t.effectDraft;
      case "notifyUser":
        return t.effectNotify;
      case "setConversationSummary":
        return t.effectSummary;
      default:
        return t.effectOther({ kind: effect.kind });
    }
  })();
  return effect.dependsOnAi && !effect.ai ? `${label} (${t.dependsOnAi})` : label;
};

export const formatDryRunReason = (item: WorkflowTryItem, t: MailWorkflowDryRunText): string => {
  const reason = item.reason;
  if (reason?.code === "already_assigned") return t.reasonAssigned;
  if (reason?.code === "upper_rule") return t.reasonUpperRule;
  const fact = reason?.field ? item.facts.find((candidate) => candidate.path.endsWith(reason.field!.split(".").at(-1)!)) : undefined;
  return (fact && formatDryRunFact(fact, t)) ?? t.reasonExcluded;
};

/** The facts line under a row: conditions' values, then what would happen. */
export const formatDryRunDetail = (item: WorkflowTryItem, t: MailWorkflowDryRunText): { facts: string; effect: string | null } => {
  if (item.outcome === "skipped") return { facts: formatDryRunReason(item, t), effect: t.skippedArrow };
  const facts = item.facts
    .map((fact) => formatDryRunFact(fact, t))
    .filter((fact): fact is string => fact !== null)
    .join(" · ");
  const effects = item.outcome === "match" ? item.effects.map((effect) => formatDryRunEffect(effect, t)) : [];
  return { facts, effect: effects.length > 0 ? effects.join(", ") : null };
};

export const dryRunTone = (item: WorkflowTryItem): DotStripTone =>
  item.outcome === "match" ? "accent" : item.outcome === "skipped" ? "warning" : "muted";
