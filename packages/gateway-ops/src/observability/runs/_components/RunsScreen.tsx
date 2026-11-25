import { api } from "@k2b/cloud/browser";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Empty,
  Failed,
  FilterBar,
  Input,
  ListOrder,
  Menu,
  type NavProps,
  Notice,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import RunNow from "../../sync/_components/RunNow";
import type { SyncScheduleRow } from "../../sync/service";
import type { RunsApi } from "../api";
import { runsMessages } from "../messages";
import {
  kindsOf,
  RUNS_PAGE_MAX,
  RUNS_PATH,
  RUNS_PER_PAGE,
  type RunKind,
  type RunRef,
  type RunStatus,
  type RunsState,
  runsHref,
  runsQuery,
} from "../query";
import type { RunRecord, RunRow, RunsPart } from "../service";
import RunRecordPane from "./RunRecordPane";

export type RunsScreenProps = {
  nav: NavProps;
  apps: { id: string; label: string; icon?: string }[];
  timeZone: string;
  /** The server's clock when it read the list, for "running for …" and the schedules' next run. */
  now: string;
  state: RunsState;
  page: number;
  run: RunRef | null;
  tab: "runs" | "schedules";
  ignored: string | null;
  parts: RunsPart[];
  record: { record: RunRecord | null; error: string | null } | null;
  schedules: { schedules: SyncScheduleRow[]; warnings: string[]; error: string | null } | null;
};

const client = api.create<RunsApi>({ baseUrl: "/api/gateway/runs" });

const STATUS_CHIP: Partial<Record<RunStatus, "ok" | "warn" | "bad">> = { failed: "bad", succeeded: "ok" };
/** Each state has its colour (where it means something), its symbol and its word. */
const STATUS_ICON: Record<RunStatus, string> = {
  failed: "alert-circle",
  running: "player-play",
  waiting: "clock",
  succeeded: "check",
  canceled: "ban",
};

/** Runs on v2: one list of every kind of run, each kind paging on its own, and the schedules that start jobs. */
export default function RunsScreen(props: RunsScreenProps) {
  const locale = useLocale();
  const t = () => runsMessages.resolve([locale()]).t;
  const query = createMemo(() => runsQuery(locale(), props.apps, props.state.filters.app));
  const [state, setState] = createSignal<RunsState>(props.state);
  const [parts, setParts] = createSignal<RunsPart[]>(props.parts);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const kindLabel = (kind: RunKind, plural = true) =>
    plural
      ? { job: t().jobs, workflow: t().workflows, delivery: t().deliveries, deadLetter: t().deadLetters }[kind]
      : { job: t().job, workflow: t().workflow, delivery: t().delivery, deadLetter: t().deadLetter }[kind];
  const statusLabel = (status: RunStatus) =>
    ({ failed: t().failed, running: t().running, waiting: t().waiting, succeeded: t().succeeded, canceled: t().canceled })[status];
  const clock = createMemo(
    () =>
      new Intl.DateTimeFormat(locale(), {
        timeZone: props.timeZone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
  );
  const at = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : clock().format(date);
  };
  const duration = (ms: number | null) => {
    if (ms === null) return "—";
    if (ms < 1000) return `${number(Math.round(ms))} ms`;
    if (ms < 60_000) return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
    return `${number(Math.round(ms / 60_000))} min`;
  };

  const kinds = () => kindsOf(state());
  const single = () => kinds().length === 1;
  const rows = createMemo(() => parts().flatMap((part) => part.rows));

  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  /** Loads the list for a state through the API; the rows stay until the new ones come, a newer change aborts this one. */
  const load = async (next: RunsState) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setLoading(true);
    try {
      const params = query().serialize(next);
      const response = await client.index.$get(
        { query: Object.fromEntries(params) as Record<string, string> },
        { init: { signal: current.signal } },
      );
      if (!response.ok) throw new Error(response.statusText);
      const body = await response.json();
      if (current.signal.aborted) return;
      setParts(body.parts);
      setFailed(false);
    } catch {
      if (!current.signal.aborted) setFailed(true);
    } finally {
      if (controller === current) setLoading(false);
    }
  };

  /** A new state from the bar, the search or the order: the list starts at its first page again. */
  const change = (next: RunsState) => {
    setState(next);
    if (!isServer) {
      const params = new URLSearchParams(location.search);
      if (params.has("page")) {
        params.delete("page");
        history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
      }
    }
    void load(next);
  };
  const search = (text: string) => {
    const next = { ...state(), search: text.trim() || undefined };
    const params = query().serialize(next, location.search);
    params.delete("page");
    history.pushState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    change(next);
  };

  const base = () => query().reset();
  const changed = () => query().serialize(state()).toString() !== query().serialize(base()).toString();
  const onlyKind = (kind: RunKind): RunsState => ({ ...state(), filters: { ...state().filters, kind: [kind] } });
  const failedView = (): RunsState => ({ ...query().reset(), filters: { ...query().reset().filters, status: "failed" } });
  const href = (extra: { page?: number; run?: RunRef | null } = {}) =>
    runsHref(query(), state(), { page: extra.page ?? props.page, run: extra.run === undefined ? props.run : extra.run });
  const openOf = (row: RunRow) => ({ href: row.recordHref ?? href({ run: row.ref }) });

  // What the filters do not apply to, said once above the list.
  const notes = createMemo(() => {
    const result: string[] = [];
    const shown = kinds();
    if (state().search && shown.includes("workflow")) result.push(t().searchNotFor({ kinds: t().workflows }));
    if (
      shown.includes("deadLetter") &&
      (() => {
        const time = state().filters.time;
        return time.kind === "preset" && time.preset !== "last-24h";
      })()
    )
      result.push(t().timeNotFor({ kinds: t().deadLetters }));
    return result;
  });

  const total = () => {
    const counted = parts().every((part) => part.total !== null);
    return counted ? parts().reduce((sum, part) => sum + (part.total ?? 0), 0) : null;
  };
  const lead = () => {
    const all = total();
    if (single() && all !== null) return t().runsOf({ count: number(rows().length), total: number(all) });
    const shown = rows().length;
    return t().runsCount({ count: all === null || parts().some((part) => part.more) ? `${number(shown)}+` : number(shown) });
  };
  const singlePart = () => (single() ? parts()[0] : undefined);
  const pages = () => {
    const part = singlePart();
    if (!part) return 1;
    if (part.total !== null) return Math.min(RUNS_PAGE_MAX, Math.max(1, Math.ceil(part.total / RUNS_PER_PAGE)));
    return part.more ? props.page + 1 : props.page;
  };

  const appLabel = (appId: string | null) => (appId ? (props.apps.find((app) => app.id === appId)?.label ?? appId) : "");
  /** The app a run belongs to, with the app's own symbol. */
  const appChip = (appId: string | null) => {
    if (!appId) return "—";
    const app = props.apps.find((candidate) => candidate.id === appId);
    return <Chip icon={app?.icon ?? "apps"}>{app?.label ?? appId}</Chip>;
  };
  const statusChip = (status: RunStatus) => {
    const tone = STATUS_CHIP[status];
    return tone ? (
      <Chip status={tone} icon={STATUS_ICON[status]}>
        {statusLabel(status)}
      </Chip>
    ) : (
      <Chip icon={STATUS_ICON[status]}>{statusLabel(status)}</Chip>
    );
  };

  const runsPane = () => (
    <Pane
      label={t().runs}
      scrollKey="gateway-ops-runs"
      status={
        <>
          <FilterBar
            query={query()}
            state={state()}
            onChange={change}
            base={base()}
            icons={{
              kind: "list",
              status: "circle-dashed",
              app: "apps",
              time: "clock",
              category: "tag",
              duration: "hourglass",
              source: "code",
              channel: "send",
            }}
            results={lead()}
          />
          <StatusRow lead={lead()} loading={loading()} filters={<ListOrder query={query()} state={state()} onChange={change} />} />
        </>
      }
    >
      <Show when={ignored()}>
        {(text) => (
          <Notice tone="warn" title={t().ignoredParts} actions={[{ label: t().hide, onClick: () => setIgnored(null) }]}>
            {text()}
          </Notice>
        )}
      </Show>
      <For each={notes()}>{(note) => <Notice tone="note">{note}</Notice>}</For>
      <For each={parts().filter((part) => part.error)}>
        {(part) => <Notice tone="bad">{t().unavailable({ kind: kindLabel(part.kind) })}</Notice>}
      </For>
      <Show when={!failed()} fallback={<Failed text={t().unavailable({ kind: t().runs })} onRetry={() => void load(state())} />}>
        <Table
          label={t().runs}
          rows={rows()}
          rowKey={(row) => `${row.ref.kind}:${row.ref.id}`}
          current={props.run ? `${props.run.kind}:${props.run.id}` : undefined}
          group={
            single()
              ? undefined
              : (row) => {
                  const part = parts().find((candidate) => candidate.kind === row.ref.kind);
                  const count = part?.total ?? null;
                  return {
                    key: row.ref.kind,
                    head: () => <Text weight="strong">{kindLabel(row.ref.kind)}</Text>,
                    count: count === null ? `${number(part?.rows.length ?? 0)}+` : number(count),
                  };
                }
          }
          open={openOf}
          empty={
            changed()
              ? {
                  icon: "filter-off",
                  text: t().noMatches,
                  action: { label: t().resetFilters, icon: "filter-off", href: runsHref(query(), base()) },
                }
              : { icon: "player-play", text: t().noRuns }
          }
          phone={(row) => ({
            lines: [
              row.name,
              [single() ? "" : kindLabel(row.ref.kind, false), appLabel(row.appId), row.detail].filter(Boolean).join(" · "),
            ],
            time: at(row.at),
            marks: statusChip(row.status),
          })}
          columns={[
            { title: t().name, width: { min: 220, default: 360 }, cell: (row) => ({ lines: [row.name, row.detail || "—"] }) },
            { title: t().status, width: { min: 110, default: 130 }, cell: (row) => statusChip(row.status) },
            { title: t().app, width: { min: 100, default: 130 }, cell: (row) => appChip(row.appId), drop: true },
            { title: t().started, width: { min: 120, default: 140 }, cell: (row) => at(row.at) },
            { title: t().duration, width: { min: 80, default: 100 }, align: "end", cell: (row) => duration(row.durationMs), drop: true },
          ]}
        />
        {/* each kind beside others shows its newest; its own list pages through all of it */}
        <Show when={!single() && parts().some((part) => part.more)}>
          <Bar
            end={
              <For each={parts().filter((part) => part.more)}>
                {(part) => (
                  <Button variant="text" href={runsHref(query(), onlyKind(part.kind))} forward>
                    {part.total === null
                      ? t().showMore({ kind: kindLabel(part.kind) })
                      : t().showAll({ count: number(part.total), kind: kindLabel(part.kind) })}
                  </Button>
                )}
              </For>
            }
          />
        </Show>
        <Show when={single() && pages() > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: props.page, pages: pages() })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={href({ page: props.page - 1, run: null })} disabled={props.page <= 1}>
                  {t().previous}
                </Button>
                <Button href={href({ page: props.page + 1, run: null })} disabled={props.page >= pages()} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Show>
    </Pane>
  );

  const schedulesPane = () => {
    const data = props.schedules;
    const list = data?.schedules ?? [];
    return (
      <Pane
        label={t().schedules}
        scrollKey="gateway-ops-schedules"
        status={<StatusRow lead={t().schedulesCount({ count: number(list.length) })} />}
      >
        <For each={data?.warnings ?? []}>{(warning) => <Notice tone="warn">{warning}</Notice>}</For>
        <Show when={!data?.error} fallback={<Failed text={t().schedulesUnavailable} onRetry={() => location.reload()} />}>
          <Table
            label={t().schedules}
            rows={list}
            rowKey={(row) => `${row.appId}:${row.schedulerId}:${row.id}`}
            empty={{ icon: "calendar-time", text: t().noSchedules }}
            phone={(row) => ({
              lines: [row.id, [row.appName, row.cron, row.lastError ? t().lastFailed : ""].filter(Boolean).join(" · ")],
              time: at(row.nextRunAt),
            })}
            columns={[
              { title: t().schedule, width: { min: 200, default: 300 }, cell: (row) => ({ lines: [row.id, row.schedulerId] }) },
              { title: t().app, width: { min: 90, default: 120 }, cell: (row) => row.appName, drop: true },
              { title: t().cron, width: { min: 110, default: 140 }, cell: (row) => ({ lines: [row.cron, row.timezone] }), drop: true },
              { title: t().nextRun, width: { min: 120, default: 140 }, cell: (row) => at(row.nextRunAt) },
              {
                title: t().lastResult,
                width: { min: 120, default: 160 },
                cell: (row) =>
                  row.lastError ? (
                    <Chip status="bad">{t().lastFailed}</Chip>
                  ) : row.lastCompletedAt ? (
                    <Chip status="ok">{t().succeeded}</Chip>
                  ) : (
                    "—"
                  ),
                drop: true,
              },
              {
                title: t().runNow,
                cell: (row) =>
                  row.handlerAvailable ? (
                    <RunNow appId={row.appId} schedulerId={row.schedulerId} scheduleId={row.id} lastRunId={row.lastRunId} />
                  ) : (
                    <Text type="meta" muted>
                      {t().handlerUnavailable}
                    </Text>
                  ),
              },
            ]}
          />
        </Show>
      </Pane>
    );
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.run && props.tab === "runs" ? 440 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={[
                { label: t().runs, href: runsHref(query(), state()), current: props.tab === "runs" && state().filters.status !== "failed" },
                {
                  label: t().viewFailed,
                  icon: "alert-circle",
                  href: runsHref(query(), failedView()),
                  current: props.tab === "runs" && state().filters.status === "failed",
                },
                { label: t().schedules, icon: "calendar-time", href: `${RUNS_PATH}?tab=schedules`, current: props.tab === "schedules" },
              ]}
            />
          }
          end={
            <>
              <Show when={props.tab === "runs"}>
                <Input
                  type="search"
                  icon="search"
                  label={t().search}
                  placeholder={t().searchShort}
                  value={state().search ?? ""}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search(input.value);
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      search("");
                    }
                  }}
                />
              </Show>
              <Menu
                label={t().moreActions}
                items={[
                  { label: t().workflowDefinitions, icon: "binary-tree", href: "/admin/observability/workflows" },
                  { label: t().notificationDefinitions, icon: "bell-cog", href: "/admin/observability/deliveries?view=registry" },
                  { label: t().earlierNotifications, icon: "mail", href: "/admin/observability/deliveries?view=legacy" },
                ]}
              />
            </>
          }
        />
      }
    >
      <Show when={props.tab === "runs"} fallback={schedulesPane()}>
        <Pane.Split>
          {runsPane()}
          <Show when={props.run}>
            {(ref) => (
              <RunRecordPane
                ref={ref()}
                record={props.record}
                timeZone={props.timeZone}
                closeHref={href({ run: null })}
                kindLabel={kindLabel(ref().kind, false)}
              />
            )}
          </Show>
        </Pane.Split>
      </Show>
    </AdminWorkspace>
  );
}
