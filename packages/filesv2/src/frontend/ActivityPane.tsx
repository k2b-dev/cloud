import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Failed, FilterBar, List, Notice, Pane, StatusRow, Text } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { ActivityBatchContext, ActivityChain, ActivityEntry, ActivityPage } from "../activity-contracts";
import type { MarkedEntry } from "../contracts";
import ActivitySearch from "./ActivitySearch";
import { type ActivityListLine, activityDays, activityListLines } from "./activity-lines";
import type { ActivityListState, ActivityQuery } from "./activity-query";
import { type HistoryActions, type HistoryEnvironment, historyRows, runDestination } from "./history-actions";
import { loadActivity } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { type ActivityFilters, activityRequest } from "./history-requests";
import { ActivityRow, MemberRow, OpenedRow, RunRow } from "./history-v2";
import { activityUrl } from "./urls";

const FILTER_ICONS = { who: "user", base: "folders", what: "activity", when: "calendar" } as const;

/**
 * Runs and batches this tab has opened. They stay open when the person comes back from a file they opened from the
 * list; opening is presentation only, so a reload starts closed.
 */
const opened = new Set<string>();

export type ActivityPaneProps = {
  /** The filters of the address; the request is made from them. */
  filters: ActivityFilters;
  query: ActivityQuery;
  state: ActivityListState;
  onChange: (state: ActivityListState) => void;
  /** The authorized first page for `filters`, or null when it could not be read. */
  initial: ActivityPage | null;
  /** Files this person opened, joined into "Me" only. */
  marks?: readonly MarkedEntry[];
  bases: readonly { id: string; label: string }[];
  /** The name of the person chosen under "Who", from the changes this person has seen, so the bar names them. */
  who?: { value: string; label: string };
  env: HistoryEnvironment;
  actions: HistoryActions;
  loadChain: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityChain>;
  loadBatch: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
  retentionDays: number;
  /** A new address is loading; the status row turns its mark. */
  pending: boolean;
  /** Reads the first page again, for Try again and after a deed. */
  onReload: () => void;
  /** Notes the people of a page, so "Who" can offer them. */
  onPeople: (entries: readonly ActivityEntry[]) => void;
};

/**
 * Activity on v2: who did what, where and when, newest first, filtered in the address. "Me" is where it starts: the
 * person's own changes and the files they opened, each led by the thing's mark; "All" leads each change with its
 * person. Older pages add to the list here; the list keeps only the lines in view.
 */
export default function ActivityPane(props: ActivityPaneProps) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const [older, setOlder] = createSignal<ActivityPage[]>([]);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [olderFailed, setOlderFailed] = createSignal(false);
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set(opened));
  let lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  // A new first page (other filters, a reload) starts the list again; older pages of the old one would not belong.
  createEffect(
    on(
      () => props.initial,
      () => {
        lifetime.abort();
        lifetime = new AbortController();
        setOlder([]);
        setOlderFailed(false);
      },
      { defer: true },
    ),
  );

  const pages = createMemo(() => (props.initial ? [props.initial, ...older()] : []));
  const next = () => pages().at(-1)?.next ?? null;
  const entries = createMemo(() => pages().flatMap((page) => page.items));
  const mine = () => props.filters.actor === "me";
  const mode = () => (mine() ? ("me" as const) : ("all" as const));
  // Scoped views name one place; opened files then belong to no filter and stay out.
  const narrowed = () => !!(props.filters.baseId || props.filters.action || props.filters.when || props.filters.q);
  const filtered = () => !!(props.filters.baseId || props.filters.path || !mine() || props.filters.action || props.filters.when);
  const days = createMemo(() =>
    activityDays(historyRows(entries(), { batches: true, merge: true }), narrowed() ? [] : (props.marks ?? []), {
      complete: !next(),
      locale: locale(),
      t: h(),
      env: props.env,
    }),
  );
  const lines = createMemo(() => activityListLines(days(), open(), (rows) => !!runDestination(rows, props.env)));
  const toggle = (key: string) => {
    if (opened.has(key)) opened.delete(key);
    else opened.add(key);
    setOpen(new Set(opened));
  };
  const limited = () => pages().some((page) => page.searchLimitReached);
  const unavailable = () => !!props.filters.baseId?.startsWith("freeipa:");

  const more = async () => {
    const cursor = next();
    if (!cursor || loadingOlder()) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const page = await loadActivity({ ...activityRequest(props.filters, props.env), cursor }, lifetime.signal, h().olderFailed);
      props.onPeople(page.items);
      setOlder((current) => [...current, page]);
    } catch {
      if (!lifetime.signal.aborted) setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  /** A deed changed the history: the list reads again from its first page. */
  const changed = () => props.onReload();

  const lead = () => {
    const count = props.initial ? new Set(entries().map((entry) => entry.id)).size : 0;
    return (next() ? h().v2ActivityLeadMore : h().v2ActivityLead).replace("{count}", new Intl.NumberFormat(locale()).format(count));
  };
  const line = (item: ActivityListLine) => {
    switch (item.kind) {
      case "opened":
        return <OpenedRow item={item.item} env={props.env} bases={props.bases} />;
      case "run":
        return <RunRow rows={item.rows} env={props.env} mode={mode()} open={item.open} onToggle={() => toggle(item.key)} />;
      case "runRow":
        return (
          <ActivityRow
            row={item.row}
            env={props.env}
            actions={props.actions}
            mode={mode()}
            member={item.short ? "short" : undefined}
            dated
            onChanged={changed}
          />
        );
      case "member":
        return <MemberRow entry={item.row.entries[item.index]!} />;
      default:
        return (
          <ActivityRow
            row={item.row}
            env={props.env}
            actions={props.actions}
            mode={mode()}
            dated
            onChanged={changed}
            toggle={item.batch ? { ...item.batch, onToggle: () => toggle(item.row.key) } : undefined}
          />
        );
    }
  };
  const allHref = () => activityUrl({ ...props.filters, actor: undefined });
  const resetHref = () => activityUrl({ actor: "me" });

  return (
    <Pane
      label={h().activity}
      scrollKey="filesv2-activity"
      status={
        <>
          <FilterBar
            query={props.query}
            state={props.state}
            onChange={props.onChange}
            icons={FILTER_ICONS}
            names={props.who ? { who: [props.who] } : undefined}
            timeZone={props.env.timeZone}
            results={lead()}
          />
          <StatusRow lead={props.initial ? lead() : h().activity} loading={props.pending} />
        </>
      }
    >
      <Show
        when={
          !props.filters.baseId &&
          props.bases.some((base) => base.id.startsWith("cloud:")) &&
          props.bases.some((base) => base.id.startsWith("freeipa:"))
        }
      >
        <Notice tone="note">{h().historyOverviewUnavailable}</Notice>
      </Show>
      <Switch>
        <Match when={unavailable()}>
          <Empty icon="history-off" text={h().historyUnavailable} />
        </Match>
        <Match when={!props.initial}>
          <Failed text={`${h().errorTitle}. ${h().errorText}`} onRetry={props.onReload} />
        </Match>
        <Match when={props.filters.q}>
          {(words) => (
            <ActivitySearch
              query={words()}
              entries={entries()}
              hasMore={!!next()}
              loadingMore={loadingOlder()}
              moreFailed={olderFailed()}
              onLoadMore={() => void more()}
              limitReached={limited()}
              env={props.env}
              actions={props.actions}
              loadChain={props.loadChain}
              loadBatch={props.loadBatch}
              retentionDays={props.retentionDays}
              clearHref={activityUrl({ ...props.filters, q: undefined })}
              onNavigate={props.env.onNavigate}
              onChanged={changed}
            />
          )}
        </Match>
        <Match when={lines().length === 0 && (next() || olderFailed())}>
          <Empty icon="history" text={h().nothingVisibleYet} />
        </Match>
        <Match when={lines().length === 0 && mine() && !narrowed()}>
          {/* Nothing of their own yet: the way to everyone else's changes is one click. */}
          <Empty
            icon="history"
            text={`${h().noMineTitle}. ${h().noMineText}`}
            action={{ label: h().showAll, icon: "users", href: allHref(), onNavigate: props.env.onNavigate }}
          />
        </Match>
        <Match when={lines().length === 0 && filtered()}>
          <Empty
            icon="filter-off"
            text={h().emptyTitle}
            action={{ label: h().resetFilters, icon: "filter-off", href: resetHref(), onNavigate: props.env.onNavigate }}
          />
        </Match>
        <Match when={lines().length === 0}>
          <Empty icon="history" text={`${h().noActivityTitle}. ${h().noActivityText}`} />
        </Match>
        <Match when={lines().length > 0}>
          <List label={h().activity} items={lines()} rowKey={(item) => item.key} row={line} />
        </Match>
      </Switch>
      <Show when={props.initial && !props.filters.q && !unavailable()}>
        <Show when={olderFailed()}>
          <Notice tone="bad" actions={[{ label: h().retry, onClick: () => void more() }]}>
            {h().olderFailed}
          </Notice>
        </Show>
        <Show when={next() && !olderFailed()}>
          <Bar
            start={<Text type="meta">{lead()}</Text>}
            end={
              <Button icon="chevron-down" busy={loadingOlder()} onClick={() => void more()}>
                {h().loadOlder}
              </Button>
            }
          />
        </Show>
        <Show when={limited()}>
          <Notice tone="note">{h().searchLimit}</Notice>
        </Show>
      </Show>
    </Pane>
  );
}
