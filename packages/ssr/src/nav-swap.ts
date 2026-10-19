import { disposeIslands, mountIslands } from "./mount";
import { captureScroll, documentNavigate, restoreScroll, swapKey } from "./nav-history";

type SwapState = {
  document: Document;
  uninstall: () => void;
  announcer: HTMLElement;
  active?: AbortController;
  token: string;
  counter: number;
  /** The page marker of the shown server page: undefined on a document loaded without a swap entry. */
  currentPage: unknown;
};
const shared: typeof globalThis & { [swapKey]?: SwapState } = globalThis;
const markerKey = "@k2b/ssr/nav";
const loadDocument = (href: string, options: { replace?: boolean }): void => {
  try {
    documentNavigate(href, options);
  } catch (error) {
    // A browser can reject navigation itself (for example an invalid URL); the API still never rejects.
    console.error("[@k2b/ssr/nav] Document navigation failed.", error);
  }
};
const marker = (state: unknown): unknown =>
  state !== null && typeof state === "object" && markerKey in state ? state[markerKey] : undefined;
const abort = (state: SwapState): void => {
  state.active?.abort();
  state.active = undefined;
};
const shellContext = (doc: Document) => {
  const shells = doc.querySelectorAll<HTMLElement>("[data-nav-shell]");
  if (shells.length !== 1) return;
  const shell = shells[0]!;
  const roots = shell.querySelectorAll<HTMLElement>("[data-nav-root]");
  const scope = shell.getAttribute("data-nav-scope");
  if (roots.length !== 1 || !scope?.startsWith("/")) return;
  return { shell, root: roots[0]!, scope };
};
const inScope = (url: URL, scope: string): boolean =>
  url.origin === window.location.origin &&
  (scope === "/" || url.pathname === scope || url.pathname.startsWith(scope.endsWith("/") ? scope : `${scope}/`));
const hashJump = (url: URL): boolean =>
  url.origin === window.location.origin &&
  url.pathname === window.location.pathname &&
  url.search === window.location.search &&
  url.hash !== "";
/** The base URL of a parsed page: its own <base href>, resolved against the response URL, as the browser would. */
const baseOf = (doc: Document, url: URL): string => new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? url.href, url).href;
const stylesheets = (doc: Document, base: string): string =>
  JSON.stringify(
    [
      ...new Set(
        [...doc.querySelectorAll('head link[rel~="stylesheet"]')].map((link) => new URL(link.getAttribute("href") ?? "", base).href),
      ),
    ].sort(),
  );
const wrappers = (root: HTMLElement): HTMLElement[] => [
  ...(root.matches("solid-island,solid-client") ? [root] : []),
  ...root.querySelectorAll<HTMLElement>("solid-island,solid-client"),
];

/** Install opt-in server HTML page swaps. Repeated calls share the same cleanup. */
export function installPageSwap(): () => void {
  if (typeof window === "undefined") return () => {};
  if (shared[swapKey]?.document === document) return shared[swapKey].uninstall;
  shared[swapKey]?.uninstall();
  const announcer = document.createElement("div");
  announcer.setAttribute("data-nav-announcer", "");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  announcer.setAttribute("aria-atomic", "true");
  announcer.setAttribute(
    "style",
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap",
  );
  const state: SwapState = {
    document,
    announcer,
    // Only tells this document's entries apart from a reloaded one's; crypto.randomUUID needs a secure context.
    token: Math.random().toString(36).slice(2),
    counter: 0,
    // A reload keeps the entry's marker; that document then also shares history with other server pages.
    currentPage: marker(window.history.state),
    uninstall: () => {
      window.removeEventListener("click", click);
      window.removeEventListener("popstate", popstate);
      announcer.remove();
      abort(state);
      if (shared[swapKey] === state) delete shared[swapKey];
    },
  };
  const click = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // The composed path reaches an anchor inside a shadow root, where event.target is the host.
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.hasAttribute("href"));
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
    const target = anchor.target || document.querySelector("base[target]")?.getAttribute("target") || "";
    if (target && !["_self", "_top", "_parent"].includes(target)) return;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (hashJump(url)) return;
    const context = shellContext(document);
    const eligible = (!target || target === "_self") && !anchor.relList.contains("external") && !anchor.hasAttribute("data-nav-document");
    if (eligible && context && inScope(url, context.scope)) {
      event.preventDefault();
      void swapPage(url.href, { replace: url.href === window.location.href });
    } else {
      // A native same-tab navigation must not race a late swap commit.
      abort(state);
    }
  };
  const popstate = (event: PopStateEvent): void => {
    abort(state);
    const page = marker(event.state);
    // Entries of the shown page keep its marker (or none on a page loaded normally); islands handle those.
    if (page === state.currentPage) return;
    // The next slice gives every history entry its page ID, including island-owned entries.
    documentNavigate(window.location.href, { replace: true });
  };
  shared[swapKey] = state;
  window.addEventListener("click", click);
  window.addEventListener("popstate", popstate);
  document.body.append(announcer);
  return state.uninstall;
}

/** Fetch and swap a declared content column, or fall back to one document load. Never rejects. */
export async function swapPage(href: string, options: { replace?: boolean } = {}): Promise<void> {
  if (typeof window === "undefined") return;
  const state = shared[swapKey];
  if (state) abort(state);
  let requested: URL;
  try {
    requested = new URL(href, document.baseURI || window.location.href);
  } catch {
    loadDocument(href, options);
    return;
  }
  const context = shellContext(document);
  if (!state || state.document !== document || !context || !inScope(requested, context.scope)) {
    loadDocument(requested.href, options);
    return;
  }
  const controller = new AbortController();
  state.active = controller;
  const active = () => !controller.signal.aborted && state.active === controller && shared[swapKey] === state;
  const fail = (error?: unknown): void => {
    if (!active()) return;
    state.active = undefined;
    if (error !== undefined) console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    loadDocument(requested.href, options);
  };
  let fetched: Document;
  let next: NonNullable<ReturnType<typeof shellContext>>;
  let finalUrl: URL;
  try {
    const response = await fetch(requested.href, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!active()) return;
    finalUrl = new URL(response.url || requested.href);
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/html" ||
      !inScope(finalUrl, context.scope)
    ) {
      fail();
      return;
    }
    const text = await response.text();
    if (!active()) return;
    fetched = new DOMParser().parseFromString(text, "text/html");
    const parsed = shellContext(fetched);
    const loader = fetched.querySelector("script[data-ssr-assets]");
    const prefix = loader?.getAttribute("data-ssr-assets");
    if (
      !parsed ||
      parsed.shell.getAttribute("data-nav-shell") !== context.shell.getAttribute("data-nav-shell") ||
      parsed.scope !== context.scope ||
      prefix !== document.querySelector("script[data-ssr-assets]")?.getAttribute("data-ssr-assets") ||
      (!prefix && wrappers(parsed.root).length > 0) ||
      stylesheets(document, document.baseURI) !== stylesheets(fetched, baseOf(fetched, finalUrl))
    ) {
      fail();
      return;
    }
    next = parsed;
    for (const name of loader?.getAttribute("data-ssr-preload")?.split(/\s+/).filter(Boolean) ?? []) {
      const href = new URL(`${prefix}/${name}`, document.baseURI).href;
      if ([...document.querySelectorAll<HTMLLinkElement>('link[rel~="modulepreload"]')].some((link) => link.href === href)) continue;
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = href;
      document.head.append(link);
    }
    // Evaluation cannot be cancelled: an entry registers its component (and mounts wrappers already waiting for it),
    // but only an active swap inserts its column.
    await Promise.all([...new Set(wrappers(next.root).map((element) => element.dataset.id))].map((id) => import(`${prefix}/${id}.js`)));
    if (!active()) return;
  } catch (error) {
    fail(error);
    return;
  }
  commit(state, context, next, fetched, finalUrl, requested, options);
}

/**
 * Applies a validated page without an await. Disposal runs application cleanups, which may navigate, uninstall, or
 * replace the column, so the transaction re-checks ownership after it. Any later throw loads the document.
 */
const commit = (
  state: SwapState,
  context: NonNullable<ReturnType<typeof shellContext>>,
  next: NonNullable<ReturnType<typeof shellContext>>,
  fetched: Document,
  finalUrl: URL,
  requested: URL,
  options: { replace?: boolean },
): void => {
  const fallback = (replace: boolean) => loadDocument(requested.href, { replace });
  // The commit owns the page from here; a navigation that cleanups or new islands start is newer and wins later.
  state.active = undefined;
  const owned = () => !state.active && shared[swapKey] === state && context.root.isConnected && context.shell.contains(context.root);
  // An island may have replaced the column while modules loaded; replacing a detached root would commit only history.
  if (!owned()) {
    if (!state.active) fallback(Boolean(options.replace));
    return;
  }
  let committed = false;
  try {
    const target = new URL(finalUrl.href);
    target.hash = requested.hash;
    let hashId = requested.hash.slice(1);
    try {
      hashId = decodeURIComponent(hashId);
    } catch {
      // A malformed escape stays as written, as the browser treats it.
    }
    const snapshot = captureScroll();
    disposeIslands(context.root);
    if (!owned()) {
      // A newer swap started during cleanup and owns the page; otherwise the old islands are gone and only a load is safe.
      if (!state.active) fallback(Boolean(options.replace));
      return;
    }
    const pageId = `${state.token}:${++state.counter}`;
    // History first: inserted resources with relative URLs resolve against the new page's URL.
    if (options.replace) window.history.replaceState({ [markerKey]: pageId }, "", target.href);
    else window.history.pushState({ [markerKey]: pageId }, "", target.href);
    committed = true;
    state.currentPage = pageId;
    const root = document.adoptNode(next.root);
    context.root.replaceWith(root);
    document.title = fetched.title;
    for (const name of context.shell.getAttribute("data-nav-attributes")?.split(/\s+/).filter(Boolean) ?? []) {
      const value = next.shell.getAttribute(name);
      if (value === null) context.shell.removeAttribute(name);
      else context.shell.setAttribute(name, value);
    }
    mountIslands(root);
    // Keyed regions inside islands exist only after mounting.
    restoreScroll(snapshot, { window: false });
    window.scrollTo(0, 0);
    if (hashId) document.getElementById(hashId)?.scrollIntoView();
    const focus = root.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? root;
    if (!focus.hasAttribute("tabindex")) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
    state.announcer.textContent = document.title;
  } catch (error) {
    console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    fallback(Boolean(options.replace) || committed);
  }
};
