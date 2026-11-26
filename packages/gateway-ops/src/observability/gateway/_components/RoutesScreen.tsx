import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, FilterBar, Icon, Input, type NavProps, Notice, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createMemo, For } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { type RoutesState, routesHref, routesQuery } from "../query";

/** One prefix of the router's table with the window's traffic, worded by the server. */
export type RouteRow = {
  prefix: string;
  app: { id: string; label: string; icon: string };
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
            { title: t().prefix, width: { min: 220, default: 420 }, cell: (row) => row.prefix },
            {
              title: t().app,
              width: { min: 120, default: 200 },
              // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
              cell: (row) => (
                <>
                  <Icon name={row.app.icon} /> {row.app.label}
                </>
              ),
              drop: true,
            },
            { title: t().requests, width: { min: 100, default: 120 }, align: "end", cell: (row) => row.requests },
            {
              title: t().errors,
              width: { min: 90, default: 110 },
              align: "end",
              cell: (row) => (row.failing ? <Chip status="bad">{row.errors}</Chip> : "—"),
            },
          ]}
        />
      </Pane>
    </AdminWorkspace>
  );
}
