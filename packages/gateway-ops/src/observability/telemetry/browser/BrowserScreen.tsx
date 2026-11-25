import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Facts, Failed, FilterBar, type NavProps, Pane, Section, StatusRow, Table, Tabs, Text } from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { OpsChartSection } from "../../_components/OpsChartSection";
import type { OpsChart } from "../../_components/ops-chart";
import { type BrowserState, browserHref, browserQuery } from "../query";
import CollectionSwitch from "./CollectionSwitch";
import { browserMessages } from "./messages";

export type BrowserRouteView = { key: string; app: string; route: string; lcp: string; inp: string; cls: string; href: string };

export type BrowserScreenProps = {
  nav: NavProps;
  apps: { id: string; label: string }[];
  state: BrowserState;
  /** The server view with the same range and app. */
  serverHref: string;
  enabled: boolean | null;
  /** null: the measurements could not be read. */
  data: {
    cells: KeyCell[];
    charts: OpsChart[];
    routes: BrowserRouteView[];
    total: string;
    previousHref: string | null;
    nextHref: string | null;
  } | null;
};

/** Browser telemetry on v2: the collection switch, what the vitals mean, their p75 over time and per route. */
export default function BrowserScreen(props: BrowserScreenProps) {
  const locale = useLocale();
  const t = () => browserMessages.resolve([locale()]).t;
  const query = createMemo(() => browserQuery(locale(), props.apps, props.state.filters.app));
  const change = (next: Pick<BrowserState, "filters">) => location.replace(browserHref(query(), { ...props.state, filters: next.filters }));
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={
            <Tabs
              label={t().navigation}
              items={[
                { label: t().server, icon: "server", href: props.serverHref },
                { label: t().browser, icon: "browser", href: browserHref(query(), props.state), current: true },
              ]}
            />
          }
          end={<Button variant="ghost" icon="refresh" label={t().reload} title={t().reload} href={browserHref(query(), props.state)} />}
        />
      }
    >
      <Pane
        label={t().title}
        scrollKey="gateway-ops-telemetry-browser"
        status={
          <>
            <FilterBar query={query()} state={props.state} onChange={change} icons={{ range: "clock", app: "apps", route: "route" }} />
            <StatusRow lead={props.data ? t().p75Summary({ count: props.data.total }) : t().error} />
          </>
        }
      >
        <CollectionSwitch enabled={props.enabled} />
        <Section
          icon="help-circle"
          title={t().metricsTitle}
          summary={t().guidance}
          more={{ label: t().learnMore, href: "https://web.dev/articles/vitals" }}
        >
          <Facts
            items={[
              { label: "LCP", value: t().lcpHelp },
              { label: "INP", value: t().inpHelp },
              { label: "CLS", value: t().clsHelp },
            ]}
          />
        </Section>
        <Show when={props.data} fallback={<Failed text={t().error} onRetry={() => location.reload()} />}>
          {(data) => (
            <>
              <KeyCells cells={data().cells} />
              <Text type="meta" muted>
                {t().note}
              </Text>
              <For each={data().charts}>{(chart) => <OpsChartSection chart={chart} icon="chart-line" empty={t().empty} />}</For>
              <Section icon="route" title={t().routes} count={data().total}>
                <Table
                  label={t().routes}
                  rows={data().routes}
                  rowKey={(row) => row.key}
                  open={(row) => ({ href: row.href })}
                  empty={{ icon: "route-off", text: t().empty }}
                  phone={(row) => ({ lines: [row.route, `${row.app} · LCP ${row.lcp} · INP ${row.inp} · CLS ${row.cls}`] })}
                  columns={[
                    { title: t().app, width: { min: 90, default: 110 }, cell: (row) => row.app, drop: true },
                    { title: t().route, width: { min: 180, default: 240 }, cell: (row) => row.route },
                    { title: "LCP · p75 / n", width: { min: 120, default: 140 }, align: "end", cell: (row) => row.lcp },
                    { title: "INP · p75 / n", width: { min: 120, default: 140 }, align: "end", cell: (row) => row.inp, drop: true },
                    { title: "CLS · p75 / n", align: "end", cell: (row) => row.cls, drop: true },
                  ]}
                />
              </Section>
              <Show when={data().previousHref || data().nextHref}>
                <Bar
                  end={
                    <>
                      <Button icon="chevron-left" href={data().previousHref ?? undefined} disabled={!data().previousHref}>
                        {t().previous}
                      </Button>
                      <Button href={data().nextHref ?? undefined} disabled={!data().nextHref} forward>
                        {t().next}
                      </Button>
                    </>
                  }
                />
              </Show>
            </>
          )}
        </Show>
      </Pane>
    </AdminWorkspace>
  );
}
