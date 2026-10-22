import { query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, DetailPanel } from "@k2b/ui";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ActivityPage, ShareAccessPeriod } from "../activity-contracts";
import type { ShareView } from "../contracts";
import { HistoryRow, SkeletonRows } from "./ActivityView";
import { type HistoryActions, type HistoryEnvironment, type HistoryRowModel, historyRows } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { AccessRow, periodHasAccess, type ShareAccess } from "./ShareHistory";

const RECENT = 4;

export type ItemHistoryProps = {
  env: HistoryEnvironment;
  actions?: HistoryActions;
  directory: boolean;
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
  const retryAccess = () => {
    for (const stream of access()) if (stream.failed) void stream.retry();
  };
  const changed = () => {
    void history.refresh();
    props.onChanged?.();
  };
  return (
    <DetailPanel.Group label={h().history}>
      <DetailPanel.Section
        title={h().history}
        tone="neutral"
        count={complete() && lines().length > 0 ? lines().length : undefined}
        actions={
          <Show when={props.activityHref}>
            {(href) => (
              <ButtonLink size="xs" variant="text" href={href()}>
                {h().allInActivity}
              </ButtonLink>
            )}
          </Show>
        }
      >
        <div class="filesv2-item-history" aria-busy={history.loading() || (!loaded() && history.refreshing()) || accessWaiting()}>
          <Switch>
            <Match when={!loaded() && history.error()}>
              <p class="filesv2-item-history__line" role="alert">
                <i class="ti ti-alert-triangle" aria-hidden="true" />
                {h().historyFailed}
                <Button size="xs" variant="text" onClick={() => void history.refresh()}>
                  {h().retry}
                </Button>
              </p>
            </Match>
            <Match when={!loaded()}>
              <p class="sr-only" role="status">
                {h().historyLoading}
              </p>
              <SkeletonRows count={RECENT} variant="detail" />
            </Match>
            <Match when={lines().length === 0 && (more() || history.error())}>
              <p class="filesv2-item-history__line" role={history.error() ? "alert" : undefined}>
                <Show when={history.error()}>
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                </Show>
                {history.error() ? h().olderFailed : h().nothingVisibleYet}
                <Button
                  size="xs"
                  variant="text"
                  loading={loadingOlder()}
                  loadingLabel={h().loadingOlder}
                  onClick={() => (history.error() ? void activity().retry() : loadNext())}
                >
                  {history.error() ? h().retry : h().showOlderUnknown}
                </Button>
              </p>
            </Match>
            <Match when={lines().length === 0 && complete()}>
              <p class="filesv2-item-history__line">{h().noEntries}</p>
            </Match>
            <Match when={lines().length === 0 && accessWaiting()}>
              <p class="sr-only" role="status">
                {h().accessLoading}
              </p>
              <SkeletonRows count={RECENT} variant="detail" />
            </Match>
            <Match when={lines().length === 0 && !accessFailed()}>
              <p class="filesv2-item-history__line">{h().linksIncomplete}</p>
            </Match>
            <Match when={lines().length > 0}>
              <ul class="filesv2-history-rows">
                <For each={shown()}>
                  {(line) => (
                    <li>
                      <Switch>
                        <Match when={line.kind === "entry" && line}>
                          {(entry) => (
                            // A folder includes descendants, so each row names its actual subject.
                            <HistoryRow
                              row={entry().row}
                              env={props.env}
                              actions={props.actions}
                              context={props.directory ? "activity" : "item"}
                              directory={props.directory ? undefined : false}
                              dated={false}
                              variant="detail"
                              onChanged={changed}
                            />
                          )}
                        </Match>
                        <Match when={line.kind === "access" && line}>
                          {(item) => <AccessRow share={item().share} period={item().period} env={props.env} />}
                        </Match>
                      </Switch>
                    </li>
                  )}
                </For>
              </ul>
              <div class="filesv2-item-history__more">
                <Show when={!expanded() && (older() > 0 || more())}>
                  <Button
                    size="xs"
                    variant="text"
                    onClick={() => {
                      setExpanded(true);
                      if (older() <= 0) loadNext();
                    }}
                  >
                    {older() > 0 && complete() ? h().showOlder.replace("{count}", String(older())) : h().showOlderUnknown}
                  </Button>
                </Show>
                <Show when={expanded() && (more() || (loaded() && history.error()))}>
                  <Button
                    size="xs"
                    variant="text"
                    loading={loadingOlder()}
                    loadingLabel={h().loadingOlder}
                    onClick={() => (history.error() ? void activity().retry() : loadNext())}
                  >
                    {history.error() ? h().retry : h().showOlderUnknown}
                  </Button>
                </Show>
                <Show when={expanded() && lines().length > RECENT}>
                  <Button size="xs" variant="text" onClick={() => setExpanded(false)}>
                    {h().showLess}
                  </Button>
                </Show>
              </div>
              <Show when={loaded() && history.error()}>
                <p class="filesv2-item-history__line" role="alert">
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  {h().olderFailed}
                </p>
              </Show>
            </Match>
          </Switch>
          <Show when={loaded() && accessWaiting() && lines().length > 0}>
            <p class="sr-only" role="status">
              {h().accessLoading}
            </p>
          </Show>
          <Show when={loaded() && accessFailed()}>
            <p class="filesv2-item-history__line" role="alert">
              <i class="ti ti-alert-triangle" aria-hidden="true" />
              {h().accessFailed}
              <Button size="xs" variant="text" onClick={retryAccess}>
                {h().retry}
              </Button>
            </p>
          </Show>
        </div>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
