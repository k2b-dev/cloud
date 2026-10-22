import { Button, Chart, type ChartCursor, DataTable, Disclosure, IconButton, Skeleton, StatCell, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { DashboardPanel } from "../../dashboard-contracts";
import { readOverviewNumber } from "../../overview-number";
import { usePulseMessages } from "../use-messages";
import type { DashboardPanelResult, PublicDashboardPanel } from "./dashboard-client";
import { dashboardCategories, dashboardCell, dashboardLine } from "./dashboard-data";

export default function DashboardPanelView(props: {
  panel: PublicDashboardPanel | DashboardPanel;
  result?: DashboardPanelResult;
  pending: boolean;
  retryDisabled?: boolean;
  cursor: ChartCursor;
  retry: () => void;
  private: boolean;
}) {
  const t = usePulseMessages(),
    locale = useLocale();
  const [sqlOpen, setSqlOpen] = createSignal(false);
  let sqlButton: HTMLButtonElement | undefined;
  const SqlButton = () => (
    <IconButton
      variant="ghost"
      size="sm"
      label={`${t().dashboardSql}: ${props.panel.title}`}
      ref={sqlButton}
      aria-controls={`pulse-panel-sql-${props.panel.id}`}
      aria-expanded={sqlOpen()}
      onClick={() => setSqlOpen((open) => !open)}
    >
      <i class="ti ti-code" aria-hidden="true" />
    </IconButton>
  );
  const data = () => props.result?.lastGood?.data;
  const line = createMemo(() =>
    data() && props.panel.kind === "line" ? dashboardLine(props.panel, data()!, locale(), props.result?.lastGood ?? undefined) : null,
  );
  const categoryResult = createMemo(() => {
    if (!data() || !["bar", "funnel"].includes(props.panel.kind)) return { data: [], error: false };
    try {
      return { data: dashboardCategories(props.panel, data()!, locale()), error: false };
    } catch {
      return { data: [], error: true };
    }
  });
  const numberResult = createMemo(() =>
    data()?.rows.length && props.panel.kind === "number" ? readOverviewNumber({ ...data()!, truncated: false }) : null,
  );
  const numberValue = () => {
    const result = numberResult();
    return result?.ok ? result.data : null;
  };
  const categories = () => categoryResult().data;
  const malformed = () => categoryResult().error || (numberResult() !== null && !numberResult()?.ok);
  const failure = () =>
    malformed()
      ? t().dashboardInvalidResult
      : props.result?.error === "TIME_LIMIT"
        ? t().dashboardTimeLimit
        : props.result?.error === "PANEL_RESULT_INVALID"
          ? t().dashboardInvalidResult
          : props.result?.error === "STORE_UNAVAILABLE"
            ? t().dashboardStoreUnavailable
            : t().dashboardPanelFailureDetail;
  const lastAt = () => props.result?.lastGood?.at;
  const stamp = () =>
    lastAt()
      ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(lastAt()!)) + " UTC"
      : "";
  const Table = () => (
    <DataTable
      ariaLabel={props.panel.title}
      density="compact"
      surface="plain"
      rows={data()?.rows ?? []}
      renderCell={({ value }) => dashboardCell(value, locale())}
      columns={(data()?.columns ?? []).map((column, index) => ({
        id: column.name,
        header: column.name,
        value: (row: unknown[]) => row[index],
      }))}
    />
  );
  return (
    <article
      class="pulse-dashboard__panel"
      data-panel={props.panel.id}
      data-kind={props.panel.kind}
      data-width={props.panel.width}
      aria-label={props.panel.title}
      aria-busy={props.pending}
    >
      <Show when={props.panel.kind === "number" && props.private && "sql" in props.panel}>
        <div class="pulse-dashboard__number-sql">
          <SqlButton />
        </div>
      </Show>
      <Show when={props.panel.kind === "number" && (!numberValue() || malformed())}>
        <h3 class="pulse-dashboard__number-placeholder-title">{props.panel.title}</h3>
      </Show>
      <Show when={props.panel.kind !== "number"}>
        <div class="pulse-dashboard__panel-head">
          <h3>{props.panel.title}</h3>
          <Show when={props.private && "sql" in props.panel}>
            <SqlButton />
          </Show>
        </div>
        <p class="pulse-dashboard__description">{props.panel.description}</p>
      </Show>
      <Show
        when={data() && !malformed()}
        fallback={
          <Show
            when={props.result?.status === "error" || malformed()}
            fallback={
              <div class="pulse-dashboard__feedback" role="status" aria-label={t().dashboardLoading}>
                <Skeleton class={props.panel.kind === "number" ? "h-[72px] w-full" : "h-[170px] w-full"} />
              </div>
            }
          >
            <div class="pulse-dashboard__feedback" role="alert">
              <strong>{t().dashboardPanelFailed}</strong>
              <p class="text-sm text-secondary">{failure()}</p>
              <Button variant="secondary" size="sm" disabled={props.pending || props.retryDisabled} onClick={props.retry}>
                {t().retry}
              </Button>
            </div>
          </Show>
        }
      >
        <Show
          when={data()!.rows.length}
          fallback={
            <div class="pulse-dashboard__feedback">
              <p class="text-secondary">{t().dashboardNoRows}</p>
            </div>
          }
        >
          <Show when={numberValue()}>
            {(number) => (
              <div class="pulse-dashboard__number" data-tone={number().detailTone}>
                <StatCell
                  label={props.panel.title}
                  value={
                    <>
                      {dashboardCell(number().value, locale())}
                      <Show when={props.panel.unit || number().unit}>
                        <small class="ml-0.5 text-[15px] font-medium text-secondary">{props.panel.unit || number().unit}</small>
                      </Show>
                    </>
                  }
                  sub={number().detail || props.panel.description}
                />
                <Show when={number().points.length > 1}>
                  <Chart
                    kind="sparkline"
                    data={number().points}
                    style={{ height: "30px" }}
                    smooth={false}
                    showLast={false}
                    showMinMax={false}
                    labels={{ interactiveChart: props.panel.title }}
                    tooltip={({ datum }) => ({
                      rows: datum.values.flatMap((field) =>
                        field.key === "y"
                          ? [
                              {
                                label: props.panel.title,
                                value: `${dashboardCell(field.value, locale())} ${props.panel.unit || number().unit}`.trim(),
                              },
                            ]
                          : [],
                      ),
                    })}
                  />
                </Show>
              </div>
            )}
          </Show>
          <Show when={line()}>
            {(options) => (
              <div class="pulse-dashboard__plot">
                <Chart {...options()} cursor={props.cursor} labels={{ interactiveLine: props.panel.title }} />
              </div>
            )}
          </Show>
          <Show when={props.panel.kind === "bar"}>
            <div class="pulse-dashboard__plot">
              <Chart
                kind="bar"
                data={categories()}
                interactive
                labels={{ interactiveChart: props.panel.title }}
                yAxis={{ format: (value) => `${dashboardCell(value, locale())} ${props.panel.unit}`.trim() }}
                tooltip={({ datum }) => ({
                  title: datum.label,
                  rows: datum.values.map((field) => ({
                    label: props.panel.title,
                    value: `${dashboardCell(field.value, locale())} ${props.panel.unit}`.trim(),
                  })),
                })}
              />
            </div>
          </Show>
          <Show when={props.panel.kind === "funnel"}>
            <div class="pulse-dashboard__plot" style={{ height: `${Math.max(198, categories().length * 36 + 32)}px` }}>
              <Chart
                kind="barGauge"
                data={categories()}
                max={Math.max(1, ...categories().map((row) => row.value))}
                min={0}
                interactive
                labels={{ interactiveChart: `${props.panel.title} · ${t().dashboardFunnel}` }}
                unit={props.panel.unit ? ` ${props.panel.unit}` : ""}
                format={(value) => dashboardCell(value, locale())}
                tooltip={({ datum }) => ({
                  title: datum.label,
                  rows: [
                    {
                      label: props.panel.title,
                      value: `${dashboardCell(categories()[datum.index]?.value, locale())} ${props.panel.unit}`.trim(),
                    },
                    {
                      label: t().dashboardConversion,
                      value: categories()[0]?.value
                        ? `${dashboardCell(((categories()[datum.index]?.value ?? 0) / categories()[0]!.value) * 100, locale())} %`
                        : "—",
                    },
                  ],
                })}
              />
            </div>
          </Show>
          <Show when={props.panel.kind === "table"}>
            <div class="pulse-dashboard__table">
              <Table />
            </div>
          </Show>
        </Show>
        <Show when={props.result?.status === "error"}>
          <div class="mt-2 flex flex-col items-start gap-1 text-sm" role="alert">
            <strong class="text-[var(--k2b-danger-text)]">{failure()}</strong>
            <span class="text-secondary">
              {t().dashboardLastGood}: {stamp()}
            </span>
            <Button variant="secondary" size="sm" disabled={props.pending || props.retryDisabled} onClick={props.retry}>
              {t().retry}
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={props.private && "sql" in props.panel && sqlOpen()}>
        <div class="pulse-dashboard__sql" id={`pulse-panel-sql-${props.panel.id}`}>
          <Disclosure
            surface="plain"
            summary={t().dashboardSql}
            icon="ti ti-code"
            value={sqlOpen()}
            onValueChange={(open) => {
              setSqlOpen(open);
              if (!open) sqlButton?.focus();
            }}
          >
            <pre>
              <code>{"sql" in props.panel ? props.panel.sql : ""}</code>
            </pre>
            <Show when={"params" in props.panel && Object.keys(props.panel.params).length}>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                <For each={"params" in props.panel ? Object.entries(props.panel.params) : []}>
                  {([name, value]) => (
                    <>
                      <dt>:{name}</dt>
                      <dd class="break-all">{value}</dd>
                    </>
                  )}
                </For>
              </dl>
            </Show>
          </Disclosure>
        </div>
      </Show>
    </article>
  );
}
