import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { DataTable, type DataTableColumn, type LogTableEntry, Pagination, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import LogFilterBar from "./LogFilterBar";
import { entryHref, LEVEL } from "./log-levels";
import type { LogFilterState } from "./types";

type Props = {
  entries: LogTableEntry[];
  /** The entry open in the detail column. */
  selectedId: string | null;
  /** Address that opens one entry in the detail column, with the current filters. */
  entryHrefBase: string;
  total: number;
  filter: LogFilterState;
  sources: string[];
  timeZone: string;
  totalPages: number;
  baseUrl: string;
  loadError: string | null;
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
    <DataTable.Panel>
      <DataTable.Header
        title={t.entries}
        subtitle={
          props.loadError
            ? t.unavailable
            : t.visibleLogEntries({
                count: formatNumber(props.entries.length, { locale: locale() }),
                total: formatNumber(props.total, { locale: locale() }),
              })
        }
      />
      <DataTable.Controls>
        <LogFilterBar filter={props.filter} sources={props.sources} />
      </DataTable.Controls>
      <Show
        when={!props.loadError}
        fallback={<Placeholder state="error" variant="compact" title={t.logStoreUnavailable} description={props.loadError ?? undefined} />}
      >
        <DataTable
          rows={props.entries}
          columns={columns}
          getRowId={(entry) => String(entry.id)}
          selectedRowId={props.selectedId}
          onRowClick={(entry) => window.location.assign(entryHref(props.entryHrefBase, String(entry.id)))}
          surface="plain"
          empty={t.noLogEntries}
          renderCell={({ row, col }) => {
            const level = LEVEL[row.level] ?? LEVEL.debug!;
            if (col.id === "level") {
              return <StatusBadge tone={level.tone} icon={level.icon} label={level.label} />;
            }
            if (col.id === "source") return <span class="text-secondary">{row.source}</span>;
            if (col.id === "message") return <span title={row.message}>{row.message}</span>;
            if (col.id === "detail") return <span class="text-dimmed">{formatMetaInline(row.metadata) || "—"}</span>;
            if (col.id === "time")
              return <span class="text-dimmed">{formatDateTime(row.createdAt, { locale: locale(), timeZone: props.timeZone })}</span>;
            return "";
          }}
        />
      </Show>
      <DataTable.Footer>
        <Pagination currentPage={props.filter.page} totalPages={props.totalPages} baseUrl={props.baseUrl} />
      </DataTable.Footer>
    </DataTable.Panel>
  );
}
