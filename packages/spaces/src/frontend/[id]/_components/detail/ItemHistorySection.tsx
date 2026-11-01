import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, Skeleton } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

/** The newest entries first; older ones wait behind one click, one bounded page at a time. */
const PAGE_SIZE = 20;
const COLLAPSED = 4;

type Props = {
  spaceId: string;
  itemId: string;
  /** A newer edit reloads the history. */
  version: string;
  dateConfig?: DateContext;
};

type Row = {
  id: string;
  at: string;
  icon: string;
  sentence: string;
  origin?: { name: string; href: string | null; runHref: string | null };
};
type Page = { rows: Row[]; nextCursor: string | null };

/** Puts the origin's link around its name inside the worded sentence, so every language keeps its own word order. */
const withOriginLink = (sentence: string, origin: Row["origin"]): JSX.Element => {
  const at = origin?.href ? sentence.indexOf(origin.name) : -1;
  if (!origin || at < 0) return sentence;
  return (
    <>
      {sentence.slice(0, at)}
      <a class="k2b-link" href={origin.href ?? undefined}>
        {origin.name}
      </a>
      {sentence.slice(at + origin.name.length)}
    </>
  );
};

/** What happened to this item, and who or what did it. Mount it once per item, so no other item's rows show here. */
export default function ItemHistorySection(props: Props) {
  const t = useSpaceMessages();
  const [expanded, setExpanded] = createSignal(false);
  const history = query.createInfinite<string, Page, string>({
    source: () => `${props.spaceId}/${props.itemId}`,
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].activity.$get(
        { param: { id: props.spaceId, itemId: props.itemId }, query: { limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.historyFailed));
      const page = await response.json();
      return { rows: page.data.map((entry) => entry.row), nextCursor: page.nextCursor };
    },
    getNextCursor: (page) => page.nextCursor,
  });
  createEffect(
    on(
      () => props.version,
      () => void history.invalidate().catch(() => undefined),
      { defer: true },
    ),
  );
  const rows = () => history.pages().flatMap((page) => page.rows);
  const visible = () => (expanded() ? rows() : rows().slice(0, COLLAPSED));
  const more = () => (!expanded() ? rows().length > COLLAPSED || history.hasMore() : history.hasMore());
  const showOlder = () => {
    if (expanded() || rows().length <= COLLAPSED) void history.loadMore();
    setExpanded(true);
  };

  return (
    <DetailPanel.Section title={t.history}>
      <Show
        when={history.pages().length || !history.loading()}
        fallback={
          <div class="grid gap-2" role="status" aria-label={t.history}>
            <Skeleton class="h-3 w-4/5" />
            <Skeleton class="h-3 w-3/5" />
          </div>
        }
      >
        <ul class="grid gap-2">
          <For each={visible()}>
            {(row) => (
              <li class="flex items-start gap-2 text-sm">
                <i class={`${row.icon} mt-0.5 text-dimmed`} aria-hidden="true" />
                <span class="min-w-0">
                  {withOriginLink(row.sentence, row.origin)}
                  <span class="block text-xs text-dimmed">
                    {dates.formatDateTime(row.at, props.dateConfig)}
                    <Show when={row.origin?.runHref}>
                      {(href) => (
                        <>
                          {" · "}
                          <a class="k2b-link" href={href()}>
                            {t.historyOpenRun}
                          </a>
                        </>
                      )}
                    </Show>
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={history.error()}>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-sm text-dimmed" role="alert">
            <span>{t.historyFailed}</span>
            <Button size="sm" variant="secondary" type="button" onClick={() => void history.refresh()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t.historyRetry}
            </Button>
          </div>
        </Show>
        <Show when={more()}>
          <Button class="mt-2 w-fit" size="sm" variant="ghost" type="button" loading={history.loadingMore()} onClick={showOlder}>
            {t.historyOlder}
          </Button>
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}
