/**
 * Runs at parse time and on client mount. Keep this function self-contained:
 * the inline script embeds its source with String(rememberSidebarScroll).
 * Memory uses the body's scroll-preserve key, or the page path, and position.
 */
export function rememberSidebarScroll(body: HTMLElement | null, fadeEdges: (body: HTMLElement) => string | undefined): () => void {
  if (!body) return () => {};
  // Read again when the page is left: an in-place navigation can change the path after mount.
  const key = () =>
    "k2b-sidebar-scroll:" +
    (body.getAttribute("data-scroll-preserve") || location.pathname) +
    ":" +
    (Array.from(document.querySelectorAll(".k2b-app-workspace__sidebar-body")).indexOf(body) + 1);
  let storage: Storage;
  let stored: string | null;
  try {
    storage = window.sessionStorage;
    stored = storage.getItem(key());
  } catch {
    return () => {};
  }
  const restore = () => {
    if (stored !== null) body.scrollTop = Number(stored);
    const current = body.querySelector<HTMLElement>('[aria-current="page"]') || body.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView({ block: "nearest" });
    const edges = fadeEdges(body);
    if (edges) body.setAttribute("data-scroll-fade", edges);
    else body.removeAttribute("data-scroll-fade");
  };
  restore();
  requestAnimationFrame(restore);
  const remember = () => {
    if (!body.isConnected) return;
    try {
      storage.setItem(key(), String(body.scrollTop));
    } catch {}
  };
  window.addEventListener("pagehide", remember);
  return () => window.removeEventListener("pagehide", remember);
}

const sidebarScrollKey = (body: HTMLElement) =>
  // Same key as rememberSidebarScroll, which must stay self-contained.
  `k2b-sidebar-scroll:${body.getAttribute("data-scroll-preserve") || location.pathname}:${
    Array.from(document.querySelectorAll(".k2b-app-workspace__sidebar-body")).indexOf(body) + 1
  }`;

/**
 * For sidebars that no inline script reached, such as those a page swap inserted: keeps each one's current item
 * in view by moving only the sidebar, so a restored page scroll stays, and stores every connected sidebar's offset
 * when the page is left. Returns the cleanup.
 */
export function followSidebarScroll(root: ParentNode, fadeEdges: (body: HTMLElement) => string | undefined): () => void {
  for (const body of Array.from(root.querySelectorAll<HTMLElement>(".k2b-app-workspace__sidebar-body"))) {
    const current = body.querySelector<HTMLElement>('[aria-current="page"]') || body.querySelector<HTMLElement>('[aria-current="true"]');
    if (current) {
      const box = body.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (item.top < box.top) body.scrollTop -= box.top - item.top;
      else if (item.bottom > box.bottom) body.scrollTop += item.bottom - box.bottom;
    }
    const edges = fadeEdges(body);
    if (edges) body.setAttribute("data-scroll-fade", edges);
    else body.removeAttribute("data-scroll-fade");
  }
  const store = () => {
    for (const body of Array.from(document.querySelectorAll<HTMLElement>(".k2b-app-workspace__sidebar-body"))) {
      try {
        window.sessionStorage.setItem(sidebarScrollKey(body), String(body.scrollTop));
      } catch {}
    }
  };
  window.addEventListener("pagehide", store);
  return () => window.removeEventListener("pagehide", store);
}
