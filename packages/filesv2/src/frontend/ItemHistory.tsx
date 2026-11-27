import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, List, Loading, Notice, Row, Section, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ActivityPage, ShareAccessPeriod } from "../activity-contracts";
import type { ShareView } from "../contracts";
import { isHistoryUnavailable } from "./HistoryUnavailable";
import { type HistoryActions, type HistoryEnvironment, type HistoryRowModel, historyRows } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { ActivityRow } from "./history-v2";
import { periodHasAccess, periodLabel, type ShareAccess } from "./ShareHistory";

const RECENT = 4;

export type ItemHistoryProps = {
  env: HistoryEnvironment;
  actions?: HistoryActions;
  directory: boolean;
  /** POSIX storage cannot offer an authorized activity history. */
  unavailable?: boolean;
  /** Identity of the item, such as base, location key and path; a new value starts a new history. */
  source: string;
  /** Authorized SSR snapshot of the first page for `source`. */
  initial?: { source: string; page: ActivityPage } | null;
  load: (cursor: string | null, signal: AbortSignal) => Promise<ActivityPage>;
  /**
   * Public links of the item the parent loaded, with their access queries. `loading` until the first link page
   * arrived, `partial` while further link pages are unloaded or failed. Only `complete` lets the history count.
   */
  links?: { items: readonly ShareAccess[]; state: "loading" | "partial" | "complete" };
  /** Activity filtered to this item; the link shows only when the parent has such an address. */
  activityHref?: string;
  onChanged?: () => void;
};

type Line =
  | { key: string; time: number; kind: "entry"; row: HistoryRowModel }
  | { key: string; time: number; kind: "access"; share: ShareView; period: ShareAccessPeriod };

/** One newest-first stream: what is loaded, and the time of its oldest loaded item while more may follow. */
type Stream = {
  lines: Line[];
  loaded: boolean;
  hasMore: boolean;
  /** Infinity when a loaded stream has more but nothing yet, so no other row may pass it. */
  oldest: number;
  failed: boolean;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
};

const at = (iso: string) => Date.parse(iso);

/**
 * The item's newest four history rows in its detail, then older rows on request. Changes and the hourly access of the
 * item's public links read as one list, newest first. A row shows only once every stream that may still hold a newer
 * row has loaded past it, so paging never reorders what was shown. Repeated editor saves of one person and run read as
 * one row; the count names rows, and only once every stream is loaded.
 */
export default function ItemHistory(props: ItemHistoryProps) {
  const h = useHistoryMessages();
  const history = query.createInfinite({
    source: () => props.source,
    initial:
      props.initial?.source === props.source
        ? { source: props.source, pages: [{ source: props.source, page: props.initial.page }] }
        : undefined,
    loadPage: async (source, { cursor, abortSignal }) => ({ source, page: await props.load(cursor ?? null, abortSignal) }),
    getNextCursor: (result: { source: string; page: ActivityPage }) => result.page.next,
  });
  // Last-good pages survive failed loads, but belong only to the item that produced them.
  const visiblePages = createMemo(() =>
    history
      .pages()
      .filter((result) => result.source === props.source)
      .map((result) => result.page),
  );
  const [expanded, setExpanded] = createSignal(false);
  const activity = createMemo((): Stream => {
    const pages = visiblePages();
    const entries = pages.flatMap((page) => page.items);
    const last = entries.at(-1);
    const hasMore = pages.at(-1)?.next != null;
    return {
      lines: historyRows(entries, { batches: false }).map((row) => ({ key: row.key, time: at(row.lead.time), kind: "entry", row })),
      loaded: pages.length > 0,
      hasMore,
      oldest: last ? at(last.time) : Number.POSITIVE_INFINITY,
      failed: !!history.error(),
      loadMore: () => history.loadMore(),
      retry: () => (hasMore ? history.loadMore() : history.refresh()),
    };
  });
  const access = createMemo((): Stream[] =>
    (props.links?.items ?? []).map(({ share, access: counts }) => {
      const periods = counts.pages().flatMap((page) => page.timeline.items);
      const last = periods.at(-1);
      return {
        lines: periods
          .filter(periodHasAccess)
          .map((period) => ({ key: `access:${share.id}:${period.date}`, time: at(period.date), kind: "access", share, period })),
        loaded: counts.pages().length > 0,
        hasMore: counts.hasMore(),
        oldest: last ? at(last.date) : Number.POSITIVE_INFINITY,
        failed: !!counts.error(),
        loadMore: () => counts.loadMore(),
        retry: () => (counts.pages().length > 0 && counts.hasMore() ? counts.loadMore() : counts.refresh()),
      };
    }),
  );
  // A link whose counts have not arrived joins once they do; until then the history neither counts nor says it is empty.
  const streams = createMemo(() => [activity(), ...access()].filter((stream) => stream.loaded));
  const open = createMemo(() => streams().filter((stream) => stream.hasMore));
  const lines = createMemo(() =>
    streams()
      .flatMap((stream) => stream.lines.filter((line) => open().every((other) => other === stream || line.time > other.oldest)))
      .sort((a, b) => b.time - a.time),
  );
  /** The stream that holds back the most rows: the one whose loaded items end newest. */
  const limiting = () => open().reduce<Stream | null>((best, stream) => (!best || stream.oldest > best.oldest ? stream : best), null);
  const loaded = () => activity().loaded;
  const more = () => open().length > 0;
  const accessFailed = () => access().some((stream) => stream.failed);
  const accessWaiting = () =>
    props.links?.state === "loading" ||
    (props.links?.items ?? []).some(({ access: counts }) => !counts.pages().length && (counts.loading() || counts.refreshing()));
  const loadingOlder = () => history.loadingMore() || (props.links?.items ?? []).some(({ access: counts }) => counts.loadingMore());
  const complete = () =>
    loaded() &&
    !more() &&
    !activity().failed &&
    (!props.links || (props.links.state === "complete" && access().every((stream) => stream.loaded && !stream.failed)));
  const shown = () => (expanded() ? lines() : lines().slice(0, RECENT));
  const older = () => lines().length - RECENT;
  const loadNext = () => void limiting()?.loadMore();
  const loadOlder = async () => {
    const source = props.source;
    if (history.error()) await activity().retry();
    else await limiting()?.loadMore();
    if (props.source === source && older() > 0) setExpanded(true);
  };
  const retryAccess = () => {
    for (const stream of access()) if (stream.failed) void stream.retry();
  };
  const changed = () => {
    void history.refresh();
    props.onChanged?.();
  };
  // older lines: the next page of the stream that holds back the most, or open what is loaded
  const olderLabel = () => (history.error() ? h().retry : h().showOlderUnknown);
  const showOlder = () => (expanded() || older() <= 0) && (more() || (loaded() && !!history.error()));
  return (
    <Section
      icon="history"
      title={h().history}
      count={!props.unavailable && complete() && lines().length > 0 ? lines().length : undefined}
      more={!props.unavailable && props.activityHref ? { label: h().allInActivity, href: props.activityHref, forward: true } : undefined}
    >
      <Switch>
        <Match when={props.unavailable || isHistoryUnavailable(history.error())}>
          <Bar start={<Text type="meta">{h().historyUnavailable}</Text>} />
        </Match>
        <Match when={!loaded() && history.error()}>
          <Notice tone="bad" actions={[{ label: h().retry, onClick: () => void history.refresh() }]}>
            {h().historyFailed}
          </Notice>
        </Match>
        <Match when={!loaded()}>
          <Loading rows={RECENT} lines={2} />
        </Match>
        <Match when={lines().length === 0 && (more() || history.error())}>
          <Bar
            start={<Text type="meta">{history.error() ? h().olderFailed : h().nothingVisibleYet}</Text>}
            end={
              <Button busy={loadingOlder()} onClick={() => (history.error() ? void activity().retry() : loadNext())}>
                {olderLabel()}
              </Button>
            }
          />
        </Match>
        <Match when={lines().length === 0 && complete()}>
          <Bar start={<Text type="meta">{h().noEntries}</Text>} />
        </Match>
        <Match when={lines().length === 0 && accessWaiting()}>
          {/* the changes are read; only the links' use is on its way: a quiet line, not placeholder rows */}
          <Bar start={<Text type="meta">{h().accessLoading}</Text>} />
        </Match>
        <Match when={lines().length === 0 && !accessFailed()}>
          <Bar start={<Text type="meta">{h().linksIncomplete}</Text>} />
        </Match>
        <Match when={lines().length > 0}>
          <List label={h().history}>
            <For each={shown()}>
              {(line) =>
                line.kind === "entry" ? (
                  // the person leads, the sentence names the thing, the time says its day
                  <ActivityRow
                    row={line.row}
                    env={props.env}
                    actions={props.actions}
                    mode="all"
                    // a file's own history says "die Datei"; a folder's names each thing, as it holds many
                    context={props.directory ? undefined : "item"}
                    dated
                    onChanged={changed}
                  />
                ) : (
                  <AccessLine share={line.share} period={line.period} env={props.env} />
                )
              }
            </For>
          </List>
          <Show when={showOlder() || older() > 0}>
            <Bar
              end={
                <>
                  <Show when={showOlder()}>
                    <Button icon="chevron-down" busy={loadingOlder()} onClick={() => void loadOlder()}>
                      {olderLabel()}
                    </Button>
                  </Show>
                  <Show when={older() > 0}>
                    <Button onClick={() => setExpanded(!expanded())}>
                      {expanded() ? h().showLess : complete() ? h().showOlder.replace("{count}", String(older())) : h().showOlderUnknown}
                    </Button>
                  </Show>
                </>
              }
            />
          </Show>
          <Show when={loaded() && history.error()}>
            <Notice tone="bad">{h().olderFailed}</Notice>
          </Show>
        </Match>
      </Switch>
      {/* the links' use still on its way: the history is not complete yet, and says so quietly */}
      <Show when={loaded() && accessWaiting() && lines().length > 0}>
        <Bar start={<Text type="meta">{h().accessLoading}</Text>} />
      </Show>
      <Show when={loaded() && accessFailed()}>
        <Notice tone="bad" actions={[{ label: h().retry, onClick: retryAccess }]}>
          {h().accessFailed}
        </Notice>
      </Show>
    </Section>
  );
}

/** One access period of a public link: what visitors did, as a quiet row with the period and the link. */
function AccessLine(props: { share: ShareView; period: ShareAccessPeriod; env: HistoryEnvironment }) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const text = () => {
    const period = props.period;
    if (period.pages > 0) {
      const count = period.pageNetworks;
      return count === null ? h().accessPages(period.pages) : h().accessPagesNetworks({ pages: period.pages, networks: count });
    }
    if (period.downloads > 0) return h().accessDownloads.replace("{count}", String(period.downloads));
    return h().accessPasswords.replace("{count}", String(period.passwordFailed));
  };
  const facts = () => {
    const period = props.period;
    return [
      props.share.title ? h().linkNamed.replace("{title}", props.share.title) : h().publicLink,
      period.pages > 0 && period.downloads > 0 ? h().periodDownloads.replace("{count}", String(period.downloads)) : "",
      (period.pages > 0 || period.downloads > 0) && period.passwordFailed > 0
        ? h().periodPasswords.replace("{count}", String(period.passwordFailed))
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <Row
      mark={{ icon: "link" }}
      lines={[
        text(),
        <>
          <time dateTime={props.period.date}>{periodLabel(props.period, h(), locale(), props.env)}</time>
          {facts() ? ` · ${facts()}` : ""}
        </>,
      ]}
    />
  );
}
