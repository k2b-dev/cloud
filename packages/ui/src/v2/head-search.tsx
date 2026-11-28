import { createEffect, createRenderEffect, createSignal, onCleanup, onMount } from "solid-js";
import { HeadSearchContext, type HeadSearchKit, Input, type InputProps } from "./controls";

// The search of a head (look rule 31) lives here, not in `controls.tsx`: an `Input` elsewhere, the nav's search among
// them, loads none of its code. The app brings it with `HeadSearch`, as a tree comes with `navTree`.

/** The place of a head's search: the end of a pane's or a workspace's head bar. */
const headEnd = '[data-slot="head"] > .k2-bar > .k2-bar-end';

/** Typing goes on here: a field, a text that can be edited, or a widget that takes keys itself. */
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, select, [role='textbox'], [role='combobox']") !== null);

/**
 * "/" opens the search of a head, as in most apps (after Z2's #4290): where the person is not typing, and not in a
 * dialog, a menu or a list (nor while a modal dialog, an open menu or another popup is open, whose own keys may take
 * "/"), the first head search in sight takes the focus. "/" with Shift counts (German: Shift+7), and so does "/" with
 * AltGr (Ctrl+Alt on Windows); a key that composes (an IME) and a handler that took the key first win. One listener
 * serves every head search of the page.
 */
const openHeadSearch = (event: KeyboardEvent) => {
  if (event.key !== "/" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.getModifierState("AltGraph") ? event.metaKey : event.ctrlKey || event.metaKey || event.altKey) return;
  if (typingIn(event.target)) return;
  if (
    event.target instanceof Element &&
    event.target.closest("dialog, [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")
  )
    return;
  if (document.activeElement?.matches('[aria-expanded="true"]')) return;
  // the toasts' region stays an open popup while it shows one, and takes no keys
  if (document.querySelector("dialog[open]:modal, [aria-modal='true'], [popover]:popover-open:not([data-k2-part='Toast'])")) return;
  const field = [...document.querySelectorAll<HTMLInputElement>(`${headEnd} > .k2-input[data-head-search] > input`)].find(
    (input) => input.getClientRects().length > 0,
  );
  if (!field) return;
  event.preventDefault();
  field.focus();
};
let slashSearches = 0;

/**
 * What a head's search adds to its `Input`:
 * - its words (`data-filled`): it folds to its symbol only while it is empty and has no focus. They come from the
 *   server's first page; the field is read again on mount (a value the browser restored, or one typed before the
 *   script ran), on typing and when the focus leaves (a caller that set `input.value` itself);
 * - pressed while empty, a short overlay over its neighbours (`data-overlay`), so nothing beside it moves or folds
 *   while the person types; its place lifts its cut for that while only (`data-k2-open-search`);
 * - an open menu at its end (a filter) keeps it open (`data-held`): the focus is in that menu then, not in the field;
 * - "/" opens it, and Escape leaves it on every width and keeps its words.
 * Attributes its owner sets, so no `:has()` restyles the page. The words are known on the server, the rest in the
 * browser only: the server's page has no focus.
 */
const useHeadSearch: HeadSearchKit = (props, end) => {
  let box: HTMLElement | undefined;
  const [filled, setFilled] = createSignal(Boolean(props.value));
  createRenderEffect(() => setFilled(Boolean(props.value)));
  const readFilled = () => {
    const input = box?.querySelector("input:not([type='hidden'])");
    if (input instanceof HTMLInputElement) setFilled(input.value !== "");
  };
  const [place, setPlace] = createSignal<HTMLElement>();
  const [overlay, setOverlay] = createSignal(false);
  onMount(() => {
    readFilled();
    const parent = box?.parentElement;
    if (!box || !parent?.matches(headEnd)) return;
    const field = box;
    setPlace(parent);
    if (slashSearches++ === 0) document.addEventListener("keydown", openHeadSearch);
    onCleanup(() => {
      if (--slashSearches === 0) document.removeEventListener("keydown", openHeadSearch);
    });
    const menu = field.querySelector(":scope > .k2-input-end");
    if (!menu) return;
    const held = () => field.toggleAttribute("data-held", menu.querySelector('[aria-expanded="true"]') !== null);
    const watch = new MutationObserver(held);
    watch.observe(menu, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
    onCleanup(() => watch.disconnect());
  });
  createEffect(() => {
    const at = place();
    if (!at) return;
    at.toggleAttribute("data-k2-open-search", overlay());
    onCleanup(() => at.removeAttribute("data-k2-open-search"));
  });
  return {
    ref: (element: HTMLElement) => {
      box = element;
    },
    "data-head-search": "",
    get "data-filled"() {
      return filled() ? "" : undefined;
    },
    get "data-overlay"() {
      return overlay() ? "" : undefined;
    },
    // one with more at its end (a filter) is more than a search: it keeps its field
    get "data-with-end"() {
      return end() !== undefined ? "" : undefined;
    },
    // a folded search names itself under the pointer
    get title() {
      return props.label;
    },
    onFocusIn: () => setOverlay((now) => now || (place() !== undefined && !filled())),
    onFocusOut: (event: FocusEvent & { currentTarget: HTMLElement }) => {
      readFilled();
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOverlay(false);
    },
    onInput: (event: InputEvent & { target: Element }) => {
      if (event.target instanceof HTMLInputElement) setFilled(event.target.value !== "");
    },
    // after the field's own keys (and the app's `onKeyDown`), which reach the field before its box
    onKeyDown: (event: KeyboardEvent & { target: Element }) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !place()) return;
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      event.target.blur();
    },
  };
};

/**
 * The search of a head: an `Input type="search"` in the `end` of a pane's or a workspace's head `Bar`, named by its
 * `label`, which is also its hint and its placeholder; `icon` is `search` unless set. It stands as its symbol (36 px,
 * like an icon button) while it is empty, on every width. From 768 px a press or "/" opens the field as a short
 * overlay over its neighbours, growing to the left from its place, until the focus leaves; its words then keep the
 * field open at its width in the row (also on the server's page), and the bar folds around it. Empty, it folds back
 * to its symbol. One with an `end` (such as a filter) keeps its field there, and an open menu at its end keeps it
 * open. On the phone a tap opens it over the head; its words keep it there. Escape leaves it on every width and keeps
 * its words, unless `onKeyDown` takes Escape itself with `preventDefault`. Its code comes with this part: a page whose
 * heads have no search loads none of it.
 */
export const HeadSearch = (props: InputProps) => (
  <HeadSearchContext.Provider value={useHeadSearch}>
    <Input {...props} type="search" icon={props.icon ?? "search"} placeholder={props.placeholder ?? props.label} />
  </HeadSearchContext.Provider>
);
