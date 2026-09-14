import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import {
  Button,
  DateRangePicker,
  ChartExplorer,
  ChartFilterControls,
  ChartSnapshotView,
  createChartCursor,
  DataTable,
  MarkdownView,
  MultiSelectInput,
  NumberInput,
  Select,
  Slider,
  StatCell,
  TextInput,
  useLocale,
  type ChartCursor,
} from "@k2b/ui";
import { chartSnapshot, explorerChart } from "./analytics-chart";
import { formatValue, type AnalyticsNode, type AnalyticsEvent, type SourceContext, type Row } from "./runtime/analytics-contracts";
import type { z } from "zod";
import { artifactMessages } from "./messages";

export function AnalyticsView(props: {
  node: AnalyticsNode;
  event: (event: AnalyticsEvent) => void;
  children: (ids: () => string[]) => JSX.Element;
  cursor: (id: string) => ChartCursor;
  busy: boolean;
}) {
  const locale = useLocale();
  const t = () => artifactMessages.resolve([locale()]).t;
  const disabled = () => props.busy || props.node.disabled || (props.node.loading && props.node.type !== "group");
  const text = () => (props.node.type === "text" ? props.node : undefined);
  const stat = () => (props.node.type === "stat" ? props.node : undefined);
  const filePicker = () => (props.node.type === "filePicker" ? props.node : undefined);
  const button = () => (props.node.type === "button" ? props.node : undefined);
  const input = () => (props.node.type === "input" ? props.node : undefined);
  const select = () => (props.node.type === "select" ? props.node : undefined);
  const multi = () => (props.node.type === "multiSelect" ? props.node : undefined);
  const number = () => (props.node.type === "number" ? props.node : undefined);
  const dateRange = () => (props.node.type === "dateRange" ? props.node : undefined);
  const slider = () => (props.node.type === "slider" ? props.node : undefined);
  const chart = () => (props.node.type === "chart" ? props.node : undefined);
  const explorer = () => (props.node.type === "explorer" ? props.node : undefined);
  const table = () => (props.node.type === "table" ? props.node : undefined);
  const group = () => (props.node.type === "group" ? props.node : undefined);
  const layout = () => (props.node.type === "layout" ? props.node : undefined);
  function Context(p: { data: z.infer<typeof SourceContext> }) {
    return (
      <div class="artifact-analysis-context">
        <span>
          {p.data.mode === "snapshot" ? t().analysisSnapshot : t().analysisLive} ·{" "}
          <time dateTime={p.data.asOf}>
            {new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(p.data.asOf))}
          </time>
        </span>
        <Show when={p.data.status !== "complete"}>
          <strong role="status">{p.data.status === "partial" ? t().analysisPartial : t().analysisFixture}</strong>
        </Show>
        <Show when={p.data.note}>
          <p>{p.data.note}</p>
        </Show>
        <For each={p.data.sources}>
          {(source) => (
            <div>
              <Show when={source.href} fallback={<span>{source.label}</span>}>
                <a href={source.href} target="_blank" rel="noopener noreferrer">
                  {source.label}
                </a>
              </Show>
              <Show when={source.description}>
                <span> · {source.description}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    );
  }
  function Explorer(p: { node: Extract<AnalyticsNode, { type: "explorer" }> }) {
    const data = createMemo(() => explorerChart(p.node.data, p.node.columns, locale()));
    return (
      <>
        <Show when={p.node.data.context}>{(context) => <Context data={context()} />}</Show>
        <ChartExplorer<{ key: string; values: Row }>
          title={p.node.label}
          description={p.node.description}
          data={data()}
          cursor={p.node.cursor ? props.cursor(p.node.cursor) : undefined}
          columns={p.node.columns.map((column) => ({
            id: column.key,
            label: column.label,
            align: column.align,
            value: (row) => formatValue(row.values[column.key], column.format, locale()),
            sortValue: column.sortable
              ? (row) => {
                  const value = row.values[column.key];
                  return typeof value === "boolean" ? Number(value) : (value ?? null);
                }
              : undefined,
          }))}
          selectedKey={p.node.selectedKey}
          onSelectedKeyChange={(key) => {
            if (!disabled()) props.event({ type: "select", key });
          }}
          view={p.node.view}
          onViewChange={(value) => {
            if (!disabled()) props.event({ type: "view", value });
          }}
        />
      </>
    );
  }
  function Table(p: { node: Extract<AnalyticsNode, { type: "table" }> }) {
    const [sort, setSort] = createSignal<{ key: string; direction: "asc" | "desc" } | null>(null);
    const rows = createMemo(() => {
      const order = sort();
      const values = [...p.node.rows];
      if (!order || !p.node.columns.some((column) => column.key === order.key && column.sortable)) return values;
      const collator = new Intl.Collator(locale(), { numeric: true });
      return values.sort((a, b) => {
        const av = a[order.key],
          bv = b[order.key];
        if (av == null) return bv == null ? 0 : 1;
        if (bv == null) return -1;
        return (
          (typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv))) *
          (order.direction === "asc" ? 1 : -1)
        );
      });
    });
    return (
      <DataTable
        rows={rows()}
        columns={p.node.columns.map((column) => ({
          id: column.key,
          header: column.label,
          value: column.key,
          align: column.align,
          sortable: column.sortable,
        }))}
        ariaLabel={p.node.label}
        getRowId={(row) => String(row[p.node.rowKey])}
        selectedRowId={p.node.selectedKey}
        sort={sort()}
        onRowClick={(row) => {
          if (!disabled()) props.event({ type: "select", key: String(row[p.node.rowKey]) });
        }}
        renderHeader={({ col, render }) =>
          col.sortable ? (
            <Button
              variant="text"
              onClick={() => setSort({ key: col.id, direction: sort()?.key === col.id && sort()?.direction === "asc" ? "desc" : "asc" })}
            >
              {p.node.columns.find((column) => column.key === col.id)?.label}{" "}
              {sort()?.key === col.id ? (sort()?.direction === "asc" ? "↑" : "↓") : "↕"}
            </Button>
          ) : (
            render()
          )
        }
        renderCell={({ row, col }) => {
          const value = formatValue(row[col.id], p.node.columns.find((column) => column.key === col.id)?.format, locale());
          return col.id === p.node.columns[0]?.key ? (
            <Button variant="text" disabled={disabled()} onClick={() => props.event({ type: "select", key: String(row[p.node.rowKey]) })}>
              {value}
            </Button>
          ) : (
            value
          );
        }}
      />
    );
  }
  return (
    <>
      <Show when={stat()}>{node=><div aria-busy={node().loading}><StatCell label={node().label}
        value={node().loading ? "…" : formatValue(node().value,node().format,locale())}
        sub={node().description} trend={node().trend} /></div>}</Show>
      <Show when={text()}>
        {(n) => (
          <Show when={n().markdown} fallback={<p class="whitespace-pre-wrap">{n().value}</p>}>
            <MarkdownView markdown={n().value} allowImages={false} linkProtocols={["https:"]} linkTarget="_blank" />
          </Show>
        )}
      </Show>
      <Show when={filePicker()}>
        {(n) => (
          <div>
            <Button disabled={disabled()} loading={n().loading} onClick={() => props.event({ type: "change", value: null })}>
              {n().label}
            </Button>
            <span>{n().names}</span>
            <Show when={n().description}>
              <p>{n().description}</p>
            </Show>
          </div>
        )}
      </Show>
      <Show when={button()}>
        {(n) => (
          <Button
            variant={n().variant}
            disabled={disabled()}
            loading={n().loading}
            onClick={() => props.event({ type: "change", value: null })}
          >
            {n().label}
          </Button>
        )}
      </Show>
      <Show when={input()}>
        {(n) => (
          <TextInput
            label={n().label}
            description={n().description}
            value={n().value}
            placeholder={n().placeholder}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value: value ?? "" })}
          />
        )}
      </Show>
      <Show when={select()}>
        {(n) => (
          <Select
            label={n().label}
            value={n().value}
            options={n().options}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value: value ?? "" })}
          />
        )}
      </Show>
      <Show when={multi()}>
        {(n) => (
          <MultiSelectInput
            label={n().label}
            value={n().value}
            options={n().options}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value })}
          />
        )}
      </Show>
      <Show when={number()}>
        {(n) => (
          <NumberInput
            label={n().label}
            value={n().value}
            min={n().min}
            max={n().max}
            step={n().step}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value })}
          />
        )}
      </Show>
      <Show when={dateRange()}>
        {(n) => (
          <DateRangePicker
            label={n().label}
            value={n().value}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value })}
          />
        )}
      </Show>
      <Show when={slider()}>
        {(n) => (
          <Slider
            label={n().label}
            value={n().value}
            min={n().min}
            max={n().max}
            step={n().step}
            disabled={disabled()}
            onValueChange={(value) => props.event({ type: "change", value })}
          />
        )}
      </Show>
      <Show when={chart()}>
        {(n) => {
          const snapshot = createMemo(() => chartSnapshot(n().data, locale()));
          return (
            <ChartSnapshotView
              snapshot={snapshot()}
              selectedKey={n().selectedKey}
              cursor={n().cursor ? props.cursor(n().cursor!) : undefined}
              onSelect={(key) => {
                if (!disabled() && n().data.marks) props.event({ type: "select", key });
              }}
              style={{ height: n().data.options.kind === "sparkline" ? "4rem" : "18rem" }}
            />
          );
        }}
      </Show>
      <Show when={explorer()}>{(n) => <Explorer node={n()} />}</Show>
      <Show when={table()}>{(n) => <Table node={n()} />}</Show>
      <Show when={group()}>
        {(n) => (
          <section aria-label={n().label} aria-busy={n().loading}>
            <strong>{n().label}</strong>
            <Show when={n().loading}>
              <span role="status"> · {t().analysisLoading}</span>
            </Show>
            <ChartFilterControls
              request={n().desired}
              displayedRequest={n().snapshot.request}
              steps={n().steps}
              series={n().series?.map((series, index) => ({ ...series, color: `var(--stdlib-chart-c${(index % 8) + 1})` }))}
              disabled={props.busy || n().disabled}
              failed={Boolean(n().error)}
              onRequest={(request) =>
                props.event({
                  type: "request",
                  request: { ...request, visibleKeys: request.visibleKeys ? [...request.visibleKeys] : undefined },
                })
              }
              onRetry={() => props.event({ type: "refresh" })}
            />
            <Button variant="secondary" disabled={props.busy || n().disabled} onClick={() => props.event({ type: "refresh" })}>
              {t().analysisRefresh}
            </Button>
            <Show when={n().comparison && n().snapshot.request.step}>
              <Button
                variant="secondary"
                disabled={n().loading || Boolean(n().error)}
                onClick={() => props.event({ type: "request", request: { ...n().desired, referenceStep: n().snapshot.request.step } })}
              >
                {t().analysisCompare}
              </Button>
            </Show>
            <Show when={n().desired.referenceStep}>
              <Button
                variant="text"
                onClick={() => {
                  const { referenceStep, ...request } = n().desired;
                  props.event({ type: "request", request });
                }}
              >
                {t().analysisClearComparison}
              </Button>
            </Show>
            <Show when={n().error}>
              <p role="alert">{n().error}</p>
            </Show>
          </section>
        )}
      </Show>
      <Show when={layout()}>
        {(n) => {
          const children = props.children(() => n().children);
          return (
            <section
              class={`artifact-analysis-layout artifact-analysis-${n().layout}`}
              style={{ "--analysis-min-width": `${n().minWidth}px` }}
            >
              <Show when={n().label}>
                <header>
                  <h3>{n().label}</h3>
                  <p>{n().description}</p>
                </header>
              </Show>
              {children}
            </section>
          );
        }}
      </Show>
    </>
  );
}

export function createAnalyticsCursors() {
  const cursors = new Map<string, ChartCursor>();
  return (id: string) => {
    let cursor = cursors.get(id);
    if (!cursor) {
      cursor = createChartCursor();
      cursors.set(id, cursor);
    }
    return cursor;
  };
}
