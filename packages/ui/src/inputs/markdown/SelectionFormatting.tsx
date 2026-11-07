import { batch, createEffect, createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { SelectionToolbar } from "../../actions/SelectionToolbar";
import { Toolbar } from "../../actions/Toolbar";
import { insertLink, toggleBold, toggleBulletList, toggleCode, toggleItalic, toggleNumberedList, toggleQuote } from "./actions";
import { useMarkdownToolbarMessages } from "./toolbar-messages";

/**
 * The box of a text range's first line in the editor's mirrored presentation layer, or nothing when that line is
 * scrolled out of the surface. The layer holds the same text as the textarea, so its text nodes map offsets to places.
 */
export const textRangeBox = (layer: HTMLElement, surface: HTMLElement, start: number, end: number): DOMRect | null => {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let from: [Node, number] | undefined;
  let to: [Node, number] | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!from && start <= offset + length) from = [node, start - offset];
    if (end <= offset + length) {
      to = [node, end - offset];
      break;
    }
    offset += length;
  }
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const first = rects[0];
  if (!first) return null;
  const line = rects.filter((rect) => Math.abs(rect.top - first.top) < 4);
  const multiline = line.length < rects.length;
  const right = multiline ? layer.getBoundingClientRect().right : Math.max(...line.map((rect) => rect.right));
  const visible = surface.getBoundingClientRect();
  if (first.bottom <= visible.top || first.top >= visible.bottom) return null;
  return new DOMRect(first.left, first.top, Math.max(1, right - first.left), first.height);
};

/**
 * The formatting toolbar of `toolbar="selection"`: it floats above selected text once the pointer lets go, and closes
 * on Escape, a collapsed selection, or when the focus leaves both text and toolbar. Touch devices keep their own
 * selection menu, so it stays hidden there; the keyboard shortcuts work everywhere.
 */
export function SelectionFormatting(props: {
  textarea: () => HTMLTextAreaElement | undefined;
  layer: () => HTMLElement | undefined;
  surface: () => HTMLElement | undefined;
  /** Changes whenever the text, the selection, or the presentation layer changed. */
  revision: () => unknown;
  disabled?: boolean;
  /** The formats at the selection, such as `bold`, shown as each action's pressed state. */
  activeFormats: () => Set<string>;
  /** Receives the handlers the textarea forwards. */
  bind: (handlers: { blur: (next: Element | null) => void; focus: () => void; escape: () => boolean }) => void;
}): JSX.Element {
  const messages = useMarkdownToolbarMessages();
  const [finePointer, setFinePointer] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [textFocused, setTextFocused] = createSignal(false);
  const [toolbarFocused, setToolbarFocused] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<string>();
  let root: HTMLDivElement | undefined;

  const selectionKey = () => {
    const textarea = props.textarea();
    return textarea ? `${textarea.selectionStart}:${textarea.selectionEnd}` : "";
  };
  const anchor = () => {
    props.revision();
    const textarea = props.textarea();
    const layer = props.layer();
    const surface = props.surface();
    if (props.disabled || !finePointer() || dragging() || !(textFocused() || toolbarFocused())) return null;
    if (!textarea || !layer || !surface || textarea.selectionStart === textarea.selectionEnd) return null;
    if (dismissed() === selectionKey()) return null;
    return textRangeBox(layer, surface, textarea.selectionStart, textarea.selectionEnd);
  };

  // Escape closes the toolbar for that one selection: a collapsed selection forgets it, so selecting the same words
  // again shows it again.
  createEffect(() => {
    props.revision();
    const textarea = props.textarea();
    if (textarea && textarea.selectionStart === textarea.selectionEnd) setDismissed(undefined);
  });

  props.bind({
    focus: () => setTextFocused(true),
    blur: (next) =>
      batch(() => {
        // Tab into the toolbar keeps it open: the toolbar takes the focus in the same move.
        if (next && root?.contains(next)) setToolbarFocused(true);
        setTextFocused(false);
      }),
    escape: () => {
      if (!anchor()) return false;
      setDismissed(selectionKey());
      return true;
    },
  });

  onMount(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setFinePointer(!query.matches);
    update();
    query.addEventListener("change", update);
    const textarea = props.textarea();
    const press = () => {
      setDragging(true);
      const release = () => {
        setDragging(false);
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", release, true);
      };
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", release, true);
    };
    // Selection changes can arrive as one event, so the next key or press that may select again forgets Escape too.
    const forget = (event: Event) => {
      if (event instanceof KeyboardEvent && ["Escape", "Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
      setDismissed(undefined);
    };
    textarea?.addEventListener("pointerdown", press);
    textarea?.addEventListener("pointerdown", forget);
    textarea?.addEventListener("keydown", forget);
    onCleanup(() => {
      query.removeEventListener("change", update);
      textarea?.removeEventListener("pointerdown", press);
      textarea?.removeEventListener("pointerdown", forget);
      textarea?.removeEventListener("keydown", forget);
    });
  });

  const run = (format: (textarea: HTMLTextAreaElement) => void) => () => {
    const textarea = props.textarea();
    if (textarea) format(textarea);
  };

  return (
    <SelectionToolbar
      label={messages().selectionFormatting}
      anchor={anchor}
      onEscape={() => {
        setDismissed(selectionKey());
        props.textarea()?.focus();
      }}
    >
      <div
        ref={root}
        style={{ display: "contents" }}
        onFocusIn={() => setToolbarFocused(true)}
        onFocusOut={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setToolbarFocused(false);
        }}
      >
        <Toolbar.Action
          label={messages().bold}
          icon="ti ti-bold"
          pressed={props.activeFormats().has("bold")}
          keys="mod+b"
          onClick={run(toggleBold)}
        />
        <Toolbar.Action
          label={messages().italic}
          icon="ti ti-italic"
          pressed={props.activeFormats().has("italic")}
          keys="mod+i"
          onClick={run(toggleItalic)}
        />
        <Toolbar.Action
          label={messages().inlineCode}
          icon="ti ti-code"
          pressed={props.activeFormats().has("code")}
          keys="mod+e"
          onClick={run(toggleCode)}
        />
        <Toolbar.Action label={messages().link} icon="ti ti-link" keys="mod+k" onClick={run(insertLink)} />
        <Toolbar.Separator />
        <Toolbar.Action
          label={messages().bulletList}
          icon="ti ti-list"
          pressed={props.activeFormats().has("bullet")}
          keys="mod+shift+8"
          onClick={run(toggleBulletList)}
        />
        <Toolbar.Action
          label={messages().numberedList}
          icon="ti ti-list-numbers"
          pressed={props.activeFormats().has("ordered")}
          keys="mod+shift+7"
          onClick={run(toggleNumberedList)}
        />
        <Toolbar.Action
          label={messages().quote}
          icon="ti ti-quote"
          pressed={props.activeFormats().has("quote")}
          onClick={run(toggleQuote)}
        />
      </div>
    </SelectionToolbar>
  );
}
