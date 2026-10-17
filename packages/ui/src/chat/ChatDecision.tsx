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
import { Avatar } from "../surfaces/Avatar";
import { useChatMessages } from "./chat-messages";
import type {
  ChatDecisionAnswer,
  ChatDecisionReason,
  ChatDecisionState,
  ChatOutcomeLine,
  ChatOutcomeTone,
  ChatPreviewHeaderRow,
  ChatPreviewPerson,
} from "./types";

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ChatDecisionProps = {
  /** `open` shows the question; every other state shows `outcome` in its place. */
  state: ChatDecisionState;
  /** The question as one sentence, usually with `ReferenceChip`s. */
  sentence: JSX.Element;
  /** Why this question is asked, in the platform's words. */
  reason: ChatDecisionReason;
  /** The thing itself, usually `Chat.Preview`. */
  preview?: JSX.Element;
  /** The main answer, named by verb and target ("Send to Lea"). `danger` for deletions, `primary` for requests. */
  confirm: ChatDecisionAnswer & { variant?: "ai" | "primary" | "danger" };
  /** The other answer ("Don't send"). */
  decline: ChatDecisionAnswer;
  /** An optional quiet third answer after the buttons, such as "Yes, and don't ask again in this chat". */
  remember?: ChatDecisionAnswer;
  /** Turns `confirm` and `remember` off; this reason replaces `reason` in the same place. */
  unavailable?: ChatDecisionReason;
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
 * A question the person answers in the conversation: one sentence, why it is asked, the thing itself, and two answers.
 * An answer collapses it at once to its outcome line, which takes the focus and is announced.
 */
export function ChatDecision(props: ChatDecisionProps): JSX.Element {
  const id = createUniqueId();
  const sentenceId = `k2b-chat-decision-${id}-sentence`;
  const reasonId = `k2b-chat-decision-${id}-reason`;
  let root: HTMLDivElement | undefined;
  let sentence: HTMLParagraphElement | undefined;
  // An answer given here moves the focus to the outcome; a click in the outcome that reopens the question moves it
  // back to the sentence. A state change from elsewhere moves no focus.
  const [answeredHere, setAnsweredHere] = createSignal(false);
  const [arrive, setArrive] = createSignal(false);
  let reopenedHere = false;
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
  const reason = createMemo(() => props.unavailable ?? props.reason);
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
        }
        reopenedHere = false;
      },
    ),
  );

  return (
    <div
      ref={root}
      class={`k2b-chat-decision ${props.class ?? ""}`}
      data-state={props.state}
      data-chat-anchor={props.anchorId !== undefined ? String(props.anchorId) : undefined}
    >
      <Show when={open()} fallback={<DecisionScope.Provider value={scope}>{props.outcome}</DecisionScope.Provider>}>
        <section class="k2b-chat-decision__card" aria-labelledby={sentenceId} aria-describedby={reasonId}>
          <p
            ref={sentence}
            id={sentenceId}
            class="k2b-chat-decision__sentence"
            tabindex="-1"
            data-arrive={arrive() ? "true" : undefined}
            onAnimationEnd={() => setArrive(false)}
          >
            {props.sentence}
          </p>
          <p id={reasonId} class="k2b-chat-line k2b-chat-decision__reason" data-tone={reason().tone ?? "neutral"}>
            <i class={`k2b-chat-line__icon ${reasonIcon(reason())}`} aria-hidden="true" />
            <span class="k2b-chat-line__text">{reason().text}</span>
          </p>
          {props.preview}
          <div class="k2b-chat-decision__answers">
            <Button
              class="k2b-chat-decision__answer"
              wrap
              variant={props.confirm.variant ?? "ai"}
              disabled={Boolean(props.unavailable)}
              onClick={() => answer(props.confirm, !props.unavailable)}
            >
              <Show when={props.confirm.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
              {props.confirm.label}
            </Button>
            <Button class="k2b-chat-decision__answer" wrap variant="subtle" onClick={() => answer(props.decline, true)}>
              <Show when={props.decline.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
              {props.decline.label}
            </Button>
            <Show when={props.remember}>
              {(remember) => (
                <Button
                  class="k2b-chat-decision__remember"
                  wrap
                  variant="text"
                  disabled={Boolean(props.unavailable)}
                  onClick={() => answer(remember(), !props.unavailable)}
                >
                  {remember().label}
                </Button>
              )}
            </Show>
          </div>
        </section>
      </Show>
    </div>
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

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type ChatPreviewProps = { children: JSX.Element; class?: string };

/** The thing a question is about, as calm text on the sentence's edge: no surface, no column. */
function ChatPreviewRoot(props: ChatPreviewProps): JSX.Element {
  return <div class={`k2b-chat-preview ${props.class ?? ""}`}>{props.children}</div>;
}

export type ChatPreviewHeaderProps = {
  /** One row per field, such as From, To, Cc, and Bcc; the label stands right before its value. */
  rows: readonly ChatPreviewHeaderRow[];
  /** A last line, such as when the message goes out. */
  note?: JSX.Element;
};

const PreviewPeople = (props: { people: readonly ChatPreviewPerson[] }) => (
  <For each={props.people}>
    {(person, index) => (
      <>
        {index() > 0 ? ", " : ""}
        <span class="k2b-chat-preview__person">
          <Show when={person.name}>{(name) => <b>{name()}</b>}</Show>
          <Show when={person.address}>
            {(address) => (
              <span class="k2b-chat-preview__address" data-alone={person.name ? undefined : "true"}>
                {address()}
              </span>
            )}
          </Show>
        </span>
      </>
    )}
  </For>
);

function ChatPreviewHeader(props: ChatPreviewHeaderProps): JSX.Element {
  return (
    <div class="k2b-chat-preview__header">
      <dl>
        <For each={props.rows}>
          {(row) => (
            <div data-emphasis={row.emphasis ? "true" : undefined}>
              <dt>{row.label}</dt>
              <dd>
                <Show when={row.people}>{(people) => <PreviewPeople people={people()} />}</Show>
                {row.value}
              </dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={props.note}>{(note) => <p>{note()}</p>}</Show>
    </div>
  );
}

export type ChatPreviewTitleProps = { children: JSX.Element; meta?: JSX.Element };

/** The thing's name in the text's own face, with optional quiet facts after it. */
function ChatPreviewTitle(props: ChatPreviewTitleProps): JSX.Element {
  return (
    <p class="k2b-chat-preview__title-line">
      <span class="k2b-chat-preview__title">{props.children}</span>
      <Show when={props.meta}>
        {(meta) => (
          <>
            {" "}
            <span class="k2b-chat-preview__meta">{meta()}</span>
          </>
        )}
      </Show>
    </p>
  );
}

/** A rule or instruction as one sentence, such as what a routine does; chips and marks may stand inside. */
function ChatPreviewSentence(props: { children: JSX.Element }): JSX.Element {
  return <p class="k2b-chat-preview__sentence">{props.children}</p>;
}

/** The first lines of a longer text. It keeps its line breaks, shows about three lines, and fades out. */
function ChatPreviewExcerpt(props: { children: JSX.Element }): JSX.Element {
  return <p class="k2b-chat-preview__excerpt">{props.children}</p>;
}

export type ChatPreviewReadMoreProps = {
  href: string;
  children: JSX.Element;
  /** Tooltip, such as "Opens exactly this version of the draft". */
  title?: string;
};

/** Opens the whole thing at exactly the version the question shows. */
function ChatPreviewReadMore(props: ChatPreviewReadMoreProps): JSX.Element {
  return (
    <a class="k2b-chat-preview__more" href={props.href} title={props.title}>
      {props.children}
    </a>
  );
}

const InList = createContext(false);

/** A list of lines with a name, such as "What the routine may do". */
function ChatPreviewLines(props: { label?: string; children: JSX.Element }): JSX.Element {
  return (
    <ul class="k2b-chat-preview__lines" aria-label={props.label}>
      <InList.Provider value={true}>{props.children}</InList.Provider>
    </ul>
  );
}

export type ChatPreviewLineProps = {
  /** Icon class; the text after it starts 1.5rem from the edge. */
  icon: string;
  /** Icon colour, such as the PDF colour of an attachment. */
  accent?: string;
  /** `muted` for limits and notes, `warning` for an application's own warning. */
  tone?: "default" | "muted" | "warning";
  /** Marks the whole line as new or removed. */
  mark?: "added" | "removed";
  /** Quiet facts after the text, such as a file size. */
  meta?: JSX.Element;
  children: JSX.Element;
};

/** One line led by an icon: a consequence, a right, an attachment, or a warning. */
function ChatPreviewLine(props: ChatPreviewLineProps): JSX.Element {
  const inList = useContext(InList);
  const messages = useChatMessages();
  const content = () => (
    <>
      <i class={`k2b-chat-line__icon ${props.icon}`} style={props.accent ? { color: props.accent } : undefined} aria-hidden="true" />
      <span class="k2b-chat-line__text">
        {/* One stable wrapper, so marking a line later never moves its mounted children. */}
        <span class="k2b-chat-mark" data-change={props.mark}>
          <Show when={props.mark}>
            {(mark) => <span class="k2b-sr-only">{mark() === "added" ? messages().markAdded : messages().markRemoved} </span>}
          </Show>
          {props.children}
        </span>
        <Show when={props.meta}>
          {(meta) => (
            <>
              {" "}
              <span class="k2b-chat-preview__meta">{meta()}</span>
            </>
          )}
        </Show>
      </span>
    </>
  );
  const attributes = () => ({
    class: "k2b-chat-line k2b-chat-preview__line",
    "data-tone": props.tone && props.tone !== "default" ? props.tone : undefined,
  });
  return inList ? <li {...attributes()}>{content()}</li> : <p {...attributes()}>{content()}</p>;
}

export type ChatPreviewPeopleProps = {
  /** The first few people; their avatars overlap at the start of the line. */
  people: readonly { name: string; src?: string | null }[];
  /** The names as text, such as "Lea Berg, Tom Weber and 3 others". */
  children: JSX.Element;
};

function ChatPreviewPeople(props: ChatPreviewPeopleProps): JSX.Element {
  return (
    <p class="k2b-chat-preview__people">
      <span class="k2b-chat-preview__faces" aria-hidden="true">
        <For each={props.people}>{(person) => <Avatar name={person.name} src={person.src} size="xs" />}</For>
      </span>
      <span>{props.children}</span>
    </p>
  );
}

export const ChatPreview = Object.assign(ChatPreviewRoot, {
  Header: ChatPreviewHeader,
  Title: ChatPreviewTitle,
  Sentence: ChatPreviewSentence,
  Excerpt: ChatPreviewExcerpt,
  ReadMore: ChatPreviewReadMore,
  Lines: ChatPreviewLines,
  Line: ChatPreviewLine,
  People: ChatPreviewPeople,
});

// ---------------------------------------------------------------------------
// Mark
// ---------------------------------------------------------------------------

export type ChatMarkProps = { change: "added" | "removed"; children: JSX.Element };

/** Marks new or removed words; screen readers hear "new:" or "removed:" first. */
export function ChatMark(props: ChatMarkProps): JSX.Element {
  const messages = useChatMessages();
  return (
    <Show
      when={props.change === "removed"}
      fallback={
        <mark class="k2b-chat-mark" data-change="added">
          <span class="k2b-sr-only">{messages().markAdded} </span>
          {props.children}
        </mark>
      }
    >
      <del class="k2b-chat-mark" data-change="removed">
        <span class="k2b-sr-only">{messages().markRemoved} </span>
        {props.children}
      </del>
    </Show>
  );
}
