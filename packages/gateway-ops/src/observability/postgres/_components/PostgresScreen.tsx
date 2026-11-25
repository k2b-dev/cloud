import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, FilterBar, Input, ListOrder, type NavProps, Notice, Pane, Section, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { InfrastructureTabs } from "../../_components/InfrastructureTabs";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { OpsChartSection } from "../../_components/OpsChartSection";
import type { OpsChart } from "../../_components/ops-chart";
import { POSTGRES_PATH, type PostgresState, postgresHref, postgresQuery } from "../query";

export type Worded = { label: string; status: "ok" | "warn" | "bad" | null };
export type PostgresSessionRow = {
  pid: string;
  state: Worded;
  /** null: the connection names no application. */
  application: string | null;
  wait: string;
  transactionAge: string;
  queryAge: string;
  query: string;
};
export type PostgresIndexRow = { key: string; name: string; table: string; kind: string; size: string; scans: string; unused: boolean };
export type PostgresTableRow = {
  key: string;
  name: string;
  schema: string;
  rows: string;
  total: string;
  heap: string;
  indexes: string;
  seqScans: string;
  indexScans: string;
  dead: string;
  analyzed: string;
  warnings: string[];
};
export type PostgresExtensionRow = { name: string; installed: boolean; installedVersion: string; defaultVersion: string; comment: string };

export type PostgresScreenProps = {
  nav: NavProps;
  schemas: string[];
  state: PostgresState;
  ignored: string | null;
  cells: KeyCell[];
  runtime: KeyCell[];
  warnings: { tone: "warn" | "bad"; title: string; text: string }[];
  tables: PostgresTableRow[];
  tablesTotal: string;
  charts: { schemaSize: OpsChart; largest: OpsChart; schemaRows: OpsChart };
  sessions: { rows: PostgresSessionRow[]; summary: string; error: string | null };
  indexes: { rows: PostgresIndexRow[]; summary: string; error: string | null };
  extensions: { rows: PostgresExtensionRow[]; summary: string };
};

const worded = (value: Worded) => (value.status ? <Chip status={value.status}>{value.label}</Chip> : <Chip>{value.label}</Chip>);

/** Postgres on v2: key numbers, warnings, the tables with their filters and order, charts, sessions, indexes, extensions. */
export default function PostgresScreen(props: PostgresScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const query = createMemo(() => postgresQuery(locale(), props.schemas, props.state.filters.schema));
  const go = (next: PostgresState, replace = false) => {
    const href = postgresHref(query(), next);
    if (replace) location.replace(href);
    else location.assign(href);
  };
  const change = (next: Pick<PostgresState, "filters" | "search" | "sort">) =>
    go({ ...props.state, filters: next.filters, search: next.search, sort: next.sort }, true);
  const search = (text: string) => go({ ...props.state, search: text.trim() || undefined });
  const filtered = () => Boolean(props.state.filters.schema || props.state.search);
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<InfrastructureTabs current="postgres" />}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchTables}
                placeholder={t().searchTables}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              <Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={postgresHref(query(), props.state)} />
            </>
          }
        />
      }
    >
      <Pane
        label="Postgres"
        scrollKey="gateway-ops-postgres"
        status={
          <>
            <FilterBar query={query()} state={props.state} onChange={change} icons={{ schema: "folders" }} />
            <StatusRow
              lead={t().tablesOf({ count: String(props.tables.length), total: props.tablesTotal })}
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
        <KeyCells cells={props.runtime} />
        <For each={props.warnings}>
          {(warning) => (
            <Notice tone={warning.tone} title={warning.title}>
              {warning.text}
            </Notice>
          )}
        </For>
        <Section icon="table" title={t().tables} count={props.tables.length}>
          <Table
            label={t().tables}
            rows={props.tables}
            rowKey={(row) => row.key}
            sticky
            empty={
              filtered()
                ? {
                    icon: "filter-off",
                    text: t().noMatchingTables,
                    action: { label: t().clear, icon: "filter-off", href: POSTGRES_PATH },
                  }
                : { icon: "table-off", text: t().noMatchingTables }
            }
            phone={(row) => ({
              lines: [`${row.schema}.${row.name}`, `${row.total} · ${row.rows} ${t().rows}`],
              marks: row.warnings.length ? <Chip status="warn">{row.warnings[0]}</Chip> : undefined,
            })}
            columns={[
              { title: t().table, width: { min: 180, default: 260 }, cell: (row) => ({ lines: [row.name, row.schema] }) },
              { title: t().rows, width: { min: 90, default: 110 }, align: "end", cell: (row) => row.rows },
              { title: t().total, width: { min: 90, default: 110 }, align: "end", cell: (row) => row.total },
              { title: t().heap, width: { min: 90, default: 100 }, align: "end", cell: (row) => row.heap, drop: true },
              { title: t().indexes, width: { min: 90, default: 100 }, align: "end", cell: (row) => row.indexes, drop: true },
              { title: t().sequentialScans, width: { min: 100, default: 120 }, align: "end", cell: (row) => row.seqScans, drop: true },
              { title: t().indexScans, width: { min: 100, default: 120 }, align: "end", cell: (row) => row.indexScans, drop: true },
              { title: t().deadRows, width: { min: 90, default: 110 }, align: "end", cell: (row) => row.dead, drop: true },
              { title: t().analyze, width: { min: 130, default: 150 }, cell: (row) => row.analyzed, drop: true },
              {
                title: t().signals,
                width: { min: 140, default: 200 },
                cell: (row) => (row.warnings.length ? <Chip status="warn">{row.warnings.join(", ")}</Chip> : "—"),
                drop: true,
              },
            ]}
          />
        </Section>
        <OpsChartSection chart={props.charts.schemaSize} icon="chart-bar" height={320} empty={t().noMatchingTables} />
        <OpsChartSection chart={props.charts.largest} icon="chart-bar" height={320} empty={t().noMatchingTables} />
        <OpsChartSection chart={props.charts.schemaRows} icon="chart-bar" height={320} empty={t().noMatchingTables} />
        <Section icon="plug-connected" title={t().sessions} count={props.sessions.rows.length} summary={props.sessions.summary}>
          <Show
            when={!props.sessions.error}
            fallback={
              <Notice tone="bad" title={t().sessions}>
                {props.sessions.error ?? ""}
              </Notice>
            }
          >
            <Table
              label={t().sessions}
              rows={props.sessions.rows}
              rowKey={(row) => row.pid}
              empty={{ icon: "plug-off", text: t().noClientBackends }}
              phone={(row) => ({ lines: [row.application ?? t().unnamed, `PID ${row.pid} · ${row.query}`], marks: worded(row.state) })}
              columns={[
                { title: "PID", width: { min: 70, default: 80 }, align: "end", cell: (row) => row.pid },
                { title: t().state, width: { min: 120, default: 160 }, cell: (row) => worded(row.state) },
                {
                  title: t().application,
                  width: { min: 120, default: 160 },
                  cell: (row) => row.application ?? <Text tone="warn">{t().unnamed}</Text>,
                  drop: true,
                },
                { title: t().waitingOn, width: { min: 120, default: 160 }, cell: (row) => row.wait, drop: true },
                { title: t().transaction, width: { min: 80, default: 90 }, align: "end", cell: (row) => row.transactionAge, drop: true },
                { title: t().query, width: { min: 80, default: 90 }, align: "end", cell: (row) => row.queryAge, drop: true },
                { title: t().statement, width: { min: 200, default: 320 }, cell: (row) => row.query, drop: true },
              ]}
            />
          </Show>
        </Section>
        <Section icon="list-search" title={t().indexes} count={props.indexes.rows.length} summary={props.indexes.summary}>
          <Show
            when={!props.indexes.error}
            fallback={
              <Notice tone="bad" title={t().indexes}>
                {props.indexes.error ?? ""}
              </Notice>
            }
          >
            <Table
              label={t().indexes}
              rows={props.indexes.rows}
              rowKey={(row) => row.key}
              empty={{ icon: "list-search", text: t().noUserIndexes }}
              phone={(row) => ({ lines: [row.name, `${row.table} · ${row.size} · ${row.scans}`] })}
              columns={[
                { title: t().index, width: { min: 200, default: 300 }, cell: (row) => ({ lines: [row.name, row.table] }) },
                { title: t().kind, width: { min: 80, default: 100 }, cell: (row) => row.kind, drop: true },
                { title: t().size, width: { min: 80, default: 100 }, align: "end", cell: (row) => row.size },
                {
                  title: t().scans,
                  align: "end",
                  cell: (row) => (row.unused ? <Text tone="warn">{row.scans}</Text> : row.scans),
                  drop: true,
                },
              ]}
            />
          </Show>
        </Section>
        <Section icon="plug" title={t().extensions} count={props.extensions.rows.length} summary={props.extensions.summary}>
          <Table
            label={t().extensions}
            rows={props.extensions.rows}
            rowKey={(row) => row.name}
            empty={{ icon: "plug-off", text: t().noMatchingExtensions }}
            phone={(row) => ({ lines: [row.name, row.comment] })}
            columns={[
              { title: t().extension, width: { min: 140, default: 180 }, cell: (row) => row.name },
              {
                title: t().status,
                width: { min: 110, default: 130 },
                cell: (row) => (row.installed ? <Chip status="ok">{t().installed}</Chip> : <Chip>{t().available}</Chip>),
              },
              { title: t().installed, width: { min: 80, default: 100 }, cell: (row) => row.installedVersion, drop: true },
              { title: t().default, width: { min: 80, default: 100 }, cell: (row) => row.defaultVersion, drop: true },
              { title: t().description, cell: (row) => row.comment, drop: true },
            ]}
          />
        </Section>
      </Pane>
    </AdminWorkspace>
  );
}
