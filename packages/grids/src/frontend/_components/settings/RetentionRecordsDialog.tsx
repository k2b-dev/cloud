import { query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  DataTable,
  type DataTableColumn,
  dialogCore,
  FilterChip,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  StatusBadge,
  TextInput,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { RetentionRecord, RetentionRecordStatus, RetentionRecordsResponse } from "../../../retention-policy-contracts";
import { errorMessage } from "../utils/api-helpers";

const PAGE_SIZE = 25;

const columns: DataTableColumn<RetentionRecord>[] = [
  { id: "record", header: "Record", value: (row) => row.recordId },
  { id: "table", header: "Table", value: (row) => row.tableName },
  { id: "status", header: "Floor", value: (row) => row.status },
  { id: "deletedAt", header: "Moved to trash", value: (row) => row.deletedAt },
  { id: "notBefore", header: "Floor date", value: (row) => row.notBefore },
  { id: "actions", header: "", align: "right" },
];

const statusLabel = (status: RetentionRecord["status"]): string => {
  if (status === "protected") return "Finalized";
  if (status === "retained") return "Retained";
  return "Floor reached";
};

function RetentionRecordsDialog(props: { baseId: string; minimumDays: number; close: () => void }) {
  const [searchInput, setSearchInput] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [status, setStatus] = createSignal<RetentionRecordStatus>("all");
  const [page, setPage] = createSignal(1);
  const searchDebounce = timed.debounce((value: string) => {
    setPage(1);
    setSearch(value.trim());
  }, 250);

  const requestUrl = () => {
    const params = new URLSearchParams({
      minimumDays: String(props.minimumDays),
      status: status(),
      page: String(page()),
      per_page: String(PAGE_SIZE),
    });
    if (search()) params.set("search", search());
    return `/api/grids/bases/${encodeURIComponent(props.baseId)}/retention-policy/records?${params}`;
  };
  const records = query.create({
    source: requestUrl,
    load: async (url, { abortSignal }): Promise<RetentionRecordsResponse> => {
      const response = await fetch(url, { signal: abortSignal });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load retained Records"));
      return response.json();
    },
  });
  const result = () => records.data();
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.pagination.total === 0) return "No Records";
    const start = (value.pagination.page - 1) * value.pagination.per_page + 1;
    const end = start + value.items.length - 1;
    return `${start}–${end} of ${value.pagination.total} Records`;
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Trashed Records"
        subtitle={`Preview for a ${props.minimumDays}-day retention floor`}
        icon="ti ti-archive"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DataTable.Header title={rangeLabel()} size="sm">
            <Button
              size="sm"
              variant="secondary"
              disabled={records.loading() || records.refreshing()}
              onClick={() => void records.refresh()}
            >
              <i class={records.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> Refresh
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label="Search retained Records"
                placeholder="Search Record ID or Table"
                icon="ti ti-search"
                activeIcon="ti ti-search"
                clearable
                value={searchInput}
                onClear={() => {
                  setSearchInput("");
                  searchDebounce.trigger("");
                }}
                onValueChange={(value) => {
                  setSearchInput(value);
                  searchDebounce.debouncedFn(value);
                }}
              />
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <FilterChip
                label="Floor status"
                icon="ti ti-filter"
                options={[
                  {
                    options: [
                      { value: "all", label: "All Records" },
                      { value: "protected", label: "Finalized" },
                      { value: "retained", label: "Retained until later" },
                      { value: "reached", label: "Floor reached" },
                    ],
                  },
                ]}
                value={[status()]}
                defaultValue={["all"]}
                isActive={status() !== "all"}
                onValueChange={(value) => {
                  setPage(1);
                  setStatus((value[0] ?? "all") as RetentionRecordStatus);
                }}
              />
            </div>
          </DataTable.Controls>
          <Show
            when={!records.error()}
            fallback={
              <Placeholder
                state="error"
                title="Retained Records are unavailable"
                description={records.error() instanceof Error ? records.error()!.message : "Could not load retained Records"}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void records.refresh()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns}
              getRowId={(row) => row.recordId}
              ariaLabel="Trashed Records under the retention floor"
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                records.loading() ? (
                  <span>Loading retained Records…</span>
                ) : search() || status() !== "all" ? (
                  <span>No Records match these filters.</span>
                ) : (
                  <span>No Records are currently in trash for this Base.</span>
                )
              }
              renderCell={({ row, col, render, value }) => {
                if (col.id === "record") return <span class="font-medium text-primary">{row.recordId}</span>;
                if (col.id === "table") {
                  return (
                    <div class="min-w-0">
                      <div class="truncate text-primary">{row.tableName}</div>
                      <div class="truncate text-xs text-dimmed">{row.tableId}</div>
                    </div>
                  );
                }
                if (col.id === "status") return <StatusBadge tone="neutral" label={statusLabel(row.status)} />;
                if (col.id === "deletedAt") return new Date(row.deletedAt).toLocaleString();
                if (col.id === "notBefore") return row.notBefore ? new Date(row.notBefore).toLocaleString() : "Protected independently";
                if (col.id === "actions") {
                  return (
                    <ButtonLink
                      size="sm"
                      variant="ghost"
                      href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(row.tableId)}?trash=1&record=${encodeURIComponent(row.recordId)}`}
                    >
                      Open in Trash <i class="ti ti-arrow-up-right" aria-hidden="true" />
                    </ButtonLink>
                  );
                }
                return render(value);
              }}
            />
          </Show>
          <Show when={(result()?.pagination.total_pages ?? 0) > 1}>
            <DataTable.Footer class="flex items-center justify-between gap-3">
              <span class="text-xs text-dimmed">
                Page {page()} of {result()?.pagination.total_pages}
              </span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={records.loading() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={records.loading() || !result()?.pagination.has_next}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </div>
            </DataTable.Footer>
          </Show>
        </DataTable.Panel>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openRetentionRecordsDialog = (baseId: string, minimumDays: number) =>
  dialogCore.open<void>(
    (close) => <RetentionRecordsDialog baseId={baseId} minimumDays={minimumDays} close={() => close()} />,
    panelDialogWorkspaceOptions,
  );
