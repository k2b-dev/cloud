import { createEffect, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show, splitProps } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { MarkdownEditor } from "../inputs/markdown/MarkdownEditor";
import { useUiMessages } from "../intl/messages";

export type DiscussionProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class"> & {
  label: JSX.Element;
  children: JSX.Element;
  icon?: string | false;
  count?: number;
  actions?: JSX.Element;
  as?: "h2" | "h3";
  surface?: "default" | "bare";
  class?: string;
};

export type DiscussionComposerProps = Omit<JSX.FormHTMLAttributes<HTMLFormElement>, "children" | "class" | "onSubmit"> & {
  label: string;
  onSubmit: (message: string) => boolean | void | Promise<boolean | void>;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  onCancel?: () => void;
  lines?: number;
  class?: string;
};

export type DiscussionListProps = {
  children?: JSX.Element;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreLabel?: string;
  onLoadMore?: () => boolean | void | Promise<boolean | void>;
  class?: string;
};

export type DiscussionItemProps = Omit<JSX.LiHTMLAttributes<HTMLLIElement>, "children" | "class"> & {
  author: JSX.Element;
  children: JSX.Element;
  avatar?: JSX.Element;
  timestamp?: JSX.Element;
  meta?: JSX.Element;
  replyContext?: JSX.Element;
  actions?: JSX.Element;
  actionVisibility?: "always" | "progressive";
  class?: string;
};

type DiscussionComponent = ((props: DiscussionProps) => JSX.Element) & {
  Composer: (props: DiscussionComposerProps) => JSX.Element;
  List: (props: DiscussionListProps) => JSX.Element;
  Item: (props: DiscussionItemProps) => JSX.Element;
};

const classNames = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

const DiscussionRoot = (props: DiscussionProps): JSX.Element => {
  const headingId = `k2b-discussion-${createUniqueId()}`;
  const [local, sectionProps] = splitProps(props, ["label", "children", "icon", "count", "actions", "as", "surface", "class"]);

  return (
    <section
      {...sectionProps}
      class={classNames("k2b-discussion", local.class)}
      data-surface={local.surface ?? "default"}
      aria-labelledby={headingId}
    >
      <header class="k2b-discussion__header">
        <Show when={local.icon !== false && local.icon}>
          {(icon) => (
            <span class="k2b-discussion__icon" aria-hidden="true">
              <i class={icon()} />
            </span>
          )}
        </Show>
        <Show when={local.as === "h2"} fallback={<h3 id={headingId}>{local.label}</h3>}>
          <h2 id={headingId}>{local.label}</h2>
        </Show>
        <Show when={local.count !== undefined}>
          <span class="k2b-discussion__count">{local.count}</span>
        </Show>
        <Show when={local.actions !== undefined}>
          <div class="k2b-discussion__actions">{local.actions}</div>
        </Show>
      </header>
      <div class="k2b-discussion__body">{local.children}</div>
    </section>
  );
};

const DiscussionComposer = (props: DiscussionComposerProps): JSX.Element => {
  const messages = useUiMessages();
  const [local, formProps] = splitProps(props, [
    "label",
    "onSubmit",
    "initialValue",
    "placeholder",
    "submitLabel",
    "cancelLabel",
    "onCancel",
    "lines",
    "class",
  ]);
  const [message, setMessage] = createSignal(local.initialValue ?? "");
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);

  const submit = async () => {
    const normalized = message().trim();
    if (!normalized || submitting()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const accepted = await local.onSubmit(normalized);
      if (accepted !== false) setMessage("");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : messages().couldNotPostMessage);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      {...formProps}
      class={classNames("k2b-discussion__composer", local.class)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div class="k2b-discussion__composer-field" data-has-inset-action="true">
        <MarkdownEditor
          aria-label={local.label}
          value={message}
          onValueChange={(value) => {
            setMessage(value);
            if (value.trim()) setSubmitError(null);
          }}
          placeholder={local.placeholder}
          lines={local.lines ?? 4}
          noToolbar
          showStats={false}
          disabled={submitting()}
          error={submitError() !== null}
          onSubmit={() => void submit()}
        />
        <div class="k2b-discussion__composer-inset-action">
          <IconButton
            type="submit"
            label={local.submitLabel ?? messages().postMessage}
            size="sm"
            variant="primary"
            loading={submitting()}
            disabled={submitting() || !message().trim()}
          >
            <i class="ti ti-send" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <Show when={submitError()}>
        {(error) => (
          <p class="k2b-discussion__status" role="alert">
            {error()}
          </p>
        )}
      </Show>
      <Show when={local.onCancel}>
        {(onCancel) => (
          <footer>
            <Button type="button" variant="ghost" size="xs" disabled={submitting()} onClick={onCancel()}>
              {local.cancelLabel ?? messages().cancel}
            </Button>
          </footer>
        )}
      </Show>
    </form>
  );
};

const scrollOwner = (element: HTMLElement): HTMLElement | null => {
  let parent = element.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    if (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflow === "auto" || style.overflow === "scroll")
      return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
};

const DiscussionList = (props: DiscussionListProps): JSX.Element => {
  const messages = useUiMessages();
  const [loadingMoreInternally, setLoadingMoreInternally] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null);
  const [sentinelVisible, setSentinelVisible] = createSignal(false);
  const [automaticLoadAttempted, setAutomaticLoadAttempted] = createSignal(false);
  let listRef: HTMLOListElement | undefined;
  let sentinelRef: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;
  let adjustmentFrame: number | undefined;
  let active = true;

  const loadingMore = () => Boolean(props.loadingMore || loadingMoreInternally());
  const canLoadMore = () =>
    Boolean(!props.loading && !props.error && !loadMoreError() && props.hasMore && props.onLoadMore && !loadingMore());

  const loadMore = async (retry = false): Promise<boolean> => {
    if (props.loading || props.error || (!retry && loadMoreError()) || !props.onLoadMore || !props.hasMore || loadingMore()) return false;
    const owner = listRef ? scrollOwner(listRef) : null;
    const previousScrollHeight = owner?.scrollHeight ?? 0;
    setLoadMoreError(null);
    setLoadingMoreInternally(true);
    let loaded = false;
    try {
      loaded = (await props.onLoadMore()) !== false;
    } catch (error) {
      if (active) setLoadMoreError(error instanceof Error ? error.message : messages().couldNotLoadEarlierMessages);
    } finally {
      if (active) setLoadingMoreInternally(false);
    }
    if (!active || !loaded || !owner) return false;
    queueMicrotask(() => {
      if (!active) return;
      adjustmentFrame = requestAnimationFrame(() => {
        if (!active) return;
        owner.scrollTop += owner.scrollHeight - previousScrollHeight;
      });
    });
    return true;
  };

  createEffect(() => {
    if (!sentinelVisible()) {
      setAutomaticLoadAttempted(false);
      return;
    }
    if (automaticLoadAttempted() || !canLoadMore()) return;
    setAutomaticLoadAttempted(true);
    void loadMore();
  });

  onMount(() => {
    if (typeof IntersectionObserver === "undefined" || !sentinelRef) return;
    observer = new IntersectionObserver(
      (entries) => {
        setSentinelVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "160px 0px 0px" },
    );
    observer.observe(sentinelRef);
  });

  onCleanup(() => {
    active = false;
    observer?.disconnect();
    if (adjustmentFrame !== undefined) cancelAnimationFrame(adjustmentFrame);
  });

  return (
    <div class={classNames("k2b-discussion__list-region", props.class)} aria-busy={props.loading || loadingMore() ? "true" : undefined}>
      <div ref={sentinelRef} class="k2b-discussion__sentinel" aria-hidden="true" />
      <Show when={props.loading}>
        <p class="k2b-discussion__status" role="status">
          <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" /> {props.loadingLabel ?? messages().loadingMessages}
        </p>
      </Show>
      <Show when={props.error}>
        {(error) => (
          <div class="k2b-discussion__status" role="alert">
            <span>{error()}</span>
            <Show when={props.onRetry}>
              <button type="button" onClick={props.onRetry}>
                {messages().retry}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={loadMoreError()}>
        {(error) => (
          <div class="k2b-discussion__status" role="alert">
            <span>{error()}</span>
            <button type="button" onClick={() => void loadMore(true)}>
              {messages().retry}
            </button>
          </div>
        )}
      </Show>
      <Show when={!props.loading && !props.error && !loadMoreError() && (canLoadMore() || loadingMore())}>
        <button type="button" class="k2b-discussion__load-more" disabled={loadingMore()} onClick={() => void loadMore()}>
          <i class={`ti ${loadingMore() ? "ti-loader-2 k2b-spin" : "ti-history"}`} aria-hidden="true" />
          {loadingMore() ? (props.loadingLabel ?? messages().loadingMessages) : (props.loadMoreLabel ?? messages().loadEarlier)}
        </button>
      </Show>
      <ol ref={listRef} class="k2b-discussion__list">
        {props.children}
      </ol>
    </div>
  );
};

const DiscussionItem = (props: DiscussionItemProps): JSX.Element => {
  const [local, itemProps] = splitProps(props, [
    "author",
    "children",
    "avatar",
    "timestamp",
    "meta",
    "replyContext",
    "actions",
    "actionVisibility",
    "class",
  ]);
  return (
    <li
      {...itemProps}
      class={classNames("k2b-discussion__item", local.class)}
      data-has-avatar={local.avatar !== undefined ? "true" : undefined}
    >
      <Show when={local.avatar !== undefined}>
        <div class="k2b-discussion__avatar">{local.avatar}</div>
      </Show>
      <div class="k2b-discussion__entry">
        <header>
          <strong>{local.author}</strong>
          <Show when={local.timestamp !== undefined}>
            <span class="k2b-discussion__timestamp">{local.timestamp}</span>
          </Show>
          <Show when={local.meta !== undefined}>
            <span class="k2b-discussion__meta">{local.meta}</span>
          </Show>
          <Show when={local.actions !== undefined}>
            <div class="k2b-discussion__item-actions" data-visibility={local.actionVisibility ?? "progressive"}>
              {local.actions}
            </div>
          </Show>
        </header>
        <Show when={local.replyContext !== undefined}>
          <div class="k2b-discussion__reply-context">{local.replyContext}</div>
        </Show>
        <div class="k2b-discussion__content">{local.children}</div>
      </div>
    </li>
  );
};

const Discussion = DiscussionRoot as DiscussionComponent;
Discussion.Composer = DiscussionComposer;
Discussion.List = DiscussionList;
Discussion.Item = DiscussionItem;

export default Discussion;
