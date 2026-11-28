import { query } from "@k2b/stdlib/solid";
import { onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import type { RetryToast } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { shouldInvalidateSpacesDetail, subscribeToSpacesDataInvalidation } from "../workspace/workspace-events";
import type { SpaceItemDetail } from "../workspace/workspace-types";

/**
 * The comments of an open item, page by page from the newest, refreshed when someone changes the item. The detail
 * snapshot brings the first page, so nothing loads on the first picture.
 */
export const useItemComments = (props: {
  spaceId: string;
  itemId: () => string;
  target: () => SpaceItemDetail["commentTarget"];
  initialPage: SpaceItemDetail["comments"];
  retryToast: RetryToast;
}) => {
  const t = useSpaceMessages();
  const source = () => `${props.target().itemId}:${props.target().recurrenceId ?? "series"}`;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const loadPage = async (page: number, signal: AbortSignal) => {
    const target = props.target();
    const res = await apiClient[":id"].items[":itemId"].comments.page.$get(
      {
        param: { id: props.spaceId, itemId: target.itemId },
        query: {
          page: String(page),
          per_page: String(props.initialPage.perPage),
          ...(target.recurrenceId ? { recurrence_id: target.recurrenceId } : {}),
        },
      },
      { init: { signal } },
    );
    if (!res.ok) throw new Error(await readResponseError(res, t.commentsRefreshFailed));
    return res.json();
  };
  const comments = query.createInfinite<string, SpaceItemDetail["comments"], number>({
    source,
    initial: { source: source(), pages: [props.initialPage] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const result = await loadPage(page, abortSignal);
      if (result.page !== page) throw new Error(t.invalidCommentsPage);
      return result;
    },
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["detail"], async ({ itemId }) => {
        while (!disposed) {
          if (!shouldInvalidateSpacesDetail(props.itemId(), itemId) && !shouldInvalidateSpacesDetail(props.target().itemId, itemId)) return;
          const requested = source();
          try {
            await invalidate();
            return;
          } catch (error) {
            // Closing or replacing this item removes its coverage obligation.
            if (disposed) return;
            if (requested === source()) throw error;
          }
        }
      }),
  });
  const refresh = (): void => void comments.invalidate().catch(() => props.retryToast(t.commentRefreshAfterSaveFailed, t.retry, refresh));
  /** Every loaded page as one list, each comment once, with the newest total. */
  const page = () => {
    const pages = comments.pages();
    const first = pages[0] ?? props.initialPage;
    const last = pages.at(-1) ?? first;
    const seen = new Set<string>();
    const items = pages
      .flatMap((entry) => entry.items)
      .filter((comment) => {
        if (seen.has(comment.id)) return false;
        seen.add(comment.id);
        return true;
      });
    return { ...last, items, total: Math.max(first.total, last.total) };
  };
  return { query: comments, page, refresh };
};
