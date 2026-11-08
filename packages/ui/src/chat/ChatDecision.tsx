import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { Button } from "../actions/Button";
import { Checkbox } from "../inputs/Checkbox";
import type { ChatDecisionAnswer, ChatDecisionReason, ChatDecisionState, ChatOutcomeLine, ChatOutcomeTone } from "./types";

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ChatDecisionProps = {
  /** `open` shows the question; every other state shows the head and `outcome` in its place. */
  state: ChatDecisionState;
  /**
   * `approve` asks for the answer. `edit` is the same card while the person still changes its details: a raised
   * island instead of the tinted ground, the details editable, and `confirm` moves on to `approve`. Both have the same
   * size, so switching moves nothing.
   */
  mode?: "approve" | "edit";
  /** What the card is, such as "Approval" with `ti ti-shield-check`, or "Draft" with `ti ti-pencil`. */
  kind: { label: string; icon: string };
  /** Who asks: the app's name and icon, its icon tile in `accent`. */
  source: { name: string; icon: string; accent?: string };
  /** The state as a word with its icon at the end of the head, for every state but an open question. */
  status?: { label: string; icon: string; tone: ChatOutcomeTone };
  /** The question as one sentence, usually with `ReferenceChip`s. */
  sentence: JSX.Element;
  /** Why this question is asked, in the platform's words. */
  reason: ChatDecisionReason;
  /** The thing itself on the surface colour, under its own label such as "Details from Mail". */
  details?: { label: string; content: JSX.Element };
  /** Quiet facts at the start of the answer row, such as when the question expires. */
  meta?: readonly { text: string; icon: string }[];
  /** The main answer, named by verb and target ("Send to Lea"); the only filled button. */
  confirm: ChatDecisionAnswer;
  /** The other answer ("Don't send"). */
  decline: ChatDecisionAnswer;
  /** A quiet answer before the others, such as "Change" back to `edit`. It turns off with `waiting` only. */
  back?: ChatDecisionAnswer;
  /**
   * A checkbox in the answer row, such as "Don't ask again here". Checked, `confirm` calls this answer's `onSelect`
   * instead of its own.
   */
  remember?: ChatDecisionAnswer;
  /** Turns `confirm` and `remember` off; this reason replaces `reason` in the same place. */
  unavailable?: ChatDecisionReason;
  /**
   * Turns every answer off until the reason clears, such as no connection, so no answer is lost on the way; this
   * reason replaces `reason` and `unavailable` in the same place.
   */
  waiting?: ChatDecisionReason;
  /** The result line shown in every state but `open`, usually `Chat.Outcome`. */
  outcome?: JSX.Element;
  /** Receives a rejected promise from an answer's `onSelect`. */
  onAnswerError?: (error: unknown) => void;
  anchorId?: string | number;
  class?: string;
};

/** What an outcome inside a question needs from it: whether it was just answered here, and a link press inside it. */
const DecisionScope = createContext<{ answered: () => boolean; pressed: () => void; released: () => void }>();

const reasonIcon = (reason: ChatDecisionReason) => reason.icon ?? "ti ti-info-circle";

/**
 * A question the person answers: what it is and who asks, one sentence, why it is asked, the thing itself, and the
 * answers. It has one look in every place: a tinted ground in the AI colour, its own AI primary colour, no rules. An
 * answer collapses it at once to its head and one outcome line, which takes the focus and is announced.
 */
export function ChatDecision(props: ChatDecisionProps): JSX.Element {
  const id = createUniqueId();
  const sentenceId = `k2b-chat-decision-${id}-sentence`;
  const reasonId = `k2b-chat-decision-${id}-reason`;
  const [remembered, setRemembered] = createSignal(false);
  const editing = () => (props.mode ?? "approve") === "edit";
  let root: HTMLElement | undefined;
  let sentence: HTMLParagraphElement | undefined;
  // An answer given here moves the focus to the outcome; a click in the outcome that reopens the question moves it
  // back to the sentence. A state change from elsewhere moves no focus.
  const [answeredHere, setAnsweredHere] = createSignal(false);
  const [arrive, setArrive] = createSignal(false);
  let reopenedHere = false;
  // A press on the sentence focuses it too; only a focus moved there from elsewhere, such as a jump, lights it up.
  // The browser also focuses the sentence again when its window comes back; that is no arrival either.
  let sentencePressed = false;
  let sentenceHeldAcrossWindow = false;
  const windowLeft = () => {
    if (sentence && document.activeElement === sentence) sentenceHeldAcrossWindow = true;
  };
  onMount(() => {
    window.addEventListener("blur", windowLeft);
    onCleanup(() => window.removeEventListener("blur", windowLeft));
  });
  // A press counts only while its action runs: a reopen from elsewhere later must not take the focus.
  const scope = {
    answered: answeredHere,
    pressed: () => {
      reopenedHere = true;
    },
    released: () => {
      reopenedHere = false;
    },
  };

  // Read once: an object literal from the host builds its JSX again on every read.
  const reason = createMemo(() => props.waiting ?? props.unavailable ?? props.reason);
  const confirmOff = () => Boolean(props.waiting ?? props.unavailable);
  const open = () => props.state === "open";

  const answer = (choice: ChatDecisionAnswer, enabled: boolean) => {
    if (!enabled || !open() || answeredHere()) return;
    setAnsweredHere(true);
    try {
      const result = choice.onSelect();
      if (result instanceof Promise) result.catch((error: unknown) => props.onAnswerError?.(error));
    } catch (error) {
      props.onAnswerError?.(error);
    }
    // A host that keeps the question open (it could not take the answer) gets working buttons back.
    queueMicrotask(() => {
      if (open()) setAnsweredHere(false);
    });
  };

  createEffect(
    on(
      () => props.state,
      (state, previous) => {
        if (state !== "open" && previous === "open" && answeredHere()) {
          root?.querySelector<HTMLElement>(".k2b-chat-outcome")?.focus({ preventScroll: true });
        }
        if (state === "open" && previous !== undefined && previous !== "open") {
          // A host that could not take an answer given here returns the question from `sending`; the outcome that held
          // the focus is gone, so the focus goes back to the sentence instead of the page.
          const active = document.activeElement;
          const failedHere = answeredHere() && previous === "sending" && (!active || active === document.body);
          setAnsweredHere(false);
          if (reopenedHere || failedHere) {
            sentence?.focus({ preventScroll: true });
            setArrive(true);
          }
          // Handled. Until then the marker holds through states in between, such as `sending` while a reopen loads.
          reopenedHere = false;
        }
      },
    ),
  );

  // A switch between editing and approving made here keeps the person on the question, now with its new words.
  createEffect(
    on(
      editing,
      () => {
        if (root?.contains(document.activeElement) && document.activeElement !== sentence) sentence?.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );

  const confirm = () => {
    const chosen = props.remember && remembered() && !editing() ? props.remember : props.confirm;
    answer(chosen, !confirmOff());
  };

  return (
    <section
      ref={root}
      class={`k2b-chat-decision ${props.class ?? ""}`}
      data-state={props.state}
      data-mode={open() && editing() ? "edit" : "approve"}
      data-k2b-primary="ai"
      data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
      aria-labelledby={open() ? sentenceId : undefined}
      aria-describedby={open() ? reasonId : undefined}
      aria-label={open() ? undefined : `${props.kind.label} · ${props.source.name}${props.status ? `: ${props.status.label}` : ""}`}
    >
      <div class="k2b-chat-decision__head">
        <i class={`k2b-chat-decision__kind-icon ${props.kind.icon}`} aria-hidden="true" />
        <span class="k2b-chat-decision__kind">{props.kind.label}</span>
        <span aria-hidden="true">·</span>
        <span class="k2b-chat-decision__source">
          <span class="k2b-chat-decision__tile k2b-icon-tile" style={props.source.accent ? { color: props.source.accent } : undefined}>
            <i class={props.source.icon} aria-hidden="true" />
          </span>
          {props.source.name}
        </span>
        <Show when={!open() && props.status}>
          {(status) => (
            <span class="k2b-chat-decision__status" data-tone={status().tone}>
              <i class={status().icon} aria-hidden="true" />
              {status().label}
            </span>
          )}
        </Show>
      </div>
      <Show when={open()} fallback={<DecisionScope.Provider value={scope}>{props.outcome}</DecisionScope.Provider>}>
        <>
          <p
            ref={sentence}
            id={sentenceId}
            class="k2b-chat-decision__sentence"
            tabindex="-1"
            data-arrive={arrive() ? "true" : undefined}
            onPointerDown={() => {
              sentencePressed = true;
            }}
            onPointerUp={() => {
              sentencePressed = false;
            }}
            onPointerCancel={() => {
              sentencePressed = false;
            }}
            onFocus={() => {
              if (!sentencePressed && !sentenceHeldAcrossWindow) setArrive(true);
              sentencePressed = false;
              sentenceHeldAcrossWindow = false;
            }}
            onAnimationEnd={() => setArrive(false)}
          >
            {props.sentence}
          </p>
          <p id={reasonId} class="k2b-chat-line k2b-chat-decision__reason" data-tone={reason().tone ?? "neutral"}>
            <i class={`k2b-chat-line__icon ${reasonIcon(reason())}`} aria-hidden="true" />
            <span class="k2b-chat-line__text">{reason().text}</span>
          </p>
          <Show when={props.details}>
            {(details) => (
              <div class="k2b-chat-decision__details">
                <p class="k2b-chat-decision__details-label">
                  <span
                    class="k2b-chat-decision__tile k2b-icon-tile"
                    style={props.source.accent ? { color: props.source.accent } : undefined}
                  >
                    <i class={props.source.icon} aria-hidden="true" />
                  </span>
                  {details().label}
                </p>
                {details().content}
              </div>
            )}
          </Show>
          <div class="k2b-chat-decision__answers">
            <Show when={(props.meta?.length ?? 0) > 0 || (props.remember && !editing())}>
              <span class="k2b-chat-decision__meta">
                <For each={props.meta ?? []}>
                  {(item) => (
                    <span class="k2b-chat-decision__fact">
                      <i class={item.icon} aria-hidden="true" />
                      {item.text}
                    </span>
                  )}
                </For>
                <Show when={!editing() ? props.remember : undefined}>
                  {(remember) => (
                    <Checkbox
                      class="k2b-chat-decision__remember"
                      label={remember().label}
                      value={remembered()}
                      disabled={confirmOff()}
                      onValueChange={(value) => setRemembered(value)}
                    />
                  )}
                </Show>
              </span>
            </Show>
            <span class="k2b-chat-decision__buttons">
              <Show when={props.back}>
                {(back) => (
                  <Button
                    class="k2b-chat-decision__answer"
                    wrap
                    variant="secondary"
                    disabled={Boolean(props.waiting)}
                    onClick={() => {
                      if (!props.waiting) void back().onSelect();
                    }}
                  >
                    <Show when={back().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                    {back().label}
                  </Button>
                )}
              </Show>
              <Button
                class="k2b-chat-decision__answer"
                wrap
                variant={editing() ? "ghost" : "secondary"}
                disabled={Boolean(props.waiting)}
                onClick={() => answer(props.decline, !props.waiting)}
              >
                <Show when={props.decline.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                {props.decline.label}
              </Button>
              <Button
                class="k2b-chat-decision__answer"
                wrap
                variant={editing() ? "secondary" : "ai"}
                disabled={confirmOff()}
                onClick={confirm}
              >
                <Show when={props.confirm.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                {props.confirm.label}
              </Button>
            </span>
          </div>
        </>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type ChatOutcomeProps = {
  /**
   * Every line one flow can show, such as running and done. All of them share one cell, so the line is as high as
   * the longest and switching between them moves nothing.
   */
  lines: Readonly<Record<string, ChatOutcomeLine>>;
  /** The key of the visible line. */
  current: string;
  /** Receives an error thrown or rejected by a line's `action`. */
  onActionError?: (error: unknown) => void;
  anchorId?: string | number;
  class?: string;
};

const OUTCOME_ICONS: Record<ChatOutcomeTone, string> = {
  running: "ti ti-loader-2 k2b-spin",
  done: "ti ti-check",
  off: "ti ti-circle-off",
  waiting: "ti ti-clock",
  warning: "ti ti-alert-triangle",
  error: "ti ti-alert-circle",
};

/** The visible words of a line, without what screen readers do not hear. */
const spokenText = (element: Element): string => {
  const copy = element.cloneNode(true) as Element;
  // Buttons under the line are controls, not part of what happened.
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"], .k2b-chat-outcome__actions')) hidden.remove();
  // The time and the link stand apart by margin only; spoken, they need a space.
  for (const part of copy.querySelectorAll(".k2b-chat-outcome__time, .k2b-chat-outcome__link")) part.before(" ");
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
};

/**
 * One line that says what happened: running, done, off, waiting, warning, or error. Changes are announced through a
 * polite live region; the line itself can take the focus.
 */
export function ChatOutcome(props: ChatOutcomeProps): JSX.Element {
  const scope = useContext(DecisionScope);
  // Only a line that replaces a question just answered here fades in; history renders final.
  const entering = untrack(() => scope?.answered() ?? false);
  const [live, setLive] = createSignal("");
  let root: HTMLDivElement | undefined;
  let cell: HTMLDivElement | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Read once: an object literal from the host builds its JSX again on every read.
  const lines = createMemo(() => props.lines);
  const line = () => lines()[props.current];
  const tone = () => line()?.tone ?? "off";
  const keys = () => {
    const all = Object.keys(lines());
    return all.includes(props.current) ? all : [props.current, ...all];
  };

  // Empty the region first, so the same words spoken again are a change too.
  const announce = () => {
    setLive("");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const current = cell?.querySelector('[data-current="true"]');
      setLive(current ? spokenText(current) : "");
    }, 40);
  };

  onMount(() => {
    if (untrack(() => scope?.answered())) announce();
  });
  createEffect(
    on(
      () => props.current,
      () => {
        // A link pressed in a line that is now hidden would leave the focus on an invisible button, which the browser
        // then drops to the page. The line itself keeps it instead.
        const active = document.activeElement;
        const hidden = active && cell?.contains(active) && !active.closest('[data-current="true"]');
        if (hidden || (pending && active === document.body)) root?.focus({ preventScroll: true });
        announce();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });

  return (
    <div
      ref={root}
      class={`k2b-chat-outcome ${props.class ?? ""}`}
      data-tone={tone()}
      data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
      data-enter={entering ? "true" : undefined}
      tabindex="-1"
    >
      <span class="k2b-chat-outcome__icon" aria-hidden="true">
        <i class={line()?.icon ?? OUTCOME_ICONS[tone()]} />
      </span>
      {/* Busy is set on the words only: a live region inside a busy subtree would be held back. */}
      <div ref={cell} class="k2b-chat-outcome__cell" aria-busy={tone() === "running" ? "true" : undefined}>
        <For each={keys()}>
          {(key) => {
            const entry = () => lines()[key];
            const current = () => key === props.current;
            return (
              <Show when={entry()}>
                {(item) => (
                  <div
                    class="k2b-chat-outcome__text"
                    data-current={current() ? "true" : undefined}
                    aria-hidden={current() ? undefined : "true"}
                  >
                    {item().text}
                    <Show when={item().detail}>
                      {(detail) => (
                        <>
                          {" "}
                          <span class="k2b-chat-outcome__detail">{detail()}</span>
                        </>
                      )}
                    </Show>
                    <Show when={item().time}>{(time) => <span class="k2b-chat-outcome__time">{time()}</span>}</Show>
                    <Show when={item().action}>
                      {(action) => (
                        <Button
                          class="k2b-chat-outcome__link"
                          wrap
                          variant="text"
                          tabIndex={current() ? undefined : -1}
                          onClick={() => {
                            // A second press while the first is still running would repeat its work.
                            if (pending) return;
                            scope?.pressed();
                            try {
                              const result = action().onSelect();
                              if (result instanceof Promise) {
                                pending = true;
                                result
                                  .catch((error: unknown) => props.onActionError?.(error))
                                  .finally(() => {
                                    pending = false;
                                    scope?.released();
                                  });
                                return;
                              }
                            } catch (error) {
                              props.onActionError?.(error);
                            }
                            scope?.released();
                          }}
                        >
                          {action().label}
                        </Button>
                      )}
                    </Show>
                    {/* Every line keeps its buttons, hidden with its text, so the cell also reserves their row. */}
                    <Show when={item().actions}>{(actions) => <div class="k2b-chat-outcome__actions">{actions()}</div>}</Show>
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
      <span class="k2b-sr-only" role="status" aria-live="polite">
        {live()}
      </span>
    </div>
  );
}
