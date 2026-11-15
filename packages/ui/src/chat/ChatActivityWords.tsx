import { createRenderEffect, createSignal, type JSX, on, onCleanup, onMount } from "solid-js";
import { prefersReducedMotion } from "../motion";

/** The host's first word stands this long before the first change. */
export const CHAT_ACTIVITY_WORDS_START_MS = 3000;
/** Then each word stands this long; the same value as `--k2b-motion-word-hold`. */
export const CHAT_ACTIVITY_WORDS_HOLD_MS = 2400;
/** The old word fades out completely in this time before the next one fades in; `--k2b-motion-word-out`. */
const WORD_OUT_MS = 120;

export type ChatActivityWordsProps = {
  /** The word for the first seconds, such as "Thinking". */
  first: string;
  /** The words that follow, in the order the host chose for this phase. They repeat after the last one. */
  words: readonly string[];
  /**
   * How long this phase has run, by the host's clock, when it renders. The server renders the word for this time and the
   * first browser frame shows the same word; the browser counts on from there.
   */
  elapsedMs: number;
  /** The one sentence screen readers hear for this phase, such as "Gustav is thinking". Words and seconds stay silent. */
  announce: string;
};

/** The word that stands after `elapsedMs`: `first` for the first seconds, then one of `words` per hold. */
export const chatActivityWordAt = (first: string, words: readonly string[], elapsedMs: number): string => {
  if (words.length === 0 || !(elapsedMs >= CHAT_ACTIVITY_WORDS_START_MS)) return first;
  return words[Math.floor((elapsedMs - CHAT_ACTIVITY_WORDS_START_MS) / CHAT_ACTIVITY_WORDS_HOLD_MS) % words.length]!;
};

/**
 * A word in a running activity label that changes with time, one word in its place at any moment: the old word fades out
 * completely, only then the next fades in. Reduced motion keeps `first`. A pointer or the focus on the row holds the word;
 * a hidden tab changes nothing and shows the word of the current time on return, without catching up. Place it in the
 * label of `Chat.Activity`; the host owns the words and the clock, this owns the timing and the announcement.
 */
export function ChatActivityWords(props: ChatActivityWordsProps): JSX.Element {
  const wordAt = (elapsed: number) => chatActivityWordAt(props.first, props.words, elapsed);
  const [shown, setShown] = createSignal(wordAt(props.elapsedMs));
  const [phase, setPhase] = createSignal<"still" | "out" | "in">("still");
  let slot: HTMLSpanElement | undefined;
  // The host's elapsed time and when this side saw it, so the word follows real time between the host's updates.
  let base = { elapsed: props.elapsedMs, at: 0 };
  const now = () => (typeof performance === "undefined" ? 0 : performance.now());
  createRenderEffect(
    on(
      () => props.elapsedMs,
      (elapsed) => {
        base = { elapsed, at: now() };
      },
    ),
  );
  const elapsedNow = () => base.elapsed + (now() - base.at);

  onMount(() => {
    let held = false;
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    let swapTimer: ReturnType<typeof setTimeout> | undefined;
    const row = slot?.closest(".k2b-chat-activity") ?? slot;
    /** Shows the word of the current time at once, without a fade; reduced motion keeps the first word. */
    const settle = () => {
      clearTimeout(swapTimer);
      setPhase("still");
      setShown(prefersReducedMotion() ? props.first : wordAt(elapsedNow()));
    };
    const schedule = () => {
      clearTimeout(tickTimer);
      const elapsed = elapsedNow();
      const wait =
        elapsed < CHAT_ACTIVITY_WORDS_START_MS
          ? CHAT_ACTIVITY_WORDS_START_MS - elapsed
          : CHAT_ACTIVITY_WORDS_HOLD_MS - ((elapsed - CHAT_ACTIVITY_WORDS_START_MS) % CHAT_ACTIVITY_WORDS_HOLD_MS);
      tickTimer = setTimeout(tick, Math.max(16, Math.ceil(wait) + 1));
    };
    const tick = () => {
      schedule();
      if (held || document.hidden || prefersReducedMotion() || phase() === "out") return;
      if (wordAt(elapsedNow()) === shown()) return;
      setPhase("out");
      swapTimer = setTimeout(() => {
        setShown(wordAt(elapsedNow()));
        setPhase("in");
      }, WORD_OUT_MS);
    };
    const hold = () => {
      held = true;
      settle();
    };
    const release = (event: Event) => {
      // Leaving with the pointer keeps holding while the focus stays in the row, and the other way round.
      const focused =
        event.type === "focusout"
          ? row?.contains((event as FocusEvent).relatedTarget as Node | null) === true
          : row?.contains(document.activeElement) === true;
      const hovered = event.type === "pointerleave" ? false : row?.matches(":hover") === true;
      held = focused || hovered;
      if (!held) settle();
    };
    const visibility = () => {
      if (!document.hidden) settle();
    };
    row?.addEventListener("pointerenter", hold);
    row?.addEventListener("pointerleave", release);
    row?.addEventListener("focusin", hold);
    row?.addEventListener("focusout", release);
    document.addEventListener("visibilitychange", visibility);
    base = { elapsed: props.elapsedMs, at: now() };
    if (prefersReducedMotion()) setShown(props.first);
    schedule();
    onCleanup(() => {
      clearTimeout(tickTimer);
      clearTimeout(swapTimer);
      row?.removeEventListener("pointerenter", hold);
      row?.removeEventListener("pointerleave", release);
      row?.removeEventListener("focusin", hold);
      row?.removeEventListener("focusout", release);
      document.removeEventListener("visibilitychange", visibility);
    });
  });

  return (
    <>
      <span ref={slot} class="k2b-chat-activity__words" aria-hidden="true">
        <span
          class="k2b-chat-activity__word"
          data-phase={phase()}
          onAnimationEnd={() => {
            if (phase() === "in") setPhase("still");
          }}
        >
          {shown()}
        </span>
      </span>
      <span class="k2b-sr-only" role="status">
        {props.announce}
      </span>
    </>
  );
}
