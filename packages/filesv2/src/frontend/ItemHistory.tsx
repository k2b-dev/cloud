import { query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, DetailPanel } from "@k2b/ui";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ActivityPage } from "../activity-contracts";
import { HistoryRow, SkeletonRows } from "./ActivityView";
import { type HistoryActions, type HistoryEnvironment, historyRows } from "./history-actions";
import { useHistoryMessages } from "./history-messages";

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
  /** Activity filtered to this item; the link shows only when the parent has such an address. */
  activityHref?: string;
  onChanged?: () => void;
};

/**
 * The item's newest four history rows in its detail, then older rows on request. Repeated editor saves of one
 * person and run read as one row; the count names rows, and only once the whole history is loaded.
 */
export default function ItemHistory(props: ItemHistoryProps) {
  const h = useHistoryMessages();
  const history = query.createInfinite({
    source: () => props.source,
    initial: props.initial?.source === props.source ? { source: props.source, pages: [props.initial.page] } : undefined,
    loadPage: (_source, { cursor, abortSignal }) => props.load(cursor ?? null, abortSignal),
    getNextCursor: (page: ActivityPage) => page.next,
  });
  const [expanded, setExpanded] = createSignal(false);
  const rows = createMemo(() =>
    historyRows(
      history.pages().flatMap((page) => page.items),
      { batches: false },
    ),
  );
  const loaded = () => history.pages().length > 0;
  const complete = () => loaded() && !history.hasMore();
  const shown = () => (expanded() ? rows() : rows().slice(0, RECENT));
  const older = () => rows().length - RECENT;
  const changed = () => {
    void history.refresh();
    props.onChanged?.();
  };
  return (
    <DetailPanel.Group label={h().history}>
      <DetailPanel.Section
        title={h().history}
        icon="ti ti-history"
        tone="neutral"
        count={complete() && rows().length > 0 ? rows().length : undefined}
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
        <div class="filesv2-item-history" aria-busy={history.loading()}>
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
            <Match when={rows().length === 0 && (history.hasMore() || history.error())}>
              <p class="filesv2-item-history__line" role={history.error() ? "alert" : undefined}>
                <Show when={history.error()}>
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                </Show>
                {history.error() ? h().olderFailed : h().nothingVisibleYet}
                <Button
                  size="xs"
                  variant="text"
                  loading={history.loadingMore()}
                  loadingLabel={h().loadingOlder}
                  onClick={() => void (history.hasMore() ? history.loadMore() : history.refresh())}
                >
                  {history.error() ? h().retry : h().showOlderUnknown}
                </Button>
              </p>
            </Match>
            <Match when={rows().length === 0}>
              <p class="filesv2-item-history__line">{h().noEntries}</p>
            </Match>
            <Match when={rows().length > 0}>
              <ul class="filesv2-history-rows">
                <For each={shown()}>
                  {(row) => (
                    <li>
                      {/* A folder includes descendants, so each row names its actual subject. */}
                      <HistoryRow
                        row={row}
                        env={props.env}
                        actions={props.actions}
                        context={props.directory ? "activity" : "item"}
                        directory={props.directory ? undefined : false}
                        dated={false}
                        variant="detail"
                        onChanged={changed}
                      />
                    </li>
                  )}
                </For>
              </ul>
              <div class="filesv2-item-history__more">
                <Show when={!expanded() && (older() > 0 || history.hasMore())}>
                  <Button size="xs" variant="text" onClick={() => setExpanded(true)}>
                    {older() > 0 && !history.hasMore() ? h().showOlder.replace("{count}", String(older())) : h().showOlderUnknown}
                  </Button>
                </Show>
                <Show when={expanded() && (history.hasMore() || (loaded() && history.error()))}>
                  <Button
                    size="xs"
                    variant="text"
                    loading={history.loadingMore()}
                    loadingLabel={h().loadingOlder}
                    onClick={() => void (history.hasMore() ? history.loadMore() : history.refresh())}
                  >
                    {history.error() ? h().retry : h().showOlderUnknown}
                  </Button>
                </Show>
                <Show when={expanded() && rows().length > RECENT}>
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
        </div>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
