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
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { RetentionRecord, RetentionRecordStatus, RetentionRecordsResponse } from "../../../retention-policy-contracts";
import { errorMessage } from "../utils/api-helpers";
import { useGridsSettingsMessages } from "./messages";

const PAGE_SIZE = 25;

function RetentionRecordsDialog(props: { baseId: string; minimumDays: number; close: () => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const columns = (): DataTableColumn<RetentionRecord>[] => [
    { id: "record", header: messages().record, value: (row) => row.recordId },
    { id: "table", header: messages().table, value: (row) => row.tableName },
    { id: "status", header: messages().floor, value: (row) => row.status },
    { id: "deletedAt", header: messages().movedToTrash, value: (row) => row.deletedAt },
    { id: "notBefore", header: messages().floorDate, value: (row) => row.notBefore },
    { id: "actions", header: "", align: "right" },
  ];
  const statusLabel = (value: RetentionRecord["status"]) =>
    value === "protected" ? messages().finalized : value === "retained" ? messages().retained : messages().floorReached;
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
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadRetainedRecordsFailed));
      return response.json();
    },
  });
  const result = () => records.data();
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.pagination.total === 0) return messages().noRecords;
    const start = (value.pagination.page - 1) * value.pagination.per_page + 1;
    const end = start + value.items.length - 1;
    return messages().recordsRange({ start: number(start), end: number(end), total: number(value.pagination.total) });
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().trashedRecords}
        subtitle={messages().retentionPreviewDays({ days: number(props.minimumDays) })}
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
              <i class={records.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> {messages().refresh}
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label={messages().searchRetainedRecords}
                placeholder={messages().searchRecordOrTable}
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
                label={messages().floorStatus}
                icon="ti ti-filter"
                options={[
                  {
                    options: [
                      { value: "all", label: messages().allRecords },
                      { value: "protected", label: messages().finalized },
                      { value: "retained", label: messages().retainedUntilLater },
                      { value: "reached", label: messages().floorReached },
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
                title={messages().retainedRecordsUnavailable}
                description={records.error() instanceof Error ? records.error()!.message : messages().loadRetainedRecordsFailed}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void records.refresh()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns()}
              getRowId={(row) => row.recordId}
              ariaLabel={messages().retainedRecordsAria}
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                records.loading() ? (
                  <span>{messages().loadingRetainedRecords}</span>
                ) : search() || status() !== "all" ? (
                  <span>{messages().noRecordsMatch}</span>
                ) : (
                  <span>{messages().noRecordsInTrash}</span>
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
                if (col.id === "deletedAt") return dateTime(row.deletedAt);
                if (col.id === "notBefore") return row.notBefore ? dateTime(row.notBefore) : messages().protectedIndependently;
                if (col.id === "actions") {
                  return (
                    <ButtonLink
                      size="sm"
                      variant="ghost"
                      href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(row.tableId)}?trash=1&record=${encodeURIComponent(row.recordId)}`}
                    >
                      {messages().openInTrash} <i class="ti ti-arrow-up-right" aria-hidden="true" />
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
                {messages().pageOf({ page: number(page()), total: number(result()?.pagination.total_pages ?? 1) })}
              </span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={records.loading() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  {messages().previous}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={records.loading() || !result()?.pagination.has_next}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {messages().next}
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
