import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { useFeedMessages } from "./feed-messages";

/** Distance in px before the edge comes into view at which the next page is requested. */
const REACH = 240;

export type LoadMoreProps = {
  /** More items follow the loaded ones. Without it, the edge shows nothing. */
  hasMore: boolean;
  /**
   * Loads the next page. A returned promise keeps the edge busy until it settles, and a rejection shows its message
   * with "Try again". Resolve to `false` when nothing loaded; the edge then waits until the reader comes back to it.
   */
  onLoadMore: () => unknown;
  /** The owner loads the next page right now, also one it started itself. */
  loading?: boolean;
  /** The owner's last load failed with this message. "Try again" calls `onLoadMore`. */
  error?: string | null;
  /**
   * Loads by itself when the edge comes within reach of the visible area, in its own scroll area or in the window.
   * Defaults to true. With false, the owner decides when to load, and the button stays.
   */
  auto?: boolean;
  /** Where the next items appear: below the edge's list (`"end"`, the default) or above it (`"start"`). */
  side?: "end" | "start";
  /**
   * Number of loaded items. A page counts as arrived when it changed; without it, when the list grew in its parent
   * element. Pass it when new items can fit into space the list already takes, such as a table that fills its height.
   */
  count?: number;
  /** Text of the button. Defaults to "Load more". */
  label?: string;
  /** Text while loading. Defaults to "Loading more…". */
  loadingLabel?: string;
  /** Text when a load failed without its own message. Defaults to "Could not load more.". */
  errorLabel?: string;
  class?: string;
};

const isPromise = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";

/**
 * The edge of a list that loads more: one row of fixed height that reads "Load more", "Loading more…", or the error
 * with "Try again", so the list around it never moves. It loads by itself when it comes within reach, once per
 * approach: a page that arrives while the edge is still in reach asks for the next one, a declined or failed request
 * waits for the reader.
 */
export function LoadMore(props: LoadMoreProps): JSX.Element {
  const messages = useFeedMessages();
  const uiMessages = useUiMessages();
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  let root: HTMLDivElement | undefined;
  let reach: HTMLSpanElement | undefined;
  let observer: IntersectionObserver | undefined;
  /** A request the owner has not answered yet. It holds until the owner answers or the edge leaves reach. */
  let requested = false;
  /** The list's progress when the last request went out. */
  let progressAtRequest = -1;
  let disposed = false;

  const loading = () => Boolean(props.loading) || pending();
  const error = () => failure() ?? props.error ?? null;
  const reasonOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : null);
  /** The item count, or else where the edge sits plus how tall its parent's content is: both grow with the list. */
  const progress = () => props.count ?? (root ? root.offsetTop + (root.parentElement?.scrollHeight ?? 0) : 0);

  /**
   * Asks the observer again, so an edge that is still in reach loads once more. Only after the list grew: a page that
   * brought nothing waits for the reader, so an owner that keeps answering empty pages is not asked in a loop.
   */
  const recheck = () => {
    if (!observer || !reach || progress() === progressAtRequest) return;
    requested = false;
    observer.unobserve(reach);
    observer.observe(reach);
  };

  const load = (byReader: boolean) => {
    if (!props.hasMore || loading()) return;
    if (!byReader && (requested || error())) return;
    requested = true;
    progressAtRequest = progress();
    setFailure(null);
    let result: unknown;
    try {
      result = props.onLoadMore();
    } catch (cause) {
      requested = false;
      setFailure(reasonOf(cause) ?? props.errorLabel ?? messages().loadMoreFailed);
      return;
    }
    // Without a promise the owner answers through `loading`, `hasMore`, or the reader leaving the edge.
    if (!isPromise(result)) return;
    setPending(true);
    result.then(
      (value) => {
        if (disposed) return;
        setPending(false);
        if (value !== false) recheck();
      },
      (cause: unknown) => {
        if (disposed) return;
        setPending(false);
        requested = false;
        setFailure(reasonOf(cause) ?? props.errorLabel ?? messages().loadMoreFailed);
      },
    );
  };

  // The owner finished a load it reports through `loading`, or found more again: the edge may ask once more.
  createEffect(
    on([() => Boolean(props.loading), () => props.hasMore], ([busy, more], previous) => {
      if (!previous) return;
      if (previous[0] && !busy) recheck();
      // More items again, for example after the list was replaced: a new approach.
      else if (!previous[1] && more) {
        progressAtRequest = -1;
        recheck();
      }
    }),
  );

  onMount(() => {
    if (props.auto === false || typeof IntersectionObserver === "undefined" || !reach) return;
    // The viewport root sees the edge through every scroll area around it. The reach strip reaches ahead of the edge
    // inside a scroll area; the margin does the same for the window.
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting) load(false);
        // Leaving reach re-arms a request the owner declined.
        else requested = false;
      },
      { rootMargin: `${REACH}px 0px` },
    );
    observer.observe(reach);
  });

  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
  });

  return (
    <div
      ref={root}
      class={props.class ? `k2b-load-more ${props.class}` : "k2b-load-more"}
      data-side={props.side ?? "end"}
      data-state={!props.hasMore ? "done" : loading() ? "loading" : error() ? "error" : "idle"}
    >
      <span ref={reach} class="k2b-load-more__reach" style={{ "--k2b-load-more-reach": `${REACH}px` }} aria-hidden="true" />
      <Show when={props.hasMore}>
        <Show when={!loading() && error()}>
          {(message) => (
            <span class="k2b-load-more__error" role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              {message()}
            </span>
          )}
        </Show>
        {/* One button in every state keeps focus where it is while the page loads. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="k2b-load-more__button"
          aria-disabled={loading() ? "true" : undefined}
          onClick={() => load(true)}
        >
          <i
            class={
              loading()
                ? "ti ti-loader-2 k2b-spin"
                : error()
                  ? "ti ti-refresh"
                  : props.side === "start"
                    ? "ti ti-chevron-up"
                    : "ti ti-chevron-down"
            }
            aria-hidden="true"
          />
          {loading() ? (props.loadingLabel ?? messages().loadingMore) : error() ? uiMessages().retry : (props.label ?? messages().loadMore)}
        </Button>
      </Show>
    </div>
  );
}

export default LoadMore;
