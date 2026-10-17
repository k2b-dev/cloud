import { onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
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
 * note that is gone reloads the page, which then shows the server's answer.
 */
export default function BookGraphLive(props: Props) {
  onMount(() => {
    const refresh = async () => {
      const response = await apiClient[":id"].book.$get({ param: { id: props.notebookId }, query: { href: props.bookHref } });
      if ([401, 403, 404].includes(response.status)) {
        window.location.assign(window.location.href);
        return;
      }
      if (!response.ok) throw new Error(`Book navigation could not be loaded (${response.status})`);
      const { html: _html, ...metadata }: BookSnapshot = await response.json();
      window.dispatchEvent(new CustomEvent<BookMetadata>(BOOK_SNAPSHOT_EVENT, { detail: metadata }));
    };
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
  return null;
}
