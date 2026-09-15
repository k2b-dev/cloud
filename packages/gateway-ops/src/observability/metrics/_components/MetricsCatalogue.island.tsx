import { formatNumber } from "@k2b/cloud/shared";
import { DataTable, type DataTableColumn, FilterChip, type FilterChipSection, StatusBadge, TextInput, useLocale } from "@k2b/ui";
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
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
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
    <div style="view-transition-name: admin-metrics-table">
      <DataTable.Panel>
        <DataTable.Header
          title={t.metrics}
          subtitle={t.metricsCount({
            count: formatNumber(filteredRows().length, { locale: locale() }),
            total: formatNumber(props.rows.length, { locale: locale() }),
          })}
          size="sm"
        />
        <DataTable.Controls class="flex-col items-stretch">
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
        </DataTable.Controls>
        <DataTable
          rows={filteredRows()}
          columns={columns}
          getRowId={(row) => row.name}
          hoverRows
          density="compact"
          surface="plain"
          cellContentClass="whitespace-normal"
          renderCell={({ row, col, value, render }) => {
            if (col.id === "source") {
              return <span class="tag bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{row.source}</span>;
            }
            if (col.id === "type") {
              return <span class="tag bg-blue-50 font-mono text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">{row.type}</span>;
            }
            if (col.id === "series") return <span class="tabular-nums text-dimmed">{formatNumber(row.series, { locale: locale() })}</span>;
            if (col.id === "status") {
              // Degraded means the collector ran but its backing source is
              // unreachable, so the series exist with zeroed values.
              return (
                <StatusBadge
                  tone={row.status === "degraded" ? "warning" : row.status}
                  label={row.status === "ok" ? "OK" : row.status === "degraded" ? t.degraded : t.error}
                  icon={row.status === "ok" ? "ti ti-check" : "ti ti-alert-triangle"}
                  title={row.status === "ok" ? undefined : (row.error ?? undefined)}
                />
              );
            }
            return render(value);
          }}
          empty={t.noMatchingMetrics}
        />
      </DataTable.Panel>
    </div>
  );
}
