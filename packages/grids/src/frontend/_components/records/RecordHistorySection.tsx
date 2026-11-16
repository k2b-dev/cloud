import type { DateContext } from "@k2b/stdlib";
import { type ActivityDensity, type ActivityEntry, ActivityList, type ActivityTone, Section, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { PublicRecordHistoryEntry as RecordHistoryEntry } from "../../../api/public-audit";
import type { PublicField as Field } from "../../../api/public-dto";
import { recordMessages } from "./messages";

const ACTION_ICONS: Record<string, string> = {
  created: "ti-plus",
  updated: "ti-pencil",
  deleted: "ti-trash",
  restored: "ti-arrow-back-up",
  imported: "ti-file-import",
  "file.added": "ti-paperclip",
  "file.replaced": "ti-replace",
  "file.removed": "ti-paperclip-off",
  finalized: "ti-lock",
  "record_snapshot.created": "ti-camera",
  "document.created": "ti-file-type-pdf",
  "workflow.record.created": "ti-table-plus",
  "workflow.record.updated": "ti-table-pencil",
  "workflow.record.deleted": "ti-trash",
  "workflow.record.finalization.requested": "ti-lock-check",
  "document_link.created": "ti-link-plus",
  "document_link.revoked": "ti-link-off",
  "document_link.accessed": "ti-link",
};

export const formatRecordHistoryAction = (action: string, locale = "en"): string => {
  const t = recordMessages.resolve([locale]).t;
  const labels: Record<string, string> = {
    created: t.created,
    updated: t.updated,
    deleted: t.deleted,
    restored: t.restored,
    imported: t.imported,
    "file.added": t.fileAdded,
    "file.replaced": t.fileReplaced,
    "file.removed": t.fileRemoved,
    finalized: t.recordFinalized,
    "record_snapshot.created": t.snapshotCreated,
    "document.created": t.documentCreated,
    "workflow.record.created": t.workflowCreated,
    "workflow.record.updated": t.workflowUpdated,
    "workflow.record.deleted": t.workflowDeleted,
    "workflow.record.finalization.requested": t.workflowFinalization,
    "document_link.created": t.documentLinkCreated,
    "document_link.revoked": t.documentLinkRevoked,
    "document_link.accessed": t.documentLinkAccessed,
  };
  return labels[action] ?? action;
};

export function formatRecordRelativeTime(iso: string, dateConfig?: DateContext): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - then) / 1000);
  const locale = dateConfig?.locale ?? "en";
  if (seconds < 60) return recordMessages.resolve([locale]).t.justNow;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 86_400 * 30) return relative.format(-Math.floor(seconds / 86_400), "day");
  return new Intl.DateTimeFormat(dateConfig?.locale, { timeZone: dateConfig?.timeZone }).format(new Date(iso));
}

const displayValue = (value: unknown, empty: string): string => {
  if (value === null || value === undefined || value === "") return empty;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? empty : value.map((item) => displayValue(item, empty)).join(", ");
  return JSON.stringify(value);
};

type HistoryProps = {
  entries: RecordHistoryEntry[];
  fields: Field[];
  dateConfig?: DateContext;
  onOpenRecord?: (recordId: string, deleted: boolean) => void;
  /** `wide` for a dialog: the meta line on the right. Defaults to the compact density of the detail panel. */
  density?: ActivityDensity;
  /** Older events follow below, such as in the combined audit trail; the rail fades out. */
  more?: boolean;
};

/** Only a completed state carries a tone; every other action stays grey. */
const actionTone = (action: string): ActivityTone => (action === "finalized" ? "success" : "neutral");

export function RecordHistoryList(props: HistoryProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const fieldNames = () => new Map(props.fields.map((field) => [field.id, field.name]));
  const fieldName = (fieldId: string, combined: boolean) => fieldNames().get(fieldId) ?? (combined ? t().unavailableField : fieldId);
  // Each event is one timeline row: what happened, which fields changed and where it was published from, and who did it.
  // Answers and the before and after of each field fold out on a click.
  const activityEntries = (): ActivityEntry[] =>
    props.entries.map((entry) => {
      const fieldsChanged = entry.diff ? Object.keys(entry.diff) : [];
      const combined = "source" in entry;
      const changedLabels = fieldsChanged.map((fieldId) => fieldName(fieldId, combined));
      const summary =
        fieldsChanged.length === 0
          ? null
          : fieldsChanged.length <= 3
            ? changedLabels.join(", ")
            : `${changedLabels.slice(0, 3).join(", ")} ${t().more({ count: fieldsChanged.length - 3 })}`;
      const source = "source" in entry ? entry.source : null;
      const detail = [
        summary ? t().changed({ value: summary }) : null,
        source ? t().publishedFrom({ base: source.baseName, table: source.tableName }) : null,
      ]
        .filter(Boolean)
        .join("\n");
      const answers = entry.context?.answers ?? [];
      const recordId = entry.recordId;
      return {
        id: entry.id,
        at: entry.createdAt,
        icon: `ti ${ACTION_ICONS[entry.action] ?? "ti-circle"}`,
        tone: actionTone(entry.action),
        text: formatRecordHistoryAction(entry.action, locale()),
        detail: detail || undefined,
        actor: entry.userDisplayName ?? (entry.userId === null ? t().systemActor : t().deletedUser),
        details:
          answers.length > 0 || fieldsChanged.length > 0
            ? () => (
                <div class="flex flex-col gap-2 text-[13px]">
                  <Show when={answers.length > 0}>
                    <dl class="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
                      <For each={answers}>
                        {(answer) => (
                          <>
                            <dt class="text-dimmed">{answer.label}</dt>
                            <dd class="whitespace-pre-wrap text-secondary">{answer.optionLabel ?? answer.value}</dd>
                          </>
                        )}
                      </For>
                    </dl>
                  </Show>
                  <Show when={fieldsChanged.length > 0}>
                    <dl class="flex flex-col gap-2">
                      <For each={fieldsChanged}>
                        {(fieldId) => {
                          const change = entry.diff?.[fieldId];
                          return (
                            <div>
                              <dt class="font-medium text-secondary">{fieldName(fieldId, combined)}</dt>
                              <dd class="mt-0.5">
                                <ActivityList.Change
                                  before={displayValue(change?.old, t().empty)}
                                  now={displayValue(change?.new, t().empty)}
                                />
                              </dd>
                            </div>
                          );
                        }}
                      </For>
                    </dl>
                  </Show>
                </div>
              )
            : undefined,
        action:
          props.onOpenRecord && recordId
            ? {
                icon: "ti ti-arrow-up-right",
                label: t().openRecord,
                onClick: () => props.onOpenRecord?.(recordId, "recordDeletedAt" in entry && entry.recordDeletedAt !== null),
              }
            : null,
      };
    });
  return (
    <Show when={props.entries.length > 0} fallback={<ActivityList.Empty text={t().noHistory} />}>
      <ActivityList
        entries={activityEntries()}
        density={props.density}
        more={props.more}
        dateConfig={props.dateConfig}
        label={t().history}
      />
    </Show>
  );
}

export default function RecordHistorySection(props: HistoryProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const latest = () => props.entries[0];
  return (
    <Section
      title={t().history}
      icon="ti ti-history"
      count={props.entries.length || undefined}
      collapsible
      summary={
        latest()
          ? [formatRecordHistoryAction(latest()!.action, locale()), latest()!.userDisplayName].filter(Boolean).join(" · ")
          : t().noHistory
      }
    >
      <RecordHistoryList {...props} />
    </Section>
  );
}
