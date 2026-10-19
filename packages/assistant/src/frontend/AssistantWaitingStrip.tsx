import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { Button, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantMessages } from "./messages";
import type { WaitingQuestionsView } from "./waiting-questions";

/**
 * "Waiting for you" above the composer: every open question in its short form, those of other chats with the chat's
 * name. A press jumps to the question. There is deliberately no way to answer several questions at once: each answer
 * belongs to its own card, where the person sees what it does.
 *
 * The strip is one row of fixed height that scrolls sideways, so a question opening or closing elsewhere never moves
 * the composer. `quiet` keeps that row in place but hides it.
 */
export function AssistantWaitingStrip(props: {
  view: WaitingQuestionsView;
  conversationId: string | null;
  /** The only open question waits in this chat and its answers are in view. */
  quiet: boolean;
  onJump: (question: AiOpenQuestion) => void;
  onShowMore: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  return (
    <nav class="assistant-waiting" aria-label={t().needsAttention} data-quiet={props.quiet ? "" : undefined} inert={props.quiet}>
      <span class="assistant-waiting__label" aria-hidden="true">
        {t().needsAttention}
      </span>
      <ul class="assistant-waiting__list">
        <For each={props.view.entries}>
          {(question) => (
            <li>
              <Button
                variant="ghost"
                class="assistant-waiting__entry"
                style={question.app.accent ? { "--assistant-waiting-accent": question.app.accent } : undefined}
                data-question={question.id}
                onClick={() => props.onJump(question)}
              >
                <i class={`assistant-waiting__icon ${question.app.icon}`} aria-hidden="true" />
                <span class="assistant-waiting__short k2b-truncate-fade">{question.short}</span>
                <Show when={question.conversationId !== props.conversationId}>
                  {/* Read as one name, "… in Team Ops"; the row's gap sets the visible space. */}{" "}
                  <small class="assistant-waiting__chat k2b-truncate-fade">
                    {question.conversationTitle ? t().waitingInChat({ title: question.conversationTitle }) : t().waitingInOtherChat}
                  </small>
                </Show>
              </Button>
            </li>
          )}
        </For>
        <Show when={props.view.more > 0}>
          <li>
            <Button variant="ghost" class="assistant-waiting__entry" onClick={() => props.onShowMore()}>
              {t().waitingMore({ count: props.view.more })}
            </Button>
          </li>
        </Show>
      </ul>
    </nav>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The card of a question in the timeline, by the anchor the chat gives it. */
const questionElement = (content: HTMLElement | undefined, anchor: string): HTMLElement | null =>
  Array.from(content?.querySelectorAll<HTMLElement>(".k2b-chat-decision[data-chat-anchor]") ?? []).find(
    (element) => element.dataset.chatAnchor === anchor,
  ) ?? null;

/**
 * What the strip needs from the timeline: whether it stays quiet, and the jump's landing.
 *
 * `quiet`: with one open question, here, the strip shows only while that question's answers are out of view. A chat
 * opens at its end, where that question is, so the server and the first frame render the strip quiet; its place stays
 * reserved either way.
 *
 * `focus` scrolls a question into view and focuses its sentence, or its outcome once it was answered, waiting a few
 * frames for a chat that just opened. A question that is gone calls `gone`. `current` ends a jump that a newer one
 * replaced.
 */
export const createWaitingQuestionFocus = (input: {
  onlyHere: Accessor<string | null>;
  viewport: Accessor<HTMLElement | undefined>;
  content: Accessor<HTMLElement | undefined>;
  scrollToAnchor: (anchor: string) => boolean;
  gone: () => void;
}) => {
  const [answersOutOfView, setAnswersOutOfView] = createSignal(false);
  createEffect(() => {
    const anchor = input.onlyHere();
    const viewport = input.viewport();
    const content = input.content();
    setAnswersOutOfView(false);
    if (!anchor || !viewport || !content || typeof IntersectionObserver === "undefined") return;
    let observed: Element | null = null;
    let frame: number | undefined;
    const observer = new IntersectionObserver(([entry]) => setAnswersOutOfView(!entry || entry.intersectionRatio < 0.99), {
      root: viewport,
      threshold: [0, 0.99, 1],
    });
    const attach = () => {
      frame = undefined;
      const answers = questionElement(content, anchor)?.querySelector(".k2b-chat-decision__answers") ?? null;
      if (answers === observed) return;
      if (observed) observer.unobserve(observed);
      observed = answers;
      if (answers) observer.observe(answers);
      // A question this chat does not show, or no longer shows open, has no answers in view.
      else setAnswersOutOfView(true);
    };
    // The timeline may render the question's card again; follow it to the new element.
    const changes = new MutationObserver(() => {
      frame ??= requestAnimationFrame(attach);
    });
    changes.observe(content, { childList: true, subtree: true });
    attach();
    onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      changes.disconnect();
      observer.disconnect();
    });
  });

  const focus = async (anchor: string, current: () => boolean = () => true) => {
    let element = questionElement(input.content(), anchor);
    for (let frame = 0; !element && frame < 60; frame += 1) {
      await nextFrame();
      if (!current()) return;
      element = questionElement(input.content(), anchor);
    }
    if (!current()) return;
    if (!element) return input.gone();
    const viewport = input.viewport();
    const card = element.getBoundingClientRect();
    const room = viewport?.getBoundingClientRect();
    if (viewport && room && card.height < room.height) {
      // A card that fits stands in the middle, with its answers in view. One near the chat's end stays at the end,
      // where the chat keeps following new messages and offers no "to the newest message".
      const end = viewport.scrollHeight - viewport.clientHeight;
      const middle = Math.min(end, Math.max(0, viewport.scrollTop + card.top - room.top - (room.height - card.height) / 2));
      if (middle >= end - 1) viewport.scrollTop = end;
      else if (input.scrollToAnchor(anchor)) viewport.scrollTop = middle;
    } else {
      // A taller one starts at the top.
      input.scrollToAnchor(anchor);
    }
    const target =
      element.querySelector<HTMLElement>(".k2b-chat-decision__sentence") ??
      element.querySelector<HTMLElement>(".k2b-chat-outcome") ??
      element;
    target.focus({ preventScroll: true });
  };

  return { quiet: () => input.onlyHere() !== null && !answersOutOfView(), focus };
};
