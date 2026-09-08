import { Chat, type ChatTimelineItem, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { AiActiveTurn } from "../client/projection";
import { type AiActiveTurnSegment, isRenderableTurnBlock, splitActiveTurnBlocks } from "../protocol";
import { type AiAssistantTimelineItem, buildAiMessageTimeline, copyTextFromAssistantEntries } from "../timeline";
import type { AiConversationTimelineEntry, AiStoredMessage } from "../types";
import { AiTurnBlockList } from "./blocks";
import { type AiChatActions, AiChatActionsProvider, createAssistantMessageActions, useAiChatActions } from "./message-actions";
import { formatWorkedDuration, isCardToolName, isRecord, isSurveyToolName, textFromMessage } from "./message-utils";
import { type AiToolDisclosureState, createAiToolDisclosureState } from "./tool-disclosure";
import { aiChatMessages } from "./messages";
import { CloudSurveyResultBlock } from "./visual-tools";
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

type AssistantBlock = AiAssistantTimelineItem["blocks"][number];

type SurveyResultBlock = Extract<AssistantBlock, { kind: "tool" }>;
type SurveySegment = { type: "assistant"; blocks: AssistantBlock[] } | { type: "survey"; block: SurveyResultBlock };

// Presentation only: the accepted answer remains a tool result in the protocol.
const splitSurveyResults = (blocks: AssistantBlock[]): SurveySegment[] => {
  const segments: SurveySegment[] = [];
  for (const block of blocks) {
    if (
      block.kind === "tool" &&
      isSurveyToolName(block.name) &&
      block.status === "completed" &&
      !block.isError &&
      isRecord(block.result) &&
      block.result.submitted === true
    ) {
      segments.push({ type: "survey", block });
    } else {
      const previous = segments.at(-1);
      if (previous?.type === "assistant") previous.blocks.push(block);
      else segments.push({ type: "assistant", blocks: [block] });
    }
  }
  return segments;
};

const surveyItem = (block: SurveyResultBlock, turnId: string): ChatTimelineItem => ({
  kind: "message",
  id: `survey-answer:${turnId}:${block.callId}`,
  role: "user",
  content: <CloudSurveyResultBlock args={block.args} result={block.result} />,
});

const isDirectCompletedResult = (block: AssistantBlock): boolean =>
  block.kind === "tool" && block.status === "completed" && !block.isError && (isCardToolName(block.name) || block.name === "present");

const isFailedBlock = (block: AssistantBlock): boolean =>
  (block.kind === "tool" && (block.isError || block.status === "failed" || block.status === "rejected")) ||
  (block.kind === "compaction" && block.status === "failed");

export const partitionCompletedAssistantBlocks = (blocks: AssistantBlock[]) => {
  const renderable = blocks.filter(isRenderableTurnBlock);
  const finalTextIndex = renderable.findLastIndex((block) => block.kind === "text");
  return {
    worked: renderable.filter((block, index) => index !== finalTextIndex && !isDirectCompletedResult(block)),
    visible: renderable.filter((block, index) => index === finalTextIndex || isDirectCompletedResult(block)),
  };
};

export function AiAssistantContent(props: {
  item: AiAssistantTimelineItem;
  disclosureState?: AiToolDisclosureState;
  segmentId?: string;
}): JSX.Element {
  const locale = useLocale();
  const blocks = createMemo(() => partitionCompletedAssistantBlocks(props.item.blocks));
  const turnId = () => props.item.loopId ?? props.item.id;
  const workedDisclosureId = () => `worked:${props.segmentId ?? turnId()}`;
  const workedOpen = () => props.disclosureState?.get(workedDisclosureId());
  const setWorkedOpen = (open: boolean) => props.disclosureState?.set(workedDisclosureId(), open);
  const workedFailed = () => blocks().worked.some(isFailedBlock);

  return (
    <div class="flex flex-col gap-2">
      <Show when={blocks().worked.length > 0}>
        <Chat.Activity
          icon="ti ti-route"
          label={props.segmentId ? aiChatMessages(locale()).workSteps : `Worked for ${formatWorkedDuration(props.item.workedMs)}`}
          tone={workedFailed() ? "danger" : undefined}
          bodyInset={false}
          defaultOpen={workedFailed()}
          open={workedOpen()}
          onOpenChange={setWorkedOpen}
        >
          <AiTurnBlockList blocks={blocks().worked} turnId={turnId()} compact disclosureState={props.disclosureState} />
        </Chat.Activity>
      </Show>
      <AiTurnBlockList blocks={blocks().visible} turnId={turnId()} disclosureState={props.disclosureState} />
    </div>
  );
}

const storedItems = (
  messages: readonly AiStoredMessage[],
  actions: AiChatActions,
  disclosureState: AiToolDisclosureState,
  locale: string,
): ChatTimelineItem[] =>
  buildAiMessageTimeline([...messages]).flatMap((item): ChatTimelineItem | ChatTimelineItem[] => {
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
      const date = new Date(item.entry.createdAt).toLocaleDateString(locale);
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
    const segments = splitSurveyResults(item.blocks);
    if (segments.length === 0) segments.push({ type: "assistant", blocks: [] });
    const lastAssistant = segments.findLastIndex((segment) => segment.type === "assistant");
    return segments.map((segment, index): ChatTimelineItem => {
      if (segment.type === "survey") return surveyItem(segment.block, item.loopId ?? item.id);
      return {
        kind: "message",
        id: index === 0 ? item.id : `${item.id}:${segment.blocks[0]!.id}`,
        role: "assistant",
        createdAt: actionEntry?.createdAt ?? item.entries.at(-1)?.createdAt,
        class: segment.blocks.some(isWideBlock) ? "ai-chat-message-wide" : undefined,
        content: (
          <AiAssistantContent
            item={{ ...item, blocks: segment.blocks }}
            segmentId={segments.length > 1 ? `${item.id}:${index}` : undefined}
            disclosureState={disclosureState}
          />
        ),
        actions:
          actionEntry && index === lastAssistant
            ? createAssistantMessageActions({ entry: actionEntry, entries: item.entries, copyText, actions })
            : undefined,
        actionDisplay: "inline",
      };
    });
  });

const activeItems = (turn: AiActiveTurn | null, actions: AiChatActions, disclosureState: AiToolDisclosureState): ChatTimelineItem[] => {
  if (!turn) return [];
  const segments = splitActiveTurnBlocks(turn.blocks).flatMap((segment): (AiActiveTurnSegment | SurveySegment)[] =>
    segment.type === "steer" ? [segment] : splitSurveyResults(segment.blocks),
  );
  // Keep the shared assistant progress indicator after the accepted answer.
  if (turn.status === "running" && segments.at(-1)?.type === "survey") segments.push({ type: "assistant", blocks: [] });
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
    if (segment.type === "survey") return surveyItem(segment.block, turn.turnId);
    if (segment.type === "steer") {
      const block = segment.block;
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

    const blocks = segment.blocks;
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
  const locale = useLocale();
  const disclosureState = createAiToolDisclosureState();
  const stored = createMemo(() => storedItems(source.messages(), actions, disclosureState, locale()));
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
