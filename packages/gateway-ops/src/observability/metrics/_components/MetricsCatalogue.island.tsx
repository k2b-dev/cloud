import { DataTable, type DataTableColumn, FilterChip, type FilterChipSection, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";

export type MetricsCatalogueRow = {
  name: string;
  sourceId: string;
  source: string;
  description: string;
  type: string;
  series: number;
  status: "ok" | "degraded" | "error";
  error: string | null;
};

type MetricsCatalogueProps = {
  rows: MetricsCatalogueRow[];
  sources: { id: string; label: string }[];
};

export default function MetricsCatalogue(props: MetricsCatalogueProps) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const columns: DataTableColumn<MetricsCatalogueRow>[] = [
    { id: "name", header: t.metric, value: (row) => row.name, cellClass: "font-mono text-[11px] max-w-[26rem]" },
    { id: "source", header: t.source, value: (row) => row.source, cellClass: "whitespace-nowrap" },
    { id: "type", header: t.type, value: (row) => row.type, cellClass: "whitespace-nowrap" },
    { id: "series", header: t.series, value: (row) => row.series, cellClass: "whitespace-nowrap text-right" },
    { id: "status", header: t.status, value: (row) => row.status, cellClass: "whitespace-nowrap" },
    { id: "description", header: t.description, value: (row) => row.description, cellClass: "min-w-[24rem]" },
  ];
  const [search, setSearch] = createSignal("");
  const [source, setSource] = createSignal("");
  const [type, setType] = createSignal("");

  const sourceOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: [
        { value: "", label: t.all, icon: "ti ti-list" },
        ...props.sources.map((item) => ({ value: item.id, label: item.label, icon: "ti ti-database" })),
      ],
    },
  ]);
  const typeOptions: FilterChipSection[] = [
    {
      options: [
        { value: "", label: t.all, icon: "ti ti-list" },
        { value: "gauge", label: t.gauge, icon: "ti ti-chart-bar" },
        { value: "counter", label: t.counter, icon: "ti ti-refresh" },
      ],
    },
  ];

  const filteredRows = createMemo(() => {
    const needle = search().trim().toLowerCase();
    const sourceId = source();
    const metricType = type();
    return props.rows.filter((row) => {
      if (sourceId && row.sourceId !== sourceId) return false;
      if (metricType && row.type !== metricType) return false;
      if (!needle) return true;
      return [row.name, row.source, row.type, row.description].some((value) => value.toLowerCase().includes(needle));
    });
  });

  return (
    <section
      class="overflow-hidden rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)]"
      style="view-transition-name: admin-metrics-table"
    >
      <div class="flex flex-col gap-2 px-3 py-2">
        <div>
          <h2 class="text-xs font-semibold text-primary">{t.metrics}</h2>
          <p class="text-[10px] text-dimmed">{t.metricsCount({ count: filteredRows().length, total: props.rows.length })}</p>
        </div>
        <TextInput
          name="metrics-search"
          type="search"
          placeholder={t.searchMetrics}
          aria-label={t.searchMetricsLabel}
          icon="ti ti-search"
          activeIcon="ti ti-search"
          value={search}
          onValueChange={setSearch}
          clearable
          clearLabel={t.clearSearch}
        />
        <div class="flex flex-wrap gap-2">
          <FilterChip
            label={t.source}
            icon="ti ti-filter"
            options={sourceOptions()}
            value={source() ? [source()] : []}
            onValueChange={(value) => setSource(value[0] ?? "")}
            isActive={source().length > 0}
            defaultValue={[]}
          />
          <FilterChip
            label={t.type}
            icon="ti ti-chart-dots"
            options={typeOptions}
            value={type() ? [type()] : []}
            onValueChange={(value) => setType(value[0] ?? "")}
            isActive={type().length > 0}
            defaultValue={[]}
          />
        </div>
      </div>
      <DataTable
        rows={filteredRows()}
        columns={columns}
        getRowId={(row) => row.name}
        hoverRows
        density="compact"
        class="overflow-x-auto"
        cellContentClass="whitespace-normal"
        renderCell={({ row, col, value, render }) => {
          if (col.id === "source") {
            return <span class="tag bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{row.source}</span>;
          }
          if (col.id === "type") {
            return <span class="tag bg-blue-50 font-mono text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{row.type}</span>;
          }
          if (col.id === "series") return <span class="tabular-nums text-dimmed">{row.series}</span>;
          if (col.id === "status") {
            if (row.status === "ok")
              return (
                <span class="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                  <i class="ti ti-check text-xs" />
                  OK
                </span>
              );
            // Degraded means the collector ran but its backing source is
            // unreachable, so the series exist with zeroed values.
            if (row.status === "degraded")
              return (
                <span class="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" title={row.error ?? undefined}>
                  <i class="ti ti-alert-triangle text-xs" />
                  {t.degraded}
                </span>
              );
            return (
              <span class="inline-flex items-center gap-1 text-red-700 dark:text-red-300" title={row.error ?? undefined}>
                <i class="ti ti-alert-triangle text-xs" />
                {t.error}
              </span>
            );
          }
          return render(value);
        }}
        empty={t.noMatchingMetrics}
      />
    </section>
  );
}
