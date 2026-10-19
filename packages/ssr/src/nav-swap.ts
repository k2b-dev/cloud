import { disposeIslands, mountIslands } from "./mount";
import { captureScroll, documentNavigate, navigate } from "./nav-history";

type SwapState = {
  document: Document;
  uninstall: () => void;
  announcer: HTMLElement;
  active?: AbortController;
  token: string;
  counter: number;
  initialPage: unknown;
  currentPage: unknown;
  swapped: boolean;
};
const swapKey = Symbol.for("@k2b/ssr/nav-swap");
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
  const initialPage = marker(window.history.state);
  const state: SwapState = {
    document,
    announcer,
    // Only tells this document's entries apart from a reloaded one's; crypto.randomUUID needs a secure context.
    token: Math.random().toString(36).slice(2),
    counter: 0,
    initialPage,
    currentPage: initialPage,
    swapped: false,
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
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (hashJump(url)) return;
    const context = shellContext(document);
    if (!anchor.relList.contains("external") && !anchor.hasAttribute("data-nav-document") && context && inScope(url, context.scope)) {
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
    if (!state.swapped && (page === undefined || page === state.initialPage)) return;
    if (state.swapped && page === state.currentPage) return;
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
  let pageId: string | undefined;
  const fail = (error?: unknown): void => {
    if (!active()) return;
    state.active = undefined;
    if (error !== undefined) console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    loadDocument(requested.href, { replace: options.replace || (pageId !== undefined && marker(window.history.state) === pageId) });
  };
  try {
    const response = await fetch(requested.href, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!active()) return;
    const finalUrl = new URL(response.url || requested.href);
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
    const fetched = new DOMParser().parseFromString(text, "text/html");
    const next = shellContext(fetched);
    const loader = fetched.querySelector("script[data-ssr-assets]");
    const prefix = loader?.getAttribute("data-ssr-assets");
    if (
      !next ||
      next.shell.getAttribute("data-nav-shell") !== context.shell.getAttribute("data-nav-shell") ||
      next.scope !== context.scope ||
      prefix !== document.querySelector("script[data-ssr-assets]")?.getAttribute("data-ssr-assets") ||
      (!prefix && wrappers(next.root).length > 0) ||
      stylesheets(document, document.baseURI) !== stylesheets(fetched, finalUrl.href)
    ) {
      fail();
      return;
    }
    for (const name of loader?.getAttribute("data-ssr-preload")?.split(/\s+/).filter(Boolean) ?? []) {
      const href = `${prefix}/${name}`;
      if (
        [...document.querySelectorAll<HTMLLinkElement>('link[rel~="modulepreload"]')].some(
          (link) => link.href === new URL(href, document.baseURI).href,
        )
      )
        continue;
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = href;
      document.head.append(link);
    }
    await Promise.all([...new Set(wrappers(next.root).map((element) => element.dataset.id))].map((id) => import(`${prefix}/${id}.js`)));
    if (!active()) return;
    // An island may have replaced the column meanwhile; replacing a detached root would commit history without a swap.
    if (!context.root.isConnected || !context.shell.contains(context.root)) {
      fail();
      return;
    }
    const snapshot = captureScroll();
    disposeIslands(context.root);
    const root = document.adoptNode(next.root);
    context.root.replaceWith(root);
    document.title = fetched.title;
    for (const name of context.shell.getAttribute("data-nav-attributes")?.split(/\s+/).filter(Boolean) ?? []) {
      const value = next.shell.getAttribute(name);
      if (value === null) context.shell.removeAttribute(name);
      else context.shell.setAttribute(name, value);
    }
    pageId = `${state.token}:${++state.counter}`;
    const target = `${finalUrl.pathname}${finalUrl.search}${requested.hash}`;
    navigate(target, {
      replace: options.replace,
      state: { [markerKey]: pageId },
      scroll: "top",
      scrollSnapshot: snapshot,
      viewTransition: false,
    });
    state.currentPage = pageId;
    state.swapped = true;
    mountIslands(root);
    if (requested.hash) document.getElementById(decodeURIComponent(requested.hash.slice(1)))?.scrollIntoView();
    const focus = root.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? root;
    if (!focus.hasAttribute("tabindex")) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
    state.announcer.textContent = "";
    state.announcer.textContent = document.title;
    if (state.active === controller) state.active = undefined;
  } catch (error) {
    fail(error);
  }
}
