import type { ChatTimelineItem } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { AiActiveTurn } from "../client/projection";
import { type AiActiveTurnSegment, isRenderableTurnBlock, splitActiveTurnBlocks } from "../protocol";
import { type AiAssistantTimelineItem, buildAiMessageTimeline, copyTextFromAssistantEntries } from "../timeline";
import type { AiConversationTimelineEntry, AiStoredMessage } from "../types";
import { AiTurnBlockList } from "./blocks";
import { type AiChatActions, AiChatActionsProvider, createAssistantMessageActions, useAiChatActions } from "./message-actions";
import { textFromMessage } from "./message-utils";
import { type AiToolDisclosureState, createAiToolDisclosureState } from "./tool-disclosure";
import { TurnNavigator } from "./turn-navigator";
import { activeTimelineSeq } from "./turn-navigator-utils";
import {
  aiSteerMessageText,
  aiUserMessageAttachments,
  aiUserMessageText,
  createAiSteerMessageActions,
  createAiUserMessageActions,
} from "./user-message";

export type AiChatTimelineSession = {
  messages: readonly AiStoredMessage[];
  activeTurn: AiActiveTurn | null;
};

export { type AiChatActions, AiChatActionsProvider };

const isWideBlock = (block: AiAssistantTimelineItem["blocks"][number]) => block.kind === "tool";

export function AiAssistantContent(props: { item: AiAssistantTimelineItem; disclosureState?: AiToolDisclosureState }): JSX.Element {
  const renderable = createMemo(() => props.item.blocks.filter(isRenderableTurnBlock));
  const turnId = () => props.item.loopId ?? props.item.id;

  return (
    <div class="flex flex-col gap-2">
      <AiTurnBlockList blocks={renderable()} turnId={turnId()} disclosureState={props.disclosureState} />
    </div>
  );
}

const storedItems = (
  messages: readonly AiStoredMessage[],
  actions: AiChatActions,
  disclosureState: AiToolDisclosureState,
): ChatTimelineItem[] =>
  buildAiMessageTimeline([...messages]).map((item): ChatTimelineItem => {
    if (item.type === "user") {
      const text = aiUserMessageText(item.entry);
      const agentMessage = item.entry.meta?.agentMessage;
      if (agentMessage) {
        const separator = text.indexOf("\n\n");
        const forwardedText = separator >= 0 ? text.slice(separator + 2) : text;
        return {
          kind: "message",
          id: item.id,
          role: "system",
          label: `Message from Assistant chat ${agentMessage.sourceTitle}`,
          createdAt: item.entry.createdAt,
          content: (
            <div class="flex flex-col gap-1">
              <p class="text-xs font-medium text-dimmed">
                <i class="ti ti-message-forward mr-1" aria-hidden="true" />
                From{" "}
                <Show
                  when={agentMessage.sourceHref}
                  fallback={
                    <span>
                      {agentMessage.sourceTitle} ({agentMessage.sourceChatId})
                    </span>
                  }
                >
                  {(href) => (
                    <a class="text-link hover:underline" href={href()}>
                      {agentMessage.sourceTitle} ({agentMessage.sourceChatId})
                    </a>
                  )}
                </Show>
                <span class="font-normal"> · turn {agentMessage.sourceTurnId}</span>
              </p>
              {forwardedText ? <p class="whitespace-pre-wrap">{forwardedText}</p> : undefined}
            </div>
          ),
          anchorId: item.entry.seq,
        };
      }
      return {
        kind: "message",
        id: item.id,
        role: "user",
        createdAt: item.entry.createdAt,
        content: text ? <p class="whitespace-pre-wrap">{text}</p> : undefined,
        attachments: aiUserMessageAttachments(item.entry, actions),
        actions: createAiUserMessageActions(item.entry, actions),
        actionDisplay: "menu",
        anchorId: item.entry.seq,
      };
    }

    if (item.type === "summary") {
      const count = item.entry.meta?.compactedCount;
      const date = new Date(item.entry.createdAt).toLocaleDateString();
      return {
        kind: "activity",
        id: item.id,
        label: "Context compacted",
        description: count ? `${count} message${count === 1 ? "" : "s"} summarized · ${date}` : date,
        icon: "ti ti-brain",
        tone: "ai",
        content: (
          <div>
            <p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">
              The model now sees this summary instead of the messages above
            </p>
            <p class="whitespace-pre-wrap">{textFromMessage(item.entry.message) || "No visible content"}</p>
          </div>
        ),
      };
    }

    const actionEntry = item.actionEntry?.compactedAt ? null : item.actionEntry;
    const copyText = copyTextFromAssistantEntries(item.entries);
    return {
      kind: "message",
      id: item.id,
      role: "assistant",
      createdAt: actionEntry?.createdAt ?? item.entries.at(-1)?.createdAt,
      class: item.blocks.some(isWideBlock) ? "ai-chat-message-wide" : undefined,
      content: <AiAssistantContent item={item} disclosureState={disclosureState} />,
      actions: actionEntry
        ? createAssistantMessageActions({
            entry: actionEntry,
            entries: item.entries,
            copyText,
            actions,
          })
        : undefined,
      actionDisplay: "inline",
    };
  });

const activeItems = (turn: AiActiveTurn | null, actions: AiChatActions, disclosureState: AiToolDisclosureState): ChatTimelineItem[] => {
  if (!turn) return [];
  const segments = splitActiveTurnBlocks(turn.blocks);
  if (segments.length === 0) {
    return [
      {
        kind: "message",
        id: `${turn.turnId}-pending`,
        role: "assistant",
        status: "streaming",
        anchorId: turn.seq,
      },
    ];
  }

  return segments.map((segment, index): ChatTimelineItem => {
    if (segment.type === "steer") {
      const block = (segment as Extract<AiActiveTurnSegment, { type: "steer" }>).block;
      return {
        kind: "message",
        id: `${turn.turnId}-steer-${block.id}`,
        role: "user",
        status: block.status === "pending" ? "pending" : block.status === "failed" ? "error" : "complete",
        content: <p class="whitespace-pre-wrap">{aiSteerMessageText(block)}</p>,
        actions: createAiSteerMessageActions(block, actions),
        actionDisplay: "menu",
        anchorId: turn.seq,
      };
    }

    const blocks = (segment as Extract<AiActiveTurnSegment, { type: "assistant" }>).blocks;
    return {
      kind: "message",
      id: `${turn.turnId}-assistant-${index}`,
      role: "assistant",
      status: turn.status === "running" && index === segments.length - 1 ? "streaming" : "complete",
      class: blocks.some(isWideBlock) ? "ai-chat-message-wide" : undefined,
      content: (
        <AiTurnBlockList
          blocks={blocks}
          turnId={turn.turnId}
          streaming={turn.status === "running" && index === segments.length - 1}
          active
          disclosureState={disclosureState}
        />
      ),
    };
  });
};

export type AiChatTimelineSource = {
  messages: Accessor<readonly AiStoredMessage[]>;
  activeTurn: Accessor<AiActiveTurn | null>;
};

/**
 * Adapts Cloud's stored/live conversation domain into portable chat items.
 * Call below AiChatActionsProvider so rich tool blocks receive the current
 * action context.
 */
export function createAiChatTimeline(source: AiChatTimelineSource): Accessor<readonly ChatTimelineItem[]> {
  const actions = useAiChatActions();
  const disclosureState = createAiToolDisclosureState();
  const stored = createMemo(() => storedItems(source.messages(), actions, disclosureState));
  const active = createMemo(() => activeItems(source.activeTurn(), actions, disclosureState));
  return createMemo(() => [...stored(), ...active()]);
}

export type AiChatTurnNavigatorProps = {
  entries: readonly AiConversationTimelineEntry[];
  loading?: boolean;
  viewport: () => HTMLDivElement | undefined;
  content: () => HTMLDivElement | undefined;
  loadThrough: (seq: number) => Promise<boolean>;
};

export function AiChatTurnNavigator(props: AiChatTurnNavigatorProps): JSX.Element {
  const [activeSeq, setActiveSeq] = createSignal<number | null>(null);
  const [loadingSeq, setLoadingSeq] = createSignal<number | null>(null);
  const [height, setHeight] = createSignal(0);
  let navigationRevision = 0;
  let updateFrame: number | undefined;

  const update = () => {
    const viewport = props.viewport();
    const content = props.content();
    if (!viewport || !content || props.entries.length === 0) {
      setActiveSeq(null);
      return;
    }
    setHeight(viewport.clientHeight);
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 8) {
      setActiveSeq(props.entries.at(-1)?.seq ?? null);
      return;
    }
    const anchors = Array.from(content.querySelectorAll<HTMLElement>("[data-chat-anchor]")).flatMap((node) => {
      const seq = Number(node.dataset.chatAnchor);
      return Number.isFinite(seq) ? [{ seq, top: node.getBoundingClientRect().top }] : [];
    });
    const rect = viewport.getBoundingClientRect();
    setActiveSeq(activeTimelineSeq(anchors, rect.top, rect.height));
  };

  const scheduleUpdate = () => {
    if (updateFrame !== undefined) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = undefined;
      update();
    });
  };

  createEffect(() => {
    const viewport = props.viewport();
    const content = props.content();
    if (!viewport || !content) return;
    update();
    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(viewport);
    observer?.observe(content);
    onCleanup(() => {
      viewport.removeEventListener("scroll", scheduleUpdate);
      observer?.disconnect();
      if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
      updateFrame = undefined;
    });
  });

  const select = async (entry: AiConversationTimelineEntry) => {
    const revision = ++navigationRevision;
    const content = props.content();
    let anchor = content?.querySelector<HTMLElement>(`[data-chat-anchor="${entry.seq}"]`) ?? null;
    if (!anchor) {
      setLoadingSeq(entry.seq);
      const loaded = await props.loadThrough(entry.seq);
      if (!loaded || revision !== navigationRevision) {
        setLoadingSeq(null);
        return;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      anchor = props.content()?.querySelector<HTMLElement>(`[data-chat-anchor="${entry.seq}"]`) ?? null;
    }
    const viewport = props.viewport();
    if (!viewport || !anchor || revision !== navigationRevision) return;
    const viewportRect = viewport.getBoundingClientRect();
    viewport.scrollTop = Math.max(0, viewport.scrollTop + anchor.getBoundingClientRect().top - viewportRect.top - 16);
    setActiveSeq(entry.seq);
    setLoadingSeq(null);
  };

  return (
    <Show when={props.entries.length >= 5 && height() > 0 && !props.loading}>
      <div class="ai-turn-navigator-shell pointer-events-none relative h-0">
        <div class="absolute top-0" style={{ left: "max(0.5rem, calc(50% - 30rem))" }}>
          <TurnNavigator
            entries={[...props.entries]}
            activeSeq={activeSeq()}
            loadingSeq={loadingSeq()}
            height={Math.max(120, height() - 16)}
            onSelect={(entry) => void select(entry)}
          />
        </div>
      </div>
    </Show>
  );
}
