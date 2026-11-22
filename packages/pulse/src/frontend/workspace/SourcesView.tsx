import type { ResourceApiKey, ResourceApiKeysProps } from "@k2b/cloud/access/ui";
import { type DataTableColumn, StatusBadge } from "@k2b/ui";
import { type Accessor, type JSX, Show } from "solid-js";
import type { PulseSource, PulseSourceScrape } from "../../contracts";
import { localizedSourceError, type pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext } from "./helpers";
import SourceDetailView from "./SourceDetailView";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const sourceScrapeColumns = (t: Messages): DataTableColumn<PulseSourceScrape>[] => [
  { id: "status", header: t.status, cellClass: "w-28 whitespace-nowrap" },
  { id: "finished", header: t.finished, cellClass: "w-44 whitespace-nowrap" },
  { id: "samples", header: t.data, cellClass: "w-28 whitespace-nowrap" },
  { id: "duration", header: t.time, cellClass: "w-20 whitespace-nowrap" },
  { id: "error", header: t.error, cellClass: "min-w-40" },
];

export type SourcesViewProps = {
  selectedBaseId: Accessor<string>;
  loading: Accessor<boolean>;
  sources: Accessor<PulseSource[]>;
  selectedSourceId: Accessor<string>;
  selectedSource: Accessor<PulseSource | null>;
  selectedSourceScrapes: Accessor<PulseSourceScrape[]>;
  selectedSourceApiKeys: Accessor<ResourceApiKey[]>;
  /** Keys show only to people who manage the base. */
  canManageKeys?: Accessor<boolean>;
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

export function SourcesDetailPanel(props: SourcesViewProps) {
  const t = usePulseMessages();
  const renderSourceScrapeCell = (scrape: PulseSourceScrape, col: DataTableColumn<PulseSourceScrape>): JSX.Element => {
    if (col.id === "status") return <StatusBadge label={scrape.success ? t().success : t().error} tone={scrape.success ? "ok" : "error"} />;
    if (col.id === "finished")
      return <span class="text-xs text-secondary">{compactDateWithDelta(scrape.finishedAt, props.dateContext())}</span>;
    if (col.id === "samples") return <span class="text-xs text-secondary">{t().ingestCounts(scrape)}</span>;
    if (col.id === "duration") return <span class="text-xs text-secondary">{scrape.durationMs}ms</span>;
    if (col.id === "error") {
      return (
        <span class={scrape.errorMessage ? "line-clamp-2 text-xs text-(--k2b-danger-text)" : "text-xs text-dimmed"}>
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
          canManageKeys={props.canManageKeys?.() ?? true}
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
