import { ButtonLink, DataTable, type DataTableColumn, dialogCore, PanelDialog, panelDialogWorkspaceOptions, StatusBadge } from "@k2b/ui";
import type { EvidenceExportPreflight } from "../../../evidence-export-contracts";

type CoverageTable = EvidenceExportPreflight["tables"][number];

const columns: DataTableColumn<CoverageTable>[] = [
  { id: "table", header: "Table", value: (row) => row.name },
  { id: "records", header: "Records", value: (row) => row.records, align: "right" },
  { id: "history", header: "History", value: (row) => row.history.state },
  { id: "finalized", header: "Finalized", value: (row) => row.finalization.finalizedRecords, align: "right" },
  { id: "actions", header: "", align: "right" },
];

const historyState = (table: CoverageTable) => {
  if (table.history.state === "active") {
    return {
      label: table.history.startsAt ? `Active since ${new Date(table.history.startsAt).toLocaleDateString()}` : "Active",
      tone: "ok" as const,
    };
  }
  if (table.history.state === "activating") return { label: "Building baseline", tone: "running" as const };
  if (table.history.state === "incomplete") return { label: "Incomplete", tone: "warning" as const };
  if (table.history.state === "legacy") return { label: "Earlier states unavailable", tone: "warning" as const };
  return { label: "Not enabled", tone: "neutral" as const };
};

function EvidenceCoverageDialog(props: { baseId: string; baseName: string; tables: CoverageTable[]; close: () => void }) {
  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Evidence coverage by Table"
        subtitle={`${props.baseName} · ${props.tables.length} stored Tables`}
        icon="ti ti-table-search"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable
          rows={props.tables}
          columns={columns}
          getRowId={(row) => row.tableId}
          ariaLabel="Evidence coverage by stored Table"
          density="compact"
          surface="paper"
          hoverRows
          stickyHeader
          fillHeight
          class="min-h-0 flex-1 overflow-auto"
          empty={<span>No stored Tables in this Base.</span>}
          renderCell={({ row, col, render, value }) => {
            if (col.id === "table") {
              return (
                <div class="min-w-0">
                  <div class="truncate font-medium text-primary">{row.name}</div>
                  <div class="truncate text-xs text-dimmed">{row.trashed ? `In trash · ${row.tableId}` : row.tableId}</div>
                </div>
              );
            }
            if (col.id === "history") {
              const state = historyState(row);
              return <StatusBadge tone={state.tone} variant="text" label={state.label} icon={null} />;
            }
            if (col.id === "finalized") return row.finalization.enabled ? row.finalization.finalizedRecords : "Not enabled";
            if (col.id === "actions" && !row.trashed) {
              return (
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(row.tableId)}`}
                >
                  Open Table <i class="ti ti-arrow-up-right" aria-hidden="true" />
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
