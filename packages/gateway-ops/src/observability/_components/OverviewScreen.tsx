import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Empty,
  Failed,
  FilterBar,
  Icon,
  List,
  type NavProps,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
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
  app: { label: string; icon: string };
  errors: string;
  requests: string;
  rate: string;
  href: string;
};

export type OverviewScreenProps = {
  nav: NavProps;
  state: OverviewState;
  /** What the window says in one statement, and why. */
  verdict: { label: string; description: string };
  signals: OverviewSignal[];
  cells: KeyCell[];
  charts: { chart: OpsChart; icon: string; empty: string; href: string; linkLabel: string }[];
  routes: { rows: FailingRoute[]; error: string | null; href: string };
};

/** A signal's sign: its symbol in the colour of its weight. Unread sources stay grey, as nothing is known. */
const SIGNAL_COLOR: Record<OverviewSignal["severity"], string> = {
  critical: "var(--k2-bad-dot)",
  warning: "var(--k2-warn-dot)",
  unavailable: "var(--k2-muted)",
};

/**
 * Operations at a glance on v2: one statement for the window, the key figures, the signals that need someone (each a
 * link to where it is looked at), the two error charts and the routes that fail most. Everything comes with the first
 * HTML; a new window is a new address.
 */
export default function OverviewScreen(props: OverviewScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const query = createMemo(() => overviewQuery(locale()));
  const severity = (signal: OverviewSignal) =>
    signal.severity === "critical" ? (
      <Chip status="bad">{t().needsAttentionLabel}</Chip>
    ) : signal.severity === "warning" ? (
      <Chip status="warn">{t().warning}</Chip>
    ) : (
      <Chip icon="database-off">{t().unavailable}</Chip>
    );
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
        <KeyCells cells={props.cells} />
        <Section icon="bell" title={t().signals} summary={props.verdict.description}>
          <Show when={props.signals.length > 0} fallback={<Empty icon="circle-check" text={t().noSignalsHint} />}>
            <List label={t().signals}>
              <For each={props.signals}>
                {(signal) => (
                  <Row
                    icon={signal.icon.replace(/^ti\s+(ti-)?/, "")}
                    color={SIGNAL_COLOR[signal.severity]}
                    lines={[signal.title, signal.detail]}
                    marks={severity(signal)}
                    href={signal.href}
                  />
                )}
              </For>
            </List>
          </Show>
        </Section>
        <For each={props.charts}>
          {(entry) => (
            <OpsChartSection chart={entry.chart} icon={entry.icon} empty={entry.empty} height={200}>
              <Bar
                end={
                  <Button variant="text" href={entry.href} forward>
                    {entry.linkLabel}
                  </Button>
                }
              />
            </OpsChartSection>
          )}
        </For>
        <Section
          icon="route"
          title={t().failingRoutes}
          summary={t().failingRoutesDescription}
          more={{ label: t().openTraffic, href: props.routes.href }}
        >
          <Show when={!props.routes.error} fallback={<Failed text={props.routes.error ?? ""} onRetry={() => location.reload()} />}>
            <Table
              label={t().failingRoutes}
              rows={props.routes.rows}
              rowKey={(row) => row.key}
              open={(row) => ({ href: row.href })}
              empty={{ icon: "circle-check", text: t().noFailingRoutes }}
              phone={(row) => ({ lines: [row.route, row.app.label], marks: <Chip status="bad">{row.rate}</Chip> })}
              columns={[
                {
                  title: t().route,
                  width: { min: 220, default: 420 },
                  cell: (row) => ({ lines: [row.route, `${row.errors} / ${row.requests}`] }),
                },
                {
                  title: t().app,
                  width: { min: 110, default: 160 },
                  // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
                  cell: (row) => (
                    <>
                      <Icon name={row.app.icon} /> {row.app.label}
                    </>
                  ),
                  drop: true,
                },
                {
                  title: t().errorRate,
                  width: { min: 110, default: 130 },
                  align: "end",
                  cell: (row) => <Chip status="bad">{row.rate}</Chip>,
                },
              ]}
            />
          </Show>
        </Section>
      </Pane>
    </AdminWorkspace>
  );
}
