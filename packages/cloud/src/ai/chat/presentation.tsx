import type { ChatTimelineItem } from "@k2b/ui";
import { useLocale } from "@k2b/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  type JSX,
  onCleanup,
  type Setter,
  Show,
} from "solid-js";
import type { AiActiveTurn } from "../client/projection";
import { type AiActiveTurnSegment, splitActiveTurnBlocks } from "../protocol";
import { type AiAssistantTimelineItem, buildAiMessageTimeline } from "../timeline";
import type { AiConversationTimelineEntry, AiStoredMessage } from "../types";
import { type AiChatActions, AiChatActionsProvider, createAssistantMessageActions, useAiChatActions } from "./message-actions";
import { isRecord, isSurveyToolName, textFromMessage } from "./message-utils";
import { aiChatMessages } from "./messages";
import { type AiToolDisclosureState, createAiToolDisclosureState } from "./tool-disclosure";
import { type AiTurnLayout, type AiTurnPhase, layoutAiTurn } from "./turn-layout";
import { TurnNavigator } from "./turn-navigator";
import { activeTimelineSeq } from "./turn-navigator-utils";
import { type AiTurnDuration, type AiTurnSegment, AiTurnView } from "./turn-view";
import {
  aiSteerMessageText,
  aiUserMessageAttachments,
  aiUserMessageText,
  createAiSteerMessageActions,
  createAiUserMessageActions,
} from "./user-message";
import { CloudSurveyResultBlock } from "./visual-tools";

export type AiChatTimelineSession = {
  messages: readonly AiStoredMessage[];
  activeTurn: AiActiveTurn | null;
};

export { type AiChatActions, AiChatActionsProvider };

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

/**
 * Timeline id of an assistant segment: its turn and its position among the turn's assistant segments. A live turn and
 * its history produce the same ids, so the timeline keeps the same elements when the turn ends.
 */
const turnSegmentId = (turnId: string, index: number) => `ai-turn:${turnId}:${index}`;

/** History phase of a finished loop, from how its loop ended. */
const storedPhase = (entries: readonly AiStoredMessage[]): AiTurnPhase => {
  const reason = entries.findLast((entry) => entry.loopDoneReason)?.loopDoneReason;
  if (!reason || reason === "stop") return "completed";
  return reason === "aborted" ? "stopped" : "failed";
};

/** Responses with a work line or rich places span the message column so their right edges align. */
const isWideLayout = (layout: AiTurnLayout) => layout.showWork || layout.results.length > 0 || layout.actions.length > 0;

const isEmptyLayout = (layout: AiTurnLayout) => !isWideLayout(layout) && layout.text.length === 0;

/**
 * Turn views live in their own roots, keyed by timeline id. A changed segment updates its view instead of
 * replacing it, so host state inside a turn, such as a running Studio session, survives every update.
 */
const createTurnViews = (disclosureState: AiToolDisclosureState) => {
  const owner = getOwner();
  const views = new Map<string, { set: Setter<AiTurnSegment>; content: JSX.Element; dispose: () => void }>();
  onCleanup(() => {
    for (const view of views.values()) view.dispose();
    views.clear();
  });
  return {
    content(segment: AiTurnSegment): JSX.Element {
      const existing = views.get(segment.id);
      if (existing) {
        existing.set(() => segment);
        return existing.content;
      }
      return createRoot((dispose) => {
        const [current, set] = createSignal(segment);
        const content = <AiTurnView segment={current} disclosureState={disclosureState} />;
        views.set(segment.id, { set, content, dispose });
        return content;
      }, owner);
    },
    retain(ids: ReadonlySet<string>) {
      for (const [id, view] of views) {
        if (ids.has(id)) continue;
        view.dispose();
        views.delete(id);
      }
    },
  };
};

type TurnViews = ReturnType<typeof createTurnViews>;

/** A segment's final text is what Copy copies; intermediate texts stay in the work line. */
const finalText = (layout: AiTurnLayout) =>
  layout.text
    .map((block) => block.text)
    .join("\n\n")
    .trim();

const storedItems = (
  messages: readonly AiStoredMessage[],
  actions: AiChatActions,
  views: TurnViews,
  locale: string,
): ChatTimelineItem[] => {
  const timeline = buildAiMessageTimeline([...messages]);
  const lastItemOfLoop = new Map<string, number>();
  timeline.forEach((item, index) => {
    if (item.type === "assistant" && item.loopId) lastItemOfLoop.set(item.loopId, index);
  });
  const segmentsOfLoop = new Map<string, number>();
  return timeline.flatMap((item, itemIndex): ChatTimelineItem | ChatTimelineItem[] => {
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
    const lastOfLoop = !item.loopId || lastItemOfLoop.get(item.loopId) === itemIndex;
    const phase = lastOfLoop ? storedPhase(item.entries) : "completed";
    const segments = splitSurveyResults(item.blocks);
    if (segments.length === 0) segments.push({ type: "assistant", blocks: [] });
    const lastAssistant = segments.findLastIndex((segment) => segment.type === "assistant");
    const scheduledTask = item.entries.find((entry) => entry.meta?.scheduledTask)?.meta?.scheduledTask ?? null;
    let firstSegment = true;
    return segments.flatMap((segment, index): ChatTimelineItem[] => {
      const turnId = item.loopId ?? item.id;
      if (segment.type === "survey") return [surveyItem(segment.block, turnId)];
      const ordinal = item.loopId ? (segmentsOfLoop.get(item.loopId) ?? 0) : index;
      if (item.loopId) segmentsOfLoop.set(item.loopId, ordinal + 1);
      const last = lastOfLoop && index === lastAssistant;
      const segmentPhase = last ? phase : "completed";
      const layout = layoutAiTurn(segment.blocks, { phase: segmentPhase, codePresentations: Boolean(actions.renderCodePresentation) });
      const messageActions =
        actionEntry && index === lastAssistant
          ? createAssistantMessageActions({ entry: actionEntry, entries: item.entries, copyText: finalText(layout), actions })
          : undefined;
      const task = firstSegment ? scheduledTask : null;
      firstSegment = false;
      if (isEmptyLayout(layout) && !messageActions && !task) return [];
      const id = item.loopId ? turnSegmentId(item.loopId, ordinal) : `${item.id}:${index}`;
      return [
        {
          kind: "message",
          id,
          role: "assistant",
          createdAt: actionEntry?.createdAt ?? item.entries.at(-1)?.createdAt,
          class: isWideLayout(layout) ? "ai-chat-message-wide" : undefined,
          content: views.content({
            id,
            turnId,
            phase: segmentPhase,
            layout,
            earlier: !last,
            duration: last ? () => ({ workedMs: item.workedMs, waitingMs: null }) : () => null,
            scheduledTask: task,
          }),
          actions: messageActions,
          actionDisplay: "inline",
        },
      ];
    });
  });
};

const activeItems = (
  turn: AiActiveTurn | null,
  actions: AiChatActions,
  views: TurnViews,
  duration: Accessor<AiTurnDuration | null>,
  locale: string,
): ChatTimelineItem[] => {
  if (!turn) return [];
  const segments = splitActiveTurnBlocks(turn.blocks).flatMap((segment): (AiActiveTurnSegment | SurveySegment)[] =>
    segment.type === "steer" ? [segment] : splitSurveyResults(segment.blocks),
  );
  // Keep the shared assistant progress indicator after the accepted answer, and before the first model block.
  if (segments.length === 0 || (turn.status === "running" && segments.at(-1)?.type === "survey"))
    segments.push({ type: "assistant", blocks: [] });
  const lastAssistant = segments.findLastIndex((segment) => segment.type === "assistant");
  let ordinal = 0;

  const items = segments.map((segment, index): ChatTimelineItem => {
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

    const last = index === lastAssistant;
    const phase: AiTurnPhase = !last ? "completed" : turn.status === "waiting_for_action" ? "waiting" : "running";
    const layout = layoutAiTurn(segment.blocks, { phase, codePresentations: Boolean(actions.renderCodePresentation) });
    const id = turnSegmentId(turn.turnId, ordinal++);
    return {
      kind: "message",
      id,
      role: "assistant",
      status: turn.status === "running" && last ? "streaming" : "complete",
      class: isWideLayout(layout) ? "ai-chat-message-wide" : undefined,
      content: views.content({ id, turnId: turn.turnId, phase, layout, earlier: !last, duration: last ? duration : () => null }),
    };
  });
  // The live timeline ends with the wait for a retried model call, below a pending steer too, so no earlier row moves.
  // Calm by design: no busy sweep while the call waits.
  if (turn.providerRetry)
    items.push({ kind: "activity", id: `${turn.turnId}-provider-retry`, label: aiChatMessages(locale).reconnecting, icon: "ti ti-refresh" });
  return items;
};

/**
 * Work time of the active turn: wall time minus time spent waiting for the user. A state snapshot seeds it after a
 * reconnect; the clock stands while the turn waits and continues from the same value afterwards.
 */
const createActiveTurnClock = (source: AiChatTimelineSource): Accessor<AiTurnDuration | null> => {
  const [now, setNow] = createSignal(Date.now());
  const running = createMemo(() => source.activeTurn() !== null);
  createEffect(() => {
    if (!running() || typeof window === "undefined") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });
  let state: { turnId: string; seed: string; startedAt: number; waitMs: number; waitingSince: number | null } | null = null;
  return createMemo(() => {
    const turn = source.activeTurn();
    const time = now();
    if (!turn) {
      state = null;
      return null;
    }
    const seed = `${turn.createdAt}|${turn.actionWaitMs}|${turn.waitingSince}`;
    if (!state || state.turnId !== turn.turnId || state.seed !== seed) {
      const userMessage = source.messages().find((message) => message.loopId === turn.turnId && message.message.role === "user");
      const started = Date.parse(turn.createdAt ?? userMessage?.createdAt ?? "");
      const waitingSince = turn.waitingSince ? Date.parse(turn.waitingSince) : Number.NaN;
      state = {
        turnId: turn.turnId,
        seed,
        startedAt: Number.isFinite(started) ? Math.min(started, time) : state?.turnId === turn.turnId ? state.startedAt : time,
        waitMs: turn.actionWaitMs ?? (state?.turnId === turn.turnId ? state.waitMs : 0),
        waitingSince: Number.isFinite(waitingSince) ? Math.min(waitingSince, time) : null,
      };
    }
    const waiting = turn.status === "waiting_for_action";
    if (waiting && state.waitingSince === null) state.waitingSince = time;
    if (!waiting && state.waitingSince !== null) {
      state.waitMs += time - state.waitingSince;
      state.waitingSince = null;
    }
    return {
      workedMs: Math.max(0, (state.waitingSince ?? time) - state.startedAt - state.waitMs),
      waitingMs: state.waitingSince === null ? null : Math.max(0, time - state.waitingSince),
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
  const views = createTurnViews(disclosureState);
  const clock = createActiveTurnClock(source);
  const stored = createMemo(() => storedItems(source.messages(), actions, views, locale()));
  const active = createMemo(() => activeItems(source.activeTurn(), actions, views, clock, locale()));
  return createMemo(() => {
    const items = [...stored(), ...active()];
    views.retain(new Set(items.map((item) => item.id)));
    return items;
  });
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
