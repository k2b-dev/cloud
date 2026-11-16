import { batch, createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { Button } from "./Button";
import { SelectionToolbar } from "./SelectionToolbar";

export type SelectionActionSelection = {
  /** The selected text, with each run of whitespace as one space and trimmed. */
  text: string;
  /** The part of the root that holds the whole selection, as `within` returned it. */
  element: HTMLElement;
};

export type SelectionActionProps = {
  /** The element whose text selections offer the action, such as a message history. */
  root: HTMLElement;
  /**
   * The part one selection may lie in, such as the text of one message. It receives the selection's start and end
   * nodes and returns their part, or nothing. A selection whose start and end lie in different parts, or outside every
   * part, offers nothing. Without it, the whole root is one part.
   */
  within?: (node: Node) => HTMLElement | null | undefined;
  /** The action's name, shown beside its icon, such as "Quote". */
  label: string;
  /** The action's icon class, such as "ti ti-quote". */
  icon: string;
  /** Runs with the selection when the person presses the action; the selection is cleared afterwards. */
  onAction: (selection: SelectionActionSelection) => void;
};

/** A selection's text as the action receives it: each run of whitespace as one space, trimmed. */
type Selected = { range: Range; element: HTMLElement; text: string };

const selectionActionText = (text: string) => text.replace(/\s+/gu, " ").trim();

const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/** The box of a range's first line, or of its last line for a pill below it. */
const lineBox = (range: Range, last: boolean): DOMRect | null => {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const edge = last ? rects.at(-1) : rects[0];
  if (!edge) return null;
  const line = rects.filter((rect) => Math.abs(rect.top - edge.top) < 4);
  const left = Math.min(...line.map((rect) => rect.left));
  const right = Math.max(...line.map((rect) => rect.right));
  return new DOMRect(left, edge.top, Math.max(1, right - left), edge.height);
};

/**
 * One action for selected text, such as "Quote", as a small pill at the selection. It lies in the top layer, so it
 * never moves the page, and pressing it keeps the selection. It appears once the pointer lets go of a selection inside
 * `root`, or at once for a selection made with the keyboard. Tab right after the selection moves the focus to the pill,
 * Enter runs it, and Tab or Escape returns the focus. Escape also closes the pill for that selection. On touch screens
 * it sits below the selection, clear of the system's own selection menu above it.
 *
 * It listens to the document's selection only while it is mounted, so an application can load it on the first
 * selection and keep its code out of the first page.
 */
export function SelectionAction(props: SelectionActionProps): JSX.Element {
  const [revision, setRevision] = createSignal(0);
  const [pressed, setPressed] = createSignal(false);
  const [dismissed, setDismissed] = createSignal<Range>();
  let pill: HTMLDivElement | undefined;
  let returnFocus: HTMLElement | null = null;
  /**
   * The selection as Tab took it into the pill. Moving the focus to a button clears the selection in WebKit, so the
   * pill keeps this copy while it has the focus.
   */
  let held: Selected | null = null;

  /** The selection and its part, while it lies in one part of the root. */
  const current = (): Selected | null => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    let range = selection.getRangeAt(0);
    const part = (node: Node) => {
      if (!props.root.contains(node)) return null;
      return props.within ? (props.within(node) ?? null) : props.root;
    };
    const element = part(range.startContainer);
    if (!element) return null;
    let text = selection.toString();
    if (part(range.endContainer) !== element) {
      // A triple click selects a paragraph up to the start of the next block. When nothing but whitespace lies past the
      // part, the selection ends with the part; a selection into another part offers nothing.
      const end = document.createRange();
      end.selectNodeContents(element);
      if (range.compareBoundaryPoints(Range.END_TO_END, end) < 0) return null;
      const rest = document.createRange();
      rest.setStart(end.endContainer, end.endOffset);
      rest.setEnd(range.endContainer, range.endOffset);
      if (rest.toString().trim()) return null;
      range = range.cloneRange();
      range.setEnd(end.endContainer, end.endOffset);
      text = range.toString();
    }
    text = selectionActionText(text);
    return text ? { range, element, text } : null;
  };

  const sameRange = (a: Range | undefined, b: Range) =>
    !!a &&
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset;

  const selected = () => current() ?? (held && pill?.contains(document.activeElement) ? held : null);

  const anchor = () => {
    revision();
    if (pressed()) return null;
    const chosen = selected();
    if (!chosen || sameRange(dismissed(), chosen.range)) return null;
    const below = coarse();
    const box = lineBox(chosen.range, below);
    // Below on touch also clears the selection handles under the last line.
    return box && below ? new DOMRect(box.left, box.top, box.width, box.height + 16) : box;
  };
  const open = () => !!anchor();

  const close = (restore: boolean) => {
    const chosen = selected();
    held = null;
    batch(() => {
      if (chosen) setDismissed(chosen.range.cloneRange());
      setRevision((value) => value + 1);
    });
    if (restore) returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
  };

  const run = () => {
    const chosen = selected();
    held = null;
    if (!chosen) return;
    props.onAction({ text: chosen.text, element: chosen.element });
    document.getSelection()?.removeAllRanges();
    returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
    setRevision((value) => value + 1);
  };

  onMount(() => {
    const changed = () => {
      // A new selection forgets an earlier Escape.
      const selected = current();
      if (!selected || !sameRange(dismissed(), selected.range)) setDismissed(undefined);
      setRevision((value) => value + 1);
    };
    const press = (event: PointerEvent) => {
      if (pill?.contains(event.target as Node)) return;
      setPressed(true);
    };
    const release = () => {
      if (!pressed()) return;
      setPressed(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || !open()) return;
      const inside = !!pill && pill.contains(document.activeElement);
      // Keys belong to the pill only while the focus is on the page, in the root or in the pill: a dialog or a
      // field elsewhere keeps its own Tab and Escape.
      const active = document.activeElement;
      if (!inside && active && active !== document.body && active !== document.documentElement && !props.root.contains(active)) return;
      // A field, a dialog or an open menu inside the root keeps its keys too.
      if (!inside && active?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), dialog, [popover]"))
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(inside);
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      if (inside) {
        event.preventDefault();
        close(true);
      } else if (!event.shiftKey) {
        const button = pill?.querySelector<HTMLButtonElement>("button");
        if (!button) return;
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const chosen = current();
        held = chosen && { ...chosen, range: chosen.range.cloneRange() };
        button.focus({ preventScroll: true });
        // Only a pill that took the focus takes the key; an inert page leaves Tab to the browser.
        if (document.activeElement !== button) {
          held = null;
          return;
        }
        event.preventDefault();
        returnFocus = before;
      }
    };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("keydown", key, true);
    });
  });

  return (
    <SelectionToolbar label={props.label} anchor={anchor} placement={coarse() ? "below" : "above"}>
      <div
        ref={pill}
        style={{ display: "contents" }}
        onFocusOut={(event) => {
          // The focus leaving the pill drops the copy of the selection it took along.
          if (event.relatedTarget instanceof Node && pill?.contains(event.relatedTarget)) return;
          held = null;
          setRevision((value) => value + 1);
        }}
      >
        <Button size="sm" variant="ghost" onClick={run}>
          <i class={props.icon} aria-hidden="true" />
          {props.label}
        </Button>
      </div>
    </SelectionToolbar>
  );
}
