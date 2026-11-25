import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  type Column,
  Empty,
  FilterBar,
  List,
  ListOrder,
  Notice,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { type ObservabilityAreaNav, ObservabilityNav } from "../../_components/ObservabilityNav";
import { OpsChartSection } from "../../_components/OpsChartSection";
import type { OpsChart } from "../../_components/ops-chart";
import { browserMessages } from "../browser/messages";
import type { TelemetryRouteSort } from "../contracts";
import { TELEMETRY_PATH, type TelemetryState, telemetryHref, telemetryQuery } from "../query";

export type TelemetryRouteView = {
  key: string;
  app: string;
  route: string;
  requests: string;
  errorRate: string;
  problem: boolean;
  errors: string;
  slow: string;
  hasSlow: boolean;
  duration: string;
  slowMax: boolean;
};
export type TelemetryEventView = {
  key: string;
  time: string;
  method: string;
  status: string;
  tone: "ok" | "warn" | "bad" | null;
  error: string | null;
  duration: string;
  slow: boolean;
};

export type TelemetryScreenProps = {
  area: ObservabilityAreaNav;
  apps: { id: string; label: string }[];
  state: TelemetryState;
  ignored: string | null;
  /** The browser view with the same range and app. */
  browserHref: string;
  cells: KeyCell[];
  charts: OpsChart[];
  slo: KeyCell[];
  routes: TelemetryRouteView[];
  /** The route open beside the list, with its newest requests. */
  route: { name: string; app: string; events: TelemetryEventView[]; summary: string; closeHref: string } | null;
};

const SORTED_COLUMN: Record<TelemetryRouteSort, number> = { requests: 1, errorRate: 2, errors: 3, slow: 4, duration: 5 };

/** Server telemetry on v2: key numbers, traffic charts, availability, the routes in their order and one route's requests. */
export default function TelemetryScreen(props: TelemetryScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const b = () => browserMessages.resolve([locale()]).t;
  const query = createMemo(() => telemetryQuery(locale(), props.apps, props.state.filters.app));
  const href = (next: TelemetryState) => telemetryHref(query(), next);
  const change = (next: Pick<TelemetryState, "filters" | "sort">) =>
    location.replace(href({ ...props.state, filters: next.filters, sort: next.sort }));
  const sortHref = (sort: TelemetryRouteSort) => ({ href: href({ ...props.state, sort: { field: sort, direction: "desc" } }) });
  const filtered = () => Boolean(props.state.filters.app || props.state.filters.only?.length);
  const sorted = () => {
    const column = Object.entries(SORTED_COLUMN).find(([field]) => field === props.state.sort.field)?.[1];
    return column === undefined ? undefined : { column, direction: "descending" as const };
  };
  return (
    <Workspace
      sidebar={<ObservabilityNav area={props.area} current="telemetry" />}
      detail={props.route ? 420 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={b().navigation}
              items={[
                { label: b().server, icon: "server", href: TELEMETRY_PATH, current: true },
                { label: b().browser, icon: "browser", href: props.browserHref },
              ]}
            />
          }
          end={<Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={href(props.state)} />}
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().telemetry}
          scrollKey="gateway-ops-telemetry"
          status={
            <>
              <FilterBar query={query()} state={props.state} onChange={change} icons={{ range: "clock", app: "apps", only: "filter" }} />
              <StatusRow
                lead={t().routesCount({ count: props.routes.length })}
                filters={<ListOrder query={query()} state={props.state} onChange={change} />}
              />
            </>
          }
        >
          <Show when={props.ignored}>
            {(text) => (
              <Notice tone="warn" title={t().ignoredParts}>
                {text()}
              </Notice>
            )}
          </Show>
          <KeyCells cells={props.cells} />
          <For each={props.charts}>{(chart) => <OpsChartSection chart={chart} icon="chart-line" empty={t().noTrafficRange} />}</For>
          <Show when={props.slo.length > 0}>
            <Section icon="shield-check" title={t().requestAvailability} summary={t().requestAvailabilityDescription}>
              <KeyCells cells={props.slo} />
            </Section>
          </Show>
          <Section icon="route" title={t().gatewayRoutesTitle} count={props.routes.length}>
            <Table
              label={t().gatewayRoutesTitle}
              rows={props.routes}
              rowKey={(row) => row.key}
              current={props.route ? `${props.route.app} ${props.route.name}` : undefined}
              sort={sorted()}
              open={(row) => ({ href: telemetryHref(query(), props.state, { app: row.app, route: row.route }) })}
              empty={
                filtered()
                  ? { icon: "filter-off", text: t().noTrafficRange, action: { label: t().clear, icon: "filter-off", href: TELEMETRY_PATH } }
                  : { icon: "route-off", text: t().noTrafficRange }
              }
              phone={(row) => ({ lines: [row.route, `${row.app} · ${row.requests} · ${row.errorRate}`] })}
              columns={(
                [
                  { title: t().route, width: { min: 200, default: 320 }, cell: (row) => ({ lines: [row.route, row.app] }) },
                  {
                    title: t().requests,
                    width: { min: 90, default: 110 },
                    align: "end",
                    sort: sortHref("requests"),
                    cell: (row) => row.requests,
                  },
                  {
                    title: t().errorRate,
                    width: { min: 90, default: 110 },
                    align: "end",
                    sort: sortHref("errorRate"),
                    cell: (row) => (row.problem ? <Text tone="bad">{row.errorRate}</Text> : row.errorRate),
                  },
                  {
                    title: t().errors,
                    width: { min: 80, default: 90 },
                    align: "end",
                    sort: sortHref("errors"),
                    cell: (row) => row.errors,
                    drop: true,
                  },
                  {
                    title: t().slow,
                    width: { min: 80, default: 90 },
                    align: "end",
                    sort: sortHref("slow"),
                    cell: (row) => (row.hasSlow ? <Text tone="warn">{row.slow}</Text> : row.slow),
                    drop: true,
                  },
                  {
                    title: t().averageMaximum,
                    align: "end",
                    sort: sortHref("duration"),
                    cell: (row) => (row.slowMax ? <Text tone="warn">{row.duration}</Text> : row.duration),
                    drop: true,
                  },
                ] satisfies Column<TelemetryRouteView>[]
              ).filter((_, index) => !props.route || index < 3)}
            />
          </Section>
        </Pane>
        <Show when={props.route}>
          {(route) => (
            <Pane
              detail
              label={route().name}
              back={{ label: t().gatewayRoutesTitle, href: route().closeHref }}
              head={
                <Bar
                  start={<Text type="lead">{route().name}</Text>}
                  end={<Button variant="ghost" icon="x" label={t().closeRouteDetail} href={route().closeHref} />}
                />
              }
            >
              <Section icon="list" title={t().requests} count={route().events.length} summary={route().summary}>
                <Show when={route().events.length > 0} fallback={<Empty icon="list" text={t().noRetainedRequests} />}>
                  <List label={t().requests}>
                    <For each={route().events}>
                      {(event) => (
                        <Row
                          lines={[`${event.method} · ${event.duration}`, event.error ?? event.time]}
                          time={event.error ? event.time : undefined}
                          end={event.tone ? <Chip status={event.tone}>{event.status}</Chip> : <Chip>{event.status}</Chip>}
                        />
                      )}
                    </For>
                  </List>
                </Show>
              </Section>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </Workspace>
  );
}
