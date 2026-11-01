import type { ResourceApiKey, ResourceApiKeysProps } from "@k2b/cloud/access/ui";
import { Button, DataTable, type DataTableColumn, StatusBadge, TextInput } from "@k2b/ui";
import { type Accessor, type JSX, Show } from "solid-js";
import type { PulseSource, PulseSourceScrape } from "../../contracts";
import { localizedSourceError, type pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext, sourceKindIcon, sourceStatus } from "./helpers";
import SourceDetailView from "./SourceDetailView";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const sourceColumns = (t: Messages): DataTableColumn<PulseSource>[] => [
  // A phone shows one column: status and newest data move into the source cell.
  { id: "source", header: t.source, value: "name", cellClass: "min-w-56 max-sm:min-w-0" },
  { id: "status", header: t.status, headerClass: "max-sm:hidden", cellClass: "w-32 whitespace-nowrap max-sm:hidden" },
  { id: "newest", header: t.newestData, headerClass: "max-sm:hidden", cellClass: "w-44 whitespace-nowrap max-sm:hidden" },
];

const sourceScrapeColumns = (t: Messages): DataTableColumn<PulseSourceScrape>[] => [
  { id: "status", header: t.status, cellClass: "w-28 whitespace-nowrap" },
  { id: "finished", header: t.finished, cellClass: "w-44 whitespace-nowrap" },
  { id: "samples", header: t.data, cellClass: "w-28 whitespace-nowrap" },
  { id: "duration", header: t.time, cellClass: "w-20 whitespace-nowrap" },
  { id: "error", header: t.error, cellClass: "min-w-40" },
];

const sourceSubtitle = (source: PulseSource, t: Messages): string =>
  source.kind === "metrics"
    ? [t.metricsEndpoint, t.scrapeEvery({ seconds: source.scrapeIntervalSeconds ?? 60 }), source.endpointUrl ?? t.noEndpointShort].join(
        " · ",
      )
    : `${t.httpIngest} · ${t.tokenIngestEndpoint}`;

const renderSourceStatusCell = (source: PulseSource, t: Messages, variant: "chip" | "dot" = "chip"): JSX.Element => {
  const status = sourceStatus(source, t);
  return <StatusBadge label={status.label} tone={status.tone} title={status.title} variant={variant} />;
};

const renderSourceTitleCell = (source: PulseSource, t: Messages, newest: string): JSX.Element => (
  <div class="flex min-w-0 items-center gap-2">
    <span class="k2b-icon-tile h-8 w-8 text-secondary" aria-hidden="true">
      <i class={`${sourceKindIcon(source.kind)} text-base`} />
    </span>
    <div class="min-w-0">
      <p class="truncate text-sm font-medium text-primary">{source.name}</p>
      <p class="mt-0.5 truncate text-xs text-dimmed" title={source.endpointUrl ?? undefined}>
        {sourceSubtitle(source, t)}
      </p>
      <p class="mt-0.5 text-xs text-dimmed">
        {source.kind === "metrics"
          ? t.sqlSeriesCount({ count: source.seriesCount ?? 0 })
          : source.todayCount == null
            ? "—"
            : t.sqlTodayCount({ count: source.todayCount })}
      </p>
      <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-dimmed sm:hidden">
        {renderSourceStatusCell(source, t, "dot")}
        <span class="truncate">
          {t.newestData}: {newest}
        </span>
      </div>
    </div>
  </div>
);

export type SourcesViewProps = {
  search: Accessor<string>;
  setSearch: (value: string) => void;
  selectedBaseId: Accessor<string>;
  loading: Accessor<boolean>;
  sources: Accessor<PulseSource[]>;
  selectedSourceId: Accessor<string>;
  selectedSource: Accessor<PulseSource | null>;
  selectedSourceScrapes: Accessor<PulseSourceScrape[]>;
  selectedSourceApiKeys: Accessor<ResourceApiKey[]>;
  origin: Accessor<string>;
  dateContext: Accessor<PulseDateContext>;
  copySetupText: (text: string, label: string) => void;
  addSource: () => void | Promise<void>;
  selectSource: (source: PulseSource) => void;
  closeSource: () => void;
  editSource: (source: PulseSource) => void | Promise<void>;
  toggleSource: (source: PulseSource) => void | Promise<void>;
  scrape: (source: PulseSource) => void | Promise<void>;
  removeSource: (source: PulseSource) => void | Promise<void>;
  createApiKey: (
    source: PulseSource,
    input: Parameters<ResourceApiKeysProps["createKey"]>[0],
  ) => ReturnType<ResourceApiKeysProps["createKey"]>;
  revokeApiKey: (source: PulseSource, credentialId: string) => ReturnType<ResourceApiKeysProps["revokeKey"]>;
};

export default function SourcesView(props: SourcesViewProps) {
  const t = usePulseMessages();
  const newestData = (source: PulseSource) =>
    source.status.newestDataAt ? compactDateWithDelta(source.status.newestDataAt, props.dateContext()) : t().noDataYet;
  const renderSourceCell = (
    source: PulseSource,
    col: DataTableColumn<PulseSource>,
    render: (value: unknown) => JSX.Element,
  ): JSX.Element => {
    if (col.id === "source") return renderSourceTitleCell(source, t(), newestData(source));
    if (col.id === "status") return renderSourceStatusCell(source, t());
    if (col.id === "newest") return <span class="text-xs text-secondary">{newestData(source)}</span>;
    return render(source[col.id as keyof PulseSource]);
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-2" aria-label={t().sources}>
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <div class="min-w-64 flex-1">
          <TextInput
            type="search"
            icon="ti ti-search"
            value={props.search}
            onValueChange={props.setSearch}
            placeholder={t().searchSourcesPlaceholder}
            clearable
          />
        </div>
        <Button
          class="pulse-workspace__desktop-action"
          type="button"
          variant="secondary"
          size="sm"
          disabled={!props.selectedBaseId() || props.loading()}
          onClick={() => void props.addSource()}
        >
          <i class="ti ti-plus" aria-hidden="true" /> {t().addSource}
        </Button>
      </div>
      <DataTable
        rows={props.sources()}
        columns={sourceColumns(t())}
        getRowId={(source) => source.id}
        selectedRowId={props.selectedSourceId() || null}
        onRowClick={props.selectSource}
        density="compact"
        fillHeight
        class="min-h-[32rem] flex-1 overflow-auto"
        empty={t().noSources}
        scrollPreserveKey="pulse-sources-table"
        renderCell={({ row: source, col, render }) => renderSourceCell(source, col, render)}
      />
    </section>
  );
}

export function SourcesDetailPanel(props: SourcesViewProps) {
  const t = usePulseMessages();
  const renderSourceScrapeCell = (scrape: PulseSourceScrape, col: DataTableColumn<PulseSourceScrape>): JSX.Element => {
    if (col.id === "status") {
      return (
        <span
          class={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
            scrape.success
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
          }`}
        >
          <i class={`ti ${scrape.success ? "ti-check" : "ti-alert-circle"}`} />
          {scrape.success ? t().success : t().error}
        </span>
      );
    }
    if (col.id === "finished")
      return <span class="text-xs text-secondary">{compactDateWithDelta(scrape.finishedAt, props.dateContext())}</span>;
    if (col.id === "samples") return <span class="text-xs text-secondary">{t().ingestCounts(scrape)}</span>;
    if (col.id === "duration") return <span class="text-xs text-secondary">{scrape.durationMs}ms</span>;
    if (col.id === "error") {
      return (
        <span class={scrape.errorMessage ? "line-clamp-2 text-xs text-red-600 dark:text-red-300" : "text-xs text-dimmed"}>
          {localizedSourceError(scrape.errorMessage, t()) ?? "-"}
        </span>
      );
    }
    return null;
  };

  return (
    <Show when={props.selectedSource()} keyed>
      {(source) => (
        <SourceDetailView
          source={source}
          origin={props.origin()}
          dateContext={props.dateContext()}
          loading={props.loading()}
          scrapes={props.selectedSourceScrapes()}
          apiKeys={props.selectedSourceApiKeys()}
          scrapeColumns={sourceScrapeColumns(t())}
          renderScrapeCell={renderSourceScrapeCell}
          copySetupText={props.copySetupText}
          editSource={props.editSource}
          toggleSource={props.toggleSource}
          close={props.closeSource}
          scrape={props.scrape}
          removeSource={props.removeSource}
          createApiKey={(input) => props.createApiKey(source, input)}
          revokeApiKey={(credentialId) => props.revokeApiKey(source, credentialId)}
        />
      )}
    </Show>
  );
}
