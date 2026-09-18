import { batch, createEffect, createSignal, onCleanup } from "solid-js";

export type SelectionModifiers = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
export type CollectionSelection = ReturnType<typeof createCollectionSelection>;

/** One selection and focus model shared by alternate presentations of a collection. */
export function createCollectionSelection(options: {
  ids: () => readonly string[];
  initial?: readonly string[];
  onChange?: (ids: readonly string[]) => void;
}) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set(options.initial ?? []));
  const [focused, setFocused] = createSignal<string | null>(options.initial?.[0] ?? null);
  let anchor: string | null = options.initial?.[0] ?? null;
  const elements = new Map<string, HTMLElement>();
  const replace = (ids: readonly string[]) => {
    const allowed = new Set(options.ids());
    const next = new Set(ids.filter((id) => allowed.has(id)));
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
    const next = new Set(selected());
    next.has(id) ? next.delete(id) : next.add(id);
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
      if (modifiers.shiftKey && anchor) {
        const ids = options.ids();
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(id);
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        replace(modifiers.ctrlKey || modifiers.metaKey ? [...selected(), ...range] : range);
      } else if (modifiers.ctrlKey || modifiers.metaKey) toggle(id);
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
      if (event.shiftKey || (!event.ctrlKey && !event.metaKey)) select(target, event);
      focus(target);
      return true;
    }
    if (event.key === " ") {
      event.preventDefault();
      toggle(id);
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      replace(ids);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      replace([]);
      return true;
    }
    return false;
  };
  return {
    selected,
    focused,
    select,
    toggle,
    replace,
    focus,
    keyDown,
    clear: () => replace([]),
    all: () => replace(options.ids()),
    markFocused: (id: string) => setFocused(id),
    register: (id: string, element: HTMLElement) => {
      elements.set(id, element);
      onCleanup(() => {
        if (elements.get(id) === element) elements.delete(id);
      });
    },
  };
}
