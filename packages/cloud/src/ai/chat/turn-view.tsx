import { announce, Button, Chat, IconButton, NoticeCard, useLocale } from "@k2b/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { CloudChartBlock } from "#chat-charts";
import { AiWorkSteps, preloadAiWorkSteps } from "#chat-work-list";
import { markdown } from "../../shared";
import { type ChatTaskReason, chatTaskReasonSentence, chatTaskReasonState, chatTaskStopSentence } from "../chat-task-reasons";
import { AI_TURN_LEASE_MS, type AiTurnBlock } from "../protocol";
import type { AiTurnError } from "../types";
import { toolSubject, useReaderTimeZone } from "./action-sentences";
import { AiAnswerSources, answerSources } from "./answer-sources";
import { SurveyToolView, TextEditorToolView } from "./blocks";
import { CapabilityTablePreview } from "./capability-table";
import { PresentToolBlock } from "./file-tools";
import { AiMapToolBlock } from "./map-widget";
import { useAiChatActions } from "./message-actions";
import { aiToolIcon, displayToolName, isCardToolName, isChartToolName, isRecord, isSurveyToolName } from "./message-utils";
import { aiChatMessages } from "./messages";
import { AssistantMarkdownBlock } from "./primitives";
import type { AiStopNotice } from "./stop-notice";
import { ResultLinks, resultLinks, ToolActionView } from "./tool-action";
import { AiToolActivity, AiToolDisclosureProvider, type AiToolDisclosureState } from "./tool-disclosure";
import { aiTurnErrorCanContinue } from "./turn-error";
import type { AiTurnAction, AiTurnLayout, AiTurnPhase, AiTurnResult } from "./turn-layout";
import { CloudCardBlock } from "./visual-tools";
import type { AiWorkContextValue } from "./work-steps";
import { workStepLine, workStepParts, workSummary } from "./work-summary";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type Messages = ReturnType<typeof aiChatMessages>;

/** Work time of a turn: wall time minus time spent waiting for the user. `waitingMs` is set while it waits. */
export type AiTurnDuration = { workedMs: number; waitingMs: number | null };

/** One rendered turn segment. Steering and accepted survey answers split a turn into segments. */
export type AiTurnSegment = {
  /** Timeline item id: the same for the live turn and its history. */
  id: string;
  turnId: string;
  phase: AiTurnPhase;
  layout: AiTurnLayout;
  /** Earlier segments of a split turn show no duration; the last one carries the whole turn. */
  earlier: boolean;
  /** Read reactively, so a ticking clock does not rebuild the segment. */
  duration: () => AiTurnDuration | null;
  /**
   * Shown above the work of a delivered scheduled result. `stop` and `reason` add a system line the chat words in
   * the reader's language; with `stop` or `reasonOnly` that line replaces the stored text.
   */
  scheduledTask?: {
    taskId: string;
    occurrenceId: string;
    reason?: ChatTaskReason;
    reasonOnly?: true;
    stop?: { cause: "paused" | "deleted"; done: string[] };
  } | null;
  /**
   * The live turn cannot reach the model or the server right now: a model call waits for its retry, or the stream
   * reconnects. The working segment's work line says so while its clock stands; a turn without a work line yet says
   * it in a row at the end of its last segment.
   */
  reconnect?: "line" | "row";
  /** Why the turn failed, shown in a notice at its end. Only the last segment of a failed turn carries it. */
  error?: AiTurnError | null;
  /** A stopped answer can be given again: the person's message is answered anew. */
  answerAgain?: () => void | Promise<void>;
  /** The person stopped this turn: it ends with the quiet stopped line and no notice. */
  stoppedByPerson?: boolean;
  stopNotice?: AiStopNotice | null;
  /** The turn is the chat's newest and nothing runs, so a new message can pick up its work. */
  continuable?: boolean;
};

const isLive = (phase: AiTurnPhase) => phase === "running" || phase === "waiting";

/** "12 s", "3 min", "1 h 5 min": seconds below a minute, then whole minutes. */
export const formatWorkDuration = (ms: number, t: Messages, long = false): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return long ? t.durationSecondsLong({ seconds }) : t.durationSeconds({ seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return long ? t.durationMinutesLong({ minutes }) : t.durationMinutes({ minutes });
  const hours = Math.floor(minutes / 60);
  return long ? t.durationHoursLong({ hours, minutes: minutes % 60 }) : t.durationHours({ hours, minutes: minutes % 60 });
};

/**
 * A duration in the activity grid's fixed column: "12 s", from 60 s "2 min", from 60 min whole hours "1 h". The column
 * fits it on a phone; `formatWorkDuration(…, true)` spells it out in its title.
 */
export const formatStepDuration = (ms: number, t: Messages): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t.durationSeconds({ seconds });
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? t.durationMinutes({ minutes }) : t.durationHours({ hours: Math.floor(minutes / 60), minutes: 0 });
};

/** Identity of the current step: it changes when another block becomes current or the current call changes state. */
const stepKey = (block: AiTurnBlock | null): string =>
  !block ? "start" : `${block.id}:${block.kind === "tool" || block.kind === "compaction" ? block.status : block.kind}`;

const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1) || value;

/** What a call acts on: the file name of its path, or its name, title, or query as given. */
const toolTarget = (block: ToolBlock): string => {
  const args = isRecord(block.args) ? block.args : {};
  if (typeof args.path === "string" && args.path.trim()) return basename(args.path.trim());
  const value = [args.name, args.title, args.query].find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value.trim() : "";
};

/** A step that runs longer than this shows its duration, so a long step does not look like a stalled one. */
export const AI_LONG_STEP_MS = AI_TURN_LEASE_MS;

/**
 * The current step of a live turn, as a short progressive phrase. A step that runs long shows its duration in place of
 * its target: "Running code · 3 min".
 */
export const liveStepLabel = (block: AiTurnBlock | null, t: Messages, stepMs = 0): string => {
  if (stepMs < AI_LONG_STEP_MS) return stepPhrase(block, t, true);
  return `${stepPhrase(block, t, false)} · ${formatWorkDuration(stepMs, t)}`;
};

const stepPhrase = (block: AiTurnBlock | null, t: Messages, withTargets: boolean): string => {
  if (!block || block.kind === "thinking" || block.kind === "steer_applied" || block.kind === "steer_message") return t.stepThinking;
  if (block.kind === "text") return t.stepWriting;
  if (block.kind === "compaction") return block.status === "running" ? t.stepCompacting : t.stepThinking;
  // A finished call means the model is deciding what to do next.
  if (block.status !== "running" && block.status !== "awaiting_client") return t.stepThinking;
  const target = withTargets ? toolTarget(block) : "";
  const withTarget = (label: string) => (target ? `${label} · ${target}` : label);
  const name = block.name;
  if (block.presentation?.kind === "capability") return withTarget(t.stepUsingApp({ app: block.presentation.appName }));
  if (name === "read_file") return t.stepReading({ target });
  if (name === "list_files") return t.stepListingFiles;
  if (name === "view_image") return withTarget(t.stepViewingImage);
  if (name === "write_file") return withTarget(t.stepWritingFile);
  if (name === "todo_write") return t.stepPlan;
  if (name === "present") return withTarget(t.stepDeliveringFile);
  if (name === "code_present") return withTarget(t.stepPreparingView);
  if (isCardToolName(name)) return t.stepPreparingCard;
  if (isChartToolName(name)) return t.stepPreparingChart;
  if (["code_write", "code_import", "code_create", "code_update", "code_fork", "code_remove", "code_restore"].includes(name))
    return withTarget(t.stepWritingCode);
  if (["code_run", "code_action", "code_sql"].includes(name)) return withTarget(t.stepRunningCode);
  if (name === "code_check") return t.stepCheckingApp;
  if (name === "code_inspect") return t.stepCheckingRun;
  if (name.startsWith("code_")) return t.stepCode;
  if (["markdown_to_pdf", "html_to_pdf"].includes(name)) return withTarget(t.stepPdf);
  if (["load_skill", "load_tools", "search_tools", "list_apps"].includes(name)) return t.stepLoading;
  if (name.startsWith("web_") || name === "fetch_file") return t.stepWeb;
  if (name === "memory") return t.stepMemory;
  if (name === "calculate") return t.stepCalculating;
  return withTarget(t.stepTool);
};

/** The thinking words, loaded once on the first thinking phase: most of a turn never shows them. */
const [thinkingWordsModule, setThinkingWordsModule] = createSignal<typeof import("./thinking-words")>();
const loadThinkingWords = () => void import("./thinking-words").then(setThinkingWordsModule);

/**
 * The work line of a turn: ✦ and the tiles of the apps it worked in, then one sentence. While the turn runs the
 * sentence is the current step and shimmers, with the work time beside it; once it ends it says what the turn did and
 * how many steps that took. It has the same height in every state, and a click opens the steps in words.
 */
function AiWorkLine(props: { segment: Accessor<AiTurnSegment> }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const segment = () => props.segment();
  const layout = () => segment().layout;
  const reconnecting = () => isLive(segment().phase) && segment().reconnect === "line";
  const waiting = () => !reconnecting() && segment().phase === "waiting" && layout().waitingFor !== null;
  const working = () => isLive(segment().phase) && !waiting() && !reconnecting();
  // The current step is timed on the work clock, so it stands while the turn reconnects.
  const currentStep = createMemo(() => (isLive(segment().phase) ? stepKey(layout().current) : null));
  const step = createMemo(on(currentStep, (key) => (key === null ? null : (untrack(segment().duration)?.workedMs ?? 0))));
  const stepMs = () => {
    const startedAt = step();
    const workedMs = segment().duration()?.workedMs;
    return startedAt === null || workedMs === undefined ? 0 : workedMs - startedAt;
  };
  // Screen readers hear once that the turn reconnects; the line itself is not read while it changes.
  createEffect(
    on(reconnecting, (now, before) => {
      if (now && !before) announce(t().reconnecting);
    }),
  );
  const worked = () => {
    const duration = segment().duration();
    return !segment().earlier && duration && duration.workedMs > 0 ? duration.workedMs : null;
  };
  const summary = createMemo(() => (isLive(segment().phase) ? "" : workSummary(layout().work, locale())));
  const ending = () => {
    const phase = segment().phase;
    return phase === "stopped" ? "stopped" : phase === "failed" && !segment().error ? "failed" : null;
  };
  // Thinking between steps changes its word with time; each thinking phase gets its own round (Feinschliff v3, 1). A
  // phase lasts as long as the line says "Thinking", across blocks: a thinking block, a finished call, and the next
  // thinking block are one phase. It starts with the step the line turned to thinking at, on the work clock.
  const thinking = createMemo(() => working() && stepPhrase(layout().current, t(), false) === t().stepThinking);
  const thinkingStart = createMemo(
    on(thinking, (now) => (now ? { id: `${segment().id}:${currentStep() ?? "start"}`, at: segment().duration()?.workedMs ?? 0 } : null)),
  );
  const thinkingPhase = () => thinkingStart()?.id ?? null;
  const thinkingMs = () => {
    const start = thinkingStart();
    const workedMs = segment().duration()?.workedMs;
    return start === null || workedMs === undefined ? 0 : workedMs - start.at;
  };
  // The words show only after 3 s of thinking, so they load when a phase begins; until then the first word stands.
  createEffect(() => thinkingPhase() && loadThinkingWords());
  const thinkingWords = (phase: string) => {
    const words = thinkingWordsModule();
    return words ? words.aiThinkingWordRound(phase, words.aiThinkingWords(locale())) : [];
  };
  const sentence = () => {
    if (reconnecting()) return t().reconnecting;
    if (working()) return liveStepLabel(layout().current, t(), stepMs());
    if (waiting()) return layout().waitingFor === "approval" ? t().waitingForApproval : t().waitingForAnswer;
    if (summary()) return summary();
    const duration = worked();
    const short = duration === null ? "" : formatWorkDuration(duration, t());
    if (ending() === "stopped") return t().workedStopped({ duration: short });
    // A failed turn with a stored reason says it in its notice; the line then reads like any finished turn.
    if (ending() === "failed") return t().workedInterrupted({ duration: short });
    return short ? t().workedFor({ duration: short }) : t().worked;
  };
  /** In meta after a finished turn: its steps, what did not go through, and how it ended. */
  const stepParts = () => {
    if (isLive(segment().phase) || (!layout().steps && !summary())) return null;
    const parts = workStepParts(layout().work, layout().steps, locale());
    const ended = summary() && ending() ? (ending() === "stopped" ? t().workEndedStopped : t().workEndedInterrupted) : "";
    return { count: parts.count, issues: ended ? [...parts.issues, { text: ended }] : parts.issues };
  };
  const ariaLabel = () => {
    if (isLive(segment().phase)) return undefined;
    const duration = worked();
    const label = t().workedLabel({
      duration: duration === null ? "" : formatWorkDuration(duration, t(), true),
      steps: layout().steps ? workStepLine(layout().work, layout().steps, locale()) : "",
      ending: ending(),
    });
    return summary() ? `${summary()}. ${label}` : label;
  };
  const hasSteps = createMemo(() => layout().work.length > 0);
  // The turn went on after a step when a later step, its answer, or its normal end followed.
  const followed = (id: string) => {
    const work = layout().work;
    const index = work.findIndex((block) => block.id === id);
    return (index >= 0 && index < work.length - 1) || layout().text.length > 0 || segment().phase === "completed";
  };
  const work: AiWorkContextValue = {
    followed,
    // Steps read how the turn ended from its phase, also when a failure notice words the line itself.
    ending: () => (segment().phase === "stopped" ? "stopped" : segment().phase === "failed" ? "failed" : null),
    liveDuration: () => (working() ? formatStepDuration(Math.max(1000, stepMs()), t()) : undefined),
    turnId: () => segment().turnId,
  };
  // The steps' code loads in the background once the line is in the browser, before anyone opens it.
  onMount(() => void preloadAiWorkSteps());
  const steps = () => <AiWorkSteps blocks={layout().work} active={working()} work={work} />;
  /** The time beside the sentence, in tabular figures: the work time while it runs, how long it waits, or the total. */
  const timeMs = (): number | null => {
    const duration = segment().duration();
    if ((working() || reconnecting()) && duration) return Math.max(1000, duration.workedMs);
    if (waiting() && duration?.waitingMs !== null && duration?.waitingMs !== undefined) return duration.waitingMs;
    const total = worked();
    return summary() && total !== null ? total : null;
  };
  // The column holds the short form; its title spells it out, "for 12 minutes" while the turn waits.
  const time = () => {
    const ms = timeMs();
    return ms === null ? undefined : formatStepDuration(ms, t());
  };
  const timeTitle = () => {
    const ms = timeMs();
    if (ms === null) return undefined;
    const long = formatWorkDuration(ms, t(), true);
    return waiting() ? t().waitingSince({ duration: long }) : long;
  };
  return (
    <AiToolActivity
      blockId={`work:${segment().id}`}
      class="ai-turn-work"
      label={
        <span class="ai-turn-work__sentence" title={thinkingPhase() ? undefined : sentence()}>
          <Show when={thinkingPhase()} keyed fallback={sentence()}>
            {(phase) => (
              <Chat.Activity.Words
                first={t().thinking}
                words={thinkingWords(phase)}
                elapsedMs={thinkingMs()}
                announce={t().thinkingAnnouncement}
              />
            )}
          </Show>
        </span>
      }
      ariaLabel={ariaLabel()}
      icon={waiting() ? "ti ti-hand-stop" : "ti ti-sparkles"}
      tone="ai"
      busy={working()}
      meta={
        <Show when={stepParts()}>
          {(parts) => (
            <span class="ai-turn-work__steps" data-issues={parts().issues.length > 0 ? "" : undefined}>
              <span class="ai-turn-work__count">
                {parts().count}
                {parts().issues.length > 0 ? " · " : ""}
              </span>
              <For each={parts().issues}>
                {(issue, index) => (
                  <>
                    {index() > 0 ? " · " : ""}
                    <span data-tone={issue.tone}>{issue.text}</span>
                  </>
                )}
              </For>
            </span>
          )}
        </Show>
      }
      duration={time()}
      durationTitle={timeTitle()}
      bodyInset={false}
      // Nothing to open before the first step, so no chevron yet. Read through a memo, so the open list is built once
      // and never rebuilt while the turn updates.
      renderBody={hasSteps() ? steps : undefined}
    />
  );
}

/**
 * The height of a clamped text: `--ai-turn-clamp-lines` (effects.css) lines of its Markdown block. A status in place 3
 * keeps at most this height.
 */
const clampedHeight = (block: Element): number => {
  const style = getComputedStyle(block);
  return Number.parseFloat(style.getPropertyValue("--ai-turn-clamp-lines")) * Number.parseFloat(style.lineHeight);
};

/**
 * Text between steps. With `clamp`, a text longer than three lines shows three, its last line fading, and a chevron beside
 * its first line shows the rest; the chevron stays where it is when the text opens or closes. The limit comes from `clamp`
 * itself, so the server render is already short; measuring only decides the chevron and the fade. Without `clamp` (the
 * answer) it shows whole. A keyboard user who reaches a link in the faded or hidden part gets the whole text, with the
 * link in view. A new `reset` closes it.
 */
function AiClampedText(props: { html: string; clamp: boolean; reset?: unknown }) {
  const locale = useLocale();
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [long, setLong] = createSignal(false);
  let block: HTMLDivElement | undefined;
  const measure = () => {
    if (!block) return;
    setLong(props.clamp && block.scrollHeight > clampedHeight(block) + 1);
  };
  // A clamped text keeps its height while it grows, so the new text is measured, not only a new size.
  createEffect(on([() => props.html, () => props.clamp], measure));
  createEffect(
    on(
      () => props.reset,
      () => setOpen(false),
      { defer: true },
    ),
  );
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !block) return;
    const observer = new ResizeObserver(measure);
    observer.observe(block);
    onCleanup(() => observer.disconnect());
  });
  const t = () => aiChatMessages(locale());
  return (
    <div
      class="ai-turn-clamp"
      data-clamp={props.clamp ? "" : undefined}
      data-long={long() ? "" : undefined}
      data-open={open() ? "" : undefined}
      onFocusIn={(event) => {
        const target = event.target;
        if (!block || !long() || open() || !(target instanceof Element) || !block.contains(target)) return;
        // Links in the visible lines keep the text closed; only the faded last line and the clipped rest open it.
        const fade = block.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(block).lineHeight);
        if (target.getBoundingClientRect().bottom <= fade) return;
        setOpen(true);
        // A timeline that follows its end moves the opened text up in the next frame; bring the link back afterwards.
        requestAnimationFrame(() => requestAnimationFrame(() => target.scrollIntoView({ block: "nearest" })));
      }}
    >
      <AssistantMarkdownBlock
        id={id}
        ref={(element) => {
          block = element;
        }}
        html={props.html}
      />
      <Show when={long()}>
        <IconButton
          size="xs"
          class="ai-turn-clamp__toggle"
          label={open() ? t().textShowLess : t().textShowAll}
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <i class={open() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
        </IconButton>
      </Show>
    </div>
  );
}

const resultRecord = (block: ToolBlock) => (isRecord(block.result) ? block.result : null);

/** The application's own short summary of a result, if it fits on one line. */
const resultSummary = (block: ToolBlock): string => {
  const value = resultRecord(block)?.summary;
  return typeof value === "string" && value.trim().length <= 500 ? value.trim() : "";
};

/** The summary and links of a table result, unless its receipt in place 4 already shows them. */
function CapabilityResultRow(props: { block: ToolBlock }) {
  const locale = useLocale();
  const block = () => props.block;
  const summary = () => resultSummary(block());
  const links = () => resultLinks(block());
  return (
    <Show when={summary() || links().length > 0}>
      <Chat.Activity
        icon={aiToolIcon(block().name, block().presentation?.appIcon)}
        accent={block().presentation?.appAccent}
        label={summary() || (block().presentation?.title ?? displayToolName(block().name, locale()))}
        trailing={links().length > 0 ? <ResultLinks links={links()} /> : undefined}
      />
    </Show>
  );
}

function AiTurnResultView(props: { result: Accessor<AiTurnResult | undefined>; receipt: Accessor<boolean> }) {
  const locale = useLocale();
  const actions = useAiChatActions();
  const block = () => props.result()?.block;
  return (
    <Show when={block()}>
      {(current) => (
        <Switch>
          <Match when={current().name === "map"}>
            <AiMapToolBlock block={current()} />
          </Match>
          <Match when={current().name === "present"}>
            <PresentToolBlock block={current()} />
          </Match>
          <Match when={current().name === "code_present"}>
            {/* One host view per call: it reserves its frame while the call runs and keeps its session afterwards. */}
            <Show keyed when={current().callId}>
              {(_callId: string) =>
                untrack(() =>
                  actions.renderCodePresentation?.(() => {
                    const latest = block();
                    return latest?.status === "completed" ? latest.result : undefined;
                  }),
                )
              }
            </Show>
          </Match>
          <Match when={isCardToolName(current().name)}>
            <CloudCardBlock args={current().args} />
          </Match>
          <Match when={isChartToolName(current().name)}>
            <CloudChartBlock args={current().args} completed={current().status === "completed"} />
          </Match>
          <Match when={true}>
            <Show when={!props.receipt()}>
              <CapabilityResultRow block={current()} />
            </Show>
            <CapabilityTablePreview
              result={current().result}
              label={current().presentation?.title ?? displayToolName(current().name, locale())}
            />
          </Match>
        </Switch>
      )}
    </Show>
  );
}

function AiTurnActionView(props: { action: Accessor<AiTurnAction | undefined>; turnId: string; phase: AiTurnPhase }) {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const action = () => props.action();
  const state = () => action()?.state;
  // Screen readers hear a waiting approval once, as one short line instead of the whole card, without moving focus.
  createEffect(
    on(state, (next, previous) => {
      const current = action();
      if (next !== "open" || previous === "open" || !isLive(props.phase) || current?.block.status !== "awaiting_approval") return;
      announce(
        aiChatMessages(locale()).approvalNeeded({
          title:
            toolSubject(current.block, locale(), timeZone) ??
            current.block.presentation?.title ??
            displayToolName(current.block.name, locale()),
        }),
      );
    }),
  );
  return (
    <div class="ai-turn__action" aria-live="off">
      <Show when={action()}>
        {(current) => (
          <Switch>
            {/* A question and every outcome of its call share one element, so an answer collapses it in place. */}
            <Match when={current().state !== "interaction"}>
              <ToolActionView block={current().block} turnId={props.turnId} state={current().state} phase={props.phase} />
            </Match>
            <Match when={true}>
              <Switch
                fallback={
                  <Chat.Activity
                    label={current().block.presentation?.title ?? displayToolName(current().block.name, locale())}
                    icon={aiToolIcon(current().block.name)}
                    busy={current().block.status === "awaiting_client"}
                  />
                }
              >
                <Match when={isSurveyToolName(current().block.name)}>
                  <SurveyToolView turnId={props.turnId} block={current().block} active={isLive(props.phase)} />
                </Match>
                <Match when={current().block.name === "text_editor" || current().block.name === "cloud_text_editor"}>
                  <TextEditorToolView turnId={props.turnId} block={current().block} active={isLive(props.phase)} />
                </Match>
              </Switch>
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  );
}

/**
 * Output-limit notices use the established multiline message surface, so their explanation stays readable on phones.
 * Continue sends a visible follow-up through the host's normal send path, only while the newest turn is idle.
 */
function AiTurnStopNotice(props: { notice: AiStopNotice; continuable: boolean; answerAgain?: () => void | Promise<void> }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const actions = useAiChatActions();
  const [continuing, setContinuing] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const continueAnswer = async () => {
    if (continuing()) return;
    setContinuing(true);
    setFailed(false);
    try {
      await actions.onContinueTurn?.(t().continueTurnMessage);
    } catch {
      setFailed(true);
    } finally {
      setContinuing(false);
    }
  };
  return (
    <NoticeCard
      tone="warning"
      class="ai-turn__notice"
      title={
        props.notice.kind === "output_limit"
          ? t().outputLimitReached
          : props.notice.kind === "no_answer"
            ? t().noAnswerTitle
            : t().turnErrorTitle
      }
      detail={
        props.notice.kind === "output_limit" && props.notice.reasoning
          ? t().outputLimitReasoning
          : props.notice.kind === "no_answer"
            ? t().noAnswerDetail
            : undefined
      }
    >
      <Show when={props.continuable && actions.onContinueTurn}>
        <Button variant="text" size="sm" loading={continuing()} disabled={actions.actionDisabled?.()} onClick={() => void continueAnswer()}>
          <i class="ti ti-player-play" aria-hidden="true" /> {props.notice.kind === "no_answer" ? t().continueTurn : t().continueAnswer}
        </Button>
      </Show>
      <Show when={props.notice.kind === "no_answer" && props.answerAgain}>
        {(again) => (
          <Button variant="text" size="sm" disabled={actions.actionDisabled?.()} onClick={() => void again()()}>
            <i class="ti ti-refresh" aria-hidden="true" /> {t().actionAnswerAgain}
          </Button>
        )}
      </Show>
      <Show when={failed()}>
        <p role="alert">{t().continueAnswerFailed}</p>
      </Show>
    </NoticeCard>
  );
}

function AiTurnErrorNotice(props: { error: AiTurnError; continuable: boolean; kept: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const actions = useAiChatActions();
  const [continuing, setContinuing] = createSignal(false);
  const canContinue = () => props.continuable && aiTurnErrorCanContinue(props.error) && Boolean(actions.onContinueTurn);
  const continueTurn = async () => {
    if (continuing()) return;
    setContinuing(true);
    try {
      await actions.onContinueTurn?.(t().continueTurnMessage);
    } finally {
      setContinuing(false);
    }
  };
  return (
    <NoticeCard
      tone="danger"
      icon="ti ti-alert-circle"
      layout="card"
      class="ai-turn__notice"
      title={t().turnInterrupted({ reason: t().turnErrorReason(props.error) })}
      detail={props.kept ? t().keptSoFar : undefined}
    >
      <Show when={canContinue()}>
        <Button variant="text" size="sm" loading={continuing()} disabled={actions.actionDisabled?.()} onClick={() => void continueTurn()}>
          <i class="ti ti-player-play" aria-hidden="true" /> {t().continueTurn}
        </Button>
      </Show>
    </NoticeCard>
  );
}

/**
 * Place 3. Live it is a status that switches in this same element. Once a step started after it, it reads quietly like
 * the texts in the expanded work, at most three lines with a chevron for the rest; a trailing text may still be the answer
 * and keeps answer typography and its whole length. While the turn runs, the place keeps the height of the text before,
 * up to a clamped status, so short statuses do not jump and a long one leaves no empty space behind. A status is not read
 * token by token: screen readers hear each status once it is complete, and that the answer is ready.
 */
function AiTurnText(props: {
  blocks: Accessor<Extract<AiTurnBlock, { kind: "text" }>[]>;
  live: Accessor<boolean>;
  /** The turn has work steps, so its live text is a status rather than the answer itself. */
  folding: Accessor<boolean>;
  /** A step started after the text, so it can no longer be the answer: it reads quietly. */
  quiet: Accessor<boolean>;
  /** An earlier segment of a split turn: it stops being live while the turn goes on. */
  earlier: Accessor<boolean>;
  /** The turn ended with its answer; a stopped or failed turn keeps its text but its answer is not ready. */
  completed: Accessor<boolean>;
}) {
  const locale = useLocale();
  const status = () => props.live() && props.folding();
  const source = createMemo(() =>
    props
      .blocks()
      .map((block) => block.text)
      .join("\n\n"),
  );
  const html = createMemo(() => markdown.renderSync(source(), { locale: locale() }));
  const shownId = createMemo(() => props.blocks()[0]?.id);
  const quiet = createMemo(() => props.quiet());
  const [minHeight, setMinHeight] = createSignal<number | null>(null);
  let element!: HTMLDivElement;
  let lastHeight = 0;
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      lastHeight = element.offsetHeight;
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  /** The quiet text's height in answer typography, whole, measured in place before the browser paints. */
  const answerHeight = () => {
    const clamp = element.querySelector(".ai-turn-clamp");
    const marks = ["data-clamp", "data-long"].filter((name) => clamp?.hasAttribute(name));
    element.classList.remove("ai-turn__text--status");
    for (const name of marks) clamp?.removeAttribute(name);
    const height = element.offsetHeight;
    element.classList.add("ai-turn__text--status");
    for (const name of marks) clamp?.setAttribute(name, "");
    return height;
  };
  /** The height of a clamped status: no reserve is larger, so a long text leaves no empty space when it is replaced. */
  const statusLimit = () => {
    const block = element.querySelector(".assistant-markdown-block");
    return block ? clampedHeight(block) : 0;
  };
  // A new status keeps the height of the one before it, and a quiet status the height it has as the answer, also when it
  // first shows quietly after a reload; both only up to a clamped status. So short statuses and a short answer move
  // nothing below, and a long text that is replaced or folds to three lines leaves no empty space.
  createEffect(
    on([shownId, quiet], ([id, isQuiet], previous) => {
      if (!props.live()) return;
      const height = Math.min(statusLimit(), Math.max(previous && previous[0] !== id ? lastHeight : 0, isQuiet ? answerHeight() : 0));
      if (height > 0) setMinHeight((current) => Math.max(current ?? 0, height));
    }),
  );
  createEffect(() => {
    if (!props.live()) setMinHeight(null);
  });
  let shown = { id: untrack(shownId), text: untrack(source) };
  createEffect(
    on([shownId, source], ([id, text]) => {
      if (id !== shown.id && status() && shown.text.trim()) announce(shown.text);
      shown = { id, text };
    }),
  );
  createEffect(
    on(props.live, (live, wasLive) => {
      if (wasLive === true && !live && untrack(props.folding) && !untrack(props.earlier) && untrack(props.completed))
        announce(aiChatMessages(locale()).answerReady);
    }),
  );
  return (
    <div
      ref={element}
      class="ai-turn__text"
      classList={{ "ai-turn__text--status": quiet() }}
      aria-live={status() ? "off" : undefined}
      style={minHeight() ? { "min-height": `${minHeight()}px` } : undefined}
    >
      <AiClampedText html={html()} clamp={quiet()} reset={shownId()} />
    </div>
  );
}

/**
 * One assistant turn segment in four fixed places: the work line, results, the newest text, and actions. Results and
 * actions are keyed by their call, so a running Studio preview or a decided approval keeps its element when the live
 * turn becomes history.
 */
export function AiTurnView(props: { segment: Accessor<AiTurnSegment>; disclosureState: AiToolDisclosureState }): JSX.Element {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const chatActions = useAiChatActions();
  const layout = () => props.segment().layout;
  const results = createMemo(() => new Map(layout().results.map((result) => [result.id, result])));
  const isMapFollowup = (id: string) => {
    const block = results().get(id)?.block;
    return (
      block?.name === "map" &&
      typeof block.result === "object" &&
      block.result !== null &&
      "anchor" in block.result &&
      block.result.anchor === false
    );
  };
  const resultIds = createMemo(() => [...results().keys()].filter((id) => !isMapFollowup(id)));
  const mapFollowupIds = createMemo(() => [...results().keys()].filter(isMapFollowup));
  const actions = createMemo(() => new Map(layout().actions.map((action) => [action.id, action])));
  const actionIds = createMemo(() => [...actions().keys()]);
  const live = () => isLive(props.segment().phase);
  // One "Answer again" at a time: a second click while the first is on its way would ask the controller to stop it.
  const [answering, setAnswering] = createSignal(false);
  const answerAgain = async (run: () => unknown) => {
    if (answering()) return;
    setAnswering(true);
    try {
      await run();
    } catch {
      // The chat controller shows why the message could not be answered again.
    } finally {
      setAnswering(false);
    }
  };
  // The sources the finished answer cites, numbered as in its text. Read once the turn ends, from the same sanitized HTML
  // the answer shows, so a link the sanitizer drops never comes back as a source.
  const sources = createMemo(() => {
    if (live()) return [];
    const text = layout()
      .text.map((block) => block.text)
      .join("\n\n");
    return text.includes("](") ? answerSources(markdown.renderSync(text, { locale: locale() }), layout().work) : [];
  });
  // A question that expired says itself why the turn ended and offers to ask again; a second notice for the same cause,
  // with a second way out, would repeat it (Rundgang 7, N1).
  const notice = () => {
    const error = props.segment().error;
    const expired = layout().actions.some((action) => action.state === "not_run" && action.block.approved === false);
    return error?.code === "wait_expired" && expired ? null : error;
  };
  /** Something of the turn stays above its failure notice. */
  const kept = () => layout().text.length > 0 || layout().results.length > 0 || layout().steps > 0;
  // Screen readers hear once that the turn they followed failed and why, as the notice says it; history read later is not
  // announced.
  createEffect(
    on(live, (now, before) => {
      const error = props.segment().error;
      if (before && !now && error) {
        const t = aiChatMessages(locale());
        announce([t.turnInterrupted({ reason: t.turnErrorReason(error) }), kept() ? t.keptSoFar : ""].filter(Boolean).join(" "));
      }
    }),
  );
  return (
    <AiToolDisclosureProvider state={props.disclosureState}>
      <div class="ai-turn">
        <Show when={props.segment().scheduledTask}>
          {(task) => (
            <Button
              variant="ghost"
              size="xs"
              class="self-start"
              onClick={() => chatActions.onOpenScheduledTaskRun?.(task().taskId, task().occurrenceId)}
              disabled={!chatActions.onOpenScheduledTaskRun}
            >
              <i class="ti ti-calendar-time" aria-hidden="true" /> {aiChatMessages(locale()).backgroundRun}
            </Button>
          )}
        </Show>
        <Show when={layout().showWork}>
          {/* The live label and clock change every second; the conversation log must not read them out. */}
          <div class="ai-turn__work" aria-live="off">
            <AiWorkLine segment={props.segment} />
          </div>
        </Show>
        <For each={resultIds()}>{(id) => <AiTurnResultView result={() => results().get(id)} receipt={() => actions().has(id)} />}</For>
        <Show when={props.segment().scheduledTask?.stop}>
          {(stop) => (
            <Chat.Activity
              class="ai-turn__routine-line"
              wrap
              icon="ti ti-player-stop"
              label={chatTaskStopSentence(stop().done, locale())}
            />
          )}
        </Show>
        <Show when={layout().text.length > 0 && !props.segment().scheduledTask?.stop && !props.segment().scheduledTask?.reasonOnly}>
          <AiTurnText
            blocks={() => layout().text}
            live={live}
            folding={() => layout().steps > 0}
            quiet={() => layout().textIsStatus}
            earlier={() => props.segment().earlier}
            completed={() => props.segment().phase === "completed"}
          />
        </Show>
        <Show when={!live() && !props.segment().scheduledTask?.stop && !props.segment().scheduledTask?.reasonOnly}>
          <AiAnswerSources sources={sources()} />
        </Show>
        <For each={mapFollowupIds()}>{(id) => <AiTurnResultView result={() => results().get(id)} receipt={() => false} />}</For>
        <Show when={props.segment().scheduledTask?.stop ? undefined : props.segment().scheduledTask?.reason}>
          {(reason) => (
            <Chat.Activity
              class="ai-turn__routine-line"
              wrap
              icon={chatTaskReasonState(reason().code) === "paused" ? "ti ti-player-pause" : "ti ti-alert-triangle"}
              tone={chatTaskReasonState(reason().code) === "paused" ? "neutral" : "warning"}
              label={chatTaskReasonSentence(reason(), { locale: locale(), timeZone })}
            />
          )}
        </Show>
        <For each={actionIds()}>
          {(id) => <AiTurnActionView action={() => actions().get(id)} turnId={props.segment().turnId} phase={props.segment().phase} />}
        </For>
        <Show when={props.segment().reconnect === "row"}>
          {/* Calm by design: no busy sweep while the turn reconnects. */}
          <Chat.Activity label={aiChatMessages(locale()).reconnecting} icon="ti ti-refresh" />
        </Show>
        <Show when={props.segment().phase === "stopped" && !props.segment().earlier && props.segment().stoppedByPerson}>
          {/* Calm by design: the person stopped it, so this is a quiet line, not a warning. */}
          <Chat.Activity
            class="ai-turn__stopped"
            wrap
            icon="ti ti-player-stop"
            label={layout().text.length > 0 ? aiChatMessages(locale()).stoppedTextStays : aiChatMessages(locale()).stoppedByYou}
            trailing={
              <Show when={props.segment().answerAgain}>
                {(again) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={answering()}
                    onClick={() => void answerAgain(again())}
                    disabled={chatActions.actionDisabled?.()}
                  >
                    <i class="ti ti-refresh" aria-hidden="true" /> {aiChatMessages(locale()).actionAnswerAgain}
                  </Button>
                )}
              </Show>
            }
          />
        </Show>
        <Show when={notice()}>
          {(error) => <AiTurnErrorNotice error={error()} continuable={props.segment().continuable === true} kept={kept()} />}
        </Show>
        <Show when={props.segment().stopNotice}>
          {(notice) => (
            <AiTurnStopNotice
              notice={notice()}
              continuable={props.segment().continuable === true}
              answerAgain={props.segment().answerAgain}
            />
          )}
        </Show>
      </div>
    </AiToolDisclosureProvider>
  );
}
