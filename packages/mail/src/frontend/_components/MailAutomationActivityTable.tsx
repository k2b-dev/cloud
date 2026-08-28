import { DataTable, type DataTableColumn, StatusBadge, type StatusTone, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type {
  MailAutomationActivityItem,
  MailAutomationActivityKind,
  MailAutomationActivityStatus,
} from "../../service/automation-workspace";
import { mailRemainingMessages } from "./mail-remaining-messages";

const statusTone = (status: MailAutomationActivityStatus): StatusTone => {
  if (status === "succeeded" || status === "completed") return "ok";
  if (status === "failed" || status === "needs_attention") return "error";
  if (status === "queued" || status === "running" || status === "waiting") return "running";
  return "neutral";
};

const formatDuration = (durationMs: number | null, locale: string): string => {
  if (durationMs === null) return "—";
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (durationMs < 1_000) return `${format.format(Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${format.format(durationMs / 1_000)} s`;
  return `${format.format(durationMs / 60_000)} min`;
};

const formatDate = (value: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export default function MailAutomationActivityTable(props: { items: MailAutomationActivityItem[]; empty?: string; compact?: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const kindLabels = createMemo<Record<MailAutomationActivityKind, string>>(() => ({
    automatic_reply: messages().automaticReply,
    incoming_automation: messages().incomingAutomation,
    workflow: messages().workflow,
    backfill: messages().backfill,
  }));
  const columns = createMemo<DataTableColumn<MailAutomationActivityItem>[]>(() => [
    { id: "kind", header: messages().type, value: (row) => kindLabels()[row.kind], class: "w-40" },
    { id: "name", header: messages().automation, value: (row) => row.name },
    { id: "status", header: messages().status, value: (row) => row.status, class: "w-36" },
    { id: "detail", header: messages().details, value: (row) => row.detail },
    { id: "duration", header: messages().duration, value: (row) => row.durationMs, align: "right", class: "w-28" },
    { id: "occurredAt", header: messages().started, value: (row) => row.occurredAt, class: "w-48" },
  ]);
  return (
    <DataTable
      rows={props.items}
      columns={columns()}
      getRowId={(row) => row.id}
      density={props.compact ? "compact" : "normal"}
      hoverRows
      highlightColumns
      empty={props.empty ?? messages().noAutomationActivity}
      class="overflow-x-auto"
      renderCell={({ row, col, render }) => {
        if (col.id === "kind") return <StatusBadge tone="neutral" label={kindLabels()[row.kind]} icon={null} />;
        if (col.id === "name")
          return (
            <a class="block truncate font-medium text-primary hover:underline" href={row.href}>
              {row.name}
            </a>
          );
        if (col.id === "status")
          return (
            <StatusBadge
              tone={statusTone(row.status)}
              label={messages().activityStatus({ status: row.status })}
              icon={["queued", "running", "waiting"].includes(row.status) ? "ti ti-loader-2 animate-spin" : undefined}
            />
          );
        if (col.id === "detail") return <span class="block whitespace-normal">{row.detail ?? "—"}</span>;
        if (col.id === "duration") return <span class="tabular-nums">{formatDuration(row.durationMs, locale())}</span>;
        if (col.id === "occurredAt") return <time dateTime={row.occurredAt}>{formatDate(row.occurredAt, locale())}</time>;
        return render(row.detail);
      }}
      cellContentClass="min-w-0"
    />
  );
}
