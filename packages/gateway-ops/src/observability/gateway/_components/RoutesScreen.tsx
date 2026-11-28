import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Failed,
  FilterBar,
  Input,
  List,
  Mark,
  type NavProps,
  Notice,
  Pane,
  Progress,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
} from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { type RoutesState, routesHref, routesQuery } from "../query";

/** One prefix of the router's table with the window's traffic, worded by the server. */
export type RouteRow = {
  prefix: string;
  app: { id: string; label: string; icon: string; color?: string };
  requests: string;
  errors: string;
  /** The prefix answered with errors in the window. */
  failing: boolean;
};

export type RoutesScreenProps = {
  nav: NavProps;
  apps: { id: string; label: string }[];
  state: RoutesState;
  cells: KeyCell[];
  /** What the router reported about its table, such as two apps claiming one prefix. */
  warnings: string[];
  rows: RouteRow[];
  /** All prefixes of the table, before the filters. */
  total: number;
  /** The traffic of the window could not be read; the router's table still stands. */
  trafficError: string | null;
  /** The apps with the most requests in the window, most first. */
  byApp: { id: string; label: string; icon: string; color?: string; requests: number }[];
};

/**
 * Gateway routes on v2: the router's table with the traffic of each prefix in the window. A prefix opens its app in
 * Administration › Apps. Everything comes with the first HTML; a filter is a new address.
 */
export default function RoutesScreen(props: RoutesScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const query = createMemo(() => routesQuery(locale(), props.apps, props.state.filters.app));
  const number = (value: number) => value.toLocaleString(locale());
  const go = (next: RoutesState) => location.assign(routesHref(query(), next));
  const filtered = () => props.rows.length !== props.total;
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Text type="body">{t().gatewayRoutesTitle}</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().filterRoutesLabel}
                placeholder={t().filterRoutes}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") go({ ...props.state, search: input.value.trim() || undefined });
                  if (event.key === "Escape" && input.value) go({ ...props.state, search: undefined });
                }}
              />
              <Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={routesHref(query(), props.state)} />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().gatewayRoutesTitle}
          scrollKey="gateway-ops-routes"
          status={
            <>
              <FilterBar query={query()} state={props.state} onChange={go} base={query().reset()} icons={{ range: "clock", app: "apps" }} />
              <StatusRow
                lead={
                  filtered()
                    ? t().filteredRoutesCount({ count: number(props.rows.length), total: number(props.total) })
                    : t().routesCount({ count: props.total })
                }
              />
            </>
          }
        >
          <KeyCells cells={props.cells} />
          <Show when={props.trafficError}>
            {(error) => (
              <Notice tone="bad" title={t().trafficUnavailable}>
                {error()}
              </Notice>
            )}
          </Show>
          <For each={props.warnings}>{(warning) => <Notice tone="warn">{warning}</Notice>}</For>
          <Table
            label={t().gatewayRoutesTitle}
            rows={props.rows}
            rowKey={(row) => row.prefix}
            sticky
            open={(row) => ({ href: `/admin/apps?app=${encodeURIComponent(row.app.id)}` })}
            empty={
              filtered() || props.state.search
                ? {
                    icon: "filter-off",
                    text: t().noMatchingRoutes({ query: props.state.search ?? "" }),
                    action: { label: t().clear, icon: "filter-off", href: routesHref(query(), query().reset()) },
                  }
                : { icon: "route", text: t().noRouterSnapshot }
            }
            phone={(row) => ({
              lines: [row.prefix, row.app.label],
              time: row.requests,
              marks: row.failing ? <Chip status="bad">{row.errors}</Chip> : undefined,
            })}
            columns={[
              { title: t().prefix, width: { min: 160, default: 220 }, cell: (row) => row.prefix },
              {
                title: t().app,
                width: { min: 100, default: 140 },
                // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
                cell: (row) => (
                  <>
                    <Mark icon={row.app.icon} color={row.app.color} /> {row.app.label}
                  </>
                ),
                drop: true,
              },
              { title: t().requests, width: { min: 72, default: 90 }, align: "end", cell: (row) => row.requests },
              {
                title: t().errors,
                width: { min: 80, default: 96 },
                align: "end",
                cell: (row) => (row.failing ? <Text tone="bad">{row.errors}</Text> : "—"),
              },
            ]}
          />
          {/* k2b-ui gap (#4470, a pane's last part draws no line): where the context column gives way under a table that ends its column, the table's last row and the
              seam draw two lines; the source line ends the column instead until the primitive drops the row's line */}
          <Text type="meta" muted>
            {t().routesSource}
          </Text>
        </Pane>
        {/* a context column beside the table on a large screen: where the traffic of the window goes */}
        <Pane side={{ from: 1100 }} label={t().requestsByApp}>
          <Section icon="chart-bar" title={t().requestsByApp}>
            <Show when={!props.trafficError} fallback={<Failed text={t().trafficUnavailable} onRetry={() => location.reload()} />}>
              <List label={t().requestsByApp}>
                <For each={props.byApp}>
                  {(app) => (
                    <Row
                      mark={{ icon: app.icon, color: app.color }}
                      lines={[app.label]}
                      end={<Progress value={app.requests} of={props.byApp[0]?.requests ?? 0} label={number(app.requests)} />}
                      href={routesHref(query(), { ...props.state, filters: { ...props.state.filters, app: app.id } })}
                    />
                  )}
                </For>
              </List>
            </Show>
          </Section>
        </Pane>
      </Pane.Split>
    </AdminWorkspace>
  );
}
