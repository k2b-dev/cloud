import type { AdminAreaGroup } from "@k2b/cloud/ssr";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Check,
  Chip,
  Dialog,
  Failed,
  Field,
  FilterBar,
  Input,
  ListOrder,
  Menu,
  Nav,
  Notice,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { apiClient } from "../api-client";
import type { LogEntry, LogLevel } from "../contracts";
import { logsMessages } from "../messages";
import {
  endsNow,
  LOG_PAGE_MAX,
  LOG_TIME_PRESETS,
  LOG_VIEWS,
  LOGS_PAGE_PATH,
  LOGS_PER_PAGE,
  type LogsState,
  logsHref,
  logsQuery,
} from "../query";
import { type LogRow, logRowFormatter } from "../rows";
import LogEntryPane from "./LogEntryPane";

export type LogsData = { entries: LogEntry[]; total: number; levels: Record<LogLevel, number> };

export type LogsScreenProps = {
  timeZone: string;
  /** Today in the reader's zone, from the server: entries of other days show their day. */
  today: string;
  /** The area's sections for the sidebar. */
  area: { title: string; groups: AdminAreaGroup[]; markLabel: string };
  state: LogsState;
  page: number;
  entry: string | null;
  liveOff: boolean;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  /** The list, or why the log store could not be read. */
  data: LogsData | null;
  error: string | null;
  selected: { entry: LogEntry | null; error: string | null } | null;
};

/** How often a live list asks for new entries while the page is visible. */
const LIVE_INTERVAL_MS = 5_000;

const levelStatus = { error: "bad", warn: "warn" } as const;

/** v1 icon classes ("ti ti-file-text") to v2 Tabler names ("file-text"). */
const icon = (classes: string) => classes.replace(/^ti\s+(ti-)?/, "").replace(/^ti-/, "");

/** The log list of Observability on v2: views, filter statements, status row, table, and the open entry beside it. */
export default function LogsScreen(props: LogsScreenProps) {
  const locale = useLocale();
  const t = () => logsMessages.resolve([locale()]).t;
  const toast = useToast();
  const query = createMemo(() =>
    logsQuery(locale(), {
      load: async (text, context) => {
        const hours = Math.min(24 * 31, Math.max(24, Math.ceil(windowHours(state()))));
        const response = await apiClient.sources.$get({ query: { since_hours: String(hours) } }, { init: { signal: context.signal } });
        if (!response.ok) throw new Error(t().storeUnavailable);
        const { sources } = await response.json();
        const needle = text.trim().toLowerCase();
        return {
          items: sources
            .filter((source) => source.toLowerCase().includes(needle))
            .slice(0, context.limit)
            .map((source) => ({ value: source, label: source })),
        };
      },
    }),
  );
  const [state, setState] = createSignal<LogsState>(props.state);
  const [data, setData] = createSignal<LogsData | null>(props.data);
  const [error, setError] = createSignal<string | null>(props.error);
  const [liveOff, setLiveOff] = createSignal(props.liveOff);
  const [liveFailed, setLiveFailed] = createSignal(false);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [cleanupOpen, setCleanupOpen] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [page, setPage] = createSignal(props.page);
  const format = createMemo(() => logRowFormatter(locale(), props.timeZone));
  const rows = createMemo(() => (data()?.entries ?? []).map((entry) => format().row(entry, props.today)));
  const total = () => data()?.total ?? 0;
  const pages = () => Math.min(LOG_PAGE_MAX, Math.max(1, Math.ceil(total() / LOGS_PER_PAGE)));
  const live = () => !liveOff() && endsNow(state()) && page() === 1;
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);

  let controller: AbortController | undefined;
  /** Loads the list for a state through the API; the old rows stay until the new ones come. */
  // k2b-ui gap: 4 – StatusRow has no reserved loading sign, so nothing shows that new rows are on their way.
  const load = async (next: LogsState, quiet = false) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const params = query().serialize(next);
    params.set("per_page", String(LOGS_PER_PAGE));
    if (page() > 1) params.set("page", String(page()));
    try {
      const response = await apiClient.index.$get(
        { query: Object.fromEntries(params) as Record<string, string> },
        { init: { signal: current.signal } },
      );
      if (!response.ok) throw new Error(t().storeUnavailable);
      const body = await response.json();
      if (current.signal.aborted) return;
      setData({ entries: body.entries, total: body.pagination.total, levels: body.levels });
      setError(null);
      setLiveFailed(false);
    } catch (failure) {
      if (current.signal.aborted) return;
      // A live refresh that fails keeps the rows and says so in the status row; it tries again on its own.
      if (quiet) setLiveFailed(true);
      else setError(failure instanceof Error ? failure.message : t().storeUnavailable);
    }
  };

  /** A new state from the bar, the search or the order: page 1 again, and the address without the old page. */
  const change = (next: LogsState) => {
    const before = state();
    setState(next);
    if (page() !== 1 && !isServer) {
      setPage(1);
      const params = new URLSearchParams(location.search);
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    const sameRows =
      query()
        .serialize({ ...next, group: undefined })
        .toString() ===
      query()
        .serialize({ ...before, group: undefined })
        .toString();
    if (!sameRows) void load(next);
  };

  const search = (text: string) => {
    const next = { ...state(), search: text.trim() || undefined };
    const params = query().serialize(next, location.search);
    history.pushState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    change(next);
  };

  const setLive = (on: boolean) => {
    setLiveOff(!on);
    const params = new URLSearchParams(location.search);
    if (on) params.delete("live");
    else params.set("live", "off");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
  };

  onMount(() => {
    const timer = setInterval(() => {
      if (live() && document.visibilityState === "visible") void load(state(), true);
    }, LIVE_INTERVAL_MS);
    onCleanup(() => {
      clearInterval(timer);
      controller?.abort();
    });
  });

  const href = (extra: { page?: number; entry?: string | null } = {}) =>
    logsHref(query(), state(), { page: extra.page ?? page(), entry: extra.entry, liveOff: liveOff() });
  const errorsView = (): LogsState => LOG_VIEWS.errors(query());
  const base = () => (state().view === "errors" ? errorsView() : query().reset());
  const changed = () => query().serialize(state()).toString() !== query().serialize(base()).toString();

  const levelWord = (level: LogLevel) => ({ debug: t().debug, info: t().info, warn: t().warn, error: t().error })[level];
  const levelChip = (level: LogLevel) => {
    const status = levelStatus[level as keyof typeof levelStatus];
    return status ? <Chip status={status}>{levelWord(level)}</Chip> : <Chip>{levelWord(level)}</Chip>;
  };
  const groupOf = (row: LogRow) => {
    const all = rows();
    if (state().group === "source") {
      const members = all.filter((other) => other.source === row.source);
      return { key: `source:${row.source}`, head: () => <Text weight="strong">{row.source}</Text>, ...groupFacts(members) };
    }
    const members = all.filter((other) => other.minute === row.minute);
    return {
      key: `minute:${row.minute}`,
      head: () => <Text weight="strong">{t().minuteHead({ time: row.minuteLabel })}</Text>,
      ...groupFacts(members),
    };
  };
  const groupFacts = (members: LogRow[]) => ({
    count: String(members.length),
    meta: t().groupCounts({
      errors: members.filter((member) => member.level === "error").length,
      warnings: members.filter((member) => member.level === "warn").length,
    }),
  });

  const liveLabel = () => (
    <>
      {t().live}
      <Show when={!endsNow(state())}>
        {" "}
        <Text type="meta" muted>
          – {t().liveOnlyUntilNow}
        </Text>
      </Show>
      <Show when={endsNow(state()) && page() > 1}>
        {" "}
        <Text type="meta" muted>
          – {t().liveOnlyFirstPage}
        </Text>
      </Show>
    </>
  );

  const nav = () => (
    <Nav
      title={props.area.title}
      icon="activity"
      groups={props.area.groups.map((group) => ({
        label: group.title,
        items: group.items.map((item) => ({
          label: item.label,
          icon: icon(item.icon),
          href: item.href,
          current: item.id === "logs",
          dot: item.mark === "error" ? ("bad" as const) : item.mark === "warning" ? ("warn" as const) : undefined,
        })),
      }))}
    />
  );

  return (
    <Workspace
      sidebar={nav()}
      detail={props.entry ? 420 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={[
                { label: t().viewAll, href: LOGS_PAGE_PATH, current: state().view !== "errors" },
                { label: t().viewErrors, icon: "alert-circle", href: logsHref(query(), errorsView()), current: state().view === "errors" },
              ]}
            />
          }
          end={
            <>
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
              <Menu
                label={t().moreActions}
                items={[
                  // k2b-ui gap: 8 – the head's search field gives way on the phone (Input has no `keep`); this entry keeps it.
                  { label: t().searchMenu, icon: "search", onClick: () => setSearchOpen(true) },
                  { label: t().retention, icon: "archive", href: "/admin/observability/retention" },
                  { label: t().cleanup, icon: "trash", danger: true, onClick: () => setCleanupOpen(true) },
                ]}
              />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().logs}
          scrollKey="gateway-ops-logs"
          status={
            <>
              <FilterBar
                query={query()}
                state={state()}
                onChange={change}
                base={base()}
                icons={{ time: "clock", level: "alert-triangle", source: "server", request: "id" }}
                names={(state().filters.source ?? []).map((source) => ({ value: source, label: source }))}
                results={t().entries({ count: number(total()) })}
              />
              <StatusRow
                lead={data() ? t().entriesOf({ count: number(rows().length), total: number(total()) }) : t().unavailable}
                // k2b-ui gap: 2 – StatusRow keeps its facts in a narrow column (concept 6d drops them below 760 px). Beside
                // an open entry the list is that narrow, so the counts give way there, and the concept's sentence
                // "Live: neue Einträge kommen oben dazu" is left out so the row fits at 1024 px.
                facts={[
                  ...(props.entry || !data()
                    ? []
                    : [
                        { value: number(data()?.levels.error ?? 0), after: t().errors },
                        { value: number(data()?.levels.warn ?? 0), after: t().warnings },
                      ]),
                  // Only a refresh that fails needs a sentence (it retries on its own).
                  ...(live() && liveFailed() ? [{ after: t().liveRetrying }] : []),
                ]}
                filters={
                  <>
                    <Check switch label={liveLabel()} checked={live()} disabled={!endsNow(state()) || page() > 1} onChange={setLive} />
                    <ListOrder query={query()} state={state()} onChange={change} />
                  </>
                }
              />
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
          <Show when={!error()} fallback={<Failed text={t().storeUnavailable} onRetry={() => void load(state())} />}>
            <Table
              label={t().logs}
              rows={rows()}
              rowKey={(row) => row.id}
              sticky
              current={props.entry ?? undefined}
              group={state().group ? groupOf : undefined}
              open={(row) => ({ href: href({ entry: row.id }) })}
              empty={
                changed()
                  ? {
                      icon: "filter-off",
                      text: t().noMatches,
                      action: { label: t().resetFilters, icon: "filter-off", href: logsHref(query(), base()) },
                    }
                  : { icon: "list-search", text: t().noEntries }
              }
              // k2b-ui gap: 3 – a phone row has no place for a trailing status chip; the level word leads the second line.
              phone={(row) => ({
                lines: [
                  row.message,
                  [row.level === "error" || row.level === "warn" ? levelWord(row.level) : "", row.source, row.requestId, row.duration]
                    .filter(Boolean)
                    .join(" · "),
                ],
                time: row.time.slice(-12, -4),
              })}
              columns={[
                { title: t().at, width: { min: 110, default: 120 }, cell: (row) => row.time },
                { title: t().level, width: { min: 96, default: 110 }, cell: (row) => levelChip(row.level) },
                { title: t().source, width: { min: 90, default: 120 }, cell: (row) => row.source, drop: true },
                { title: t().message, width: { min: 240, default: 480 }, cell: (row) => row.message },
                { title: t().request, width: { min: 90, default: 120 }, cell: (row) => row.requestId ?? "—", drop: true },
                { title: t().duration, width: { min: 80, default: 100 }, align: "end", cell: (row) => row.duration ?? "—", drop: true },
              ]}
            />
            <Show when={pages() > 1}>
              <Bar
                start={<Text type="meta">{t().pageOf({ page: page(), pages: pages() })}</Text>}
                end={
                  <>
                    <Button icon="chevron-left" href={href({ page: page() - 1 })} disabled={page() <= 1}>
                      {t().previous}
                    </Button>
                    <Button href={href({ page: page() + 1 })} disabled={page() >= pages()} forward>
                      {t().next}
                    </Button>
                  </>
                }
              />
            </Show>
          </Show>
        </Pane>
        <Show when={props.entry}>
          <LogEntryPane selected={props.selected} timeZone={props.timeZone} closeHref={href({ entry: null })} listLabel={t().logs} />
        </Show>
      </Pane.Split>
      <SearchDialog
        open={searchOpen()}
        onOpenChange={setSearchOpen}
        value={state().search ?? ""}
        onSearch={(text) => {
          setSearchOpen(false);
          search(text);
        }}
      />
      <CleanupDialog
        open={cleanupOpen()}
        onOpenChange={setCleanupOpen}
        onDone={(deleted) => {
          toast(t().deleted({ count: deleted }), { status: "ok" });
          void load(state());
        }}
      />
    </Workspace>
  );
}

/** Hours from the start of the state's window until now, for the sources the source filter offers. */
const windowHours = (state: LogsState): number => {
  const time = state.filters.time;
  if (time.kind === "preset") return LOG_TIME_PRESETS[time.preset] / 60;
  return time.from ? (Date.now() - Date.parse(time.from)) / 3_600_000 : 24 * 31;
};

/** The free search as a dialog, for the phone, where the head's search field gives way (k2b-ui gap: 8). */
function SearchDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; value: string; onSearch: (text: string) => void }) {
  const locale = useLocale();
  const t = () => logsMessages.resolve([locale()]).t;
  const [text, setText] = createSignal(props.value);
  // each opening starts from the search the list shows now
  createEffect(
    on(
      () => props.open,
      (open) => open && setText(props.value),
    ),
  );
  return (
    <Dialog
      title={t().search}
      open={props.open}
      onOpenChange={props.onOpenChange}
      foot={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t().cancel}</Button>
          <Button icon="search" onClick={() => props.onSearch(text())}>
            {t().searchShort}
          </Button>
        </>
      }
    >
      <Field label={t().search}>
        <Input
          type="search"
          icon="search"
          value={props.value}
          onInput={setText}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) props.onSearch(text());
          }}
        />
      </Field>
    </Dialog>
  );
}

/** "Alte Einträge löschen …": the number of days to keep, then one deed that deletes what is older. */
function CleanupDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onDone: (deleted: number) => void }) {
  const locale = useLocale();
  const t = () => logsMessages.resolve([locale()]).t;
  const [days, setDays] = createSignal("30");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const valid = () => /^[1-9]\d{0,4}$/.test(days());
  const submit = async () => {
    if (!valid()) return setFailure(t().cleanupDaysInvalid);
    setBusy(true);
    setFailure(null);
    try {
      const response = await apiClient.cleanup.$delete({ query: { days: days() } });
      const body = await response.json();
      if (!response.ok || !("deleted" in body)) throw new Error(t().cleanupFailed);
      props.onOpenChange(false);
      props.onDone(body.deleted);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().cleanupFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().cleanupTitle}
      open={props.open}
      onOpenChange={props.onOpenChange}
      foot={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t().cancel}</Button>
          <Button icon="trash" busy={busy()} onClick={() => void submit()}>
            {t().cleanupConfirm}
          </Button>
        </>
      }
    >
      <Field label={t().cleanupDays} optional={t().days} hint={t().cleanupHint} error={failure() ?? undefined}>
        <Input type="number" min={1} value={days()} onInput={setDays} />
      </Field>
    </Dialog>
  );
}
