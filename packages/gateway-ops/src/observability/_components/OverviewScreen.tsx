import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  Bar,
  Button,
  Chip,
  Failed,
  FilterBar,
  List,
  Mark,
  type NavProps,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
} from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../messages";
import { type OverviewSignal, type OverviewState, overviewHref, overviewQuery } from "../overview";
import { type KeyCell, KeyCells } from "./KeyCells";
import { OpsChartSection } from "./OpsChartSection";
import type { OpsChart } from "./ops-chart";

/** A route that answered with errors in the window, worded by the server. */
export type FailingRoute = {
  key: string;
  route: string;
  app: { label: string; icon: string; color?: string };
  errors: string;
  requests: string;
  rate: string;
  /** The share of errors is high enough to stand in red. */
  bad: boolean;
  href: string;
};

/** An app of the registry with its state in the window: online, needs a look, or offline. */
export type OverviewApp = { id: string; label: string; icon: string; color?: string; status: "ok" | "warn" | "bad"; detail?: string };

export type OverviewScreenProps = {
  nav: NavProps;
  state: OverviewState;
  /** What the window says in one statement. */
  verdict: { label: string; description: string };
  /** The hero (server errors with their real history) first, then the volumes of the window. */
  cells: KeyCell[];
  /** The signals that need someone, each a link to where it is looked at; the hero's own figure is not repeated. */
  signals: OverviewSignal[];
  /** The log severity over the window. */
  logs?: { chart: OpsChart; empty: string; href: string; linkLabel: string };
  routes: { rows: FailingRoute[]; error: string | null; href: string };
  /** The three services of the infrastructure record, each with its state; none when it did not answer in time. */
  services: { key: string; label: string; icon: string; href: string; status: "ok" | "warn" | "bad" | undefined }[];
  /** The apps of the registry with their state; null when health could not be read. */
  apps: OverviewApp[] | null;
};

/**
 * Operations at a glance on v2: the window's statement, the server errors with their history as the hero, the signals
 * that need someone, the failing routes and the log severity; beside them the services and the apps with their state.
 * Everything comes with the first HTML; a new window is a new address.
 */
export default function OverviewScreen(props: OverviewScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const query = createMemo(() => overviewQuery(locale()));
  // a state in a word: neutral when good, colour only where something needs a look
  const stateOf = (status: "ok" | "warn" | "bad" | undefined, ok: string, detail?: string) =>
    status === "bad" ? (
      <Chip status="bad">{detail ?? t().needsAttentionLabel}</Chip>
    ) : status === "warn" ? (
      <Chip status="warn">{detail ?? t().needsReview}</Chip>
    ) : status === "ok" ? (
      <Text type="meta" muted>
        {ok}
      </Text>
    ) : (
      <Chip icon="database-off">{t().unavailable}</Chip>
    );
  // a signal's weight in a word, red or amber; an unread source stays grey, as nothing is known
  const severity = (signal: OverviewSignal) =>
    signal.severity === "critical" ? (
      <Chip status="bad">{t().needsAttentionLabel}</Chip>
    ) : signal.severity === "warning" ? (
      <Chip status="warn">{t().warning}</Chip>
    ) : (
      <Chip icon="database-off">{t().unavailable}</Chip>
    );
  const online = () => props.apps?.filter((app) => app.status === "ok").length ?? 0;
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Text type="body">{t().observability}</Text>}
          end={<Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={overviewHref(query(), props.state)} />}
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().observability}
          scrollKey="gateway-ops-overview"
          status={
            <>
              <FilterBar
                query={query()}
                state={props.state}
                onChange={(next) => location.assign(overviewHref(query(), next))}
                icons={{ range: "clock" }}
              />
              <StatusRow
                lead={props.verdict.label}
                facts={[{ after: props.signals.length === 0 ? t().allSignalsQuiet : t().openSignals({ count: props.signals.length }) }]}
              />
            </>
          }
        >
          {/* k2b-ui gap: hero band (look.md rule 1); until it lands the hero is the first cell, with its real history */}
          <KeyCells cells={props.cells} />
          {/* the signals are the exceptions under the hero: one row each, a link to where it is looked at */}
          <Show when={props.signals.length > 0}>
            <List label={t().signals}>
              <For each={props.signals}>
                {(signal) => (
                  <Row
                    mark={{ icon: signal.icon.replace(/^ti\s+(ti-)?/, "") }}
                    lines={[signal.title, signal.detail]}
                    marks={severity(signal)}
                    href={signal.href}
                  />
                )}
              </For>
            </List>
          </Show>
          <Section
            icon="route"
            title={t().failingRoutes}
            count={props.routes.rows.length}
            more={{ label: t().openTraffic, href: props.routes.href }}
          >
            <Show when={!props.routes.error} fallback={<Failed text={props.routes.error ?? ""} onRetry={() => location.reload()} />}>
              <Table
                label={t().failingRoutes}
                rows={props.routes.rows}
                rowKey={(row) => row.key}
                open={(row) => ({ href: row.href })}
                empty={{ icon: "circle-check", text: t().noFailingRoutes }}
                phone={(row) => ({
                  lines: [row.route, `${row.app.label} · ${row.errors} / ${row.requests}`],
                  marks: row.bad ? <Chip status="bad">{row.rate}</Chip> : <Text type="meta">{row.rate}</Text>,
                })}
                columns={[
                  { title: t().route, width: { min: 160, default: 200 }, cell: (row) => row.route },
                  {
                    title: t().app,
                    width: { min: 100, default: 130 },
                    // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
                    cell: (row) => (
                      <>
                        <Mark icon={row.app.icon} color={row.app.color} /> {row.app.label}
                      </>
                    ),
                    drop: true,
                  },
                  { title: t().errors, width: { min: 72, default: 80 }, align: "end", cell: (row) => row.errors },
                  { title: t().requests, width: { min: 72, default: 80 }, align: "end", cell: (row) => row.requests },
                  {
                    title: t().errorRate,
                    width: { min: 72, default: 80 },
                    align: "end",
                    cell: (row) => (row.bad ? <Text tone="bad">{row.rate}</Text> : row.rate),
                  },
                ]}
              />
            </Show>
          </Section>
          <Show when={props.logs}>
            {(logs) => (
              <OpsChartSection chart={logs().chart} icon="file-alert" empty={logs().empty} height={180}>
                <Bar
                  end={
                    <Button variant="text" href={logs().href} forward>
                      {logs().linkLabel}
                    </Button>
                  }
                />
              </OpsChartSection>
            )}
          </Show>
        </Pane>
        <Pane side label={t().infrastructure}>
          {/* the three services at a glance; each opens its area of the infrastructure record */}
          <Section icon="server-2" title={t().infrastructure}>
            <List label={t().infrastructure}>
              <For each={props.services}>
                {(service) => (
                  <Row
                    mark={{ icon: service.icon }}
                    lines={[service.label]}
                    end={stateOf(service.status, t().healthy)}
                    href={service.href}
                  />
                )}
              </For>
            </List>
          </Section>
          <Section
            icon="apps"
            title={t().apps}
            summary={props.apps ? t().appsOnlineOf({ online: String(online()), total: String(props.apps.length) }) : undefined}
          >
            <Show when={props.apps} fallback={<Failed text={t().unavailable} onRetry={() => location.reload()} />}>
              {(apps) => (
                <List label={t().apps}>
                  <For each={apps()}>
                    {(app) => (
                      <Row
                        mark={{ icon: app.icon, color: app.color }}
                        lines={[app.label]}
                        end={stateOf(app.status, t().online, app.detail)}
                        href={`/admin/apps?app=${encodeURIComponent(app.id)}`}
                      />
                    )}
                  </For>
                </List>
              )}
            </Show>
          </Section>
        </Pane>
      </Pane.Split>
    </AdminWorkspace>
  );
}
