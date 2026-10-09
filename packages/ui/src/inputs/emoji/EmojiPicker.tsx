import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Button } from "../../actions/Button";
import { returnFocus, ringOnReturn } from "../../internal/focus-return";
import { useLocale } from "../../intl/locale";
import { useUiMessages } from "../../intl/messages";
import {
  EMOJI_GROUPS,
  EMOJI_SKIN_TONES,
  type EmojiEntry,
  type EmojiGroupKey,
  type EmojiIndex,
  type EmojiSkinTone,
  emojiInTone,
  emojiName,
  findEmoji,
  loadEmojiIndex,
  RECENT_EMOJI_LIMIT,
  searchEmoji,
} from "./emoji-index";
import { type EmojiMessages, useEmojiMessages } from "./emoji-messages";

/** Emoji per row. Keyboard navigation moves by rows of this length. */
const COLUMNS = 8;
/** Search results render in blocks of this many rows, so the browser lays out only the blocks in view. */
const RESULT_BLOCK = 8 * COLUMNS;
const TONE_SAMPLE = "✋";
const TONE_SAMPLE_LIGHT = "✋\u{1F3FB}";

export type EmojiPickerProps = {
  /** Called with the chosen emoji, in the chosen skin tone where it has one. */
  onPick: (emoji: string) => void;
  /** Recently used emoji, most recent first, shown as the first group. The application stores them; see `rememberEmoji`. */
  recent?: readonly string[];
  /** The skin tone for emoji that have one. Defaults to `0`, the default yellow. */
  skinTone?: EmojiSkinTone;
  /** Shows the skin-tone choice. The application stores the tone and passes it back as `skinTone`. */
  onSkinToneChange?: (tone: EmojiSkinTone) => void;
  /** Escape in an empty search field asks to close the surface the picker sits in. */
  onClose?: () => void;
  /** Moves focus into the search field once the picker is shown. */
  autofocus?: boolean;
  /** The picker's accessible name. Defaults to "Emoji". */
  label?: string;
  class?: string;
};

type Section = { key: EmojiGroupKey | "recent"; items: readonly Item[] };
type Item = { emoji: string; entry?: EmojiEntry };

const groupTitle = (messages: EmojiMessages, key: Section["key"]): string => {
  switch (key) {
    case "recent":
      return messages.emojiRecent;
    case "smileys":
      return messages.emojiSmileys;
    case "people":
      return messages.emojiPeople;
    case "animals":
      return messages.emojiAnimals;
    case "food":
      return messages.emojiFood;
    case "travel":
      return messages.emojiTravel;
    case "activities":
      return messages.emojiActivities;
    case "objects":
      return messages.emojiObjects;
    case "symbols":
      return messages.emojiSymbols;
    case "flags":
      return messages.emojiFlags;
  }
};

const toneLabel = (messages: EmojiMessages, tone: EmojiSkinTone): string =>
  [
    messages.emojiToneDefault,
    messages.emojiToneLight,
    messages.emojiToneMediumLight,
    messages.emojiToneMedium,
    messages.emojiToneMediumDark,
    messages.emojiToneDark,
  ][tone]!;

const toneSample = (tone: EmojiSkinTone): string =>
  tone === 0 ? TONE_SAMPLE : TONE_SAMPLE_LIGHT.replace("\u{1F3FB}", String.fromCodePoint(0x1f3fb + tone - 1));

/** Where `index` moves for an arrow key in rows of `COLUMNS`, where every section starts a new row. */
export const nextEmojiIndex = (
  sizes: readonly number[],
  index: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): number => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return -1;
  if (index < 0) return 0;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(total - 1, index + 1);
  const starts: number[] = [];
  sizes.reduce((start, size) => (starts.push(start), start + size), 0);
  const section = starts.findLastIndex((start, position) => start <= index && sizes[position]! > 0);
  const offset = index - starts[section]!;
  const column = offset % COLUMNS;
  const size = sizes[section]!;
  if (key === "ArrowUp") {
    if (offset >= COLUMNS) return index - COLUMNS;
    for (let previous = section - 1; previous >= 0; previous--) {
      if (!sizes[previous]) continue;
      const lastRow = Math.floor((sizes[previous]! - 1) / COLUMNS) * COLUMNS;
      return starts[previous]! + Math.min(lastRow + column, sizes[previous]! - 1);
    }
    return index;
  }
  if (offset + COLUMNS < size) return index + COLUMNS;
  // A shorter last row: the last emoji of the section is below.
  if (Math.floor(offset / COLUMNS) < Math.floor((size - 1) / COLUMNS)) return starts[section]! + size - 1;
  for (let next = section + 1; next < sizes.length; next++) {
    if (sizes[next]) return starts[next]! + Math.min(column, sizes[next]! - 1);
  }
  return index;
};

/**
 * A search field, the groups, and a grid of emoji. Search finds English and German names, keywords and GitHub
 * shortcodes. The focus stays in the search field: arrow keys move through the grid, Enter picks.
 */
function EmojiPickerPanel(props: EmojiPickerProps): JSX.Element {
  const messages = useUiMessages();
  const text = useEmojiMessages();
  const locale = useLocale();
  const id = `k2b-emoji-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const [index, setIndex] = createSignal<EmojiIndex>();
  const [failed, setFailed] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const isActive = createSelector(active);
  const [tonesOpen, setTonesOpen] = createSignal(false);
  const [currentGroup, setCurrentGroup] = createSignal<Section["key"]>();
  /** Up or down moved into the grid; from then on, left and right move there too, until the search changes. */
  const [gridEntered, setGridEntered] = createSignal(false);
  let searchRef: HTMLInputElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let toneButtonRef: HTMLButtonElement | undefined;
  let tonesRef: HTMLDivElement | undefined;
  let groupsRef: HTMLDivElement | undefined;
  /** Keyboard moves scroll the active emoji into view; the pointer does not. */
  let revealActive = false;

  const load = () => {
    setFailed(false);
    loadEmojiIndex().then(setIndex, () => setFailed(true));
  };
  onMount(load);

  const tone = () => props.skinTone ?? 0;
  const searching = () => query().trim().length > 0;
  // The groups render once and stay while a search shows its results above them, so clearing a search is instant.
  const groups = createMemo((): readonly Section[] => {
    const data = index();
    if (!data) return [];
    const recent: Section = {
      key: "recent",
      items: (props.recent ?? []).slice(0, RECENT_EMOJI_LIMIT).map((emoji) => ({ emoji, entry: findEmoji(data, emoji) })),
    };
    const all = EMOJI_GROUPS.map(
      (group): Section => ({
        key: group.key,
        items: data.entries.filter((entry) => entry.group === group.id).map((entry) => ({ emoji: emojiInTone(entry, tone()), entry })),
      }),
    );
    return recent.items.length ? [recent, ...all] : all;
  });
  const groupStarts = createMemo(() => {
    const starts: number[] = [];
    groups().reduce((start, section) => (starts.push(start), start + section.items.length), 0);
    return starts;
  });
  const results = createMemo((): readonly Item[] => {
    const data = index();
    if (!data || !searching()) return [];
    return searchEmoji(data, query()).map((entry) => ({ emoji: emojiInTone(entry, tone()), entry }));
  });
  const resultBlocks = createMemo(() =>
    Array.from({ length: Math.ceil(results().length / RESULT_BLOCK) }, (_, block) =>
      results().slice(block * RESULT_BLOCK, (block + 1) * RESULT_BLOCK),
    ),
  );
  /** The sizes of the visible sections, for the arrow keys. */
  const sizes = () => (searching() ? [results().length] : groups().map((section) => section.items.length));
  const items = createMemo(() => (searching() ? results() : groups().flatMap((section) => section.items)));
  const activeItem = () => items()[active()];
  const optionId = (position: number, list = searching() ? "r" : "g") => `${id}-${list}${position}`;
  const nameOf = (item: Item) => (item.entry ? emojiName(item.entry, locale()) : item.emoji);
  /** Where an element sits in the list, from its top. */
  const offsetOf = (element: Element) =>
    element.getBoundingClientRect().top - scrollRef!.getBoundingClientRect().top + scrollRef!.scrollTop;

  // A new search starts at its best match; the groups at their top.
  createEffect(
    on([query, index], () => {
      setActive(0);
      if (scrollRef) scrollRef.scrollTop = 0;
    }),
  );

  createEffect(() => {
    const position = active();
    if (!revealActive) return;
    revealActive = false;
    const option = document.getElementById(optionId(position));
    if (!option || !scrollRef) return;
    // Sticky group titles cover the top of the list; an emoji in a first row scrolls with its title.
    const covered = option.closest("[role='group']")?.querySelector<HTMLElement>("[data-emoji-heading]")?.offsetHeight ?? 0;
    const top = offsetOf(option) - covered;
    const bottom = offsetOf(option) + option.offsetHeight;
    if (top < scrollRef.scrollTop) scrollRef.scrollTop = top;
    else if (bottom > scrollRef.scrollTop + scrollRef.clientHeight) scrollRef.scrollTop = bottom - scrollRef.clientHeight;
  });

  /** The group whose title sits at the top of the list, for the group bar. */
  const syncGroup = () => {
    if (!scrollRef || searching()) return;
    const top = scrollRef.scrollTop + 1;
    let current: Section["key"] | undefined;
    for (const group of scrollRef.querySelectorAll<HTMLElement>("[data-emoji-group]")) {
      if (offsetOf(group) <= top) current = group.dataset.emojiGroup as Section["key"];
    }
    setCurrentGroup(current ?? groups()[0]?.key);
  };
  createEffect(on([groups, searching], () => queueMicrotask(syncGroup)));

  onMount(() => {
    if (props.autofocus) queueMicrotask(() => searchRef?.focus({ preventScroll: true }));
  });

  const pick = (item: Item | undefined) => {
    if (item) props.onPick(item.emoji);
  };

  const showGroup = (key: Section["key"]) => {
    setQuery("");
    queueMicrotask(() => {
      const group = scrollRef?.querySelector<HTMLElement>(`[data-emoji-group="${key}"]`);
      if (!group || !scrollRef) return;
      scrollRef.scrollTop = offsetOf(group);
      const position = groups().findIndex((section) => section.key === key);
      if (position >= 0) setActive(groupStarts()[position]!);
      syncGroup();
    });
  };

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      // Left and right edit a search until up or down enters the grid.
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && query() && !gridEntered()) return;
      event.preventDefault();
      revealActive = true;
      setGridEntered(true);
      setActive(nextEmojiIndex(sizes(), active(), event.key));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(activeItem());
      return;
    }
    if (event.key === "Escape") {
      if (query()) {
        event.preventDefault();
        event.stopPropagation();
        setQuery("");
        return;
      }
      if (props.onClose) {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    }
  };

  const openTones = () => {
    setTonesOpen(true);
    queueMicrotask(() => tonesRef?.querySelector<HTMLElement>("[aria-checked='true']")?.focus());
  };
  const closeTones = (focusButton: boolean) => {
    setTonesOpen(false);
    if (focusButton) queueMicrotask(() => toneButtonRef?.focus());
  };
  /** As in any radio group, the arrow keys choose; Enter, Space, a click or Escape close the choice. */
  const onTonesKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = EMOJI_SKIN_TONES[(tone() + step + EMOJI_SKIN_TONES.length) % EMOJI_SKIN_TONES.length]!;
      props.onSkinToneChange?.(next);
      queueMicrotask(() => tonesRef?.querySelector<HTMLElement>(`[data-tone="${next}"]`)?.focus());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeTones(true);
    }
  };

  /** The group bar is one tab stop; arrow keys move along it. */
  const onGroupsKeyDown = (event: KeyboardEvent) => {
    const buttons = [...(groupsRef?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    buttons[(target + buttons.length) % buttons.length]?.focus();
  };
  const groupKeys = createMemo((): Section["key"][] => [
    ...(props.recent?.length ? (["recent"] as const) : []),
    ...EMOJI_GROUPS.map((group) => group.key),
  ]);
  const groupIcon = (key: Section["key"]) =>
    key === "recent" ? "ti ti-clock" : (EMOJI_GROUPS.find((group) => group.key === key)?.icon ?? "ti ti-mood-smile");
  const tabStop = () => currentGroup() ?? groupKeys()[0];

  /** The grid shares its pointer listeners; the target's position says which emoji it is. */
  const itemAt = (event: Event): number | undefined => {
    const option = (event.target as Element | null)?.closest<HTMLElement>("[data-emoji-index]");
    return option ? Number(option.dataset.emojiIndex) : undefined;
  };

  // A button, so that a tap is a click on every engine; the focus stays in the search field.
  const option = (item: Item, list: "r" | "g", position: () => number) => (
    <button
      id={optionId(position(), list)}
      type="button"
      role="option"
      tabIndex={-1}
      class="k2b-emoji-picker__option"
      aria-selected={isActive(position())}
      aria-label={nameOf(item)}
      data-emoji-index={position()}
      data-active={isActive(position()) ? "true" : undefined}
      onClick={() => pick(item)}
    >
      {item.emoji}
    </button>
  );

  return (
    <div class={`k2b-emoji-picker ${props.class ?? ""}`} role="group" aria-label={props.label ?? text().emojiPicker}>
      <div class="k2b-emoji-picker__header">
        <div class="k2b-emoji-picker__search" inert={tonesOpen()}>
          <i class="ti ti-search" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            role="combobox"
            aria-label={text().emojiSearch}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={activeItem() ? optionId(active()) : undefined}
            placeholder={text().emojiSearch}
            autocomplete="off"
            spellcheck={false}
            enterkeyhint="done"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setGridEntered(false);
            }}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <Show when={props.onSkinToneChange}>
          <button
            ref={toneButtonRef}
            type="button"
            class="k2b-emoji-picker__tone-button"
            aria-label={text().emojiSkinTone}
            aria-haspopup="true"
            aria-expanded={tonesOpen()}
            title={`${text().emojiSkinTone}: ${toneLabel(text(), tone())}`}
            inert={tonesOpen()}
            onClick={openTones}
          >
            <span aria-hidden="true">{toneSample(tone())}</span>
          </button>
          {/* The tones cover the header in place, so nothing below moves. */}
          <Show when={tonesOpen()}>
            <div
              ref={tonesRef}
              class="k2b-emoji-picker__tones"
              role="radiogroup"
              aria-label={text().emojiSkinTone}
              onKeyDown={onTonesKeyDown}
              onFocusOut={(event) => {
                if (!tonesRef?.contains(event.relatedTarget as Node | null)) closeTones(false);
              }}
            >
              <For each={EMOJI_SKIN_TONES}>
                {(value) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={value === tone()}
                    aria-label={toneLabel(text(), value)}
                    title={toneLabel(text(), value)}
                    tabIndex={value === tone() ? 0 : -1}
                    data-tone={value}
                    onClick={() => {
                      props.onSkinToneChange?.(value);
                      closeTones(true);
                    }}
                  >
                    <span aria-hidden="true">{toneSample(value)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <div ref={groupsRef} class="k2b-emoji-picker__groups" role="toolbar" aria-label={text().emojiGroups} onKeyDown={onGroupsKeyDown}>
        <For each={groupKeys()}>
          {(key) => (
            <button
              type="button"
              aria-label={groupTitle(text(), key)}
              title={groupTitle(text(), key)}
              aria-current={!searching() && currentGroup() === key ? "true" : undefined}
              tabIndex={key === tabStop() ? 0 : -1}
              disabled={!index()}
              onClick={() => showGroup(key)}
            >
              <i class={groupIcon(key)} aria-hidden="true" />
            </button>
          )}
        </For>
      </div>

      <div ref={scrollRef} class="k2b-emoji-picker__scroll" onScroll={syncGroup}>
        <Show
          when={index()}
          fallback={
            <div class="k2b-emoji-picker__state" role="status">
              <Show
                when={failed()}
                fallback={
                  <>
                    <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                    <span class="k2b-sr-only">{messages().loading}</span>
                  </>
                }
              >
                <span>{text().emojiLoadFailed}</span>
                <Button size="sm" variant="subtle" onClick={load}>
                  {messages().retry}
                </Button>
              </Show>
            </div>
          }
        >
          <div
            id={`${id}-list`}
            role="listbox"
            class="k2b-emoji-picker__list"
            aria-label={props.label ?? text().emojiPicker}
            onPointerMove={(event) => {
              const position = itemAt(event);
              if (position !== undefined && !isActive(position) && event.pointerType === "mouse") setActive(position);
            }}
            onMouseDown={(event) => {
              // The focus stays in the search field, where the keyboard works.
              if (itemAt(event) !== undefined) event.preventDefault();
            }}
          >
            <Show when={searching()}>
              <div role="group" aria-label={messages().searchResults}>
                <For each={resultBlocks()}>
                  {(block, blockIndex) => (
                    <div
                      class="k2b-emoji-picker__grid k2b-emoji-picker__block"
                      style={{ "--k2b-emoji-rows": String(Math.ceil(block.length / COLUMNS)) }}
                    >
                      <For each={block}>{(item, itemIndex) => option(item, "r", () => blockIndex() * RESULT_BLOCK + itemIndex())}</For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="k2b-emoji-picker__all" hidden={searching()}>
              <For each={groups()}>
                {(section, sectionIndex) => (
                  <div
                    role="group"
                    class="k2b-emoji-picker__section"
                    data-emoji-group={section.key}
                    aria-labelledby={`${id}-${section.key}`}
                    style={{ "--k2b-emoji-rows": String(Math.ceil(section.items.length / COLUMNS)) }}
                  >
                    <div id={`${id}-${section.key}`} class="k2b-emoji-picker__heading" data-emoji-heading>
                      {groupTitle(text(), section.key)}
                    </div>
                    <div class="k2b-emoji-picker__grid">
                      <For each={section.items}>
                        {(item, itemIndex) => option(item, "g", () => groupStarts()[sectionIndex()]! + itemIndex())}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
          <Show when={searching() && results().length === 0}>
            <div class="k2b-emoji-picker__state" role="status">
              {text().emojiNoResults}
            </div>
          </Show>
        </Show>
      </div>

      <div class="k2b-emoji-picker__preview" aria-hidden="true">
        <Show when={activeItem()}>
          {(item) => (
            <>
              <span class="k2b-emoji-picker__preview-emoji">{item().emoji}</span>
              <span class="k2b-emoji-picker__preview-name">{nameOf(item())}</span>
              <Show when={item().entry?.shortcodes[0]}>{(code) => <span class="k2b-emoji-picker__preview-code">:{code()}:</span>}</Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

export type EmojiPickerPopoverProps = Omit<EmojiPickerProps, "onClose" | "autofocus"> & {
  /** The control the picker opens next to. The picker is open while this is set. */
  anchor: HTMLElement | null | undefined;
  /** Called after a pick, on Escape, on a click outside, and on another press of the anchor. */
  onClose: () => void;
};

const touchOnlyQuery = "(any-pointer: coarse) and (not (any-pointer: fine))";
const GAP = 6;
const MARGIN = 8;

/**
 * The picker next to a control, such as the composer's emoji button or a message's "Add reaction". It opens above the
 * control where there is room and below it otherwise, closes after a pick, and returns the focus to where it was.
 */
function EmojiPickerPopover(props: EmojiPickerPopoverProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  /** Where the focus was when the picker opened, and whether a keyboard opened it. */
  let previous: HTMLElement | null = null;
  let ring = false;
  /** An anchor pressed while the picker was open closes it; the same click must not open it again. */
  let pressedAnchor: HTMLElement | undefined;
  const [shown, setShown] = createSignal<HTMLElement>();

  const place = () => {
    const anchor = shown();
    if (!surface || !anchor) return;
    // An anchor that left the page, such as a row a virtual list recycled, takes the picker with it.
    if (!anchor.isConnected) {
      hide();
      props.onClose();
      return;
    }
    const box = anchor.getBoundingClientRect();
    const size = surface.getBoundingClientRect();
    const above = box.top - GAP - size.height;
    const below = box.bottom + GAP;
    const top = above >= MARGIN || below + size.height > window.innerHeight - MARGIN ? above : below;
    // Aligned with the anchor's end, like a menu at the end of a composer.
    const left = box.right - size.width;
    surface.style.left = `${Math.round(Math.max(MARGIN, Math.min(left, window.innerWidth - size.width - MARGIN)))}px`;
    surface.style.top = `${Math.round(Math.max(MARGIN, Math.min(top, window.innerHeight - size.height - MARGIN)))}px`;
  };

  const restoreFocus = () => {
    // A pick that moved the focus on purpose, such as into a composer, keeps it there.
    const focused = document.activeElement;
    if (focused && focused !== document.body && !surface?.contains(focused)) return;
    if (previous?.isConnected) returnFocus(previous, ring);
  };

  const hide = () => {
    restoreFocus();
    if (surface?.matches(":popover-open")) surface.hidePopover();
    setShown(undefined);
  };

  const pressed = (event: PointerEvent) => {
    const anchor = shown();
    pressedAnchor = anchor && event.target instanceof Node && anchor.contains(event.target) ? anchor : undefined;
  };

  createEffect(() => {
    const anchor = props.anchor ?? undefined;
    untrack(() => {
      if (!anchor) {
        if (shown()) hide();
        return;
      }
      if (anchor === pressedAnchor) {
        // The press that closed the picker also asked to open it: it stays closed.
        pressedAnchor = undefined;
        props.onClose();
        return;
      }
      if (shown() === anchor || !surface) return;
      // Moving to another anchor keeps the picker open and the focus to return to.
      if (!shown()) {
        previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ring = ringOnReturn(previous ?? anchor);
      }
      setShown(anchor);
      if (!surface.matches(":popover-open")) surface.showPopover();
      place();
    });
  });

  /** The page scrolled under the anchor; the picker's own list scrolling moves nothing. */
  const scrolled = (event: Event) => {
    if (!(event.target instanceof Node && surface?.contains(event.target))) place();
  };

  onMount(() => {
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scrolled, true);
    document.addEventListener("pointerdown", pressed, true);
    // The picker renders into the open surface after it is shown; its size places it.
    const observer = typeof ResizeObserver === "function" && surface ? new ResizeObserver(place) : undefined;
    if (surface) observer?.observe(surface);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("pointerdown", pressed, true);
      if (surface?.matches(":popover-open")) hide();
    });
  });

  const touchOnly = () => typeof matchMedia === "function" && matchMedia(touchOnlyQuery).matches;

  return (
    <div
      ref={surface}
      popover="auto"
      class="k2b-emoji-picker-popover"
      onToggle={(event) => {
        if ((event as ToggleEvent).newState === "open") return;
        // Light dismissal by the browser: a click outside, Escape, or another popover.
        if (shown()) {
          setShown(undefined);
          restoreFocus();
          props.onClose();
        }
        // The pressed anchor is forgotten once its click has had the chance to reopen the picker.
        setTimeout(() => {
          pressedAnchor = undefined;
        });
      }}
    >
      <Show when={shown()}>
        <EmojiPickerPanel
          onPick={(emoji) => {
            props.onPick(emoji);
            hide();
            props.onClose();
          }}
          recent={props.recent}
          skinTone={props.skinTone}
          onSkinToneChange={props.onSkinToneChange}
          label={props.label}
          class={props.class}
          // A phone's keyboard would cover the emoji; a touch-only device searches after a tap on the field.
          autofocus={!touchOnly()}
          onClose={() => {
            hide();
            props.onClose();
          }}
        />
      </Show>
    </div>
  );
}

/** The emoji picker. `EmojiPicker.Popover` opens it next to a control. */
export const EmojiPicker = Object.assign(EmojiPickerPanel, { Popover: EmojiPickerPopover });
