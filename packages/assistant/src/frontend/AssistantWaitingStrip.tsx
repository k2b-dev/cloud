import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { type Accessor, children, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { assistantMessages } from "./messages";
import type { WaitingAttention, WaitingQuestionsView } from "./waiting-questions";

/** The sign of each kind of entry; a new source adds its kind here. */
const KIND_ICON: Record<AiOpenQuestion["kind"] | WaitingAttention["kind"], string> = {
  approval: "ti ti-shield-check",
  code_activate: "ti ti-power",
  code_changes: "ti ti-message-2",
  code_expired: "ti ti-clock-off",
  code_attention: "ti ti-alert-circle",
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
  /**
   * The list's last entry. Assistant opens Approvals there, always, as "See all"; the PWA goes to the next waiting
   * chat and names it after the questions the read left out, only while there are such.
   */
  more?: { label: string; always: boolean };
  /**
   * The second part of the row (Feinschliff v6, 6b): "Queued · n" at its end, which opens the queued messages. The row
   * still never grows past one line.
   */
  queue?: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  // Resolved once, so reading it for the row's state and its place does not render it twice.
  const queue = children(() => props.queue);
  const entryList = createMemo((): Entry[] => [
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
  ]);
  const entries = entryList;
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])));
  // Chips are keyed by their entry, so a live update that leaves an entry in place keeps its element and focus.
  const shownKeys = createMemo(
    () =>
      entries()
        .slice(0, WAITING_CHIPS)
        .map((entry) => entry.key),
    undefined,
    {
      equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
    },
  );
  /**
   * Chips keep their natural width; those that do not fit beside the first leave the row and count in "+n". Measured
   * whenever the row's width or its entries change, before the next paint.
   */
  let list: HTMLUListElement | undefined;
  const [cut, setCut] = createSignal(0);
  const measure = () => {
    if (!list) return;
    const items = Array.from(list.children) as HTMLElement[];
    for (const item of items) item.removeAttribute("data-cut");
    const limit = list.getBoundingClientRect().right + 0.5;
    let count = 0;
    items.forEach((item, index) => {
      const box = item.getBoundingClientRect();
      if (index === 0 || box.width === 0 || box.right <= limit) return;
      item.setAttribute("data-cut", "");
      count += 1;
    });
    setCut(count);
  };
  createEffect(on(shownKeys, () => queueMicrotask(measure)));
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !list?.parentElement) return;
    const observer = new ResizeObserver(measure);
    observer.observe(list.parentElement);
    onCleanup(() => observer.disconnect());
  });
  /** Behind "+n": what the row leaves out, and what the server's bounded read did not send. */
  const hidden = (visible: number) => Math.max(0, entries().length - visible) + props.view.more;
  const hiddenWide = () => hidden(WAITING_CHIPS) + cut();
  const menu = (): DropdownItem[] => {
    const item = (entry: Entry) => ({
      // The kind's colour, as on the chip: the menu renders in its own layer, so the entry carries it.
      class:
        entry.kind === "approval"
          ? "assistant-waiting__menu-entry"
          : "assistant-waiting__menu-entry assistant-waiting__menu-entry--attention",
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
      ...((props.more?.always ?? true) || props.view.more > 0
        ? [{ items: [{ label: props.more?.label ?? t().waitingAll, action: () => props.onShowMore() }] }]
        : []),
    ];
  };
  return (
    <nav
      class="assistant-waiting"
      aria-label={t().needsAttention}
      data-quiet={props.quiet ? "" : undefined}
      data-queue={queue() ? "" : undefined}
      inert={props.quiet}
    >
      <span class="assistant-waiting__label" aria-hidden="true">
        <i class="ti ti-hand-stop" />
        <span class="assistant-waiting__title">{t().needsAttention}</span>
      </span>
      <ul class="assistant-waiting__list" ref={list}>
        <For each={shownKeys()}>
          {(key) => (
            <Show when={byKey().get(key)}>
              {(current) => {
                const entry = current();
                return (
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
                      {/* The chip shows one sentence (v12 image 69); the chat it belongs to is named in the list. */}
                      <Show when={entry.where}>{(where) => <span class="k2b-sr-only"> {where()}</span>}</Show>
                    </button>
                  </li>
                );
              }}
            </Show>
          )}
        </For>
      </ul>
      {/* Wide, "+n" counts what the row leaves out; narrow, the row shows one entry and "+n" counts the rest. */}
      <Show when={entries().length > 1 || props.view.more > 0}>
        <Dropdown.Root position="top-left" phone="sheet" label={t().needsAttention} items={menu()}>
          <Dropdown.Trigger
            appearance="plain"
            class="assistant-waiting__more"
            data-wide={hiddenWide() > 0 ? "" : undefined}
            label={t().waitingShowAll({ count: entries().length + props.view.more })}
          >
            <span class="assistant-waiting__count" data-width="wide">
              +{hiddenWide()}
            </span>
            <span class="assistant-waiting__count" data-width="narrow">
              +{hidden(1)}
            </span>
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
      <Show when={queue()}>
        <span class="assistant-waiting__grow" />
        {queue()}
      </Show>
    </nav>
  );
}

/** How long a jump waits for its card and the card's main control to appear. */
const LANDING_WAIT_MS = 3000;

/** Resolves on the next change inside `root`, on the next frame without one, or after `ms` at the latest. */
const nextChange = (root: HTMLElement | undefined, ms: number) =>
  new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = root && typeof MutationObserver !== "undefined" ? new MutationObserver(done) : undefined;
    observer?.observe(root!, { childList: true, subtree: true, attributes: true });
    // Without a timeline yet (the chat still opens), look again on the next frame.
    if (!observer) requestAnimationFrame(done);
    const timer = setTimeout(done, Math.max(0, Math.min(ms, root ? 250 : ms)));
  });

/**
 * The card of a waiting entry in the timeline, by the anchor the chat gives it: a decision card, or any other card that
 * waits for the person, such as a version to switch on.
 */
const questionElement = (content: HTMLElement | undefined, anchor: string): HTMLElement | null =>
  Array.from(content?.querySelectorAll<HTMLElement>("[data-chat-anchor]") ?? []).find((element) => element.dataset.chatAnchor === anchor) ??
  null;

/** Where the focus lands on a card: its sentence, its outcome once answered, else its main button. */
const landingTarget = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>(".k2b-chat-decision__sentence") ??
  element.querySelector<HTMLElement>(".k2b-chat-outcome") ??
  element.querySelector<HTMLElement>('[data-chat-primary]:not(:disabled), .k2b-button[data-variant="primary"]:not(:disabled)') ??
  element.querySelector<HTMLElement>("button:not(:disabled), a[href]");

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
    // A card may come late: its chat still loads, or the card itself is loaded on demand and first renders without its
    // buttons. Wait until the card and the place the focus lands on are both there, at most LANDING_WAIT_MS.
    const landing = () => {
      const element = questionElement(input.content(), anchor);
      return element ? { element, target: landingTarget(element) } : null;
    };
    const deadline = performance.now() + LANDING_WAIT_MS;
    let found = landing();
    while (!found?.target && performance.now() < deadline) {
      await nextChange(input.content(), deadline - performance.now());
      if (!current()) return;
      found = landing();
    }
    if (!current()) return;
    if (!found) return input.gone();
    const element = found.element;
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
    const target = found.target ?? element;
    // A card without anything to focus still takes the focus, so the jump never ends on the page itself.
    if (!found.target && !element.hasAttribute("tabindex")) element.tabIndex = -1;
    target.focus({ preventScroll: true });
  };

  return { quiet: () => input.onlyHere() !== null && !answersOutOfView(), focus };
};
