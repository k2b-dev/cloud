import { createEffect, onCleanup } from "solid-js";

const selector = "[data-scroll-fade-mode]";
const active = new WeakMap<HTMLElement, { users: number; stop: () => void }>();

/** Self-contained because the sidebar inline script embeds its source. */
export function scrollFadeEdges(body: HTMLElement): "top" | "bottom" | "both" | undefined {
  const mode = body.getAttribute("data-scroll-fade-mode");
  const horizontal = body.getAttribute("data-scroll-fade-axis") === "horizontal";
  const overflow = horizontal ? body.scrollWidth - body.clientWidth : body.scrollHeight - body.clientHeight;
  // Horizontal RTL scrollLeft starts at zero on the right and becomes negative.
  const rtl = horizontal && getComputedStyle(body).direction === "rtl";
  const offset = horizontal ? (rtl ? overflow + body.scrollLeft : body.scrollLeft) : body.scrollTop;
  const top = mode === "both" && overflow > 1 && offset > 1;
  const bottom = !!mode && overflow > 1 && overflow - offset > 1;
  return top && bottom ? "both" : top ? "top" : bottom ? "bottom" : undefined;
}

/** Shared by hydrated components and the workspace's server-rendered scrollports. */
function observeScrollFade(body: HTMLElement) {
  let entry = active.get(body);
  if (!entry) {
    const apply = () => {
      const edges = scrollFadeEdges(body);
      if (edges) {
        if (body.getAttribute("data-scroll-fade") !== edges) body.setAttribute("data-scroll-fade", edges);
      } else if (body.hasAttribute("data-scroll-fade")) body.removeAttribute("data-scroll-fade");
    };
    // Measuring forces layout. Scrolling (the browser sends one scroll event per frame) and changes to the scrollport
    // itself measure at once, and so does the first change of its content in a frame, so a reader such as an editor's
    // scroll margins sees the current edges. Later content changes in that frame are measured once when it ends: a list
    // that updates many rows at once, such as marking every chat read, otherwise lays the page out again for each row.
    let frame = 0;
    let stale = false;
    const update = () => {
      if (frame) {
        stale = true;
        return;
      }
      apply();
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (stale) apply();
        stale = false;
      });
    };
    const resize = new ResizeObserver(update);
    const observe = () => {
      resize.disconnect();
      resize.observe(body);
      for (const child of Array.from(body.children)) resize.observe(child);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      stale = false;
      apply();
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" && record.target === body)) observe();
      else if (records.some((record) => record.target === body)) apply();
      else update();
    });
    mutations.observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "data-scroll-fade-mode", "data-scroll-fade-axis", "dir"],
    });
    body.addEventListener("scroll", apply, { passive: true });
    observe();
    entry = {
      users: 0,
      stop: () => {
        if (frame) cancelAnimationFrame(frame);
        resize.disconnect();
        mutations.disconnect();
        body.removeEventListener("scroll", apply);
        body.removeAttribute("data-scroll-fade");
      },
    };
    active.set(body, entry);
  }
  entry.users++;
  return () => {
    if (--entry.users === 0) {
      entry.stop();
      active.delete(body);
    }
  };
}

export function createScrollFade(element: () => HTMLElement | undefined, enabled: () => boolean) {
  createEffect(() => {
    if (!enabled()) return;
    const body = element();
    if (body) onCleanup(observeScrollFade(body));
  });
}

/** Enrich only explicitly marked UI scrollports, including SSR and later navigation. */
export function installScrollFades(root: Document | HTMLElement) {
  const owned = new Map<HTMLElement, () => void>();
  const sync = () => {
    const next = new Set(Array.from(root.querySelectorAll<HTMLElement>(selector)));
    if (root instanceof HTMLElement && root.matches(selector)) next.add(root);
    for (const [element, stop] of owned)
      if (!next.has(element)) {
        stop();
        owned.delete(element);
      }
    for (const element of next) if (!owned.has(element)) owned.set(element, observeScrollFade(element));
  };
  const containsPort = (node: Node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector));
  const mutations = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === "attributes" ||
          Array.from(record.addedNodes).some(containsPort) ||
          Array.from(record.removedNodes).some(containsPort),
      )
    )
      sync();
  });
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-scroll-fade-mode"] });
  sync();
  return () => {
    mutations.disconnect();
    for (const stop of owned.values()) stop();
    owned.clear();
  };
}
