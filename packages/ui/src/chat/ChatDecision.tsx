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
import { Button, ButtonLink } from "../actions/Button";
import { Checkbox } from "../inputs/Checkbox";
import type {
  ChatDecisionAnswer,
  ChatDecisionFact,
  ChatDecisionReason,
  ChatDecisionState,
  ChatOutcomeLine,
  ChatOutcomeTone,
} from "./types";

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
  /** Who asks: the app's name and icon, its icon tile in `accent`. Without it the head names only what the card is. */
  source?: { name: string; icon: string; accent?: string };
  /**
   * The state as a word with its icon at the end of the head. A closed question always has one; an open one has one when
   * the question itself has a state, such as a version that waits for an administrator.
   */
  status?: { label: string; icon: string; tone: ChatOutcomeTone };
  /** The question as one sentence, usually with `ReferenceChip`s. */
  sentence: JSX.Element;
  /** Why this question is asked, in the platform's words. A question with an `entry` may say it there instead. */
  reason?: ChatDecisionReason;
  /**
   * The thing itself on the surface colour, under its own label such as "Details from Mail". `note` is one quiet line
   * under it that holds for every such question, such as what Cloud checked.
   */
  /**
   * The thing itself under its label, such as "Details from Code"; `context` is a quiet addition after it, such as
   * "compared with version 4", and `note` one quiet line under the details. Facts alone, such as `ChatDecisionFacts`,
   * need no label.
   */
  details?: { label?: string; context?: string; content: JSX.Element; note?: { text: string; icon?: string } };
  /** Lines after the details, each with its icon, such as what happens now and what holds until then. */
  notes?: readonly ChatDecisionReason[];
  /** Quiet facts at the start of the answer row, such as when the question expires. */
  meta?: readonly ChatDecisionFact[];
  /** The main answer, named by verb and target ("Send to Lea"); the only filled button. */
  confirm?: ChatDecisionAnswer;
  /** The other answer ("Don't send"). */
  decline?: ChatDecisionAnswer;
  /** A quiet text answer before the others, such as "Change" back to `edit`. It turns off with `waiting` only. */
  back?: ChatDecisionAnswer;
  /** A quiet text link before the answers, such as "See everything" on the thing's own page. */
  link?: { label: string; href: string };
  /** Further answers on the surface colour before `decline`, such as "Withdraw". They turn off with `waiting` only. */
  more?: readonly ChatDecisionAnswer[];
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
  /**
   * Takes the answer row's place, such as `ChatDecisionField` for a question that asks for one value. `meta`, `back`,
   * `more`, `link`, `remember`, `confirm` and `decline` of the question are then not shown; the entry brings its own.
   */
  entry?: JSX.Element;
  /** Receives a rejected promise from an answer's `onSelect`. */
  onAnswerError?: (error: unknown) => void;
  /**
   * Lines the facts keep where they wrap under the answers, for a question whose facts change while it stays open, such
   * as work that waits, runs and stops: the question then keeps its height between those states.
   */
  factLines?: 1 | 2;
  anchorId?: string | number;
  class?: string;
};

/** What an outcome inside a question needs from it: whether it was just answered here, and a link press inside it. */
const DecisionScope = createContext<{ answered: () => boolean; pressed: () => void; released: () => void }>();

/** What an `entry` needs from its question: to answer it, whether answers are off, its box, and the island. */
export type DecisionEntryScope = {
  /** Answers like the question's own buttons; `hold` keeps it answered here until the answer's promise settles. */
  answer: (choice: ChatDecisionAnswer, enabled: boolean, hold?: boolean) => void;
  waiting: () => boolean;
  unavailable: () => boolean;
  root: () => HTMLElement | undefined;
  /** Turns the question into the raised island of `edit` for good. */
  edit: () => void;
};
export const DecisionEntry = createContext<DecisionEntryScope>();

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

  const answer = (choice: ChatDecisionAnswer, enabled: boolean, hold = false) => {
    if (!enabled || !open() || answeredHere()) return;
    setAnsweredHere(true);
    let pending: Promise<void> | undefined;
    try {
      const result = choice.onSelect();
      if (result instanceof Promise) pending = result.catch((error: unknown) => props.onAnswerError?.(error));
    } catch (error) {
      props.onAnswerError?.(error);
    }
    // A host that keeps the question open (it could not take the answer) gets working buttons back. A held answer
    // waits for its work, such as saving a value while the question stays open: an outcome set at its end still
    // counts as answered here and takes the focus.
    const release = () => {
      if (open()) setAnsweredHere(false);
    };
    if (hold && pending) void pending.then(release);
    else queueMicrotask(release);
  };
  const [entryEditing, setEntryEditing] = createSignal(false);
  const entryScope: DecisionEntryScope = {
    answer,
    waiting: () => Boolean(props.waiting),
    unavailable: () => Boolean(props.unavailable),
    root: () => root,
    edit: () => setEntryEditing(true),
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
    if (props.confirm?.busy) return;
    const chosen = props.remember && remembered() && !editing() ? props.remember : props.confirm;
    if (chosen) answer(chosen, !confirmOff());
  };

  return (
    <section
      ref={root}
      class={`k2b-chat-decision ${props.class ?? ""}`}
      data-state={props.state}
      data-mode={open() && (editing() || entryEditing()) ? "edit" : "approve"}
      data-k2b-primary="ai"
      data-fact-lines={props.factLines === 2 ? "2" : undefined}
      data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
      aria-labelledby={open() ? sentenceId : undefined}
      aria-describedby={open() && reason() ? reasonId : undefined}
      aria-label={
        open()
          ? undefined
          : `${props.kind.label}${props.source ? ` · ${props.source.name}` : ""}${props.status ? `: ${props.status.label}` : ""}`
      }
    >
      <div class="k2b-chat-decision__head">
        <i class={`k2b-chat-decision__kind-icon ${props.kind.icon}`} aria-hidden="true" />
        <span class="k2b-chat-decision__kind">{props.kind.label}</span>
        <Show when={props.source}>
          {(source) => (
            <>
              <span aria-hidden="true">·</span>
              <span class="k2b-chat-decision__source">
                <span class="k2b-chat-decision__tile k2b-icon-tile" style={source().accent ? { color: source().accent } : undefined}>
                  <i class={source().icon} aria-hidden="true" />
                </span>
                {source().name}
              </span>
            </>
          )}
        </Show>
        <Show when={props.status}>
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
          <Show when={reason()}>
            {(shown) => (
              <p id={reasonId} class="k2b-chat-line k2b-chat-decision__reason" data-tone={shown().tone ?? "neutral"}>
                <i class={`k2b-chat-line__icon ${reasonIcon(shown())}`} aria-hidden="true" />
                <span class="k2b-chat-line__text">{shown().text}</span>
              </p>
            )}
          </Show>
          <Show when={props.details}>
            {(details) => (
              <div class="k2b-chat-decision__details">
                <Show when={details().label}>
                  {(label) => (
                    <p class="k2b-chat-decision__details-label">
                      <Show when={props.source}>
                        {(source) => (
                          <span
                            class="k2b-chat-decision__tile k2b-icon-tile"
                            style={source().accent ? { color: source().accent } : undefined}
                          >
                            <i class={source().icon} aria-hidden="true" />
                          </span>
                        )}
                      </Show>
                      <span>
                        <strong>{label()}</strong>
                        <Show when={details().context}>
                          {(context) => <span class="k2b-chat-decision__details-context"> · {context()}</span>}
                        </Show>
                      </span>
                    </p>
                  )}
                </Show>
                {details().content}
                <Show when={details().note}>
                  {(note) => (
                    <p class="k2b-chat-decision__details-note">
                      <i class={note().icon ?? "ti ti-info-circle"} aria-hidden="true" />
                      {note().text}
                    </p>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <Show when={(props.notes?.length ?? 0) > 0}>
            <div class="k2b-chat-decision__notes">
              <For each={props.notes}>
                {(note) => (
                  <p class="k2b-chat-line k2b-chat-decision__note" data-tone={note.tone ?? "neutral"}>
                    <i class={`k2b-chat-line__icon ${reasonIcon(note)}`} aria-hidden="true" />
                    <span class="k2b-chat-line__text">{note.text}</span>
                  </p>
                )}
              </For>
            </div>
          </Show>
          {/* The entry is read inside the provider only: reading it creates it, and it needs its question. */}
          <DecisionEntry.Provider value={entryScope}>
            <Show
              when={props.entry}
              fallback={
                <div class="k2b-chat-decision__answers">
                  <Show when={(props.meta?.length ?? 0) > 0 || (props.remember && !editing())}>
                    <span class="k2b-chat-decision__meta">
                      <For each={props.meta ?? []}>
                        {(item) => (
                          <span class="k2b-chat-decision__fact" data-tone={item.tone ?? "neutral"}>
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
                          variant="text"
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
                    <For each={props.more ?? []}>
                      {(more) => (
                        <Button
                          class="k2b-chat-decision__answer"
                          wrap
                          variant="secondary"
                          disabled={Boolean(props.waiting)}
                          onClick={() => {
                            if (!props.waiting)
                              void Promise.resolve(more.onSelect()).catch((error: unknown) => props.onAnswerError?.(error));
                          }}
                        >
                          <Show when={more.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                          {more.label}
                        </Button>
                      )}
                    </For>
                    <Show when={props.decline}>
                      {(decline) => (
                        <Button
                          class="k2b-chat-decision__answer"
                          wrap
                          variant={editing() ? "text" : "secondary"}
                          disabled={Boolean(props.waiting)}
                          onClick={() => answer(decline(), !props.waiting)}
                        >
                          <Show when={decline().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                          {decline().label}
                        </Button>
                      )}
                    </Show>
                    <Show when={props.confirm}>
                      {(confirmAnswer) => (
                        <Button
                          class="k2b-chat-decision__answer"
                          wrap
                          variant={editing() ? "secondary" : "ai"}
                          disabled={confirmOff()}
                          aria-disabled={confirmAnswer().busy ? "true" : undefined}
                          aria-busy={confirmAnswer().busy ? "true" : undefined}
                          data-busy={confirmAnswer().busy ? "" : undefined}
                          onClick={confirm}
                        >
                          <Show when={confirmAnswer().icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                          {confirmAnswer().label}
                        </Button>
                      )}
                    </Show>
                    {/* A link to read everything comes last, after the answers: it leaves the question, it does not answer it. */}
                    <Show when={props.link}>
                      {(link) => (
                        <ButtonLink class="k2b-chat-decision__answer" wrap variant="text" href={link().href}>
                          {link().label}
                        </ButtonLink>
                      )}
                    </Show>
                  </span>
                </div>
              }
            >
              {(entry) => entry()}
            </Show>
          </DecisionEntry.Provider>
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
export const spokenText = (element: Element): string => {
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
