import { createEffect, onCleanup } from "solid-js";

const selector = "[data-scroll-fade-mode]";
const active = new WeakMap<HTMLElement, { users: number; stop: () => void }>();

/** Shared by hydrated components and the workspace's server-rendered scrollports. */
function observeScrollFade(body: HTMLElement) {
  let entry = active.get(body);
  if (!entry) {
    const update = () => {
      const mode = body.getAttribute("data-scroll-fade-mode");
      const overflow = body.scrollHeight - body.clientHeight;
      const top = mode === "both" && overflow > 1 && body.scrollTop > 1;
      const bottom = !!mode && overflow > 1 && overflow - body.scrollTop > 1;
      const edges = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : undefined;
      if (edges) body.setAttribute("data-scroll-fade", edges);
      else body.removeAttribute("data-scroll-fade");
    };
    const resize = new ResizeObserver(update);
    const observe = () => {
      resize.disconnect();
      resize.observe(body);
      for (const child of Array.from(body.children)) resize.observe(child);
      update();
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" && record.target === body)) observe();
      else update();
    });
    mutations.observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "data-scroll-fade-mode"],
    });
    body.addEventListener("scroll", update, { passive: true });
    observe();
    entry = {
      users: 0,
      stop: () => {
        resize.disconnect();
        mutations.disconnect();
        body.removeEventListener("scroll", update);
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
