import {
  ButtonLink,
  DataTable,
  type DataTableColumn,
  dialogCore,
  PanelDialog,
  panelDialogWorkspaceOptions,
  StatusBadge,
  useLocale,
} from "@k2b/ui";
import type { EvidenceExportPreflight } from "../../../evidence-export-contracts";
import { useGridsSettingsMessages } from "./messages";

type CoverageTable = EvidenceExportPreflight["tables"][number];

function EvidenceCoverageDialog(props: { baseId: string; baseName: string; tables: CoverageTable[]; close: () => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const date = (value: string) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(value));
  const columns = (): DataTableColumn<CoverageTable>[] => [
    { id: "table", header: messages().table, value: (row) => row.name },
    { id: "records", header: messages().records, value: (row) => row.records, align: "right" },
    { id: "history", header: messages().history, value: (row) => row.history.state },
    { id: "finalized", header: messages().finalized, value: (row) => row.finalization.finalizedRecords, align: "right" },
    { id: "actions", header: "", align: "right" },
  ];
  const historyState = (table: CoverageTable) => {
    if (table.history.state === "active")
      return {
        label: table.history.startsAt ? messages().activeSince({ date: date(table.history.startsAt) }) : messages().active,
        tone: "ok" as const,
      };
    if (table.history.state === "activating") return { label: messages().buildingBaseline, tone: "running" as const };
    if (table.history.state === "incomplete") return { label: messages().incomplete, tone: "warning" as const };
    if (table.history.state === "legacy") return { label: messages().earlierStatesUnavailable, tone: "warning" as const };
    return { label: messages().notEnabled, tone: "neutral" as const };
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().evidenceCoverageByTable}
        subtitle={`${props.baseName} · ${messages().storedTableCount({ count: number(props.tables.length) })}`}
        icon="ti ti-table-search"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable
          rows={props.tables}
          columns={columns()}
          getRowId={(row) => row.tableId}
          ariaLabel={messages().evidenceCoverageAria}
          density="compact"
          surface="paper"
          hoverRows
          stickyHeader
          fillHeight
          class="min-h-0 flex-1 overflow-auto"
          empty={<span>{messages().noStoredTables}</span>}
          renderCell={({ row, col, render, value }) => {
            if (col.id === "table") {
              return (
                <div class="min-w-0">
                  <div class="truncate font-medium text-primary">{row.name}</div>
                  <div class="truncate text-xs text-dimmed">
                    {row.trashed ? messages().inTrashWithId({ id: row.tableId }) : row.tableId}
                  </div>
                </div>
              );
            }
            if (col.id === "history") {
              const state = historyState(row);
              return <StatusBadge tone={state.tone} variant="text" label={state.label} icon={null} />;
            }
            if (col.id === "finalized") return row.finalization.enabled ? number(row.finalization.finalizedRecords) : messages().notEnabled;
            if (col.id === "actions" && !row.trashed) {
              return (
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(row.tableId)}`}
                >
                  {messages().openTable} <i class="ti ti-arrow-up-right" aria-hidden="true" />
                </ButtonLink>
              );
            }
            return render(value);
          }}
        />
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openEvidenceCoverageDialog = (baseId: string, baseName: string, tables: CoverageTable[]) =>
  dialogCore.open<void>(
    (close) => <EvidenceCoverageDialog baseId={baseId} baseName={baseName} tables={tables} close={close} />,
    panelDialogWorkspaceOptions,
  );
