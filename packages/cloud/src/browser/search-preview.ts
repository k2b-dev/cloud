import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { BoundBlockView } from "../blocks/schema";
import type { CloudResourceRef } from "../contracts";

/** What the preview column shows for the active hit: its reader's view, or the search facts when there is none. */
export type SearchPreviewState = { state: "idle" } | { state: "loading" } | { state: "view"; view: BoundBlockView } | { state: "facts" };

/** Arrow keys move fast through hits; only a hit the person rests on asks its reader. */
export const SEARCH_PREVIEW_DELAY_MS = 150;

const key = (ref: CloudResourceRef) => `${ref.type}\u0000${ref.id}`;

/**
 * Loads the reader view of the active search hit through `/api/search/preview`, as the person: after a short delay,
 * cancelling the previous request, and kept for as long as the dialog is open. Without a reader, on an error, a
 * timeout or without access the column keeps the search facts, so a missing view never blanks it.
 */
export function createSearchPreview(ref: Accessor<CloudResourceRef | undefined>): Accessor<SearchPreviewState> {
  const cache = new Map<string, BoundBlockView | null>();
  const [state, setState] = createSignal<SearchPreviewState>({ state: "idle" });
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    request?.abort();
    request = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  createEffect(() => {
    const current = ref();
    stop();
    if (!current) return setState({ state: "idle" });
    const cached = cache.get(key(current));
    if (cached !== undefined) return setState(cached ? { state: "view", view: cached } : { state: "facts" });
    setState({ state: "loading" });
    timer = setTimeout(() => {
      const controller = new AbortController();
      request = controller;
      const query = new URLSearchParams({ type: current.type, id: current.id });
      void fetch(`/api/search/preview?${query}`, { signal: controller.signal, credentials: "same-origin" })
        .then(async (response) => (response.ok ? (((await response.json()) as { view?: BoundBlockView | null }).view ?? null) : null))
        .catch(() => (controller.signal.aborted ? undefined : null))
        .then((view) => {
          if (view === undefined || controller.signal.aborted) return;
          cache.set(key(current), view);
          setState(view ? { state: "view", view } : { state: "facts" });
        });
    }, SEARCH_PREVIEW_DELAY_MS);
  });
  onCleanup(stop);
  return state;
}
