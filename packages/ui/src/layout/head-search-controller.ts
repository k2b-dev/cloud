/**
 * The head's search behind its icon (K15). A narrow head keeps `AppWorkspace.Head`'s `search` behind an icon; the icon
 * opens it in a row of its own under the head line and focuses its field. Escape inside the search or the icon close
 * it again and return focus to the icon. A field with a value keeps the search in sight (CSS), and the icon says so
 * with `aria-expanded`. The head is server HTML, so the shared workspace controller runs this.
 */
const TOGGLE = "[data-app-workspace-head-search-toggle]";
const HEAD = ".k2b-app-workspace__head";

const searchOf = (toggle: Element) => {
  const id = toggle.getAttribute("aria-controls");
  return id ? toggle.ownerDocument.getElementById(id) : null;
};
const filled = (search: Element) =>
  Array.from(search.querySelectorAll<HTMLInputElement>("input[placeholder]")).some((input) => input.value !== "");

const sync = (toggle: Element) => {
  const head = toggle.closest(HEAD);
  const search = searchOf(toggle);
  if (!head || !search) return;
  const expanded = String(head.hasAttribute("data-search-open") || filled(search));
  if (toggle.getAttribute("aria-expanded") !== expanded) toggle.setAttribute("aria-expanded", expanded);
};

export const installHeadSearch = (eventRoot: Document | HTMLElement): (() => void) => {
  const toggles = () => Array.from(eventRoot.querySelectorAll(TOGGLE));
  const onClick = (event: Event) => {
    const toggle = event.target instanceof Element ? event.target.closest<HTMLElement>(TOGGLE) : null;
    const head = toggle?.closest(HEAD);
    const search = toggle ? searchOf(toggle) : null;
    if (!toggle || !head || !search) return;
    if (head.hasAttribute("data-search-open")) head.removeAttribute("data-search-open");
    else {
      head.setAttribute("data-search-open", "");
      search.querySelector<HTMLElement>("input, textarea, [tabindex]:not([tabindex='-1'])")?.focus({ preventScroll: true });
    }
    sync(toggle);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Element)) return;
    const search = event.target.closest(".k2b-app-workspace__head-search");
    const head = search?.closest(HEAD);
    const toggle = head?.querySelector<HTMLElement>(TOGGLE);
    // Only where the search waits behind its icon: a wide head has no icon to return to.
    if (!search || !head || !toggle || !head.hasAttribute("data-search-open") || !toggle.checkVisibility()) return;
    event.preventDefault();
    head.removeAttribute("data-search-open");
    toggle.focus({ preventScroll: true });
    sync(toggle);
  };
  const onInput = (event: Event) => {
    const search = event.target instanceof Element ? event.target.closest(".k2b-app-workspace__head-search") : null;
    const toggle = search?.closest(HEAD)?.querySelector(TOGGLE);
    if (toggle) sync(toggle);
  };
  for (const toggle of toggles()) sync(toggle);
  eventRoot.addEventListener("click", onClick);
  eventRoot.addEventListener("keydown", onKeyDown as EventListener);
  eventRoot.addEventListener("input", onInput);
  return () => {
    eventRoot.removeEventListener("click", onClick);
    eventRoot.removeEventListener("keydown", onKeyDown as EventListener);
    eventRoot.removeEventListener("input", onInput);
  };
};
