import type { AiProject } from "@k2b/cloud/ai";
import { conversationFileSource } from "@k2b/cloud/ai/solid";
import { AnchoredPopover, Button, formatFileViewSize, IconButton, IconButtonLink, Skeleton, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, Show, untrack } from "solid-js";
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
          <For each={props.group.rows}>{(row) => <BoxRow row={row} actions={props.actions} downloadHref={props.downloadHref} />}</For>
        </ul>
      </Show>
    </section>
  );
}

/**
 * The box "In this chat": a small island beside the chat while there is room, the content of a popover under the
 * chat's button otherwise, and of a sheet on phones. One row per thing, at most ten rows; a click opens the thing as a
 * tab. While the pointer or focus is inside, it keeps what the person reads and collects news behind "New · n".
 */
export function AssistantChatContextBox(props: {
  state: ChatSidebarState;
  actions: ContextBoxActions;
  project?: AiProject | null;
  frozen: Accessor<boolean>;
  variant: "island" | "popover" | "sheet";
  headingId?: string;
  headingRef?: (element: HTMLHeadingElement) => void;
  handlers?: JSX.HTMLAttributes<HTMLElement>;
}) {
  const copy = useCopy();
  const locale = useLocale();
  const held = createHeldContextSnapshot(props.state.snapshot, props.frozen);
  const files = createMemo(() => {
    const chatId = held.shown()?.chatId;
    return chatId ? conversationFileSource("/api/ai", chatId) : null;
  });
  const downloadHref = (path: string) => files()?.downloadHref?.(path) ?? undefined;
  const model = createMemo(() => {
    const snapshot = held.shown();
    if (!snapshot) return null;
    const t = copy();
    return buildContextBoxModel(snapshot, {
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
          <i class="ti ti-layout-sidebar-right-expand" aria-hidden="true" />
        </IconButton>
      </header>
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
    </aside>
  );
}

/**
 * The places of the box in the chat layout: the island in its column, and the button that stands in for it when there
 * is no room or tabs are open. The button opens the box as a popover below it, or as a sheet on phones. CSS decides
 * which shows, so the server's first frame is final. Rendered inside `.assistant-chat-layout`.
 */
export function AssistantChatContextPlaces(props: {
  chatId: string | null;
  state: ChatSidebarState;
  actions: ContextBoxActions;
  project?: AiProject | null;
  /** The chat's title, for the head row on phones, where the app's head names only the app. */
  title?: string | null;
  onSheet: () => void;
}) {
  const copy = useCopy();
  const host = createChatContextHost({ onSheet: () => props.onSheet() });
  createEffect(on(() => props.chatId, host.close, { defer: true }));
  const freeze = createReadingFreeze();
  /** In the popover, every action leaves the box: it closes first. */
  const leave =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) => {
      host.close();
      run(...args);
    };
  const popoverActions: ContextBoxActions = {
    onOpen: (target) => leave(props.actions.onOpen)(target),
    onJump: (target) => leave(props.actions.onJump)(target),
    onOpenAll: () => leave(props.actions.onOpenAll)(),
    onOpenSources: () => leave(props.actions.onOpenSources)(),
    onOpenContext: () => leave(props.actions.onOpenContext)(),
  };
  return (
    <>
      {/* The button stands in a head row above the timeline, never over it, so it covers no message. */}
      <div class="assistant-context-head">
        <Show when={props.title}>
          {(title) => (
            <p class="assistant-context-head__title k2b-truncate-fade" title={title()}>
              {title()}
            </p>
          )}
        </Show>
        <Button
          ref={host.buttonRef}
          class="assistant-context-button"
          data-k2b-primary="ai"
          size="sm"
          variant="ghost"
          aria-label={copy().title}
          aria-haspopup="dialog"
          aria-expanded={host.anchor() ? "true" : "false"}
          onClick={host.toggle}
        >
          <i class="ti ti-layout-list" aria-hidden="true" />
          <span>{copy().title}</span>
        </Button>
      </div>
      <div class="assistant-context-boxcol">
        <AssistantChatContextBox
          variant="island"
          state={props.state}
          actions={props.actions}
          project={props.project}
          frozen={freeze.frozen}
          handlers={freeze.handlers}
          headingId="assistant-chat-context-title"
        />
      </div>
      <AnchoredPopover
        anchor={host.anchor()}
        onClose={host.close}
        label={copy().title}
        width="19.5rem"
        sheet={false}
        class="assistant-context-popover"
      >
        {/* While open, it keeps what the person reads; news wait behind "New · n". */}
        <AssistantChatContextBox
          variant="popover"
          state={props.state}
          actions={popoverActions}
          project={props.project}
          frozen={() => true}
        />
      </AnchoredPopover>
    </>
  );
}
