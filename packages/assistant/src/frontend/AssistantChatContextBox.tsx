import type { AiProject } from "@k2b/cloud/ai";
import { conversationFileSource } from "@k2b/cloud/ai/solid";
import { Button, formatFileViewSize, IconButton, IconButtonLink, ResizeSeparator, Skeleton, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show, untrack } from "solid-js";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { type ChatSidebarState, createReadingFreeze } from "./AssistantChatSidebar";
import {
  buildContextBoxModel,
  type ContextBoxGroup,
  type ContextBoxJump,
  type ContextBoxOpen,
  type ContextBoxRow,
  contextBoxPending,
} from "./chat-context-box";
import { createChatContextHost } from "./chat-sidebar-layout";
import { chatSidebarMessages } from "./chat-sidebar-messages";

export type ContextBoxActions = {
  /** Opens a row's thing as a tab, or jumps to it in the chat. */
  onOpen: (open: Exclude<ContextBoxOpen, { kind: "none" }>) => void;
  onJump: (target: ContextBoxJump) => void;
  /** The whole list with search: the tab "In this chat". */
  onOpenAll: () => void;
  onOpenSources: () => void;
  onOpenContext: () => void;
};

const useCopy = () => {
  const locale = useLocale();
  return () => chatSidebarMessages.resolve([locale()]).t;
};

/**
 * Holds what the box shows while the person reads it (`frozen`): new results only raise "New · n" in the head, and a
 * click on it takes them over. Never holds the snapshot of another chat.
 */
export const createHeldContextSnapshot = (live: Accessor<AssistantChatContextSnapshot | null>, frozen: Accessor<boolean>) => {
  const [held, setHeld] = createSignal<AssistantChatContextSnapshot | null>(null);
  createEffect(on(frozen, (value) => setHeld(value ? untrack(live) : null)));
  const shown = createMemo(() => {
    const current = live();
    const kept = held();
    return kept && current && kept.chatId === current.chatId ? kept : current;
  });
  const sameChat = () => {
    const kept = held();
    const current = live();
    return kept && current && kept !== current && kept.chatId === current.chatId ? { kept, current } : null;
  };
  const pending = createMemo(() => {
    const pair = sameChat();
    return pair ? contextBoxPending(pair.kept, pair.current) : 0;
  });
  /** Anything else changed meanwhile, such as sources or the context. */
  const changed = createMemo(() => {
    const pair = sameChat();
    if (!pair) return false;
    const content = (snapshot: AssistantChatContextSnapshot) => JSON.stringify({ ...snapshot, now: null });
    return content(pair.kept) !== content(pair.current);
  });
  return { shown, pending, changed, apply: () => setHeld(frozen() ? live() : null) };
};

function BoxRow(props: { row: ContextBoxRow; actions: ContextBoxActions; downloadHref: (path: string) => string | undefined }) {
  const copy = useCopy();
  const open = () => {
    const target = props.row.open;
    if (target.kind !== "none") props.actions.onOpen(target);
  };
  const label = () =>
    props.row.open.kind === "jump" ? copy().jumpRow({ title: props.row.title }) : copy().openRow({ title: props.row.title });
  return (
    <li class="assistant-context-box__row" data-attention={props.row.attention ? "" : undefined} data-row={props.row.key}>
      <button
        type="button"
        class="assistant-context-box__main"
        title={props.row.tooltip}
        aria-label={`${label()}, ${props.row.trailing}`}
        disabled={props.row.open.kind === "none"}
        onClick={open}
      >
        <Show when={props.row.tile} fallback={<i class={`assistant-context-box__icon ${props.row.icon}`} aria-hidden="true" />}>
          {(tile) => (
            <span
              class="assistant-context-box__tile"
              style={tile().accent ? { "--assistant-context-box-accent": tile().accent } : undefined}
              aria-hidden="true"
            >
              <i class={props.row.icon} />
            </span>
          )}
        </Show>
        <span class="assistant-context-box__title k2b-truncate-fade">{props.row.title}</span>
        <span class="assistant-context-box__trailing" data-tone={props.row.tone}>
          {props.row.trailing}
        </span>
      </button>
      <Show when={props.row.hover}>
        {(hover) => (
          <span class="assistant-context-box__act">
            {(() => {
              const action = hover();
              if (action.kind === "download")
                return (
                  <IconButtonLink
                    size="xs"
                    variant="ghost"
                    href={props.downloadHref(action.path) ?? "#"}
                    download={action.name}
                    label={copy().downloadNamedShort({ name: action.name })}
                    tooltip={copy().download}
                  >
                    <i class="ti ti-download" aria-hidden="true" />
                  </IconButtonLink>
                );
              if (action.kind === "jump")
                return (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    label={copy().jumpRow({ title: props.row.title })}
                    tooltip={copy().showInChat}
                    onClick={() => props.actions.onJump(action.target)}
                  >
                    <i class="ti ti-corner-left-up" aria-hidden="true" />
                  </IconButton>
                );
              return (
                <IconButtonLink size="xs" variant="ghost" href={action.href} label={action.label} tooltip={action.label}>
                  <i class={action.icon} aria-hidden="true" />
                </IconButtonLink>
              );
            })()}
          </span>
        )}
      </Show>
    </li>
  );
}

function BoxGroup(props: {
  group: ContextBoxGroup;
  actions: ContextBoxActions;
  downloadHref: (path: string) => string | undefined;
  onAll: () => void;
}) {
  const copy = useCopy();
  const [unfolded, setUnfolded] = createSignal(false);
  return (
    <section class="assistant-context-box__group" aria-label={props.group.label} data-group={props.group.key}>
      <h3 class="assistant-context-box__label">
        <span>{props.group.label}</span>
        <Show when={props.group.count > 0}>
          <span class="assistant-context-box__count">{props.group.count}</span>
        </Show>
        <Show when={props.group.more}>
          <button
            type="button"
            class="assistant-context-box__all"
            aria-label={copy().boxShowAllNamed({ label: props.group.label })}
            onClick={props.onAll}
          >
            {copy().boxShowAll}
          </button>
        </Show>
      </h3>
      <Show when={props.group.rows.length} fallback={<p class="assistant-context-box__none">{copy().boxNone}</p>}>
        <ul class="assistant-context-box__rows">
          <For each={unfolded() ? [...props.group.rows, ...(props.group.rest ?? [])] : props.group.rows}>
            {(row) => <BoxRow row={row} actions={props.actions} downloadHref={props.downloadHref} />}
          </For>
        </ul>
      </Show>
      <Show when={!unfolded() && props.group.rest?.length}>
        {(count) => (
          <button
            type="button"
            class="assistant-context-box__unfold"
            onClick={(event) => {
              // The button leaves; the focus goes on to the first row it unfolded.
              const list = event.currentTarget.previousElementSibling;
              setUnfolded(true);
              list?.querySelectorAll<HTMLElement>(".assistant-context-box__main")[props.group.rows.length]?.focus();
            }}
          >
            {copy().boxMore({ count: count() })}
          </button>
        )}
      </Show>
    </section>
  );
}

/**
 * "In this chat": a column docked beside the chat while there is room (or a drawer over it), and the content of a
 * sheet on phones. One row per thing, at most ten rows, in sections between hairlines; a click opens the thing as a
 * tab. While the pointer or focus is inside, it keeps what the person reads and collects news behind "New · n".
 */
export function AssistantChatContextBox(props: {
  state: ChatSidebarState;
  actions: ContextBoxActions;
  project?: AiProject | null;
  frozen: Accessor<boolean>;
  variant: "column" | "sheet";
  headingId?: string;
  headingRef?: (element: HTMLHeadingElement) => void;
  handlers?: JSX.HTMLAttributes<HTMLElement>;
  /** Closes the column or the drawer; the sheet closes itself. */
  onClose?: () => void;
}) {
  const copy = useCopy();
  const locale = useLocale();
  const held = createHeldContextSnapshot(props.state.snapshot, props.frozen);
  const files = createMemo(() => {
    const chatId = held.shown()?.chatId;
    return chatId ? conversationFileSource("/api/ai", chatId) : null;
  });
  const downloadHref = (path: string) => files()?.downloadHref?.(path) ?? undefined;
  // The chat whose box showed content in this page view; its box keeps its lines when that content goes.
  const [filledChat, setFilledChat] = createSignal<string | null>(null);
  const model = createMemo(() => {
    const snapshot = held.shown();
    if (!snapshot) return null;
    const t = copy();
    return buildContextBoxModel(snapshot, {
      filled: untrack(filledChat) === snapshot.chatId,
      locale: locale(),
      // Whole kilobytes keep the place at the row's end narrow.
      formatSize: (bytes) => formatFileViewSize(bytes < 1024 * 1024 ? Math.round(bytes / 1024) * 1024 : bytes, locale()),
      project: props.project?.name ?? null,
      copy: {
        results: t.results,
        sourcesSummary: t.boxSourcesSummary,
        contextSummary: t.boxContextSummary,
        contextFallback: t.secrets,
        showInChat: t.showInChat,
      },
    });
  });
  createEffect(() => {
    const chatId = held.shown()?.chatId;
    if (chatId && model()?.empty === false) setFilledChat(chatId);
  });
  const fresh = () => held.pending() > 0 || held.changed();
  return (
    <aside
      class="assistant-context-box"
      data-k2b-primary="ai"
      data-variant={props.variant}
      aria-labelledby={props.headingId}
      aria-label={props.headingId ? undefined : copy().title}
      {...props.handlers}
    >
      <header class="assistant-context-box__head">
        <h2 id={props.headingId} ref={props.headingRef} tabIndex={-1} class="assistant-context-box__heading">
          {copy().title}
        </h2>
        <span class="assistant-context-box__slot">
          {/* Always rendered, so the head keeps its layout when news wait. */}
          <button
            type="button"
            class="assistant-context-box__new"
            data-pending={fresh() ? "true" : undefined}
            aria-hidden={fresh() ? undefined : "true"}
            tabIndex={fresh() ? 0 : -1}
            aria-label={copy().boxShowNew}
            onClick={held.apply}
          >
            {copy().boxNew({ count: held.pending() })}
          </button>
        </span>
        <IconButton
          size="sm"
          variant="ghost"
          label={copy().boxOpenAsTab}
          tooltip={copy().boxOpenAsTab}
          onClick={() => props.actions.onOpenAll()}
        >
          <i class="ti ti-arrows-diagonal" aria-hidden="true" />
        </IconButton>
        <Show when={props.onClose}>
          {(close) => (
            <IconButton
              size="sm"
              variant="ghost"
              class="assistant-context-box__close"
              label={copy().boxClose}
              tooltip={copy().boxClose}
              onClick={() => close()()}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          )}
        </Show>
      </header>
      {/* The sections stand between hairlines that the body draws (one line, one owner). */}
      <div class="assistant-context-box__body k2b-divided">
        <Show
          when={model()}
          fallback={
            <Show
              when={props.state.error()}
              fallback={
                <div class="assistant-context-box__loading" role="status" aria-label={copy().loading}>
                  <Skeleton class="assistant-context-box__skeleton" />
                  <Skeleton class="assistant-context-box__skeleton" />
                  <Skeleton class="assistant-context-box__skeleton" />
                </div>
              }
            >
              <div class="assistant-context-box__failed" role="alert">
                <p>
                  {copy().boxFailed}
                  <span class="assistant-context-box__meta">{copy().boxFailedDetail}</span>
                </p>
                <button type="button" class="assistant-context-box__retry" onClick={() => void props.state.refresh()}>
                  {copy().retry}
                </button>
              </div>
            </Show>
          }
        >
          {(box) => (
            <Show when={!box().empty} fallback={<p class="assistant-context-box__empty">{copy().boxEmpty}</p>}>
              <BoxGroup group={box().results} actions={props.actions} downloadHref={downloadHref} onAll={() => props.actions.onOpenAll()} />
              <For each={box().groups}>
                {(group) => (
                  <BoxGroup group={group} actions={props.actions} downloadHref={downloadHref} onAll={() => props.actions.onOpenAll()} />
                )}
              </For>
              <ul class="assistant-context-box__lines">
                <Show when={box().sources}>
                  {(summary) => (
                    <li class="assistant-context-box__row">
                      <button
                        type="button"
                        class="assistant-context-box__main"
                        title={`${copy().boxSources}: ${summary()}`}
                        onClick={() => props.actions.onOpenSources()}
                      >
                        <i class="assistant-context-box__icon ti ti-world" aria-hidden="true" />
                        <span class="assistant-context-box__title k2b-truncate-fade">
                          <span class="assistant-context-box__key">{copy().boxSources}</span>
                          {summary()}
                        </span>
                      </button>
                    </li>
                  )}
                </Show>
                <Show when={box().context}>
                  {(summary) => (
                    <li class="assistant-context-box__row">
                      <button
                        type="button"
                        class="assistant-context-box__main"
                        title={`${copy().boxContext}: ${summary()}`}
                        onClick={() => props.actions.onOpenContext()}
                      >
                        <i class="assistant-context-box__icon ti ti-adjustments" aria-hidden="true" />
                        <span class="assistant-context-box__title k2b-truncate-fade">
                          <span class="assistant-context-box__key">{copy().boxContext}</span>
                          {summary()}
                        </span>
                      </button>
                    </li>
                  )}
                </Show>
              </ul>
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}

/**
 * The places of "In this chat" in the chat layout: the head row of the chat with its title and the button, and the
 * column with its grip. CSS decides whether the column is docked beside the chat or waits behind the button, so the
 * server's first frame is final; the person may close the docked column. Without room the button opens the same
 * column as a drawer over the chat, and on phones a sheet. Rendered inside `.assistant-chat-layout`.
 */
export function AssistantChatContextPlaces(props: {
  chatId: string | null;
  state: ChatSidebarState;
  actions: ContextBoxActions;
  project?: AiProject | null;
  /** The chat's title, for the chat's head row. */
  title?: string | null;
  onSheet: () => void;
}) {
  const copy = useCopy();
  const host = createChatContextHost({ onSheet: () => props.onSheet() });
  createEffect(on(() => props.chatId, host.closeDrawer, { defer: true }));
  const freeze = createReadingFreeze();
  let column: HTMLDivElement | undefined;
  let button: HTMLElement | undefined;
  // The width the person gave the column with its grip, in rem; until then the stylesheet's.
  const [width, setWidth] = createSignal<number | null>(null);
  const REM = 16;
  const shownWidth = () => width() ?? (column ? column.getBoundingClientRect().width / REM : 20);
  // The chat keeps at least 400 px (Gustav flat); the column takes at most 30 rem.
  const widest = () => {
    const layout = column?.parentElement;
    return layout ? Math.max(20, Math.min(30, (layout.getBoundingClientRect().width - 400) / REM)) : 30;
  };
  /** In the drawer every action that leaves the column closes it first. */
  const leave =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) => {
      host.closeDrawer();
      run(...args);
    };
  const actions: ContextBoxActions = {
    onOpen: (target) => leave(props.actions.onOpen)(target),
    onJump: (target) => leave(props.actions.onJump)(target),
    onOpenAll: () => leave(props.actions.onOpenAll)(),
    onOpenSources: () => leave(props.actions.onOpenSources)(),
    onOpenContext: () => leave(props.actions.onOpenContext)(),
  };
  // A drawer closes with Escape and with a press anywhere outside it and its button.
  createEffect(() => {
    if (!host.drawer()) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (column?.contains(target) || button?.contains(target))) return;
      host.closeDrawer();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      host.close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    });
  });
  return (
    <>
      {/* The chat's head row: its title and, while the column is not docked, the button. The timeline scrolls below it,
          so no message passes under the button. */}
      <div class="assistant-context-head">
        <Show when={props.title}>
          {(title) => (
            <p class="assistant-context-head__title k2b-truncate-fade" title={title()}>
              {title()}
            </p>
          )}
        </Show>
        <Button
          ref={(element: HTMLElement) => {
            button = element;
            host.buttonRef(element);
          }}
          class="assistant-context-button"
          data-k2b-primary="ai"
          size="sm"
          variant="secondary"
          aria-label={copy().title}
          aria-controls="assistant-chat-context-column"
          aria-expanded={host.drawer() ? "true" : "false"}
          onClick={host.toggle}
        >
          <i class="ti ti-list-details" aria-hidden="true" />
          <span>{copy().title}</span>
        </Button>
      </div>
      <div
        ref={column}
        id="assistant-chat-context-column"
        class="assistant-context-boxcol"
        data-closed={host.closed() ? "" : undefined}
        data-drawer={host.drawer() ? "open" : undefined}
        style={width() === null ? undefined : { "--assistant-context-column": `${width()}rem` }}
      >
        <ResizeSeparator
          class="assistant-context-grip"
          label={copy().boxResize}
          orientation="vertical"
          controls="assistant-chat-context-column"
          grow="start"
          unit={REM}
          step={1}
          largeStep={4}
          min={20}
          max={widest()}
          value={shownWidth()}
          onResize={(value) => setWidth(Math.min(value, widest()))}
          onReset={() => setWidth(null)}
        />
        <AssistantChatContextBox
          variant="column"
          state={props.state}
          actions={actions}
          project={props.project}
          frozen={freeze.frozen}
          handlers={freeze.handlers}
          headingId="assistant-chat-context-title"
          headingRef={host.headingRef}
          onClose={host.close}
        />
      </div>
    </>
  );
}
