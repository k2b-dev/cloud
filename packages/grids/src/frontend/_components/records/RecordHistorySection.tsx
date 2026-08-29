import type { DateContext } from "@k2b/stdlib";
import { Avatar, DetailPanel, IconButton, Placeholder, Tooltip, useLocale } from "@k2b/ui";
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
  "workflow.record.finalization.requested": "ti-lock-check",
  "document_link.created": "ti-link-plus",
  "document_link.revoked": "ti-link-off",
  "document_link.accessed": "ti-link",
};

const ACTION_COLORS: Record<string, string> = {
  created: "text-emerald-600 dark:text-emerald-400",
  updated: "text-blue-600 dark:text-blue-400",
  deleted: "text-red-600 dark:text-red-400",
  restored: "text-amber-600 dark:text-amber-400",
  imported: "text-zinc-600 dark:text-zinc-400",
  "file.added": "text-emerald-600 dark:text-emerald-400",
  "file.replaced": "text-blue-600 dark:text-blue-400",
  "file.removed": "text-amber-600 dark:text-amber-400",
  finalized: "text-emerald-600 dark:text-emerald-400",
  "record_snapshot.created": "text-blue-600 dark:text-blue-400",
  "document.created": "text-blue-600 dark:text-blue-400",
};

export const formatRecordHistoryAction = (action: string, locale = "en"): string => {
  const t = recordMessages.resolve([locale]).t;
  const labels: Record<string, string> = {
    "file.added": t.fileAdded,
    "file.replaced": t.fileReplaced,
    "file.removed": t.fileRemoved,
    finalized: t.recordFinalized,
    "record_snapshot.created": t.snapshotCreated,
    "document.created": t.documentCreated,
    "workflow.record.created": t.workflowCreated,
    "workflow.record.updated": t.workflowUpdated,
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
};

export function RecordHistoryList(props: HistoryProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  const fieldNames = () => new Map(props.fields.map((field) => [field.id, field.name]));
  return (
    <div class="flex flex-col gap-2">
      <Show when={props.entries.length === 0}>
        <Placeholder align="left" class="px-0 py-2" description={<>{t().noHistory}</>} />
      </Show>
      <For each={props.entries}>
        {(entry) => {
          const fieldsChanged = entry.diff ? Object.keys(entry.diff) : [];
          const combinedEntry = "source" in entry;
          const changedLabels = fieldsChanged.map(
            (fieldId) => fieldNames().get(fieldId) ?? (combinedEntry ? t().unavailableField : fieldId),
          );
          const summary =
            fieldsChanged.length === 0
              ? null
              : fieldsChanged.length <= 3
                ? changedLabels.join(", ")
                : `${changedLabels.slice(0, 3).join(", ")} ${t().more({ count: fieldsChanged.length - 3 })}`;
          return (
            <div class="relative">
              <details class="text-xs">
                <summary
                  class={`cursor-pointer select-none flex items-baseline gap-2 ${props.onOpenRecord && entry.recordId ? "pr-8" : ""}`}
                >
                  <i
                    class={`ti ${ACTION_ICONS[entry.action] ?? "ti-circle"} ${ACTION_COLORS[entry.action] ?? "text-dimmed"} text-xs`}
                    aria-hidden="true"
                  />
                  <span class="text-secondary">{formatRecordHistoryAction(entry.action, locale())}</span>
                  <Show
                    when={entry.userDisplayName}
                    fallback={
                      <Show when={entry.userId === null} fallback={<span class="text-dimmed italic">{t().deletedUser}</span>}>
                        <span class="text-dimmed inline-flex items-center gap-1">
                          <i class="ti ti-user-question text-[10px]" aria-hidden="true" />
                          {t().systemActorBy}
                        </span>
                      </Show>
                    }
                  >
                    {(name) => (
                      <span class="inline-flex min-w-0 items-center gap-1 text-dimmed">
                        {t().by}
                        <Avatar
                          name={name()}
                          src={
                            entry.userId && entry.userAvatarHash
                              ? `/api/accounts/users/${encodeURIComponent(entry.userId)}/avatar?rev=${encodeURIComponent(entry.userAvatarHash)}`
                              : null
                          }
                          size="xs"
                          class="h-4! w-4! text-[8px]!"
                        />
                        <span class="truncate">{name()}</span>
                      </span>
                    )}
                  </Show>
                  <Tooltip.Anchor content={entry.createdAt} class="ml-auto shrink-0">
                    <span class="text-[10px] text-dimmed">{formatRecordRelativeTime(entry.createdAt, props.dateConfig)}</span>
                  </Tooltip.Anchor>
                </summary>
                <Show when={summary}>{(value) => <p class="ml-5 text-[11px] text-dimmed">{t().changed({ value: value() })}</p>}</Show>
                <Show when={"source" in entry ? entry.source : null}>
                  {(source) => (
                    <p class="ml-5 text-[11px] text-dimmed">{t().publishedFrom({ base: source().baseName, table: source().tableName })}</p>
                  )}
                </Show>
                <Show when={(entry.context?.answers.length ?? 0) > 0}>
                  <dl class="ml-5 mt-2 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                    <For each={entry.context?.answers ?? []}>
                      {(answer) => (
                        <>
                          <dt class="text-dimmed">{answer.label}</dt>
                          <dd class="whitespace-pre-wrap text-secondary">{answer.optionLabel ?? answer.value}</dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
                <Show when={entry.diff && fieldsChanged.length > 0}>
                  <dl class="ml-5 mt-2 flex flex-col gap-2">
                    <For each={fieldsChanged}>
                      {(fieldId) => {
                        const change = entry.diff?.[fieldId];
                        return (
                          <div class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2 text-[11px]">
                            <dt class="font-medium text-secondary">
                              {fieldNames().get(fieldId) ?? (combinedEntry ? t().unavailableField : fieldId)}
                            </dt>
                            <dd class="mt-1 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1">
                              <span class="text-dimmed">{t().before}</span>
                              <span class="break-words text-secondary">{displayValue(change?.old, t().empty)}</span>
                              <span class="text-dimmed">{t().after}</span>
                              <span class="break-words text-secondary">{displayValue(change?.new, t().empty)}</span>
                            </dd>
                          </div>
                        );
                      }}
                    </For>
                  </dl>
                </Show>
              </details>
              <Show when={props.onOpenRecord && entry.recordId}>
                <Tooltip.Anchor content={t().openRecord} class="absolute right-0 top-0">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    class="-my-1"
                    label={t().openRecord}
                    onClick={() => {
                      props.onOpenRecord?.(entry.recordId!, "recordDeletedAt" in entry && entry.recordDeletedAt !== null);
                    }}
                  >
                    <i class="ti ti-arrow-up-right" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export default function RecordHistorySection(props: HistoryProps) {
  const locale = useLocale();
  const t = () => recordMessages.resolve([locale()]).t;
  return (
    <DetailPanel.Group label={t().recordHistory}>
      <DetailPanel.Section title={t().history} icon="ti ti-history" meta={props.entries.length} collapsible>
        <RecordHistoryList {...props} />
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
