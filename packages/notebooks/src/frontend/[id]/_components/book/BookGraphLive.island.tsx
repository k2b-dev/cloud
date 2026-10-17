import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebookWorkspaceMessages } from "../../messages";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, type BookSnapshot } from "./book-state";

type Props = {
  notebookId: string;
  /** The Book address of the graph's note; its snapshot carries the navigation beside the graph. */
  bookHref: string;
};

/**
 * Covers workspace events while the graph stands in the Book shell, where no Book page is open: the Book navigation
 * takes the next snapshot of the graph's note, so renamed, moved, or removed pages show without a reload. A grant or
 * note that is gone loads the page again, which then shows the server's answer. A failed update stays visible above
 * the graph with Retry; the event stays unacknowledged, so the live connection also tries again.
 */
export default function BookGraphLive(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [failed, setFailed] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);
  const refresh = async () => {
    try {
      const response = await apiClient[":id"].book.$get({ param: { id: props.notebookId }, query: { href: props.bookHref } });
      if ([401, 403, 404].includes(response.status)) {
        window.location.assign(window.location.href);
        return;
      }
      if (!response.ok) throw new Error(`Book navigation could not be loaded (${response.status})`);
      const { html: _html, ...metadata }: BookSnapshot = await response.json();
      window.dispatchEvent(new CustomEvent<BookMetadata>(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
      setFailed(false);
    } catch (error) {
      setFailed(true);
      throw error;
    }
  };
  const retry = () => {
    setRetrying(true);
    refresh()
      .catch(() => undefined)
      .finally(() => setRetrying(false));
  };
  onMount(() => {
    const onWorkspaceEvent = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
      if (detail.event.notebookId !== props.notebookId) return;
      // Comments and favorites change nothing in the Book navigation.
      if (detail.event.type === "note.comments.changed" || detail.event.type === "note.favorite.changed") detail.cover(Promise.resolve());
      else detail.cover(refresh());
    };
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    onCleanup(() => window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent));
  });
  // Over the graph, not in its flow, so the notice moves nothing when it appears. It starts below the graph's two
  // toolbar rows, so it never covers Close, the search or the filters.
  return (
    <div aria-live="polite" class="pointer-events-none absolute inset-x-0 top-[6.25rem] z-20 flex justify-center px-12">
      <Show when={failed()}>
        <NoticeCard role="alert" tone="danger" title={t().updateLoadFailed} class="pointer-events-auto max-w-md">
          <Button variant="secondary" size="xs" loading={retrying()} onClick={retry}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>
    </div>
  );
}
