import { disposeIslands, mountIslands } from "./mount";
import { captureScroll, documentNavigate, restoreScroll, swapKey } from "./nav-history";

type SwapState = {
  document: Document;
  uninstall: () => void;
  announcer: HTMLElement;
  active?: AbortController;
  native?: { event: Event; controller: AbortController };
  token: string;
  counter: number;
  /** Counts started swaps, so deferred history work of an older navigation can tell it was overtaken. */
  started: number;
  /** The page marker of the shown server page; island-owned state may leave it undefined. */
  currentPage: unknown;
  trusted: boolean;
  /** Where the kept head's relative links resolved: history commits move the document URL, not its loaded head. */
  headBase: string;
  fragment?: { event: MouseEvent; href: string };
};
const swappedKey = Symbol.for("@k2b/ssr/nav-swap/swapped");
const shared: typeof globalThis & { [swapKey]?: SwapState; [swappedKey]?: Document } = globalThis;
const markerKey = "@k2b/ssr/nav";
const loadDocument = (href: string, options: { replace?: boolean }): void => {
  try {
    documentNavigate(href, options);
  } catch (error) {
    // A browser can reject navigation itself (for example an invalid URL); the API still never rejects.
    console.error("[@k2b/ssr/nav] Document navigation failed.", error);
  }
};
// A target that differs from the current URL only by its hash must still load: assign() or replace() would only scroll.
const recover = (href: string, replace: boolean): void => {
  try {
    const url = new URL(href);
    const here = new URL(window.location.href);
    if (url.origin !== here.origin || url.pathname !== here.pathname || url.search !== here.search || !href.includes("#")) {
      loadDocument(href, { replace });
      return;
    }
    if (url.href !== here.href) {
      if (replace) window.history.replaceState(window.history.state, "", url.href);
      else window.history.pushState(window.history.state, "", url.href);
    }
    window.location.reload();
  } catch (error) {
    // History and reload can also be refused by the browser; the API still never rejects.
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
  // `href="#"` has an empty hash but still jumps natively.
  (url.hash !== "" || url.href.endsWith("#"));
const sameTabAnchor = (event: MouseEvent) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  // The composed path reaches an anchor inside a shadow root, where event.target is the host.
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement && node.hasAttribute("href"));
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
  // An explicit target="" means this tab even under <base target>; reserved names are case-insensitive.
  const target = (
    anchor.hasAttribute("target") ? anchor.getAttribute("target") : document.querySelector("base[target]")?.getAttribute("target")
  )
    ?.trim()
    .toLowerCase();
  if (target && !["_self", "_top", "_parent"].includes(target)) return;
  return { anchor, target };
};
/** The base URL of a parsed page: its own <base href>, resolved against the response URL, as the browser would. */
const baseOf = (doc: Document, url: URL): string => new URL(doc.querySelector("base[href]")?.getAttribute("href") ?? url.href, url).href;
/** A fetched page keeps the current head, so its <base> must already match, also where it resolves to. */
const baseElement = (doc: Document): string =>
  JSON.stringify([doc.querySelector("base[href]")?.getAttribute("href"), doc.querySelector("base[target]")?.getAttribute("target")]);
const compatibleBase = (fetched: Document, url: URL): boolean =>
  baseElement(fetched) === baseElement(document) && (!fetched.querySelector("base[href]") || baseOf(fetched, url) === document.baseURI);
/** The kept head's cascade: stylesheet URLs in order, with their media. */
const stylesheets = (doc: Document, base: string): string =>
  JSON.stringify(
    [...doc.querySelectorAll('head link[rel~="stylesheet"]')].map((link) => [
      new URL(link.getAttribute("href") ?? "", base).href,
      link.getAttribute("media"),
    ]),
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
  const navigation = window.performance.getEntriesByType("navigation")[0];
  const state: SwapState = {
    document,
    announcer,
    // Only tells this document's entries apart from a reloaded one's; crypto.randomUUID needs a secure context.
    token: Math.random().toString(36).slice(2),
    counter: 0,
    started: 0,
    // A reload keeps the entry's marker; that document then also shares history with other server pages.
    currentPage: marker(window.history.state),
    // The navigation entry keeps the URL the document loaded from, also across a reinstall after a swap.
    headBase: navigation?.name || window.location.href,
    // Only a fresh document without a swap can trust unmarked island entries.
    trusted: shared[swappedKey] !== document && (navigation === undefined || ("type" in navigation && navigation.type === "navigate")),
    uninstall: () => {
      window.removeEventListener("click", captureClick, true);
      window.removeEventListener("click", click);
      window.removeEventListener("submit", submit, true);
      window.removeEventListener("popstate", popstate);
      announcer.remove();
      abort(state);
      if (shared[swapKey] === state) delete shared[swapKey];
    },
  };
  if (window.history.state === null) {
    state.currentPage = `${state.token}:${++state.counter}`;
    window.history.replaceState({ [markerKey]: state.currentPage }, "");
  }
  const captureClick = (event: MouseEvent): void => {
    const link = sameTabAnchor(event);
    if (!link) return;
    // stopPropagation can hide a native click from the bubble listener; wait until handlers can prevent it.
    if (state.active) state.native = { event, controller: state.active };
    let url: URL;
    try {
      url = new URL(link.anchor.href);
    } catch {
      return;
    }
    if (!hashJump(url)) return;
    const fragment = { event, href: url.href };
    state.fragment = fragment;
    // Native fragment activation finishes before the next task.
    setTimeout(() => {
      if (state.fragment === fragment) state.fragment = undefined;
    }, 0);
  };
  const click = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    const link = sameTabAnchor(event);
    if (!link) return;
    const { anchor, target } = link;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      return;
    }
    if (hashJump(url)) {
      // A native jump on this page is still a newer navigation than a pending swap.
      abort(state);
      return;
    }
    const context = shellContext(document);
    const eligible =
      (!target || target === "_self") && !/(^|\s)external(\s|$)/i.test(anchor.rel) && !anchor.hasAttribute("data-nav-document");
    if (eligible && context && inScope(url, context.scope)) {
      event.preventDefault();
      void swapPage(url.href, { replace: url.href === window.location.href });
    } else {
      // A native same-tab navigation must not race a late swap commit.
      abort(state);
    }
  };
  const submit = (event: SubmitEvent): void => {
    if (!state.active) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const method = event.submitter?.hasAttribute("formmethod") ? event.submitter.getAttribute("formmethod") : form.getAttribute("method");
    if (method?.trim().toLowerCase() === "dialog") return;
    const target = (
      event.submitter?.hasAttribute("formtarget")
        ? event.submitter.getAttribute("formtarget")
        : form.hasAttribute("target")
          ? form.getAttribute("target")
          : document.querySelector("base[target]")?.getAttribute("target")
    )
      ?.trim()
      .toLowerCase();
    if (target && !["_self", "_top", "_parent"].includes(target)) return;
    // Capture survives stopPropagation; defer cancellation until later handlers can prevent the submission.
    state.native = { event, controller: state.active };
  };
  const popstate = (event: PopStateEvent): void => {
    abort(state);
    const page = marker(event.state);
    // Marked entries stay with islands only while their server page is shown.
    if (page !== undefined) {
      if (page === state.currentPage) return;
    } else {
      // The link's own fresh fragment entry belongs to the shown page, even after a swap.
      if (
        event.state === null &&
        state.fragment &&
        state.fragment.href === window.location.href &&
        state.fragment.event.eventPhase === Event.NONE &&
        !state.fragment.event.defaultPrevented
      ) {
        state.fragment = undefined;
        if (state.currentPage !== undefined) window.history.replaceState({ [markerKey]: state.currentPage }, "");
        return;
      }
      if (state.trusted) return;
    }
    // The next slice gives every history entry its page ID, including island-owned entries.
    // reload(), not replace(location.href): for a URL with a hash that would only be a fragment navigation.
    window.location.reload();
  };
  shared[swapKey] = state;
  window.addEventListener("click", captureClick, true);
  window.addEventListener("click", click);
  window.addEventListener("submit", submit, true);
  window.addEventListener("popstate", popstate);
  document.body.append(announcer);
  return state.uninstall;
}

/** Fetch and swap a declared content column, or fall back to one document load. Never rejects. */
export async function swapPage(href: string, options: { replace?: boolean } = {}): Promise<void> {
  if (typeof window === "undefined") return;
  const state = shared[swapKey];
  if (state) {
    abort(state);
    state.started++;
  }
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
  const active = () => {
    if (state.native?.controller === controller && state.native.event.eventPhase === Event.NONE && !state.native.event.defaultPrevented) {
      // Dispatch finished without prevention, so the browser's native default action ran and wins.
      if (state.active === controller) state.active = undefined;
      controller.abort();
      return false;
    }
    return !controller.signal.aborted && state.active === controller && shared[swapKey] === state;
  };
  const fail = (error?: unknown): void => {
    if (!active()) return;
    state.active = undefined;
    if (error !== undefined) console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    recover(requested.href, Boolean(options.replace));
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
      !compatibleBase(fetched, finalUrl) ||
      stylesheets(document, document.querySelector("base[href]") ? document.baseURI : state.headBase) !==
        stylesheets(fetched, baseOf(fetched, finalUrl))
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
  // The commit owns the page from here: a navigation that cleanups or new islands start cannot stop it halfway.
  // A swap they start finds its captured root detached and loads its document; cleanups should not navigate.
  state.active = undefined;
  const owned = () => shared[swapKey] === state && context.root.isConnected && context.shell.contains(context.root);
  // An island may have replaced the column while modules loaded; replacing a detached root would commit only history.
  if (!owned()) {
    recover(requested.href, Boolean(options.replace));
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
      // A cleanup uninstalled the swap or replaced the column: the old islands are gone, so only a load is safe.
      recover(requested.href, Boolean(options.replace));
      return;
    }
    const pageId = `${state.token}:${++state.counter}`;
    // History first: inserted resources with relative URLs resolve against the new page's URL.
    if (options.replace) window.history.replaceState({ [markerKey]: pageId }, "", target.href);
    else window.history.pushState({ [markerKey]: pageId }, "", target.href);
    committed = true;
    state.trusted = false;
    shared[swappedKey] = document;
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
    recover(requested.href, Boolean(options.replace) || committed);
  }
};
