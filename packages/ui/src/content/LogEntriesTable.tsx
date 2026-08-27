import { dates } from "@k2b/stdlib";
import { Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";
import DataTable, { type DataTableColumn } from "./DataTable";

export type LogTableEntry = {
  id: number | string;
  level: string;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type Props = {
  entries: readonly LogTableEntry[];
  emptyMessage?: string;
};

/**
 * Cloud paints each level with a hardcoded Tailwind palette pair
 * (`text-amber-500 dark:text-amber-400`, …). The package keeps the same
 * per-level distinction but routes it through `data-level` so the semantic
 * `--k2b-*` tokens stay the single theming contract in both schemes.
 */
const levelIcon: Record<string, { icon: string; level: string; label: string }> = {
  debug: { icon: "ti ti-bug", level: "debug", label: "debug" },
  info: { icon: "ti ti-info-circle", level: "info", label: "info" },
  warn: { icon: "ti ti-alert-triangle", level: "warn", label: "warn" },
  error: { icon: "ti ti-alert-circle", level: "error", label: "error" },
};

export default function LogEntriesTable(props: Props) {
  const messages = useUiMessages();
  const columns = (): DataTableColumn<LogTableEntry>[] => [
    { id: "level", header: "Level", value: (entry) => entry.level },
    { id: "source", header: `Source (${props.entries.length})`, value: (entry) => entry.source },
    { id: "message", header: "Message", value: (entry) => entry.message },
    { id: "time", header: "Time", value: (entry) => entry.createdAt, cellClass: "k2b-log-table__time-cell" },
  ];

  return (
    <Show
      when={props.entries.length > 0}
      fallback={<Placeholder surface="paper" description={<>{props.emptyMessage ?? messages().noLogEntries}</>} />}
    >
      <DataTable
        rows={props.entries}
        columns={columns()}
        getRowId={(entry) => String(entry.id)}
        hoverRows
        class="k2b-log-table"
        renderCell={({ row, col }) => {
          if (col.id === "level") {
            const level = levelIcon[row.level] ?? { icon: "ti ti-circle", level: "neutral", label: row.level || "unknown" };
            return (
              <span class="k2b-log-level" data-level={level.level}>
                <i class={`k2b-log-level__icon ${level.icon}`} aria-hidden="true" />
                <span>{level.label}</span>
              </span>
            );
          }
          if (col.id === "source") return <span class="k2b-log-table__source">{row.source}</span>;
          if (col.id === "message") return <span title={row.message}>{row.message}</span>;
          if (col.id === "time") return <span class="k2b-log-table__time">{dates.formatDateTime(row.createdAt)}</span>;
          return "";
        }}
      />
    </Show>
  );
}
