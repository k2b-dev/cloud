import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { IconButton } from "../actions/Button";
import { useChatMessages } from "../chat/chat-messages";
import { positionTooltipSurface } from "../feedback/tooltip-position";
import { ScrollArea } from "../layout/ScrollArea";

export type ReactionBarItem = {
  /** Stable identity of the reaction, passed to `onToggle`. */
  key: string;
  emoji: string;
  count: number;
  /** The reader reacted this way; the chip shows pressed. */
  own?: boolean;
  /** Who reacted, for example from `reactionPeople`. Read by screen readers and shown in the names hint. */
  label?: string;
  /** A change of the reader's own reaction is still being saved; the chip carries `aria-busy`. */
  busy?: boolean;
};
export type ReactionBarProps = {
  reactions: readonly ReactionBarItem[];
  /** Called with a reaction's key when the reader presses its chip. Without it, the chips are not controls. */
  onToggle?: (key: string) => void;
  /** Called by "Add reaction" with the button to anchor a picker to, such as `EmojiPicker.Popover`. Without it there is no button. */
  onAdd?: (anchor: HTMLElement) => void;
  /** "default": 26 px chips (chat, item detail). "compact": 24 px chips (cards). */
  density?: "default" | "compact";
  /** "scroll" (default): one line of fixed height that scrolls sideways. "wrap": every chip shows, lines wrap. */
  overflow?: "scroll" | "wrap";
  /** Shows at most this many chips and then "+n", n being the number of further emoji. The shown chips do not scroll. */
  max?: number;
  /** Screen-reader text of "+n"; defaults to "{n} more reactions". */
  moreLabel?: (count: number) => string;
  /** "always" (default) or "progressive": shown on hover and focus with a mouse or trackpad (k2b-progressive-action, inside the caller's k2b-progressive-row), kept while its picker is open, hidden on touch. Its place stays reserved. */
  add?: "always" | "progressive";
  class?: string;
};

const HOVER_MS = 250;
const HOLD_MS = 500;
const MOVE_TOLERANCE = 8;

export function ReactionBar(props: ReactionBarProps): JSX.Element {
  const chatMessages = useChatMessages();
  // A max uses the wrapping layout, so the shown chips, +n, and add button wrap together.
  const overflow = () => (props.max !== undefined ? "wrap" : (props.overflow ?? "scroll"));
  const shown = createMemo(() => (props.max === undefined ? props.reactions : props.reactions.slice(0, props.max)));
  const keys = createMemo(() => shown().map((reaction) => reaction.key));
  const byKey = createMemo(() => new Map(shown().map((reaction) => [reaction.key, reaction])));
  const more = () => props.reactions.length - shown().length;
  /** The reaction whose names the hint shows; it follows that reaction while the caller updates it. */
  const [hintKey, setHintKey] = createSignal<string>();
  const hinted = () => {
    const key = hintKey();
    const reaction = key === undefined ? undefined : byKey().get(key);
    return reaction?.label?.trim() ? reaction : undefined;
  };
  const hint = () => {
    const reaction = hinted();
    return reaction ? `${reaction.emoji} ${reaction.label}` : "";
  };
  const [touch, setTouch] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let surface: HTMLSpanElement | undefined;

  onMount(() => {
    if (!root || !surface) return;
    const bar = root;
    const tooltip = surface;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let openChip: HTMLElement | undefined;
    let swallowClick = false;
    let press: { chip: HTMLElement; id: number; x: number; y: number; held: boolean; moved: boolean } | undefined;

    const chipOf = (target: EventTarget | null): HTMLElement | undefined => {
      const chip = target instanceof Element ? target.closest<HTMLElement>("[data-reaction-key]") : null;
      return chip && chip.closest(".k2b-reaction-bar") === bar ? chip : undefined;
    };
    const clearTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const close = () => {
      clearTimer();
      openChip = undefined;
      try {
        tooltip.hidePopover();
      } catch {
        /* The surface may already be disconnected. */
      }
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
    const dismiss = () => close();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    /** Opens the names hint over a chip; false when the chip has no names to show. */
    const open = (chip: HTMLElement, fromTouch: boolean): boolean => {
      clearTimer();
      const reaction = byKey().get(chip.dataset.reactionKey ?? "");
      if (!reaction?.label?.trim() || !chip.isConnected) return false;
      setHintKey(reaction.key);
      setTouch(fromTouch);
      if (!tooltip.matches(":popover-open")) {
        try {
          tooltip.showPopover();
        } catch {
          return false;
        }
      }
      openChip = chip;
      positionTooltipSurface(tooltip, chip, "top");
      document.addEventListener("pointerdown", dismiss, true);
      document.addEventListener("keydown", escape);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
      return true;
    };
    // An open hint follows its reaction: new names show at once, and it closes when the reaction, its names, or its
    // chip go away.
    createEffect(
      on(hinted, (reaction) => {
        if (!openChip) return;
        if (!reaction || !openChip.isConnected) close();
        else positionTooltipSurface(tooltip, openChip, "top");
      }),
    );
    const delayed = (chip: HTMLElement) => {
      if (touch() && openChip) return;
      if (
        !byKey()
          .get(chip.dataset.reactionKey ?? "")
          ?.label?.trim()
      ) {
        close();
        return;
      }
      clearTimer();
      if (openChip) open(chip, false);
      else timer = setTimeout(() => open(chip, false), HOVER_MS);
    };
    const enter = (event: PointerEvent) => {
      const chip = chipOf(event.target);
      if (chip && event.target === chip && event.pointerType !== "touch") delayed(chip);
    };
    const leave = (event: PointerEvent) => {
      if (event.target !== chipOf(event.target) || (touch() && openChip)) return;
      // Moving directly to another chip keeps an open hint available for its immediate update.
      const next = chipOf(event.relatedTarget);
      if (
        !next ||
        !byKey()
          .get(next.dataset.reactionKey ?? "")
          ?.label?.trim()
      )
        close();
    };
    const focusIn = (event: FocusEvent) => {
      const chip = chipOf(event.target);
      if (chip?.matches(":focus-visible")) delayed(chip);
    };
    const focusOut = (event: FocusEvent) => {
      if (chipOf(event.target) && !chipOf(event.relatedTarget) && !(touch() && openChip)) close();
    };
    const resetSwallow = () => {
      swallowClick = false;
      document.removeEventListener("pointerdown", resetSwallow, true);
    };
    const endPress = () => {
      clearTimer();
      press = undefined;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
    const down = (event: PointerEvent) => {
      resetSwallow();
      close();
      endPress();
      const chip = chipOf(event.target);
      if (!chip || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
      press = { chip, id: event.pointerId, x: event.clientX, y: event.clientY, held: false, moved: false };
      timer = setTimeout(() => {
        timer = undefined;
        if (!press || press.moved) return;
        // Only a hold that shows names takes the press; on a chip without names it stays an ordinary press.
        press.held = open(press.chip, true);
      }, HOLD_MS);
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", cancel, true);
    };
    const move = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_TOLERANCE) {
        press.moved = true;
        clearTimer();
      }
    };
    const up = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      if (press.held) {
        swallowClick = true;
        // Some browsers send no click after a hold. Never consume the next real tap.
        document.addEventListener("pointerdown", resetSwallow, true);
      } else if (!press.moved && !props.onToggle) open(press.chip, true);
      endPress();
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === press?.id) endPress();
    };
    const touchEnd = (event: TouchEvent) => {
      if (!swallowClick || !event.cancelable) return;
      // A cancelled touchend sends no click, so nothing is left to swallow.
      event.preventDefault();
      resetSwallow();
    };
    // Only the click of the held finger or pen is swallowed; a keyboard's click has no detail and always goes through.
    const click = (event: MouseEvent) => {
      if (!swallowClick || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
      resetSwallow();
    };
    const contextMenu = (event: MouseEvent) => {
      if (chipOf(event.target) && (press || swallowClick || (touch() && openChip))) event.preventDefault();
    };

    bar.addEventListener("pointerenter", enter, true);
    bar.addEventListener("pointerleave", leave, true);
    bar.addEventListener("focusin", focusIn);
    bar.addEventListener("focusout", focusOut);
    bar.addEventListener("pointerdown", down);
    bar.addEventListener("touchend", touchEnd, { passive: false });
    bar.addEventListener("click", click, true);
    bar.addEventListener("contextmenu", contextMenu);
    onCleanup(() => {
      close();
      endPress();
      resetSwallow();
      bar.removeEventListener("pointerenter", enter, true);
      bar.removeEventListener("pointerleave", leave, true);
      bar.removeEventListener("focusin", focusIn);
      bar.removeEventListener("focusout", focusOut);
      bar.removeEventListener("pointerdown", down);
      bar.removeEventListener("touchend", touchEnd);
      bar.removeEventListener("click", click, true);
      bar.removeEventListener("contextmenu", contextMenu);
    });
  });

  const chip = (key: string, reaction: Accessor<ReactionBarItem>) => {
    const label = (own: boolean) =>
      chatMessages().messageReaction({ emoji: reaction().emoji, count: reaction().count, names: reaction().label, own });
    return (
      <Show
        when={props.onToggle}
        fallback={
          <span
            class="k2b-reaction-bar__chip"
            role="img"
            aria-label={label(Boolean(reaction().own))}
            aria-busy={reaction().busy ? "true" : undefined}
            data-own={reaction().own ? "" : undefined}
            data-reaction-key={key}
            data-gesture-ignore
          >
            <span aria-hidden="true">{reaction().emoji}</span>
            <span aria-hidden="true">{reaction().count}</span>
          </span>
        }
      >
        {(toggle) => (
          <button
            type="button"
            class="k2b-reaction-bar__chip"
            aria-pressed={reaction().own ? "true" : "false"}
            aria-label={label(false)}
            aria-busy={reaction().busy ? "true" : undefined}
            data-own={reaction().own ? "" : undefined}
            data-reaction-key={key}
            onClick={() => toggle()(key)}
          >
            <span aria-hidden="true">{reaction().emoji}</span>
            <span aria-hidden="true">{reaction().count}</span>
          </button>
        )}
      </Show>
    );
  };
  const chips = () => <For each={keys()}>{(key) => <Show when={byKey().get(key)}>{(reaction) => chip(key, reaction)}</Show>}</For>;

  return (
    <div
      ref={root}
      class={props.class ? `k2b-reaction-bar ${props.class}` : "k2b-reaction-bar"}
      role="group"
      aria-label={chatMessages().messageReactions}
      data-density={props.density ?? "default"}
      data-overflow={overflow()}
      data-add={props.onAdd ? (props.add ?? "always") : undefined}
      data-empty={props.reactions.length === 0 ? "" : undefined}
    >
      <Show when={overflow() === "scroll"} fallback={<div class="k2b-reaction-bar__list">{chips()}</div>}>
        <Show when={shown().length > 0}>
          <ScrollArea orientation="horizontal" class="k2b-reaction-bar__scroll" tabindex={props.onToggle ? undefined : 0}>
            {chips()}
          </ScrollArea>
        </Show>
      </Show>
      <Show when={more() > 0}>
        <span class="k2b-reaction-bar__more">
          <span aria-hidden="true">+{more()}</span>
          <span class="k2b-sr-only">{props.moreLabel?.(more()) ?? chatMessages().moreReactions({ count: more() })}</span>
        </span>
      </Show>
      <Show when={props.onAdd}>
        {(add) => (
          <span class={`k2b-reaction-bar__add${props.add === "progressive" ? " k2b-progressive-action" : ""}`}>
            <IconButton
              label={chatMessages().messageAddReaction}
              size="xs"
              class="k2b-reaction-bar__add-button"
              aria-haspopup="dialog"
              onClick={(event) => add()(event.currentTarget)}
            >
              <i class="ti ti-mood-plus" aria-hidden="true" />
            </IconButton>
          </span>
        )}
      </Show>
      <span
        ref={surface}
        class="k2b-tooltip k2b-reaction-bar__hint"
        popover="manual"
        role="tooltip"
        aria-hidden="true"
        data-touch={touch() ? "" : undefined}
      >
        {hint()}
      </span>
    </div>
  );
}
