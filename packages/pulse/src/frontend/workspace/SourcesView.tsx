import type { ResourceApiKey, ResourceApiKeysProps } from "@k2b/cloud/access/ui";
import { Button, DataTable, TextInput, type DataTableColumn, useLocale } from "@k2b/ui";
import { Show, type Accessor, type JSX } from "solid-js";
import type { PulseSource, PulseSourceScrape } from "../../contracts";
import { compactDateWithDelta, sourceKindIcon, sourceStatus, type PulseDateContext } from "./helpers";
import SourceDetailView from "./SourceDetailView";
import type { pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";

type PublishedCounts = {
  resources: number;
  metricVariants: number;
  states: number;
  events: number;
};

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const sourceColumns = (t: Messages): DataTableColumn<PulseSource>[] => [
  { id: "source", header: t.source, value: "name", cellClass: "min-w-56" },
  { id: "status", header: t.status, cellClass: "w-28 whitespace-nowrap" },
  { id: "resources", header: t.resources, cellClass: "w-24 whitespace-nowrap" },
  { id: "signals", header: t.signals, cellClass: "w-32 whitespace-nowrap" },
  { id: "target", header: t.target, cellClass: "min-w-48" },
  { id: "seen", header: t.lastSeen, cellClass: "w-48 whitespace-nowrap" },
];

const sourceScrapeColumns = (t: Messages): DataTableColumn<PulseSourceScrape>[] => [
  { id: "status", header: t.status, cellClass: "w-28 whitespace-nowrap" },
  { id: "finished", header: t.finished, cellClass: "w-44 whitespace-nowrap" },
  { id: "samples", header: t.data, cellClass: "w-28 whitespace-nowrap" },
  { id: "duration", header: t.time, cellClass: "w-20 whitespace-nowrap" },
  { id: "error", header: t.error, cellClass: "min-w-40" },
];

const renderSourceTitleCell = (source: PulseSource): JSX.Element => {
  return (
    <div class="flex min-w-0 items-center gap-2">
      <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
        <i class={`${sourceKindIcon(source.kind)} text-base`} />
      </span>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium text-primary">{source.name}</p>
        <p class="mt-0.5 truncate text-xs text-dimmed">{source.kind}</p>
      </div>
    </div>
  );
};

const renderSourceStatusCell = (source: PulseSource, t: Messages): JSX.Element => {
  const status = sourceStatus(source, { paused: t.paused, error: t.error, healthy: t.healthy, waiting: t.waiting });
  return (
    <span class={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${status.text}`}>
      <i class={status.icon} />
      {status.label}
    </span>
  );
};

const renderSourceSignalsCell = (counts: PublishedCounts, locale: string): JSX.Element => {
  const total = counts.metricVariants + counts.states + counts.events;
  return (
    <span class="text-xs text-secondary">
      {total.toLocaleString(locale)}{" "}
      <span class="text-dimmed">
        ({counts.metricVariants}m/{counts.states}s/{counts.events}e)
      </span>
    </span>
  );
};

const renderSourceTargetCell = (source: PulseSource, t: Messages): JSX.Element => {
  if (source.kind === "metrics") {
    return (
      <div class="min-w-0">
        <p class="truncate text-xs text-secondary" title={source.endpointUrl ?? ""}>
          {source.endpointUrl ?? t.noEndpointShort}
        </p>
        <p class="mt-1 text-xs text-dimmed">{t.scrapeEvery({ seconds: source.scrapeIntervalSeconds ?? 60 })}</p>
      </div>
    );
  }
  if (source.kind === "http_ingest") return <span class="text-xs text-secondary">{t.tokenIngestEndpoint}</span>;
  return <span class="text-xs text-secondary">{t.internalAppTelemetry}</span>;
};

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
  publishedCounts: (sourceId: string) => PublishedCounts;
  copySetupText: (text: string, label: string) => void;
  addSource: () => void | Promise<void>;
  selectSource: (source: PulseSource) => void;
  closeSource: () => void;
  openSourceResources: (source: PulseSource) => void;
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
  const locale = useLocale();
  const renderSourceCell = (
    source: PulseSource,
    col: DataTableColumn<PulseSource>,
    render: (value: unknown) => JSX.Element,
  ): JSX.Element => {
    if (col.id === "source") return renderSourceTitleCell(source);
    if (col.id === "status") return renderSourceStatusCell(source, t());
    if (col.id === "resources") {
      const counts = props.publishedCounts(source.id);
      return <span class="text-xs text-secondary">{counts.resources.toLocaleString(locale())}</span>;
    }
    if (col.id === "signals") return renderSourceSignalsCell(props.publishedCounts(source.id), locale());
    if (col.id === "target") return renderSourceTargetCell(source, t());
    if (col.id === "seen") return source.lastSeenAt ? compactDateWithDelta(source.lastSeenAt, props.dateContext()) : t().waiting;
    return render(source[col.id as keyof PulseSource]);
  };

  return (
    <section class="flex min-h-0 flex-1 flex-col gap-2">
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
          type="button"
          variant="secondary"
          size="sm"
          disabled={!props.selectedBaseId() || props.loading()}
          onClick={() => void props.addSource()}
        >
          <i class="ti ti-plus" /> {t().addSource}
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
          {scrape.errorMessage ?? "-"}
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
          published={props.publishedCounts(source.id)}
          origin={props.origin()}
          dateContext={props.dateContext()}
          loading={props.loading()}
          scrapes={props.selectedSourceScrapes()}
          apiKeys={props.selectedSourceApiKeys()}
          scrapeColumns={sourceScrapeColumns(t())}
          renderScrapeCell={renderSourceScrapeCell}
          copySetupText={props.copySetupText}
          openSourceResources={props.openSourceResources}
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
