import { createRenderEffect, createSignal, type JSX, on, onCleanup, onMount } from "solid-js";
import { announce } from "../feedback/announce";
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
  /**
   * The one sentence screen readers hear for this phase, such as "Gustav is thinking", once, through the page's live
   * region. Words and seconds stay silent.
   */
  announce: string;
};

/** The word that stands after `elapsedMs`: `first` for the first seconds, then one of `words` per hold. */
export const chatActivityWordAt = (first: string, words: readonly string[], elapsedMs: number): string => {
  if (words.length === 0 || !(elapsedMs >= CHAT_ACTIVITY_WORDS_START_MS)) return first;
  return words[Math.floor((elapsedMs - CHAT_ACTIVITY_WORDS_START_MS) / CHAT_ACTIVITY_WORDS_HOLD_MS) % words.length]!;
};

/**
 * A word in a running activity label that changes with time, one word in its place at any moment: the old word fades out
 * completely, only then the next fades in. With reduced motion the stylesheet shows a resting `first` instead, from the
 * server's HTML on, and nothing changes. A pointer moved on the row, not a finger's tap, or the focus in it holds the word;
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
    const row = slot?.closest<HTMLElement>(".k2b-chat-activity") ?? slot;
    /** Shows the word of the current time at once, without a fade. */
    const settle = () => {
      clearTimeout(swapTimer);
      setPhase("still");
      setShown(wordAt(elapsedNow()));
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
    // A pointer holds the word once it moves on the row; a row that appears under a resting pointer, such as the send
    // button just pressed, or a finger's tap holds nothing. The focus in the row holds it too.
    let pointer = false;
    let focus = false;
    const sync = () => {
      if (held === (pointer || focus)) return;
      held = pointer || focus;
      settle();
    };
    const move = (event: PointerEvent) => {
      pointer = event.pointerType !== "touch";
      sync();
    };
    const leave = () => {
      pointer = false;
      sync();
    };
    const focusIn = () => {
      focus = true;
      sync();
    };
    const focusOut = (event: FocusEvent) => {
      focus = row?.contains(event.relatedTarget as Node | null) === true;
      sync();
    };
    const visibility = () => {
      if (!document.hidden) settle();
    };
    row?.addEventListener("pointermove", move);
    row?.addEventListener("pointerleave", leave);
    row?.addEventListener("focusin", focusIn);
    row?.addEventListener("focusout", focusOut);
    document.addEventListener("visibilitychange", visibility);
    base = { elapsed: props.elapsedMs, at: now() };
    schedule();
    // Once per phase, through the page's one live region: a status inside the busy row and message could be held back
    // until the row is gone.
    announce(props.announce);
    onCleanup(() => {
      clearTimeout(tickTimer);
      clearTimeout(swapTimer);
      row?.removeEventListener("pointermove", move);
      row?.removeEventListener("pointerleave", leave);
      row?.removeEventListener("focusin", focusIn);
      row?.removeEventListener("focusout", focusOut);
      document.removeEventListener("visibilitychange", visibility);
    });
  });

  return (
    <>
      <span ref={slot} class="k2b-chat-activity__words" aria-hidden="true">
        {/* With reduced motion the stylesheet shows this resting first word instead of the changing one, already in
            the server's HTML, so the first frame never jumps. */}
        <span class="k2b-chat-activity__word-rest">{props.first}</span>
        <span
          class="k2b-chat-activity__word"
          data-phase={phase()}
          onTransitionEnd={() => {
            if (phase() === "in") setPhase("still");
          }}
        >
          {shown()}
        </span>
      </span>
    </>
  );
}
