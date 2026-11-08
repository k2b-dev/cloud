import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { Button, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { assistantMessages } from "./messages";
import type { WaitingQuestionsView } from "./waiting-questions";

/**
 * "Gustav is waiting for your approval: <short>" above the composer, in the approval's tint, with **View**. One open
 * approval names itself and View jumps to its card; several are counted, and View jumps to the first one of this chat
 * or opens the list of approvals. There is deliberately no way to answer several at once: each answer belongs to its
 * own card, where the person sees what it does.
 *
 * The line has a fixed height, so an approval opening or closing elsewhere never moves the composer. `quiet` keeps that
 * line in place but hides it.
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
  const count = () => props.view.entries.length + props.view.more;
  const first = () => props.view.entries[0];
  const view = () => {
    const question = first();
    if (question && (count() === 1 || question.conversationId === props.conversationId)) props.onJump(question);
    else props.onShowMore();
  };
  return (
    <nav class="assistant-waiting" aria-label={t().needsAttention} data-quiet={props.quiet ? "" : undefined} inert={props.quiet}>
      <i class="assistant-waiting__mark ti ti-shield-check" aria-hidden="true" />
      <p class="assistant-waiting__text">
        <Show when={count() === 1 ? first() : undefined} fallback={t().waitingForApprovals({ count: count() })}>
          {(question) => (
            <>
              {t().waitingForApproval}{" "}
              <strong class="assistant-waiting__short" data-question={question().id}>
                {question().short}
              </strong>
              <Show when={question().conversationId !== props.conversationId}>
                {" "}
                <small class="assistant-waiting__chat">
                  {question().conversationTitle ? t().waitingInChat({ title: question().conversationTitle! }) : t().waitingInOtherChat}
                </small>
              </Show>
            </>
          )}
        </Show>
      </p>
      <Button variant="secondary" size="sm" class="assistant-waiting__view" onClick={view}>
        {t().waitingView}
        <i class="ti ti-arrow-down" aria-hidden="true" />
      </Button>
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
