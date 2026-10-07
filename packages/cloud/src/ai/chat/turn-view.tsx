import { announce, Button, ButtonLink, Chat, NoticeCard, useLocale } from "@k2b/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
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
import { markdown } from "../../shared";
import { AI_TURN_LEASE_MS, type AiTurnBlock } from "../protocol";
import type { AiTurnError } from "../types";
import { ApprovalBlockView, CompactionBlockView, CompactToolRow, SurveyToolView, TextEditorToolView } from "./blocks";
import { CapabilityTablePreview } from "./capability-table";
import { PresentToolBlock } from "./file-tools";
import { useAiChatActions } from "./message-actions";
import { aiToolIcon, capabilityErrorDescription, displayToolName, isCardToolName, isRecord, isSurveyToolName } from "./message-utils";
import { aiChatMessages } from "./messages";
import { AssistantMarkdownBlock } from "./primitives";
import { AiToolActivity, AiToolDisclosureProvider, type AiToolDisclosureState } from "./tool-disclosure";
import { type AiWorkEntry, countWorkSteps, groupWorkBlocks, summarizeToolGroup } from "./tool-groups";
import { aiTurnErrorCanContinue, aiTurnErrorDescription } from "./turn-error";
import type { AiTurnAction, AiTurnLayout, AiTurnPhase, AiTurnResult } from "./turn-layout";
import { CloudCardBlock } from "./visual-tools";

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
  /** Shown above the work of a delivered scheduled result. */
  scheduledTask?: { taskId: string; occurrenceId: string } | null;
  /**
   * The live turn cannot reach the model or the server right now: a model call waits for its retry, or the stream
   * reconnects. The working segment's work line says so while its clock stands; a turn without a work line yet says
   * it in a row at the end of its last segment.
   */
  reconnect?: "line" | "row";
  /** Why the turn failed, shown in a notice at its end. Only the last segment of a failed turn carries it. */
  error?: AiTurnError | null;
  /** The failed turn is the chat's newest and nothing runs, so a new message can pick up its work. */
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

/** Identity of the current step: it changes when another block becomes current or the current call changes state. */
const stepKey = (block: AiTurnBlock | null): string =>
  !block ? "start" : `${block.id}:${block.kind === "tool" || block.kind === "compaction" ? block.status : block.kind}`;

/** A running clock: "2:41", "1:02:41". */
export const formatWorkClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1) || value;

const toolTarget = (block: ToolBlock): string => {
  const args = isRecord(block.args) ? block.args : {};
  const value = [args.path, args.name, args.title, args.query].find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? basename(value.trim()) : "";
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
  if (["code_write", "code_create", "code_update", "code_fork", "code_remove", "code_restore"].includes(name))
    return withTarget(t.stepWritingCode);
  if (["code_run", "code_action", "code_sql"].includes(name)) return withTarget(t.stepRunningCode);
  if (["code_inspect", "code_interact"].includes(name)) return t.stepCheckingApp;
  if (name.startsWith("code_")) return t.stepCode;
  if (["markdown_to_pdf", "html_to_pdf"].includes(name)) return withTarget(t.stepPdf);
  if (["load_skill", "load_tools", "search_tools", "list_apps"].includes(name)) return t.stepLoading;
  if (name.startsWith("web_") || name === "fetch_file") return t.stepWeb;
  if (name === "memory") return t.stepMemory;
  if (name === "calculate") return t.stepCalculating;
  return withTarget(t.stepTool);
};

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
  const steps = () => t().steps({ count: layout().steps });
  const label = () => {
    if (reconnecting()) return t().reconnecting;
    if (working()) return liveStepLabel(layout().current, t(), stepMs());
    if (waiting()) return layout().waitingFor === "approval" ? t().waitingForApproval : t().waitingForAnswer;
    const duration = worked();
    const short = duration === null ? "" : formatWorkDuration(duration, t());
    if (segment().phase === "stopped") return t().workedStopped({ duration: short });
    // A failed turn with a stored reason says it in its notice; the line then reads like any finished turn.
    if (segment().phase === "failed" && !segment().error) return t().workedInterrupted({ duration: short });
    return short ? t().workedFor({ duration: short }) : t().worked;
  };
  const ariaLabel = () => {
    const phase = segment().phase;
    if (isLive(phase)) return undefined;
    const duration = worked();
    return t().workedLabel({
      duration: duration === null ? "" : formatWorkDuration(duration, t(), true),
      steps: layout().steps ? steps() : "",
      ending: phase === "stopped" || (phase === "failed" && !segment().error) ? phase : null,
    });
  };
  const trailing = () => {
    const duration = segment().duration();
    if ((working() || reconnecting()) && duration) {
      return (
        <span class="ai-turn-work__meta">
          {formatWorkClock(duration.workedMs)}
          <span class="ai-turn-work__live-steps"> · {steps()}</span>
        </span>
      );
    }
    if (waiting() && duration?.waitingMs !== null && duration?.waitingMs !== undefined) {
      return (
        <span class="ai-turn-work__meta">
          {t().waitingSince({ duration: formatWorkDuration(duration.waitingMs, t()) })}
          <span class="ai-turn-work__live-steps"> · {steps()}</span>
        </span>
      );
    }
    return layout().steps ? <span class="ai-turn-work__meta">{steps()}</span> : undefined;
  };
  return (
    <AiToolActivity
      blockId={`work:${segment().id}`}
      class="ai-turn-work"
      label={label()}
      ariaLabel={ariaLabel()}
      icon={waiting() ? "ti ti-hand-stop" : segment().phase === "stopped" ? "ti ti-player-stop" : "ti ti-route"}
      tone={working() ? "ai" : "neutral"}
      busy={working()}
      trailing={trailing()}
      renderBody={() => <AiWorkSteps blocks={layout().work} active={working()} />}
    />
  );
}

function ThoughtRow(props: { block: Extract<AiTurnBlock, { kind: "thinking" }>; busy: boolean }) {
  const locale = useLocale();
  const firstLine = () =>
    props.block.text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return (
    <Show when={firstLine()} fallback={<Chat.Activity label={aiChatMessages(locale()).stepThinking} icon="ti ti-bulb" busy={props.busy} />}>
      <AiToolActivity
        blockId={props.block.id}
        label={firstLine()}
        icon="ti ti-bulb"
        renderBody={() => <p class="ai-turn-steps__thought">{props.block.text.trim()}</p>}
      />
    </Show>
  );
}

function WorkEntryRow(props: { entry: AiWorkEntry; busy: boolean }) {
  const locale = useLocale();
  return (
    <Switch>
      <Match when={props.entry.kind === "tool" && props.entry}>{(tool) => <CompactToolRow block={tool()} busy={props.busy} />}</Match>
      <Match when={props.entry.kind === "thinking" && props.entry}>{(thought) => <ThoughtRow block={thought()} busy={props.busy} />}</Match>
      <Match when={props.entry.kind === "compaction" && props.entry}>{(compaction) => <CompactionBlockView block={compaction()} />}</Match>
      <Match when={props.entry.kind === "steer_applied"}>
        <Chat.Activity label={aiChatMessages(locale()).steered} icon="ti ti-route" />
      </Match>
    </Switch>
  );
}

function WorkGroup(props: { id: string; entries: AiWorkEntry[]; active: boolean }) {
  const locale = useLocale();
  const tools = () => props.entries.filter((entry): entry is ToolBlock => entry.kind === "tool");
  const last = () => props.entries.at(-1)!;
  return (
    <Show when={props.entries.length > 1} fallback={<WorkEntryRow entry={last()} busy={props.active} />}>
      <AiToolActivity
        blockId={`group:${props.id}`}
        label={tools().length ? summarizeToolGroup(tools(), locale()) : aiChatMessages(locale()).reasoning}
        description={countWorkSteps(props.entries, locale())}
        icon="ti ti-stack-2"
        busy={props.active && last().kind === "tool" && (last() as ToolBlock).status === "running"}
        renderBody={() => (
          <For each={props.entries}>
            {(entry, index) => <WorkEntryRow entry={entry} busy={props.active && index() === props.entries.length - 1} />}
          </For>
        )}
      />
    </Show>
  );
}

function WorkText(props: { text: string }) {
  const locale = useLocale();
  // Render Markdown only when the text itself changes, not on every update of the turn around it.
  const text = createMemo(() => props.text);
  const html = createMemo(() => markdown.renderSync(text(), { locale: locale() }));
  return (
    <div class="ai-turn-steps__text">
      <AssistantMarkdownBlock html={html()} />
    </div>
  );
}

/** Expanded work: intermediate texts as quiet paragraphs, the steps between them as groups. One indent, one size. */
function AiWorkSteps(props: { blocks: AiTurnBlock[]; active: boolean }) {
  const groups = createMemo(() => groupWorkBlocks(props.blocks));
  const keyed = createMemo(
    () => new Map(groups().map((group) => [group.kind === "text" ? `text:${group.block.id}` : `steps:${group.id}`, group])),
  );
  const keys = createMemo(() => [...keyed().keys()]);
  return (
    <div class="ai-turn-steps">
      <For each={keys()}>
        {(key, index) => {
          const group = () => keyed().get(key);
          const text = () => {
            const value = group();
            return value?.kind === "text" ? value.block.text : undefined;
          };
          const steps = () => {
            const value = group();
            return value?.kind === "steps" ? value : undefined;
          };
          return (
            <Switch>
              <Match when={text() !== undefined}>
                <WorkText text={text()!} />
              </Match>
              <Match when={steps()}>
                {(value) => <WorkGroup id={value().id} entries={value().entries} active={props.active && index() === keys().length - 1} />}
              </Match>
            </Switch>
          );
        }}
      </For>
    </div>
  );
}

const resultRecord = (block: ToolBlock) => (isRecord(block.result) ? block.result : null);

/** The application's own short summary of a result, if it fits on one line. */
const resultSummary = (block: ToolBlock): string => {
  const value = resultRecord(block)?.summary;
  return typeof value === "string" && value.trim().length <= 500 ? value.trim() : "";
};

/** Links a result offers, limited to paths inside this Cloud. */
const resultLinks = (block: ToolBlock): Record<string, unknown>[] => {
  const value = resultRecord(block)?.links;
  return Array.isArray(value)
    ? value.filter(
        (link): link is Record<string, unknown> =>
          isRecord(link) && typeof link.href === "string" && /^\/(?![\\/])[^\\\u0000-\u001f\u007f]*$/.test(link.href),
      )
    : [];
};

function ResultLinks(props: { links: Record<string, unknown>[] }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const label = (link: Record<string, unknown>) =>
    typeof link.title === "string" ? link.title : link.rel === "edit" ? t().edit : link.rel === "download" ? t().download : t().open;
  return (
    <span class="flex min-w-0 flex-wrap items-center justify-end gap-1">
      <For each={props.links}>
        {(link) => (
          <ButtonLink
            class="ai-chat-result-link"
            href={String(link.href)}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            variant="ghost"
          >
            {label(link)}
          </ButtonLink>
        )}
      </For>
    </span>
  );
}

/** The summary and links of a table result, unless its receipt in place 4 already shows them. */
function CapabilityResultRow(props: { block: ToolBlock }) {
  const block = () => props.block;
  const summary = () => resultSummary(block());
  const links = () => resultLinks(block());
  return (
    <Show when={summary() || links().length > 0}>
      <Chat.Activity
        icon={aiToolIcon(block().name, block().presentation?.appIcon)}
        accent={block().presentation?.appAccent}
        label={summary() || (block().presentation?.title ?? displayToolName(block().name))}
        trailing={links().length > 0 ? <ResultLinks links={links()} /> : undefined}
      />
    </Show>
  );
}

function AiTurnResultView(props: { result: Accessor<AiTurnResult | undefined>; receipt: Accessor<boolean> }) {
  const actions = useAiChatActions();
  const block = () => props.result()?.block;
  return (
    <Show when={block()}>
      {(current) => (
        <Switch>
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
          <Match when={true}>
            <Show when={!props.receipt()}>
              <CapabilityResultRow block={current()} />
            </Show>
            <CapabilityTablePreview result={current().result} label={current().presentation?.title ?? displayToolName(current().name)} />
          </Match>
        </Switch>
      )}
    </Show>
  );
}

function AiReceipt(props: { action: AiTurnAction; stopped: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const block = () => props.action.block;
  const title = () => block().presentation?.title ?? displayToolName(block().name);
  const links = () => (props.action.state === "done" ? resultLinks(block()) : []);
  const label = () => {
    const state = props.action.state;
    if (state === "done") {
      const summary = resultSummary(block());
      if (summary) return summary;
      // A tool that is not a Cloud action has no effect of its own to report; the receipt records the decision.
      return block().presentation?.kind === "capability" ? t().receiptDone({ title: title() }) : t().receiptApproved({ title: title() });
    }
    if (state === "rejected") return t().receiptRejected({ title: title() });
    if (state === "failed") return t().receiptFailed({ title: title() });
    return t().receiptNotRun({ title: title(), stopped: props.stopped });
  };
  return (
    <Chat.Activity
      class="ai-turn-receipt"
      icon={aiToolIcon(block().name, block().presentation?.appIcon)}
      accent={block().presentation?.appAccent}
      label={label()}
      description={props.action.state === "failed" ? capabilityErrorDescription(block().result) : undefined}
      trailing={links().length > 0 ? <ResultLinks links={links()} /> : undefined}
    />
  );
}

function AiTurnActionView(props: { action: Accessor<AiTurnAction | undefined>; turnId: string; phase: AiTurnPhase }) {
  const locale = useLocale();
  let row!: HTMLDivElement;
  // Set while focus is in this place, including after the focused control disappeared with the decided card.
  let focusedHere = false;
  const action = () => props.action();
  const state = () => action()?.state;
  // Screen readers hear a waiting approval once, as one short line instead of the whole card, without moving focus.
  createEffect(
    on(state, (next, previous) => {
      const current = action();
      if (next !== "open" || previous === "open" || !isLive(props.phase) || current?.block.status !== "awaiting_approval") return;
      announce(
        aiChatMessages(locale()).approvalNeeded({ title: current.block.presentation?.title ?? displayToolName(current.block.name) }),
      );
    }),
  );
  // A card the user decided becomes its receipt in place. Focus stays on that place without scrolling.
  createEffect(
    on(state, (next, previous) => {
      if (previous !== "open" || next === "open" || !focusedHere || typeof document === "undefined") return;
      const focused = document.activeElement;
      if (!focused || focused === document.body || row.contains(focused)) row.focus({ preventScroll: true });
    }),
  );
  return (
    <div
      ref={row}
      class="ai-turn__action"
      aria-live="off"
      tabIndex={-1}
      onFocusIn={() => {
        focusedHere = true;
      }}
      onFocusOut={(event) => {
        if (event.relatedTarget instanceof Node && !row.contains(event.relatedTarget)) focusedHere = false;
      }}
    >
      <Show when={action()}>
        {(current) => (
          <Switch fallback={<AiReceipt action={current()} stopped={props.phase === "stopped"} />}>
            <Match when={current().state === "open" && current().block.status === "awaiting_approval"}>
              <ApprovalBlockView turnId={props.turnId} block={current().block} />
            </Match>
            <Match when={current().state === "open" || current().state === "interaction"}>
              <Switch
                fallback={
                  <Chat.Activity
                    label={current().block.presentation?.title ?? displayToolName(current().block.name)}
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
            <Match when={current().state === "running"}>
              <Chat.Activity
                label={current().block.presentation?.title ?? displayToolName(current().block.name)}
                icon={aiToolIcon(current().block.name, current().block.presentation?.appIcon)}
                accent={current().block.presentation?.appAccent}
                busy
              />
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  );
}

/**
 * Why a turn failed and what comes next, at its end. "Continue" sends a visible message through the host's normal
 * send path, so the person sees what was asked; it is offered only for the chat's newest turn and only when a new
 * turn can finish the work.
 */
function AiTurnErrorNotice(props: { error: AiTurnError; continuable: boolean }) {
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
    <NoticeCard tone="danger" class="ai-turn__notice" title={t().turnErrorTitle} detail={aiTurnErrorDescription(props.error, locale())}>
      <Show when={canContinue()}>
        <Button variant="text" size="sm" loading={continuing()} disabled={actions.actionDisabled?.()} onClick={() => void continueTurn()}>
          <i class="ti ti-player-play" aria-hidden="true" /> {t().continueTurn}
        </Button>
      </Show>
    </NoticeCard>
  );
}

/**
 * Place 3. Live it is a status that switches in this same element; it keeps its height until the turn ends. A status
 * is not read token by token: screen readers hear each status once it is complete, and that the answer is ready.
 */
function AiTurnText(props: {
  blocks: Accessor<Extract<AiTurnBlock, { kind: "text" }>[]>;
  live: Accessor<boolean>;
  /** The turn has work steps, so its live text is a status rather than the answer itself. */
  folding: Accessor<boolean>;
  /** An earlier segment of a split turn: it stops being live while the turn goes on. */
  earlier: Accessor<boolean>;
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
  createEffect(
    on(
      shownId,
      () => {
        if (props.live() && lastHeight > 0) setMinHeight((current) => Math.max(current ?? 0, lastHeight));
      },
      { defer: true },
    ),
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
      if (wasLive === true && !live && untrack(props.folding) && !untrack(props.earlier)) announce(aiChatMessages(locale()).answerReady);
    }),
  );
  return (
    <div
      ref={element}
      class="ai-turn__text"
      aria-live={status() ? "off" : undefined}
      style={minHeight() ? { "min-height": `${minHeight()}px` } : undefined}
    >
      <AssistantMarkdownBlock html={html()} />
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
  const chatActions = useAiChatActions();
  const layout = () => props.segment().layout;
  const results = createMemo(() => new Map(layout().results.map((result) => [result.id, result])));
  const resultIds = createMemo(() => [...results().keys()]);
  const actions = createMemo(() => new Map(layout().actions.map((action) => [action.id, action])));
  const actionIds = createMemo(() => [...actions().keys()]);
  const live = () => isLive(props.segment().phase);
  // Screen readers hear once that the turn they followed failed and why; history read later is not announced.
  createEffect(
    on(live, (now, before) => {
      const error = props.segment().error;
      if (before && !now && error) {
        const t = aiChatMessages(locale());
        announce(`${t.turnErrorTitle} ${aiTurnErrorDescription(error, locale())}`);
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
        <Show when={layout().text.length > 0}>
          <AiTurnText blocks={() => layout().text} live={live} folding={() => layout().steps > 0} earlier={() => props.segment().earlier} />
        </Show>
        <For each={actionIds()}>
          {(id) => <AiTurnActionView action={() => actions().get(id)} turnId={props.segment().turnId} phase={props.segment().phase} />}
        </For>
        <Show when={props.segment().reconnect === "row"}>
          {/* Calm by design: no busy sweep while the turn reconnects. */}
          <Chat.Activity label={aiChatMessages(locale()).reconnecting} icon="ti ti-refresh" />
        </Show>
        <Show when={props.segment().error}>
          {(error) => <AiTurnErrorNotice error={error()} continuable={props.segment().continuable === true} />}
        </Show>
      </div>
    </AiToolDisclosureProvider>
  );
}
