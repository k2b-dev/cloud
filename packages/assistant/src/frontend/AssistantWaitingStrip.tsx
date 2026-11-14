import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantMessages } from "./messages";
import type { WaitingAttention, WaitingQuestionsView } from "./waiting-questions";

/** The sign of each kind of entry; a new source adds its kind here. */
const KIND_ICON: Record<AiOpenQuestion["kind"] | WaitingAttention["kind"], string> = {
  approval: "ti ti-shield-check",
  routine: "ti ti-alert-circle",
  app_run: "ti ti-alert-circle",
};

/** The row shows at most this many entries; the rest are behind "+n". A narrow chat shows one. */
const WAITING_CHIPS = 3;

type Entry = {
  key: string;
  kind: AiOpenQuestion["kind"] | WaitingAttention["kind"];
  short: string;
  /** "in <chat>" for an entry of another chat. */
  where: string | null;
  open: () => void;
};

/**
 * "Waiting for you" above the composer: everything that waits for the person, each entry with the sign of its kind and
 * a short sentence, those of other chats with the chat's name. A press goes to the thing itself. There is deliberately
 * no way to answer several at once: each answer belongs to its own card, where the person sees what it does.
 *
 * The row is 32 px high and never wraps: what does not fit is behind "+n", which opens the whole list as a menu (a sheet
 * on phones), grouped into this chat and other chats, with "See all". It lies over the free margin at the timeline's
 * end, so it appears and leaves without moving the field or the conversation. `quiet` keeps it in place but hides it.
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
  const entries = (): Entry[] => [
    ...props.view.attention.map((item) => ({ key: item.key, kind: item.kind, short: item.short, where: null, open: item.open })),
    ...props.view.entries.map((question) => ({
      key: question.id,
      kind: question.kind,
      short: question.short,
      where:
        question.conversationId === props.conversationId
          ? null
          : question.conversationTitle
            ? t().waitingInChat({ title: question.conversationTitle })
            : t().waitingInOtherChat,
      open: () => props.onJump(question),
    })),
  ];
  const shown = () => entries().slice(0, WAITING_CHIPS);
  /** Behind "+n": what the row leaves out, and what the server's bounded read did not send. */
  const hidden = (visible: number) => Math.max(0, entries().length - visible) + props.view.more;
  const menu = (): DropdownItem[] => {
    const item = (entry: Entry) => ({
      icon: KIND_ICON[entry.kind],
      label: entry.short,
      description: entry.where ?? undefined,
      action: entry.open,
    });
    const here = entries().filter((entry) => entry.where === null);
    const elsewhere = entries().filter((entry) => entry.where !== null);
    return [
      ...(here.length ? [{ sectionLabel: t().waitingHere, items: here.map(item) }] : []),
      ...(elsewhere.length ? [{ sectionLabel: t().waitingElsewhere, items: elsewhere.map(item) }] : []),
      { items: [{ label: t().waitingAll, action: () => props.onShowMore() }] },
    ];
  };
  return (
    <nav class="assistant-waiting" aria-label={t().needsAttention} data-quiet={props.quiet ? "" : undefined} inert={props.quiet}>
      <span class="assistant-waiting__label" aria-hidden="true">
        <i class="ti ti-hand-stop" />
        <span class="assistant-waiting__title">{t().needsAttention}</span>
      </span>
      <ul class="assistant-waiting__list">
        <For each={shown()}>
          {(entry) => (
            <li class="assistant-waiting__item">
              <button
                type="button"
                class="assistant-waiting__entry"
                data-kind={entry.kind}
                data-entry={entry.key}
                title={entry.where ? `${entry.short} ${entry.where}` : entry.short}
                onClick={() => entry.open()}
              >
                <i class={`assistant-waiting__icon ${KIND_ICON[entry.kind]}`} aria-hidden="true" />
                <span class="assistant-waiting__short k2b-truncate-fade">{entry.short}</span>
                <Show when={entry.where}>
                  {(where) => (
                    <>
                      {/* Read as one name, "… in Team Ops"; the chip's gap sets the visible space. */}{" "}
                      <small class="assistant-waiting__chat k2b-truncate-fade">{where()}</small>
                    </>
                  )}
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>
      {/* Wide, "+n" counts what the row leaves out; narrow, the row shows one entry and "+n" counts the rest. */}
      <Show when={entries().length > 1 || props.view.more > 0}>
        <Dropdown.Root position="top-left" phone="sheet" label={t().needsAttention} items={menu()}>
          <Dropdown.Trigger
            appearance="plain"
            class="assistant-waiting__more"
            data-wide={hidden(WAITING_CHIPS) > 0 ? "" : undefined}
            label={t().waitingShowAll({ count: entries().length + props.view.more })}
          >
            <span class="assistant-waiting__count" data-width="wide">
              +{hidden(WAITING_CHIPS)}
            </span>
            <span class="assistant-waiting__count" data-width="narrow">
              +{hidden(1)}
            </span>
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
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
