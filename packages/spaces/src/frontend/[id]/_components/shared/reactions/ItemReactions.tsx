import { EmojiPicker, ReactionBar, type ReactionBarProps, reactionPeople, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { MAX_ITEM_REACTION_EMOJI, type SpaceItemReaction } from "@/contracts";
import type { RetryToast } from "../../../../lib/feedback";
import { useSpaceMessages } from "../../../messages";
import { queueReaction, type ReactionIntent, type ReactionNotice, shownReactions, showReactions } from "./reaction-queue";
import { readRecentEmoji, rememberRecentEmoji } from "./recent-emoji";

type PickTarget = { anchor: HTMLElement; pick: (emoji: string) => void };
export type ReactionPicker = { open: (anchor: HTMLElement, pick: (emoji: string) => void) => void; popover: () => JSX.Element };

/**
 * One emoji picker for a whole surface, such as the board or the item detail, anchored to the "Add reaction" button
 * that opened it. Recent emoji are read when it opens, so the server render never touches storage.
 */
export const createReactionPicker = (): ReactionPicker => {
  const [target, setTarget] = createSignal<PickTarget>();
  const [recent, setRecent] = createSignal<readonly string[]>([]);
  return {
    open: (anchor, pick) => {
      setRecent(readRecentEmoji());
      setTarget({ anchor, pick });
    },
    popover: () => (
      <EmojiPicker.Popover
        anchor={target()?.anchor}
        recent={recent()}
        onPick={(emoji) => {
          setRecent(rememberRecentEmoji(emoji));
          target()?.pick(emoji);
        }}
        onClose={() => setTarget(undefined)}
      />
    ),
  };
};

const ADD = "add";
/**
 * The reaction control that had the focus when it left the page, because its card was rebuilt, such as by the column
 * reload after a saved reaction, or because its chip went away. The bar gives it back, or the place it was at. Any
 * other move of the focus clears it.
 */
let lastFocus: { itemId: string; density: string; key: string; position: number } | undefined;
const controlKey = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return undefined;
  const chip = target.closest<HTMLElement>("[data-reaction-key]");
  if (chip) return chip.dataset.reactionKey;
  return target.closest(".k2b-reaction-bar__add") ? ADD : undefined;
};

const focusDocuments = new WeakSet<Document>();

type Props = {
  spaceId: string;
  itemId: string;
  /** The item payload's summary in server order; absent counts as none. */
  reactions: SpaceItemReaction[] | undefined;
  /** Chips toggle and "Add reaction" shows; otherwise chips only read. */
  canReact: boolean;
  picker: ReactionPicker;
  /** The surface's Retry toasts; they close with it. */
  retryToast: RetryToast;
  density: NonNullable<ReactionBarProps["density"]>;
  add: NonNullable<ReactionBarProps["add"]>;
  focusFallback?: () => HTMLElement | null | undefined;
  max?: number;
  class?: string;
};

/**
 * The reactions of one item: the item payload plus the person's intents, which are saved one after another per item.
 * A failed intent drops out, so the chip shows the server state again, and its toast sends the same intent once more.
 * A saved one stays on the view until the item has been read again.
 */
export default function ItemReactions(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const target = () => ({ spaceId: props.spaceId, itemId: props.itemId });
  const shown = createMemo(() => shownReactions(target(), props.reactions ?? []));
  const ownReaction = (emoji: string) => shown().reactions.some((reaction) => reaction.emoji === emoji && reaction.own);

  const notice: ReactionNotice = {
    failed: (intent) => props.retryToast(t.reactionSaveFailed, t.reactionRetry, () => queueReaction(target(), intent, notice)),
    refreshFailed: (retry) => props.retryToast(t.itemRefreshFailed, t.retry, retry),
    // Trying again cannot help, so the toast says what does instead of offering Retry.
    limitReached: () => toast.error(t.reactionLimitReached({ count: MAX_ITEM_REACTION_EMOJI })),
  };
  if (!isServer) createEffect(() => onCleanup(showReactions(target(), notice)));
  const queue = (intent: ReactionIntent) => queueReaction(target(), intent, notice);
  // A chip turns the person's own reaction off or on; the picker only adds, so a pick of their own emoji changes nothing.
  const toggle = (emoji: string) => queue({ emoji, on: !ownReaction(emoji) });
  const pick = (emoji: string) => {
    if (ownReaction(emoji)) return;
    const known = shown().reactions.some((reaction) => reaction.emoji === emoji);
    if (!known && shown().reactions.length >= MAX_ITEM_REACTION_EMOJI) notice.limitReached();
    else queue({ emoji, on: true });
  };

  const items = () =>
    shown().reactions.map((reaction) => ({
      key: reaction.emoji,
      emoji: reaction.emoji,
      count: reaction.count,
      own: reaction.own,
      busy: shown().busy.has(reaction.emoji),
      label: reactionPeople(
        { names: reaction.people.map((person) => person.displayName), own: reaction.own, count: reaction.count },
        locale(),
      ),
    }));

  let wrapper: HTMLSpanElement | undefined;
  const chips = () => [...(wrapper?.querySelectorAll<HTMLElement>("[data-reaction-key]") ?? [])];
  const addButton = () => wrapper?.querySelector<HTMLElement>(".k2b-reaction-bar__add button") ?? undefined;
  const tryFocus = (control: HTMLElement | null | undefined) => {
    control?.focus({ preventScroll: true });
    return Boolean(control) && document.activeElement === control;
  };
  /**
   * Gives the focus back after it fell to the page with its control: to the same control, else to the chip now at its
   * place or the one before, "Add reaction", or the surface's fallback. A hidden "Add reaction", as on touch screens,
   * does not take focus, so the next one is tried.
   */
  const restoreFocus = () => {
    const previous = lastFocus;
    if (!wrapper || previous?.itemId !== props.itemId || previous.density !== props.density) return;
    // Focus elsewhere stays where it is.
    if (document.activeElement && document.activeElement !== document.body) return;
    const all = chips();
    const same = previous.key === ADD ? addButton() : all.find((chip) => chip.dataset.reactionKey === previous.key);
    if (tryFocus(same)) return;
    for (const control of [all[previous.position], all[previous.position - 1], addButton(), props.focusFallback?.()]) {
      if (tryFocus(control)) return;
    }
  };
  // A live change or the person's own toggle can remove the focused chip while the bar stays.
  createEffect(on(shown, restoreFocus, { defer: true }));
  onMount(() => {
    if (!focusDocuments.has(document)) {
      focusDocuments.add(document);
      const clear = (event: Event) => {
        if (controlKey(event.target) === undefined) lastFocus = undefined;
      };
      document.addEventListener("pointerdown", clear, true);
      document.addEventListener("focusin", clear, true);
    }
    // A rebuilt card gives back the focus its old card lost.
    restoreFocus();
  });

  return (
    // The wrapper takes no layout; it only follows the focus of the controls inside.
    <span
      ref={wrapper}
      class="contents"
      onFocusIn={(event) => {
        const key = controlKey(event.target);
        const position = key === ADD ? chips().length : chips().findIndex((chip) => chip.dataset.reactionKey === key);
        lastFocus = key ? { itemId: props.itemId, density: props.density, key, position } : undefined;
      }}
      onFocusOut={(event) => {
        const left = event.target;
        if (event.relatedTarget instanceof Node) {
          if (!wrapper?.contains(event.relatedTarget)) lastFocus = undefined;
          return;
        }
        // Focus that went to the page while its control stays, such as after a click outside, is not given back later.
        queueMicrotask(() => {
          if (left instanceof Node && left.isConnected) lastFocus = undefined;
        });
      }}
    >
      <ReactionBar
        reactions={items()}
        density={props.density}
        max={props.max}
        overflow="wrap"
        moreLabel={props.max === undefined ? undefined : (count) => t.moreReactionsInItem({ count })}
        add={props.add}
        onToggle={props.canReact ? toggle : undefined}
        onAdd={props.canReact ? (anchor) => props.picker.open(anchor, pick) : undefined}
        class={props.class}
      />
    </span>
  );
}
