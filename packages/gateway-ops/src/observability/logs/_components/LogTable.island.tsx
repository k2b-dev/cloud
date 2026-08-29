import { dates } from "@k2b/stdlib";
import { Button, CopyButton, DataTable, type DataTableColumn, type LogTableEntry, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import LogFilterBar from "./LogFilterBar";
import type { LogFilterState } from "./types";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  entries: LogTableEntry[];
  total: number;
  filter: LogFilterState;
  sources: string[];
  retentionDays: number;
};

const LEVEL: Record<string, { icon: string; color: string; label: string }> = {
  debug: { icon: "ti ti-bug", color: "text-zinc-400 dark:text-zinc-500", label: "debug" },
  info: { icon: "ti ti-info-circle", color: "text-blue-500 dark:text-blue-400", label: "info" },
  warn: { icon: "ti ti-alert-triangle", color: "text-amber-500 dark:text-amber-400", label: "warn" },
  error: { icon: "ti ti-alert-circle", color: "text-red-500 dark:text-red-400", label: "error" },
};

/** key=value, key2=value2 for the inline detail column */
function formatMetaInline(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "";
  return Object.entries(metadata)
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(", ");
}

/** Structured metadata view for the detail dialog */
function MetadataDetail(props: { metadata: Record<string, unknown> | null }) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (!props.metadata) return null;

  const entries = Object.entries(props.metadata);
  const jsonRaw = JSON.stringify(props.metadata, null, 2);
  const [showRaw, setShowRaw] = createSignal(false);

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={!showRaw()}
        fallback={
          <div class="relative bg-zinc-100 dark:bg-zinc-800 rounded-md px-3 py-2">
            <pre class="text-[11px] text-secondary whitespace-pre-wrap break-all max-h-64 overflow-y-auto pr-16">{jsonRaw}</pre>
            <div class="absolute top-2 right-2">
              <CopyButton text={jsonRaw} label={t.copy} />
            </div>
          </div>
        }
      >
        <div class="bg-zinc-100 dark:bg-zinc-800 rounded-md px-3 py-2">
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            {entries.map(([key, value]) => {
              const isComplex = typeof value === "object" && value !== null;
              const display = isComplex ? JSON.stringify(value) : String(value ?? "null");
              return (
                <>
                  <span class="text-dimmed font-medium shrink-0">{key}</span>
                  <span class={`text-secondary break-all ${isComplex ? "font-mono text-[11px]" : ""}`}>{display}</span>
                </>
              );
            })}
          </div>
        </div>
      </Show>
      <Button type="button" variant="ghost" size="xs" class="self-start" onClick={() => setShowRaw(!showRaw())}>
        {showRaw() ? t.viewFormatted : t.viewRaw}
      </Button>
    </div>
  );
}

function showDetail(entry: LogTableEntry) {
  const locale = document.documentElement.lang;
  const { t } = gatewayOpsMessages.resolve([locale]);
  const level = LEVEL[entry.level];
  void prompts.dialog(
    (close) => (
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <span class="text-dimmed">{t.level}</span>
          <span class={`font-medium ${level?.color ?? "text-primary"}`}>{level?.label ?? entry.level}</span>
          <span class="text-dimmed">{t.source}</span>
          <span class="text-primary">{entry.source}</span>
          <span class="text-dimmed">{t.time}</span>
          <span class="text-primary">{dates.formatDateTime(entry.createdAt, { locale })}</span>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-[10px] uppercase tracking-wider text-dimmed">{t.message}</span>
          <p class="text-xs text-primary whitespace-pre-wrap break-all bg-zinc-100 dark:bg-zinc-800 rounded-md px-3 py-2">
            {entry.message}
          </p>
        </div>
        <Show when={entry.metadata}>
          <div class="flex flex-col gap-1">
            <span class="text-[10px] uppercase tracking-wider text-dimmed">{t.metadata}</span>
            <MetadataDetail metadata={entry.metadata} />
          </div>
        </Show>
        <div class="flex justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={() => close()}>
            {t.close}
          </Button>
        </div>
      </div>
    ),
    {
      title: `${level?.label ?? entry.level}: ${entry.source}`,
      icon: level?.icon ?? "ti ti-file-text",
      size: "large",
    },
  );
}

export default function LogTable(props: Props) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<LogTableEntry>[] = [
    { id: "level", header: t.level, value: (entry) => entry.level },
    { id: "source", header: t.source, value: (entry) => entry.source, cellClass: "whitespace-nowrap" },
    { id: "message", header: t.message, value: (entry) => entry.message },
    { id: "detail", header: t.detail, value: (entry) => formatMetaInline(entry.metadata), class: "hidden xl:table-cell" },
    { id: "time", header: t.time, value: (entry) => entry.createdAt, cellClass: "whitespace-nowrap" },
  ];

  return (
    <section class="overflow-hidden rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)]">
      <div class="flex flex-col gap-2 px-3 py-2">
        <div>
          <h2 class="text-xs font-semibold text-primary">{t.entries}</h2>
          <p class="text-[10px] text-dimmed">{t.visibleLogEntries({ count: props.entries.length, total: props.total })}</p>
        </div>
        <LogFilterBar filter={props.filter} sources={props.sources} retentionDays={props.retentionDays} />
      </div>
      <Show when={props.entries.length > 0} fallback={<Placeholder description={<>{t.noLogEntries}</>} />}>
        <DataTable
          rows={props.entries}
          columns={columns}
          getRowId={(entry) => String(entry.id)}
          onRowClick={showDetail}
          class="overflow-x-auto"
          renderCell={({ row, col }) => {
            const level = LEVEL[row.level] ?? LEVEL.debug!;
            if (col.id === "level") {
              return (
                <span class={`inline-flex items-center gap-1.5 whitespace-nowrap ${level.color}`}>
                  <i class={`${level.icon} text-sm`} />
                  <span>{level.label}</span>
                </span>
              );
            }
            if (col.id === "source") return <span class="text-secondary">{row.source}</span>;
            if (col.id === "message") return <span title={row.message}>{row.message}</span>;
            if (col.id === "detail") return <span class="text-dimmed">{formatMetaInline(row.metadata) || "—"}</span>;
            if (col.id === "time") return <span class="text-dimmed">{dates.formatDateTime(row.createdAt, { locale: locale() })}</span>;
            return "";
          }}
        />
      </Show>
    </section>
  );
}
