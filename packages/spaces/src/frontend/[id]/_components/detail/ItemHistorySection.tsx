import { type DateContext, dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Bar, Button, Failed, Loading, Row, Section } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { shouldInvalidateSpacesDetail, subscribeToSpacesDataInvalidation } from "../workspace/workspace-events";

/** The newest entries first; older ones wait behind one click, one bounded page at a time. */
const PAGE_SIZE = 20;
const COLLAPSED = 4;

type Props = {
  spaceId: string;
  itemId: string;
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

/** What happened to this item, and who or what did it. Mount it once per item, so no other item's rows show here. */
export default function ItemHistorySection(props: Props) {
  const t = useSpaceMessages();
  const [expanded, setExpanded] = createSignal(false);
  /** The history loads only when someone asks for it, so the open item shows without waiting. */
  const [shown, setShown] = createSignal(false);
  const history = query.createInfinite<string, Page, string>({
    source: () => `${props.spaceId}/${props.itemId}`,
    enabled: shown,
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
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["detail"], async ({ itemId }) => {
        // A history nobody opened has nothing to refresh.
        if (shown() && shouldInvalidateSpacesDetail(props.itemId, itemId)) await invalidate();
      }),
  });
  const rows = () => history.pages().flatMap((page) => page.rows);
  const visible = () => (expanded() ? rows() : rows().slice(0, COLLAPSED));
  const more = () => (!expanded() ? rows().length > COLLAPSED || history.hasMore() : history.hasMore());
  const showOlder = () => {
    if (expanded() || rows().length <= COLLAPSED) void history.loadMore();
    setExpanded(true);
  };

  return (
    <Section
      icon="history"
      title={t.history}
      actions={shown() ? undefined : [{ label: t.historyShow, icon: "history", onClick: () => setShown(true) }]}
    >
      <Show when={shown()}>
        <Show when={history.pages().length || !history.loading()} fallback={<Loading rows={2} lines={2} />}>
          <For each={visible()}>
            {(row) => (
              <Row
                icon={row.icon.replace(/^ti\s+ti-/, "")}
                lines={[row.sentence, dates.formatDateTime(row.at, props.dateConfig)]}
                href={row.origin?.href ?? undefined}
                action={row.origin?.runHref ? { label: t.historyOpenRun, href: row.origin.runHref } : undefined}
              />
            )}
          </For>
          <Show when={history.error()}>
            <Failed text={t.historyFailed} onRetry={() => void history.refresh()} />
          </Show>
          <Show when={more() && !history.error()}>
            <Bar
              end={
                <Button variant="ghost" busy={history.loadingMore()} onClick={showOlder}>
                  {t.historyOlder}
                </Button>
              }
            />
          </Show>
        </Show>
      </Show>
    </Section>
  );
}
