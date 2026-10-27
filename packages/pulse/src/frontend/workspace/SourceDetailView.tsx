import { type ResourceApiKey, ResourceApiKeys, type ResourceApiKeysProps } from "@k2b/cloud/access/ui";
import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import {
  Button,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  DetailPanel,
  type DropdownItem,
  IconButton,
  StatusBadge,
  Tooltip,
} from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { PulseSource, PulseSourceScrape } from "../../contracts";
import { localizedSourceError } from "../../messages";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext } from "./helpers";

type Props = {
  source: PulseSource;
  origin: string;
  dateContext: PulseDateContext;
  loading: boolean;
  scrapes: PulseSourceScrape[];
  apiKeys: ResourceApiKey[];
  scrapeColumns: DataTableColumn<PulseSourceScrape>[];
  renderScrapeCell: (scrape: PulseSourceScrape, col: DataTableColumn<PulseSourceScrape>) => JSX.Element;
  copySetupText: (text: string, label: string) => void;
  editSource: (source: PulseSource) => void | Promise<void>;
  toggleSource: (source: PulseSource) => void | Promise<void>;
  close: () => void;
  scrape: (source: PulseSource) => void | Promise<void>;
  removeSource: (source: PulseSource) => void | Promise<void>;
  createApiKey: ResourceApiKeysProps["createKey"];
  revokeApiKey: ResourceApiKeysProps["revokeKey"];
};

const httpIngestExample = (source: PulseSource, origin: string) =>
  source.kind === "http_ingest"
    ? `curl -fsS -X POST ${origin}/api/pulse/ingest \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: import-2026-10-19-0001" \\
  --data '{
    "metrics": [
      { "name": "orders.created", "value": 1, "type": "counter", "dimensions": { "channel": "webshop" } },
      { "name": "solar.output_watts", "value": 4200, "type": "gauge", "unit": "W", "dimensions": { "site": "warehouse" } }
    ],
    "events": [
      { "kind": "order.created", "dimensions": { "channel": "webshop" }, "payload": { "orderId": "demo-1001" } },
      { "kind": "import.finished", "dimensions": { "dataset": "inventory" }, "payload": { "rows": 128 } }
    ],
    "states": [
      { "key": "checkout.enabled", "value": true },
      { "key": "integration.online", "value": true, "dimensions": { "integration": "webshop" } }
    ]
  }'`
    : "";

export default function SourceDetailView(props: Props) {
  const t = usePulseMessages();
  /** Setup help waits collapsed under "More about this source"; its copy command sits above the code. */
  const renderCodeSection = (params: { title: string; summary: string; code: string; hint?: string }) => (
    <DetailPanel.Section title={params.title} collapsible summary={params.summary}>
      <div class="mb-2 flex items-start justify-between gap-3">
        <Show when={params.hint}>
          <p class="text-xs text-secondary">{params.hint}</p>
        </Show>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          class="ml-auto shrink-0"
          onClick={() => props.copySetupText(params.code, t().commandCopied)}
        >
          <i class="ti ti-copy" /> {t().copy}
        </Button>
      </div>
      <pre class="max-h-72 overflow-auto rounded-lg bg-zinc-100 p-3 text-[11px] leading-relaxed text-secondary dark:bg-zinc-900/80">
        <code>{params.code}</code>
      </pre>
    </DetailPanel.Section>
  );

  const cloudId = useCloudIdCopy();
  const httpExample = () => httpIngestExample(props.source, props.origin);
  const status = () => props.source.status;
  /** The target leads the properties: where Pulse reads from, or where the source sends to. */
  const statusItems = () => [
    {
      term: t().target,
      description:
        props.source.kind === "metrics" ? (
          <span class="break-all">{props.source.endpointUrl ?? t().noEndpoint}</span>
        ) : (
          <span class="break-all font-mono text-xs">{`POST ${props.origin}/api/pulse/ingest`}</span>
        ),
    },
    {
      term: t().newestData,
      description: status().newestDataAt ? compactDateWithDelta(status().newestDataAt!, props.dateContext) : t().noDataYet,
    },
    {
      term: t().lastSeen,
      description: props.source.lastSeenAt ? compactDateWithDelta(props.source.lastSeenAt, props.dateContext) : t().waiting,
    },
    ...(props.source.kind === "metrics"
      ? [
          { term: t().interval, description: `${props.source.scrapeIntervalSeconds ?? 60}s` },
          {
            term: t().metricsKept,
            description: props.source.metricFilters.length ? (
              <span class="break-all font-mono text-xs">{props.source.metricFilters.join(", ")}</span>
            ) : (
              t().allMetrics
            ),
          },
        ]
      : []),
    ...(status().throttled
      ? [
          {
            term: t().status,
            description: (
              <span class="flex flex-col items-start gap-1">
                <StatusBadge label={t().throttled} tone="warning" />
                <span class="text-xs text-secondary">{t().throttledDetail}</span>
              </span>
            ),
          },
        ]
      : []),
    ...(status().refusedHistograms.length
      ? [
          {
            term: t().refusedHistograms,
            description: (
              <ul class="flex flex-col gap-0.5 text-xs">
                <For each={status().refusedHistograms}>
                  {(item) => (
                    <li class="break-all">
                      <span class="font-mono">{item.family}</span>
                      <span class="text-secondary"> · {t().refusedHistogramReason({ reason: item.reason })}</span>
                    </li>
                  )}
                </For>
              </ul>
            ),
          },
        ]
      : []),
    ...(status().skippedSummaries ? [{ term: t().skipped, description: t().skippedSummaries({ count: status().skippedSummaries }) }] : []),
    ...(status().lastError
      ? [
          {
            term: t().error,
            description: <span class="break-all text-red-600 dark:text-red-300">{localizedSourceError(status().lastError, t())}</span>,
          },
        ]
      : []),
  ];

  const latestScrape = () => props.scrapes[0];
  /** Rarer commands on the source; Edit is the main action beside them. */
  const moreActions = (): DropdownItem[] => [
    {
      label: props.source.enabled ? t().pause : t().resume,
      icon: `ti ${props.source.enabled ? "ti-player-pause" : "ti-player-play"}`,
      action: () => void props.toggleSource(props.source),
    },
    ...(props.source.kind === "metrics"
      ? [
          {
            label: t().scrape,
            icon: "ti ti-refresh",
            disabled: props.loading || !props.source.enabled,
            action: () => void props.scrape(props.source),
          },
        ]
      : []),
    {
      items: [
        {
          label: t().removeSource,
          icon: "ti ti-trash",
          variant: "danger" as const,
          disabled: props.loading,
          action: () => void props.removeSource(props.source),
        },
      ],
    },
  ];

  return (
    <DetailPanel>
      <DetailPanel.Header
        kind={
          <>
            <span>{t().source}</span>
            <StatusBadge
              tone={props.source.enabled ? "ok" : "neutral"}
              icon={props.source.enabled ? "ti ti-circle-check" : "ti ti-player-pause"}
              label={props.source.enabled ? t().enabled : t().paused}
            />
          </>
        }
        title={props.source.name}
        subtitle={
          <>
            {props.source.kind === "metrics" ? t().metricsEndpoint : t().httpIngest}
            {props.source.bearerTokenConfigured ? ` · ${t().bearerAuth}` : ""}
          </>
        }
        menu={[...moreActions(), ...cloudId.section({ type: "pulse.source", id: props.source.id })]}
        menuLabel={t().moreSourceActions}
        actions={
          <Tooltip.Anchor content={t().closeDetails}>
            <IconButton label={t().closeSourceDetails} variant="ghost" size="sm" onClick={props.close}>
              <i class="ti ti-x" />
            </IconButton>
          </Tooltip.Anchor>
        }
        primaryActions={
          <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: props.source.name })}>
            <Button type="button" variant="subtle" size="sm" class="pulse-details-main" onClick={() => void props.editSource(props.source)}>
              <i class="ti ti-pencil" aria-hidden="true" /> {t().edit}
            </Button>
          </div>
        }
      />

      <DetailPanel.Body>
        <DetailPanel.Section title={t().properties}>
          <DescriptionList items={statusItems()} layout="rows" size="sm" />
        </DetailPanel.Section>

        <Show when={props.source.kind === "http_ingest"}>
          <ResourceApiKeys
            title={t().apiKeys}
            description={`${t().apiKeysDescription} ${t().bearerTokenHint}`}
            initialKeys={props.apiKeys}
            permissionOptions={[
              {
                value: "write",
                label: t().ingest,
                description: t().ingestDescription,
                icon: "ti ti-database-import",
              },
            ]}
            createKey={props.createApiKey}
            revokeKey={props.revokeApiKey}
          />
        </Show>

        <DetailPanel.Group title={t().moreAboutSource}>
          <Show when={props.source.kind === "metrics"}>
            <DetailPanel.Section
              title={t().scrapeHistory}
              count={props.scrapes.length || undefined}
              collapsible
              summary={
                latestScrape()
                  ? `${latestScrape()!.success ? t().success : t().error} · ${compactDateWithDelta(latestScrape()!.finishedAt, props.dateContext)}`
                  : t().noScrapes
              }
            >
              <DataTable
                rows={props.scrapes}
                columns={props.scrapeColumns}
                getRowId={(scrape) => scrape.id}
                density="compact"
                class="max-h-72 overflow-auto"
                empty={t().noScrapes}
                renderCell={({ row: scrape, col }) => props.renderScrapeCell(scrape, col)}
              />
            </DetailPanel.Section>
          </Show>
          <Show when={httpExample()}>
            {(command) =>
              renderCodeSection({
                title: t().httpIngestExample,
                summary: t().httpIngestExampleSummary,
                code: command(),
                hint: t().idempotencyHint,
              })
            }
          </Show>
        </DetailPanel.Group>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
