import { Button, DataTable, type DataTableColumn, DescriptionList, DetailPanel, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { type ResourceApiKey, ResourceApiKeys, type ResourceApiKeysProps } from "@valentinkolb/cloud/access/ui";
import { type JSX, Show } from "solid-js";
import type { PulseSource, PulseSourceScrape } from "../../contracts";
import { compactDateWithDelta, type PulseDateContext } from "./helpers";
import { usePulseMessages } from "../use-messages";

type Props = {
  source: PulseSource;
  published: { resources: number; metricVariants: number; states: number; events: number };
  origin: string;
  dateContext: PulseDateContext;
  loading: boolean;
  scrapes: PulseSourceScrape[];
  apiKeys: ResourceApiKey[];
  scrapeColumns: DataTableColumn<PulseSourceScrape>[];
  renderScrapeCell: (scrape: PulseSourceScrape, col: DataTableColumn<PulseSourceScrape>) => JSX.Element;
  copySetupText: (text: string, label: string) => void;
  openSourceResources: (source: PulseSource) => void;
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
  const locale = useLocale();
  const renderCodeSection = (params: { title: string; code: string }) => (
    <DetailPanel.Section
      title={params.title}
      icon="ti ti-code"
      tone="neutral"
      actions={
        <div class="flex shrink-0 items-center gap-1">
          <Button type="button" variant="secondary" size="sm" onClick={() => props.copySetupText(params.code, t().commandCopied)}>
            <i class="ti ti-copy" /> {t().copy}
          </Button>
        </div>
      }
    >
      <pre class="max-h-72 overflow-auto rounded-lg bg-zinc-100 p-3 text-[11px] leading-relaxed text-secondary dark:bg-zinc-900/80">
        <code>{params.code}</code>
      </pre>
    </DetailPanel.Section>
  );

  const httpExample = () => httpIngestExample(props.source, props.origin);
  const statusItems = () => [
    {
      term: t().lastSeen,
      description: props.source.lastSeenAt ? compactDateWithDelta(props.source.lastSeenAt, props.dateContext) : t().waiting,
    },
    ...(props.source.kind === "metrics" ? [{ term: t().interval, description: `${props.source.scrapeIntervalSeconds ?? 60}s` }] : []),
    ...(props.source.lastError
      ? [
          {
            term: t().error,
            description: <span class="break-all text-red-600 dark:text-red-300">{props.source.lastError}</span>,
          },
        ]
      : []),
  ];

  return (
    <DetailPanel>
      <DetailPanel.Header
        title={props.source.name}
        icon="ti ti-database-share"
        meta={t().source}
        subtitle={
          <>
            {props.source.kind}
            {props.source.enabled ? ` · ${t().enabled}` : ` · ${t().paused}`}
            {props.source.bearerTokenConfigured ? ` · ${t().bearerAuth}` : ""}
          </>
        }
        actions={
          <Tooltip.Anchor content={t().closeDetails}>
            <IconButton label={t().closeSourceDetails} variant="ghost" size="sm" onClick={props.close}>
              <i class="ti ti-x" />
            </IconButton>
          </Tooltip.Anchor>
        }
        primaryActions={
          <div class="flex flex-wrap items-center gap-2" role="group" aria-label={t().actionsFor({ name: props.source.name })}>
            <Button type="button" variant="secondary" size="sm" onClick={() => void props.editSource(props.source)}>
              <i class="ti ti-pencil" /> {t().edit}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void props.toggleSource(props.source)}>
              <i class={`ti ${props.source.enabled ? "ti-player-pause" : "ti-player-play"}`} />
              {props.source.enabled ? t().pause : t().resume}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => props.openSourceResources(props.source)}>
              <i class="ti ti-cube" /> {t().resources}
            </Button>
            <Show when={props.source.kind === "metrics"}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={props.loading || !props.source.enabled}
                onClick={() => void props.scrape(props.source)}
              >
                <i class="ti ti-refresh" /> {t().scrape}
              </Button>
            </Show>
          </div>
        }
      />

      <DetailPanel.Body>
        <DetailPanel.Summary title={t().status}>
          <DescriptionList items={statusItems()} layout="rows" size="sm" />
        </DetailPanel.Summary>

        <DetailPanel.Group label={t().sourceData}>
          <DetailPanel.Section title={t().published} icon="ti ti-chart-dots" tone="accent">
            <div class="flex flex-col gap-2">
              <DetailPanel.Action
                type="button"
                title={t().resources}
                description={t().publishedCount({ count: props.published.resources.toLocaleString(locale()) })}
                leading={<i class="ti ti-cube" aria-hidden="true" />}
                trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                onClick={() => props.openSourceResources(props.source)}
              />
              <DescriptionList
                items={[
                  { term: t().metrics, description: t().variants({ count: props.published.metricVariants.toLocaleString(locale()) }) },
                  { term: t().states, description: props.published.states.toLocaleString(locale()) },
                  { term: t().events, description: t().recentCount({ count: props.published.events.toLocaleString(locale()) }) },
                ]}
                layout="rows"
                size="sm"
              />
            </div>
          </DetailPanel.Section>

          <DetailPanel.Section title={t().target} icon="ti ti-target" tone="neutral">
            <Show
              when={props.source.kind === "metrics"}
              fallback={<p class="text-xs text-secondary">{t().ingestEndpoint({ kind: props.source.kind })}</p>}
            >
              <p class="break-all text-xs text-secondary">{props.source.endpointUrl ?? t().noEndpoint}</p>
            </Show>
          </DetailPanel.Section>
        </DetailPanel.Group>

        <Show when={props.source.kind === "metrics"}>
          <DetailPanel.Section title={t().scrapeHistory} icon="ti ti-refresh" tone="success">
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

        <Show when={props.source.kind === "http_ingest"}>
          <div class="flex flex-col gap-2">
            <ResourceApiKeys
              title={t().apiKeys}
              description={t().apiKeysDescription}
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
            <p class="text-xs text-dimmed">{t().bearerTokenHint}</p>
          </div>
        </Show>

        <Show when={httpExample()}>{(command) => renderCodeSection({ title: t().httpIngestExample, code: command() })}</Show>

        <DetailPanel.Section
          title={t().dangerZone}
          icon="ti ti-trash"
          tone="danger"
          actions={
            <Button type="button" variant="danger" size="sm" disabled={props.loading} onClick={() => void props.removeSource(props.source)}>
              <i class="ti ti-trash" /> {t().remove}
            </Button>
          }
        />
      </DetailPanel.Body>
    </DetailPanel>
  );
}
