import { batch, createEffect, createSignal, onCleanup } from "solid-js";

export type SelectionModifiers = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
export type CollectionSelection = ReturnType<typeof createCollectionSelection>;

/**
 * One selection and focus model shared by alternate presentations of a collection.
 *
 * `ids` is the selectable collection in display order. `multiple: false` keeps at most one ID selected: a click,
 * toggle, or arrow key selects only that item, and ranges and select-all do nothing.
 *
 * `checklist: true` suits choosing on touch screens: a plain click or tap toggles one item, and arrow keys only move
 * focus. Space still toggles; Shift-click still selects a range.
 */
export function createCollectionSelection(options: {
  ids: () => readonly string[];
  initial?: readonly string[];
  onChange?: (ids: readonly string[]) => void;
  multiple?: boolean;
  checklist?: boolean;
}) {
  const multiple = options.multiple ?? true;
  const checklist = options.checklist ?? false;
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set(multiple ? options.initial : options.initial?.slice(0, 1)));
  const [focused, setFocused] = createSignal<string | null>(options.initial?.[0] ?? null);
  let anchor: string | null = options.initial?.[0] ?? null;
  const elements = new Map<string, HTMLElement>();
  const replace = (ids: readonly string[]) => {
    const allowed = new Set(options.ids());
    const next = new Set(ids.filter((id) => allowed.has(id)).slice(multiple ? 0 : -1));
    if (next.size === selected().size && [...next].every((id) => selected().has(id))) return;
    setSelected(next);
    options.onChange?.([...next]);
  };
  createEffect(() => {
    const ids = options.ids();
    replace([...selected()]);
    if (!focused() || !ids.includes(focused()!)) setFocused(ids[0] ?? null);
    if (anchor && !ids.includes(anchor)) anchor = null;
  });
  const toggle = (id: string) => {
    const next = new Set(multiple ? selected() : []);
    selected().has(id) ? next.delete(id) : next.add(id);
    batch(() => {
      setFocused(id);
      replace([...next]);
    });
    anchor = id;
  };
  const select = (id: string, modifiers: SelectionModifiers = {}) => {
    if (!options.ids().includes(id)) return;
    batch(() => {
      setFocused(id);
      if (multiple && modifiers.shiftKey && anchor) {
        const ids = options.ids();
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(id);
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        replace(modifiers.ctrlKey || modifiers.metaKey ? [...selected(), ...range] : range);
      } else if (checklist || (multiple && (modifiers.ctrlKey || modifiers.metaKey))) toggle(id);
      else {
        anchor = id;
        replace([id]);
      }
    });
  };
  const focus = (id: string) => {
    setFocused(id);
    elements.get(id)?.focus({ preventScroll: true });
    elements.get(id)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const keyDown = (event: KeyboardEvent, id: string, columns = 1) => {
    const ids = options.ids();
    const index = ids.indexOf(id);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = index + columns;
    if (event.key === "ArrowUp") next = index - columns;
    if (columns > 1 && event.key === "ArrowRight") next = index + 1;
    if (columns > 1 && event.key === "ArrowLeft") next = index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = ids.length - 1;
    if (next !== undefined && ids.length) {
      event.preventDefault();
      const target = ids[Math.max(0, Math.min(next, ids.length - 1))]!;
      if (event.shiftKey ? multiple || !checklist : !checklist && !event.ctrlKey && !event.metaKey) select(target, event);
      focus(target);
      return true;
    }
    if (event.key === " ") {
      event.preventDefault();
      toggle(id);
      return true;
    }
    if (multiple && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      replace(ids);
      return true;
    }
    // With nothing selected, Escape belongs to the host, for example to close a dialog.
    if (event.key === "Escape" && selected().size > 0) {
      event.preventDefault();
      replace([]);
      return true;
    }
    return false;
  };
  return {
    multiple,
    selected,
    focused,
    select,
    toggle,
    replace,
    focus,
    keyDown,
    clear: () => replace([]),
    all: () => (multiple ? replace(options.ids()) : undefined),
    markFocused: (id: string) => setFocused(id),
    register: (id: string, element: HTMLElement) => {
      elements.set(id, element);
      onCleanup(() => {
        if (elements.get(id) === element) elements.delete(id);
      });
    },
  };
}
