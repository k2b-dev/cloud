import { children, createEffect, createSignal, createUniqueId, type JSX, on, onCleanup, Show, splitProps } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { useChatMessages } from "../chat/chat-messages";
import { LoadMore } from "../content/LoadMore";
import { MarkdownEditor } from "../inputs/markdown/MarkdownEditor";
import { useUiMessages } from "../intl/messages";
import { Section } from "../surfaces/Section";
import { useDetailPanelMessages } from "./detail-panel-messages";

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
  /**
   * Shows only the newest `fold` entries and a "Show n older" toggle above them. Expanded, the toggle reads "Show less"
   * and earlier pages load as usual. Omit it to show every loaded entry.
   */
  fold?: number;
  /** Controls the fold, for example to reveal an older entry; `onExpandedChange` requests a change. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
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

export type DiscussionThreadProps = {
  /** Accessible name of the thread, such as "Comments on line 3". */
  label: string;
  /** The entries, as `Discussion.Item`s. In a thread every entry is flush, with a small avatar, name and time in one line, and the text below. */
  children?: JSX.Element;
  /** Without it the thread is read only: no reply field and no writing. */
  onSubmit?: (message: string) => boolean | void | Promise<boolean | void>;
  /** The reply field's placeholder and the writing field's name, such as "Reply …" or "Comment on line 5 …". */
  placeholder?: string;
  /** A quiet line beside the buttons while writing, such as who will see the comment and when. */
  hint?: JSX.Element;
  /** Label of the button that posts, such as "Comment". */
  submitLabel: string;
  cancelLabel?: string;
  /** Whether the writing field is open; omit to let the thread manage it. */
  writing?: boolean;
  onWritingChange?: (writing: boolean) => void;
  /** Opens with the writing field, such as a new thread on a line. */
  defaultWriting?: boolean;
};

type DiscussionComponent = ((props: DiscussionProps) => JSX.Element) & {
  Composer: (props: DiscussionComposerProps) => JSX.Element;
  List: (props: DiscussionListProps) => JSX.Element;
  Item: (props: DiscussionItemProps) => JSX.Element;
  Thread: (props: DiscussionThreadProps) => JSX.Element;
};

const classNames = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

/** A discussion is a `Section`: the same frame, heading, count, and one action as every topic beside it. */
const DiscussionRoot = (props: DiscussionProps): JSX.Element => {
  const [local, sectionProps] = splitProps(props, ["label", "children", "icon", "count", "actions", "as", "surface", "class"]);

  return (
    <Section
      {...sectionProps}
      class={classNames("k2b-discussion", local.class)}
      data-surface={local.surface ?? "default"}
      title={local.label}
      icon={local.icon || undefined}
      count={local.count}
      actions={local.actions}
      level={local.as === "h2" ? 2 : 3}
      frame={local.surface === "bare" ? "none" : undefined}
    >
      <div class="k2b-discussion__body">{local.children}</div>
    </Section>
  );
};

const DiscussionComposer = (props: DiscussionComposerProps): JSX.Element => {
  const messages = useUiMessages();
  const chatMessages = useChatMessages();
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
      setSubmitError(error instanceof Error ? error.message : chatMessages().couldNotPostMessage);
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
            // The error belongs to the submitted text; any edit, including clearing it, makes it stale.
            if (value !== message()) setSubmitError(null);
            setMessage(value);
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
            label={local.submitLabel ?? chatMessages().postMessage}
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
  const chatMessages = useChatMessages();
  const foldMessages = useDetailPanelMessages();
  const [internalExpanded, setInternalExpanded] = createSignal(false);
  const expanded = () => props.expanded ?? internalExpanded();
  const setExpanded = (next: boolean) => {
    if (props.expanded === undefined) setInternalExpanded(next);
    props.onExpandedChange?.(next);
  };
  const resolved = children(() => props.children);
  const entries = () => resolved.toArray();
  const hidden = () => (props.fold !== undefined && !expanded() ? Math.max(0, entries().length - props.fold) : 0);
  const folded = () => props.fold !== undefined && entries().length > props.fold;
  const visible = () => (hidden() > 0 ? entries().slice(hidden()) : entries());
  const [loadingMoreInternally, setLoadingMoreInternally] = createSignal(false);
  let listRef: HTMLOListElement | undefined;
  let adjustmentFrame: number | undefined;
  let active = true;

  const loadingMore = () => Boolean(props.loadingMore || loadingMoreInternally());

  /** Loads earlier entries above the list and keeps the entries in view where they were. */
  const loadEarlier = async (): Promise<boolean> => {
    if (!props.onLoadMore) return false;
    const owner = listRef ? scrollOwner(listRef) : null;
    const previousScrollHeight = owner?.scrollHeight ?? 0;
    setLoadingMoreInternally(true);
    let loaded = false;
    try {
      loaded = (await props.onLoadMore()) !== false;
    } finally {
      if (active) setLoadingMoreInternally(false);
    }
    if (!active || !loaded || !owner) return loaded;
    queueMicrotask(() => {
      if (!active) return;
      adjustmentFrame = requestAnimationFrame(() => {
        if (!active) return;
        owner.scrollTop += owner.scrollHeight - previousScrollHeight;
      });
    });
    return true;
  };

  onCleanup(() => {
    active = false;
    if (adjustmentFrame !== undefined) cancelAnimationFrame(adjustmentFrame);
  });

  return (
    <div class={classNames("k2b-discussion__list-region", props.class)} aria-busy={props.loading || loadingMore() ? "true" : undefined}>
      <Show when={props.loading}>
        <p class="k2b-discussion__status" role="status">
          <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" /> {props.loadingLabel ?? chatMessages().loadingMessages}
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
      {/* The toggle stays above the entries in both states, so nothing above it moves. A failed refresh keeps it:
          the entries it folds are still there. */}
      <Show when={folded() && !props.loading}>
        <button type="button" class="k2b-discussion__fold" aria-expanded={hidden() === 0} onClick={() => setExpanded(hidden() > 0)}>
          <i class={`ti ${hidden() > 0 ? "ti-chevron-down" : "ti-chevron-up"}`} aria-hidden="true" />
          {hidden() > 0 ? foldMessages().showOlder({ count: hidden() }) : foldMessages().showLess}
        </button>
      </Show>
      {/* Earlier entries load above the list, with the shared edge; while folded, the toggle reveals them first. */}
      <Show when={props.onLoadMore && props.hasMore && hidden() === 0 && !props.loading && !props.error}>
        <LoadMore
          side="start"
          class="k2b-discussion__load-more"
          hasMore
          count={entries().length}
          loading={props.loadingMore}
          onLoadMore={loadEarlier}
          label={props.loadMoreLabel ?? chatMessages().loadEarlier}
          loadingLabel={props.loadingLabel ?? chatMessages().loadingMessages}
          errorLabel={chatMessages().couldNotLoadEarlierMessages}
        />
      </Show>
      <ol ref={listRef} class="k2b-discussion__list">
        {visible()}
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
          <Show when={local.meta !== undefined}>
            <span class="k2b-discussion__meta">{local.meta}</span>
          </Show>
          {/* Times end on the panel's trailing edge; item actions sit just before them. */}
          <Show when={local.actions !== undefined}>
            <div class="k2b-discussion__item-actions" data-visibility={local.actionVisibility ?? "progressive"}>
              {local.actions}
            </div>
          </Show>
          <Show when={local.timestamp !== undefined}>
            <span class="k2b-discussion__timestamp">{local.timestamp}</span>
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

/** Line height of thread text: a short comment and the reply line are as high as the writing field. */
const THREAD_LINE = 19;

/**
 * A compact thread, as beside a line of code: no surface, one line at the start that turns into the focus colour while
 * writing, every entry flush with the others, and a real "Reply …" field as its last line. Focus or the first
 * character opens the writing field in the same place; it is exactly as high as a short comment with the reply line,
 * so posting changes no height.
 */
const DiscussionThread = (props: DiscussionThreadProps): JSX.Element => {
  const messages = useUiMessages();
  const chatMessages = useChatMessages();
  const fieldId = `k2b-discussion-thread-${createUniqueId()}`;
  const [internalWriting, setInternalWriting] = createSignal(props.defaultWriting ?? false);
  const writing = () => props.writing ?? internalWriting();
  const setWriting = (next: boolean) => {
    if (props.writing === undefined) setInternalWriting(next);
    props.onWritingChange?.(next);
  };
  const [text, setText] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  let thread: HTMLDivElement | undefined;
  let field: HTMLTextAreaElement | undefined;

  // The field grows with its text and keeps one line more than it holds, the header line of the comment it becomes.
  const fit = () => {
    if (!field) return;
    // Measured without the minimum, which would count as a line of text.
    field.style.minHeight = "0px";
    field.style.height = "0px";
    const lines = Math.max(1, Math.round(field.scrollHeight / THREAD_LINE));
    field.style.minHeight = "";
    field.style.height = `${(lines + 1) * THREAD_LINE}px`;
  };
  createEffect(
    on(writing, (open) => {
      if (!open) return;
      queueMicrotask(() => {
        if (!field) return;
        fit();
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
      });
    }),
  );

  const close = () => {
    setText("");
    setFailed(null);
    setWriting(false);
    // The field leaves; the focus stays on the thread instead of falling back to the page.
    queueMicrotask(() => {
      if (thread && !thread.contains(document.activeElement)) thread.focus({ preventScroll: true });
    });
  };
  const submit = async () => {
    const message = text().trim();
    if (!message || submitting() || !props.onSubmit) return;
    setSubmitting(true);
    setFailed(null);
    try {
      if ((await props.onSubmit(message)) !== false) close();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : chatMessages().couldNotPostMessage);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={thread}
      class="k2b-discussion-thread"
      role="group"
      aria-label={props.label}
      tabIndex={-1}
      data-writing={writing() ? "" : undefined}
    >
      <ol class="k2b-discussion-thread__list">{props.children}</ol>
      <Show when={props.onSubmit}>
        <Show
          when={writing()}
          fallback={
            <input
              type="text"
              class="k2b-discussion-thread__reply"
              placeholder={props.placeholder}
              aria-label={props.placeholder}
              autocomplete="off"
              value=""
              onFocus={() => setWriting(true)}
              onInput={(event) => {
                // The first character opens the writing field and moves there.
                setText(event.currentTarget.value);
                event.currentTarget.value = "";
                setWriting(true);
              }}
            />
          }
        >
          <form
            class="k2b-discussion-thread__compose"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <textarea
              ref={field}
              id={fieldId}
              class="k2b-discussion-thread__field"
              placeholder={props.placeholder}
              aria-label={props.placeholder}
              aria-invalid={failed() ? "true" : undefined}
              aria-describedby={`${fieldId}-status`}
              value={text()}
              disabled={submitting()}
              onInput={(event) => {
                setText(event.currentTarget.value);
                if (failed()) setFailed(null);
                fit();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div class="k2b-discussion-thread__actions">
              {/* The status line is always there: the hint, or why posting failed. */}
              <p
                id={`${fieldId}-status`}
                class="k2b-discussion-thread__status"
                role={failed() ? "alert" : undefined}
                data-tone={failed() ? "danger" : undefined}
              >
                {failed() ?? props.hint}
              </p>
              <Button type="button" variant="ghost" size="sm" disabled={submitting()} onClick={close}>
                {props.cancelLabel ?? messages().cancel}
              </Button>
              <Button type="submit" variant="primary" size="sm" loading={submitting()} disabled={!text().trim()}>
                {failed() ? messages().retry : props.submitLabel}
              </Button>
            </div>
          </form>
        </Show>
      </Show>
    </div>
  );
};

const Discussion = DiscussionRoot as DiscussionComponent;
Discussion.Composer = DiscussionComposer;
Discussion.List = DiscussionList;
Discussion.Item = DiscussionItem;
Discussion.Thread = DiscussionThread;

export default Discussion;
