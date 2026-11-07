import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CommandList, commandListKey, commandOptionId, createCommandNavigator } from "../../actions/CommandList";
import type { CommandItem, CommandSource } from "../../actions/command-items";
import { useCommandMessages } from "../../actions/command-messages";
import { type Completion, detectQuery, type QueryContext } from "../completion";
import { isInCodeZone } from "./code-zone";

export type SlashCommandsProps = {
  /** The editor's textarea, from `MarkdownEditor`'s `textareaRef`. The commands attach once it is there. */
  textarea: HTMLTextAreaElement | undefined;
  /** The same entries as `CommandMenu`'s `items`. */
  items: CommandSource;
};

/** Replaces a range of the text the way typing would, so undo keeps working; an empty text deletes. */
const replace = (textarea: HTMLTextAreaElement, start: number, end: number, text: string) => {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  if (start === end && text === "") return;
  try {
    if (document.execCommand?.(text === "" ? "delete" : "insertText", false, text)) return;
  } catch {
    // Fall through to the standards-based replacement.
  }
  textarea.setRangeText(text, start, end, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

/** The box of the text offset `at` in the presentation layer, or nothing where the engine cannot measure it. */
const offsetBox = (layer: HTMLElement, at: number): DOMRect | undefined => {
  const walker = document.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (at <= offset + length) {
      const range = document.createRange();
      range.setStart(node, at - offset);
      range.setEnd(node, Math.min(length, at - offset + 1));
      return range.getClientRects?.()[0];
    }
    offset += length;
  }
  return undefined;
};

const trigger: Completion = { trigger: "/", suggest: () => [] };

/**
 * Slash commands for a `MarkdownEditor`: `/` at the start of a line or after a space opens the entries at the slash.
 * Place it beside the editor and pass the editor's textarea. It listens to the textarea itself, so editors without
 * commands carry none of it: native listeners run before the editor's own, and a key it uses is marked handled with
 * `preventDefault`, which the editor respects.
 */
export function SlashCommands(props: SlashCommandsProps): JSX.Element {
  return <Show when={props.textarea}>{(textarea) => <AttachedCommands textarea={textarea()} items={props.items} />}</Show>;
}

function AttachedCommands(props: { textarea: HTMLTextAreaElement; items: CommandSource }): JSX.Element {
  const messages = useCommandMessages();
  const textarea = props.textarea;
  const id = `${textarea.id || "k2b-markdown"}-commands`;
  /** The editor's presentation layer: the same text as the textarea, laid out the same way. */
  const preview = () => textarea.parentElement?.querySelector<HTMLElement>(".k2b-markdown-editor__preview") ?? undefined;
  const [context, setContext] = createSignal<QueryContext | null>(null);
  /** Where Escape closed the commands; they stay closed while the caret stays in that `/query`. */
  let dismissedAt: number | null = null;
  let popover: HTMLDivElement | undefined;
  const nav = createCommandNavigator({
    items: () => props.items,
    query: () => context()?.query ?? "",
    onPick: (item) => pick(item),
    // A second list starts with an empty query: the typed word gives way to the bare `/`.
    onStep: () => {
      const current = context();
      if (current && current.text !== "/") replace(textarea, current.start, current.end, "/");
    },
  });
  const open = createMemo(() => context() !== null && (nav.step() !== undefined || nav.entries().length > 0));
  const close = () => {
    setContext(null);
    nav.reset();
  };
  const pick = (item: CommandItem) => {
    const current = context();
    if (!current) return;
    const { text, onSelect } = item;
    close();
    replace(textarea, current.start, current.end, text ?? "");
    if (text === undefined) onSelect?.();
  };

  const detect = () => {
    const found = document.activeElement === textarea ? detectQuery(textarea, [trigger], { isExcluded: isInCodeZone }) : null;
    // Commands start at the line start or after a space, never inside `https://` or after a bracket.
    const usable = found && (found.start === 0 || /\s/.test(textarea.value[found.start - 1] ?? "")) ? found : null;
    if (usable?.start !== context()?.start) {
      if (usable?.start !== dismissedAt) dismissedAt = null;
      close();
    }
    if (usable && usable.start !== dismissedAt) setContext(usable);
  };

  const position = () => {
    if (!popover?.isConnected) return;
    const start = context()?.start ?? 0;
    const layer = preview();
    const rect = (layer && offsetBox(layer, start)) ?? textarea.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = below < 320 && rect.top > below;
    // A long list never reaches past the window edge it opens toward.
    popover.style.setProperty("max-height", `${Math.max(120, Math.min(320, (above ? rect.top : below) - 12))}px`, "important");
    popover.style.setProperty("top", above ? "auto" : `${rect.bottom + 4}px`, "important");
    popover.style.setProperty("bottom", above ? `${window.innerHeight - rect.top + 4}px` : "auto", "important");
    if (!popover.matches(":popover-open")) popover.showPopover?.();
    const width = popover.getBoundingClientRect().width;
    popover.style.setProperty("left", `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`, "important");
  };

  // The textarea points at the list while it shows, as a combobox does.
  createEffect(() => {
    const active = open() && nav.entries().length ? commandOptionId(id, nav.active()) : undefined;
    if (open()) textarea.setAttribute("aria-controls", id);
    else if (textarea.getAttribute("aria-controls") === id) textarea.removeAttribute("aria-controls");
    if (active) textarea.setAttribute("aria-activedescendant", active);
    else if (textarea.getAttribute("aria-activedescendant")?.startsWith(`${id}-`)) textarea.removeAttribute("aria-activedescendant");
  });
  // Opening, and entries that arrive while the `/` waits, such as from a reactive source, show the list.
  createEffect(() => {
    if (!open()) return;
    queueMicrotask(position);
    window.addEventListener("resize", position);
    textarea.addEventListener("scroll", position);
    onCleanup(() => {
      window.removeEventListener("resize", position);
      textarea.removeEventListener("scroll", position);
    });
  });

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      const current = context();
      if (!current || !open() || event.defaultPrevented) return;
      if (commandListKey(nav, event, current.query)) event.preventDefault();
      else if (event.key === "Escape") {
        event.preventDefault();
        dismissedAt = current.start;
        close();
      }
    };
    const selection = () => {
      if (document.activeElement === textarea) detect();
    };
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && popover?.contains(event.relatedTarget)) return;
      close();
      dismissedAt = null;
    };
    textarea.addEventListener("keydown", key);
    textarea.addEventListener("input", detect);
    textarea.addEventListener("blur", blur);
    document.addEventListener("selectionchange", selection);
    // A `/` typed while this module loaded opens the list now.
    detect();
    onCleanup(() => {
      textarea.removeEventListener("keydown", key);
      textarea.removeEventListener("input", detect);
      textarea.removeEventListener("blur", blur);
      document.removeEventListener("selectionchange", selection);
      popover?.hidePopover?.();
    });
  });

  return (
    <Show when={open()}>
      <div ref={popover} popover="manual" class="k2b-autocomplete__options" data-commands="" role="presentation">
        <CommandList navigator={nav} id={id} label={messages().commands} stepHint query={() => context()?.query ?? ""} />
      </div>
    </Show>
  );
}
