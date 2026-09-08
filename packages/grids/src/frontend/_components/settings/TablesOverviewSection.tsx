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
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { PublicTableAdminOverviewItem, PublicTableAdminOverviewPage } from "../../../api/table-admin-overview";
import { openHistoryProtectionDialog } from "../dialogs/HistoryProtectionDialog";
import { errorMessage } from "../utils/api-helpers";
import { useGridsSettingsMessages } from "./messages";

const PAGE_SIZE = 25;

function TablesOverviewDialog(props: { baseId: string; close: () => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const historyLabel = (value: PublicTableAdminOverviewItem["durableHistory"]) =>
    value === "active" ? messages().historyActive : value === "preparing" ? messages().historyPreparing : messages().historyOff;
  const finalizationLabel = (value: PublicTableAdminOverviewItem["finalizationMode"]) =>
    value === "fourEyes"
      ? messages().finalizationFourEyes
      : value === "direct"
        ? messages().finalizationDirect
        : messages().finalizationOff;
  const mutationLabel = (item: PublicTableAdminOverviewItem) =>
    item.mutationPolicy.mode === "all"
      ? messages().allWritePaths
      : item.mutationPolicy.sources
          .map((source) => (source === "direct" ? messages().direct : source === "form" ? messages().forms : messages().workflows))
          .join(", ");
  const columns = () => [
    { id: "table", header: messages().table },
    { id: "fields", header: messages().fields, align: "right" as const },
    { id: "protection", header: messages().historyAndFinalization },
    { id: "writes", header: messages().allowedWrites },
    { id: "actions", header: messages().actions, align: "right" as const },
  ];
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
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadTablesFailed));
      return response.json();
    },
  });
  const result = () => tables.data();
  const totalPages = createMemo(() => Math.max(1, Math.ceil((result()?.total ?? 0) / PAGE_SIZE)));
  const rangeLabel = createMemo(() => {
    const value = result();
    if (!value || value.total === 0) return messages().noTables;
    const start = (page() - 1) * PAGE_SIZE + 1;
    return messages().tablesRange({ start: number(start), end: number(start + value.items.length - 1), total: number(value.total) });
  });
  const setFilter = <T,>(setter: (value: T) => void, value: T) => {
    setPage(1);
    setter(value);
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().tableOverview}
        subtitle={messages().tableOverviewSubtitle}
        icon="ti ti-table-options"
        close={props.close}
      />
      <PanelDialog.Body>
        <DataTable.Panel class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DataTable.Header title={rangeLabel()} size="sm">
            <Button size="sm" variant="secondary" disabled={tables.loading() || tables.refreshing()} onClick={() => void tables.refresh()}>
              <i class={tables.refreshing() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" /> {messages().refresh}
            </Button>
          </DataTable.Header>
          <DataTable.Controls>
            <div class="w-full">
              <TextInput
                type="search"
                aria-label={messages().searchTables}
                placeholder={messages().searchByNameOrId}
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
                label={messages().type}
                icon="ti ti-table"
                options={[
                  {
                    options: [
                      { value: "all", label: messages().allTypes },
                      { value: "stored", label: messages().storedTables },
                      { value: "combined", label: messages().combinedTables },
                    ],
                  },
                ]}
                value={[kind()]}
                defaultValue={["all"]}
                isActive={kind() !== "all"}
                onValueChange={(value) => setFilter(setKind, value[0] === "stored" || value[0] === "combined" ? value[0] : "all")}
              />
              <FilterChip
                label={messages().durableHistory}
                icon="ti ti-history"
                options={[
                  {
                    options: [
                      { value: "all", label: messages().anyHistoryState },
                      { value: "off", label: messages().off },
                      { value: "preparing", label: messages().preparing },
                      { value: "active", label: messages().active },
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
                label={messages().finalization}
                icon="ti ti-lock-check"
                options={[
                  {
                    options: [
                      { value: "all", label: messages().anyFinalizationMode },
                      { value: "off", label: messages().off },
                      { value: "direct", label: messages().direct },
                      { value: "fourEyes", label: messages().fourEyes },
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
                title={messages().tablesUnavailable}
                description={tables.error() instanceof Error ? tables.error()!.message : messages().loadTablesFailed}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void tables.refresh()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <DataTable
              rows={result()?.items ?? []}
              columns={columns()}
              getRowId={(row) => row.id}
              ariaLabel={messages().tableAdminOverviewAria}
              density="compact"
              surface="plain"
              hoverRows
              fillHeight
              class="min-h-0 flex-1 overflow-auto"
              empty={
                tables.loading() ? (
                  <span>{messages().loadingTables}</span>
                ) : search() || kind() !== "all" || history() !== "all" || finalization() !== "all" ? (
                  <span>{messages().noTablesMatch}</span>
                ) : (
                  <span>{messages().baseHasNoTables}</span>
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
                        {row.kind === "combined" ? messages().combinedTable : messages().storedTable} · {row.id}
                      </div>
                    </div>
                  );
                if (col.id === "fields")
                  return (
                    <div class="whitespace-nowrap text-sm">
                      <div>{number(row.fieldCount)}</div>
                      <div class="text-xs text-dimmed">
                        {messages().indexedAndUnique({ indexed: number(row.indexedFieldCount), unique: number(row.uniqueFieldCount) })}
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
                      <i class="ti ti-shield-cog" aria-hidden="true" /> {messages().manage}
                    </Button>
                  );
                return null;
              }}
            />
          </Show>
          <Show when={totalPages() > 1}>
            <DataTable.Footer class="flex items-center justify-between gap-3">
              <span class="text-xs text-dimmed">{messages().pageOf({ page: number(page()), total: number(totalPages()) })}</span>
              <div class="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tables.loading() || tables.refreshing() || page() <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  {messages().previous}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={tables.loading() || tables.refreshing() || page() >= totalPages()}
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

const openTablesOverviewDialog = (baseId: string) =>
  dialogCore.open<void>((close) => <TablesOverviewDialog baseId={baseId} close={() => close()} />, panelDialogWorkspaceOptions);

export function TablesOverviewSection(props: { baseId: string }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  return (
    <SettingsGroup title={messages().tableOverview} description={messages().tableOverviewDescription}>
      <SettingsGroup.Action>
        <Button size="sm" variant="secondary" onClick={() => void openTablesOverviewDialog(props.baseId)}>
          <i class="ti ti-table-search" aria-hidden="true" /> {messages().reviewTables}
        </Button>
      </SettingsGroup.Action>
      <NoticeCard tone="info" icon="ti ti-table-options">
        {messages().tableOverviewGuidance}
      </NoticeCard>
    </SettingsGroup>
  );
}
