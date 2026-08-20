import { query, timed } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  dialogCore,
  FilterChip,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  SettingsGroup,
  StatusBadge,
  TextInput,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { PublicTableAdminOverviewItem, PublicTableAdminOverviewPage } from "../../../api/table-admin-overview";
import { openHistoryProtectionDialog } from "../dialogs/HistoryProtectionDialog";
import { errorMessage } from "../utils/api-helpers";

const PAGE_SIZE = 25;

const historyLabel = (value: PublicTableAdminOverviewItem["durableHistory"]) =>
  value === "active" ? "History active" : value === "preparing" ? "History preparing" : "History off";
const finalizationLabel = (value: PublicTableAdminOverviewItem["finalizationMode"]) =>
  value === "fourEyes" ? "Four-eyes" : value === "direct" ? "Direct" : "Finalization off";
const mutationLabel = (item: PublicTableAdminOverviewItem) =>
  item.mutationPolicy.mode === "all"
    ? "All write paths"
    : item.mutationPolicy.sources.map((source) => (source === "direct" ? "Direct" : source === "form" ? "Forms" : "Workflows")).join(", ");

const columns = [
  { id: "table", header: "Table" },
  { id: "fields", header: "Fields", align: "right" as const },
  { id: "protection", header: "History & Finalization" },
  { id: "writes", header: "Allowed writes" },
  { id: "actions", header: "Actions", align: "right" as const },
];

function TablesOverviewDialog(props: { baseId: string; close: () => void }) {
  const [searchInput, setSearchInput] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [kind, setKind] = createSignal<"all" | "stored" | "combined">("all");
  const [history, setHistory] = createSignal<"all" | "off" | "preparing" | "active">("all");
  const [finalization, setFinalization] = createSignal<"all" | "off" | "direct" | "fourEyes">("all");
  const [page, setPage] = createSignal(1);
  const searchDebounce = timed.debounce((value: string) => {
    setPage(1);
    setSearch(value.trim());
  }, 250);

  const requestUrl = () => {
    const params = new URLSearchParams({
      kind: kind(),
      history: history(),
      finalization: finalization(),
      page: String(page()),
      perPage: String(PAGE_SIZE),
    });
    if (search()) params.set("q", search());
    return `/api/grids/tables/by-base/${encodeURIComponent(props.baseId)}/admin-overview?${params}`;
  };
  const tables = query.create({
    source: requestUrl,
    load: async (url, { abortSignal }): Promise<PublicTableAdminOverviewPage> => {
      const response = await fetch(url, { signal: abortSignal });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load Tables"));
      return response.json();
    },
  });
  const result = () => tables.data();
  const totalPages = createMemo(() => Math.max(1, Math.ceil((result()?.total ?? 0) / PAGE_SIZE)));
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.total === 0) return "No Tables";
    const start = (page() - 1) * PAGE_SIZE + 1;
    return `${start}–${start + value.items.length - 1} of ${value.total} Tables`;
  });
  const setFilter = <T,>(setter: (value: T) => void, value: T) => {
    setPage(1);
    setter(value);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Table overview"
        subtitle="Find a Table, compare its safeguards, or open its settings."
        icon="ti ti-table-options"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DataTable.Header title={rangeLabel()} size="sm">
            <Button size="sm" variant="secondary" disabled={tables.loading() || tables.refreshing()} onClick={() => void tables.refresh()}>
              <i class={tables.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> Refresh
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label="Search Tables"
                placeholder="Search by name or ID"
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
                label="Type"
                icon="ti ti-table"
                options={[
                  {
                    options: [
                      { value: "all", label: "All types" },
                      { value: "stored", label: "Stored Tables" },
                      { value: "combined", label: "Combined Tables" },
                    ],
                  },
                ]}
                value={[kind()]}
                defaultValue={["all"]}
                isActive={kind() !== "all"}
                onValueChange={(value) => setFilter(setKind, value[0] === "stored" || value[0] === "combined" ? value[0] : "all")}
              />
              <FilterChip
                label="Durable History"
                icon="ti ti-history"
                options={[
                  {
                    options: [
                      { value: "all", label: "Any history state" },
                      { value: "off", label: "Off" },
                      { value: "preparing", label: "Preparing" },
                      { value: "active", label: "Active" },
                    ],
                  },
                ]}
                value={[history()]}
                defaultValue={["all"]}
                isActive={history() !== "all"}
                onValueChange={(value) =>
                  setFilter(setHistory, value[0] === "off" || value[0] === "preparing" || value[0] === "active" ? value[0] : "all")
                }
              />
              <FilterChip
                label="Finalization"
                icon="ti ti-lock-check"
                options={[
                  {
                    options: [
                      { value: "all", label: "Any Finalization mode" },
                      { value: "off", label: "Off" },
                      { value: "direct", label: "Direct" },
                      { value: "fourEyes", label: "Four-eyes" },
                    ],
                  },
                ]}
                value={[finalization()]}
                defaultValue={["all"]}
                isActive={finalization() !== "all"}
                onValueChange={(value) =>
                  setFilter(setFinalization, value[0] === "off" || value[0] === "direct" || value[0] === "fourEyes" ? value[0] : "all")
                }
              />
            </div>
          </DataTable.Controls>

          <Show
            when={!tables.error()}
            fallback={
              <Placeholder
                state="error"
                title="Tables are unavailable"
                description={tables.error() instanceof Error ? tables.error()!.message : "Could not load Tables"}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void tables.refresh()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns}
              getRowId={(row) => row.id}
              ariaLabel="Table administration overview"
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                tables.loading() ? (
                  <span>Loading Tables…</span>
                ) : search() || kind() !== "all" || history() !== "all" || finalization() !== "all" ? (
                  <span>No Tables match these filters.</span>
                ) : (
                  <span>This Base has no Tables.</span>
                )
              }
              renderCell={({ row, col }) => {
                if (col.id === "table")
                  return (
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <i class={row.kind === "combined" ? "ti ti-table-share" : "ti ti-table"} aria-hidden="true" />
                        <a
                          class="truncate font-medium text-primary hover:underline focus-visible:underline"
                          href={`/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(row.id)}`}
                        >
                          {row.name}
                        </a>
                      </div>
                      <div class="text-xs text-dimmed">
                        {row.kind === "combined" ? "Combined Table" : "Stored Table"} · {row.id}
                      </div>
                    </div>
                  );
                if (col.id === "fields")
                  return (
                    <div class="whitespace-nowrap text-sm">
                      <div>{row.fieldCount}</div>
                      <div class="text-xs text-dimmed">
                        {row.indexedFieldCount} indexed · {row.uniqueFieldCount} unique
                      </div>
                    </div>
                  );
                if (col.id === "protection")
                  return (
                    <div class="flex flex-wrap gap-1.5">
                      <StatusBadge
                        tone={row.durableHistory === "active" ? "ok" : row.durableHistory === "preparing" ? "warning" : "neutral"}
                        label={historyLabel(row.durableHistory)}
                      />
                      <StatusBadge
                        tone={row.finalizationMode === "fourEyes" ? "running" : "neutral"}
                        label={finalizationLabel(row.finalizationMode)}
                      />
                      <Show when={row.approverGroupName}>
                        <span class="text-xs text-dimmed">{row.approverGroupName}</span>
                      </Show>
                    </div>
                  );
                if (col.id === "writes") return <span class="text-sm">{mutationLabel(row)}</span>;
                if (col.id === "actions")
                  return (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void openHistoryProtectionDialog({ tableId: row.id, tableName: row.name })}
                    >
                      <i class="ti ti-shield-cog" aria-hidden="true" /> Manage
                    </Button>
                  );
                return null;
              }}
            />
          </Show>
          <Show when={totalPages() > 1}>
            <DataTable.Footer class="flex items-center justify-between gap-3">
              <span class="text-xs text-dimmed">
                Page {page()} of {totalPages()}
              </span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tables.loading() || tables.refreshing() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tables.loading() || tables.refreshing() || page() >= totalPages()}
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

export const openTablesOverviewDialog = (baseId: string) =>
  dialogCore.open<void>((close) => <TablesOverviewDialog baseId={baseId} close={() => close()} />, panelDialogWorkspaceOptions);

export function TablesOverviewSection(props: { baseId: string }) {
  return (
    <SettingsGroup
      title="Table overview"
      description="Compare Table structure, write paths, Durable History, and Finalization in one place."
    >
      <SettingsGroup.Action>
        <Button size="sm" variant="secondary" onClick={() => void openTablesOverviewDialog(props.baseId)}>
          <i class="ti ti-table-search" aria-hidden="true" /> Review Tables
        </Button>
      </SettingsGroup.Action>
      <NoticeCard tone="info" icon="ti ti-table-options">
        Use this overview when you need to find Tables that do not keep history yet, or check where Records require approval before they
        become final.
      </NoticeCard>
    </SettingsGroup>
  );
}
