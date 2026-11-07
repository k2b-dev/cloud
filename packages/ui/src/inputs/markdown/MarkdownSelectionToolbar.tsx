import { i18n } from "@k2b/stdlib";
import { batch, createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { SelectionToolbar } from "../../actions/SelectionToolbar";
import { Toolbar } from "../../actions/Toolbar";
import { useLocale } from "../../intl/locale";
import { insertLink, toggleBold, toggleBulletList, toggleCode, toggleItalic, toggleNumberedList, toggleQuote } from "./actions";
import { computeActiveFormats } from "./active-formats";

const selectionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      bold: "Bold",
      italic: "Italic",
      inlineCode: "Inline code",
      link: "Link",
      bulletList: "Bullet list",
      numberedList: "Numbered list",
      quote: "Quote",
      selectionFormatting: "Format selection",
    },
    de: {
      bold: "Fett",
      italic: "Kursiv",
      inlineCode: "Inline-Code",
      link: "Link",
      bulletList: "Aufzählung",
      numberedList: "Nummerierte Liste",
      quote: "Zitat",
      selectionFormatting: "Auswahl formatieren",
    },
  },
});

export const checkSelectionMessages = () => selectionMessages.check();

/**
 * The box of a text range's first line in the editor's mirrored presentation layer, or nothing when that line is
 * scrolled out of the surface. The layer holds the same text as the textarea, so its text nodes map offsets to places.
 */
export const textRangeBox = (layer: HTMLElement, surface: HTMLElement, start: number, end: number): DOMRect | null => {
  const walker = document.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */);
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

export type MarkdownSelectionToolbarProps = {
  /** The editor's textarea, from `MarkdownEditor`'s `textareaRef`. The toolbar attaches once it is there. */
  textarea: HTMLTextAreaElement | undefined;
};

/**
 * A small formatting toolbar that floats above selected text in a `MarkdownEditor`: bold, italic, code, link, lists, and
 * quote. Place it beside an editor with `noToolbar` and pass the editor's textarea. It appears once the pointer lets go
 * of a selection and closes on Escape, a collapsed selection, or when the focus leaves both text and toolbar. Touch
 * devices keep their own selection menu, so nothing of it renders there; the keyboard shortcuts work everywhere. It
 * listens to the textarea itself, so editors without it carry none of its code.
 */
export function MarkdownSelectionToolbar(props: MarkdownSelectionToolbarProps): JSX.Element {
  return <Show when={props.textarea}>{(textarea) => <SelectionFormatting textarea={textarea()} />}</Show>;
}

function SelectionFormatting(props: { textarea: HTMLTextAreaElement }): JSX.Element {
  const locale = useLocale();
  const messages = () => selectionMessages.resolve([locale()]).t;
  const textarea = props.textarea;
  // The editor's surface and its presentation layer: the same text as the textarea, laid out the same way.
  const surface = textarea.parentElement ?? textarea;
  const layer = surface.querySelector<HTMLElement>(".k2b-markdown-editor__preview") ?? surface;
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((value) => value + 1);
  const [finePointer, setFinePointer] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [textFocused, setTextFocused] = createSignal(document.activeElement === textarea);
  const [toolbarFocused, setToolbarFocused] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<string>();
  let root: HTMLDivElement | undefined;

  const selectionKey = () => `${textarea.selectionStart}:${textarea.selectionEnd}`;
  const anchor = () => {
    revision();
    if (textarea.disabled || !finePointer() || dragging() || !(textFocused() || toolbarFocused())) return null;
    if (textarea.selectionStart === textarea.selectionEnd || dismissed() === selectionKey()) return null;
    return textRangeBox(layer, surface, textarea.selectionStart, textarea.selectionEnd);
  };

  // Escape closes the toolbar for that one selection: a collapsed selection forgets it, so selecting the same words
  // again shows it again.
  createEffect(() => {
    revision();
    if (textarea.selectionStart === textarea.selectionEnd) setDismissed(undefined);
  });

  onMount(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setFinePointer(!query.matches);
    update();
    const press = () => {
      setDismissed(undefined);
      setDragging(true);
      const release = () => {
        setDragging(false);
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", release, true);
      };
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", release, true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.defaultPrevented || !anchor()) return;
        event.preventDefault();
        setDismissed(selectionKey());
        return;
      }
      // Selection changes can arrive as one event, so the next key that may select again forgets Escape too.
      if (!["Shift", "Control", "Meta", "Alt"].includes(event.key)) setDismissed(undefined);
    };
    const focus = () => setTextFocused(true);
    const blur = (event: FocusEvent) =>
      batch(() => {
        // Tab into the toolbar keeps it open: the toolbar takes the focus in the same move.
        if (event.relatedTarget instanceof Node && root?.contains(event.relatedTarget)) setToolbarFocused(true);
        setTextFocused(false);
      });
    const selection = () => {
      if (document.activeElement === textarea) bump();
    };
    // The presentation layer renders a frame after an edit; the toolbar measures again once it did.
    const layerElement = layer;
    const layerObserver = new MutationObserver(bump);
    layerObserver.observe(layerElement, { childList: true, subtree: true, characterData: true });
    query.addEventListener("change", update);
    textarea.addEventListener("pointerdown", press);
    textarea.addEventListener("keydown", key);
    textarea.addEventListener("focus", focus);
    textarea.addEventListener("blur", blur);
    textarea.addEventListener("input", bump);
    // The toolbar hides while its line is scrolled away and shows again when it returns.
    textarea.addEventListener("scroll", bump);
    document.addEventListener("selectionchange", selection);
    onCleanup(() => {
      layerObserver.disconnect();
      query.removeEventListener("change", update);
      textarea.removeEventListener("pointerdown", press);
      textarea.removeEventListener("keydown", key);
      textarea.removeEventListener("focus", focus);
      textarea.removeEventListener("blur", blur);
      textarea.removeEventListener("input", bump);
      textarea.removeEventListener("scroll", bump);
      document.removeEventListener("selectionchange", selection);
    });
  });

  const run = (format: (textarea: HTMLTextAreaElement) => void) => () => format(textarea);
  const formats = createMemo(() => {
    revision();
    return computeActiveFormats(textarea);
  });
  const pressed = (format: string) => formats().has(format);

  // Touch devices keep their own selection menu: the toolbar is not rendered there at all, so nothing of it mounts
  // or animates.
  return (
    <Show when={finePointer()}>
      <SelectionToolbar
        label={messages().selectionFormatting}
        anchor={anchor}
        onEscape={() => {
          setDismissed(selectionKey());
          textarea.focus();
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
          <Toolbar.Action label={messages().bold} icon="ti ti-bold" pressed={pressed("bold")} keys="mod+b" onClick={run(toggleBold)} />
          <Toolbar.Action
            label={messages().italic}
            icon="ti ti-italic"
            pressed={pressed("italic")}
            keys="mod+i"
            onClick={run(toggleItalic)}
          />
          <Toolbar.Action
            label={messages().inlineCode}
            icon="ti ti-code"
            pressed={pressed("code")}
            keys="mod+e"
            onClick={run(toggleCode)}
          />
          <Toolbar.Action label={messages().link} icon="ti ti-link" keys="mod+k" onClick={run(insertLink)} />
          <Toolbar.Separator />
          <Toolbar.Action
            label={messages().bulletList}
            icon="ti ti-list"
            pressed={pressed("bullet")}
            keys="mod+shift+8"
            onClick={run(toggleBulletList)}
          />
          <Toolbar.Action
            label={messages().numberedList}
            icon="ti ti-list-numbers"
            pressed={pressed("ordered")}
            keys="mod+shift+7"
            onClick={run(toggleNumberedList)}
          />
          <Toolbar.Action label={messages().quote} icon="ti ti-quote" pressed={pressed("quote")} onClick={run(toggleQuote)} />
        </div>
      </SelectionToolbar>
    </Show>
  );
}
