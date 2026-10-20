import type { ScrollSnapshot } from "./nav";
import { disposeIslands, islandsPending, mountIslands } from "./mount";
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
  currentPage: string;
  currentEntry: Entry;
  /** Traversal moves history before the DOM, so its scroll still belongs to the shown entry. */
  shown: Entry;
  stopRestore: () => void;
  scroll: Map<string, ScrollSnapshot>;
  decide: (event: PopStateEvent) => "page" | "nav";
  /** Where the kept head's relative links resolved: history commits move the document URL, not its loaded head. */
  headBase: string;
  fragment?: { event: MouseEvent; href: string };
};
const shared: typeof globalThis & { [swapKey]?: SwapState } = globalThis;
const markerKey = "@k2b/ssr/nav";
const scrollKey = "@k2b/ssr/nav:scroll";
// Chromium and Firefox keep at most 50 session history entries.
const scrollLimit = 50;
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
type Entry = { page?: string; position: number; scroll?: ScrollSnapshot };
type Marker = Entry & { page: string };
type Traversal = { href: string; entry: Entry };
const historyKey = Symbol.for("@k2b/ssr/nav-history");
type HistoryWrites = { push: History["pushState"]; replace: History["replaceState"] };
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const point = (value: unknown): value is { x: number; y: number } =>
  plain(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
const scrollSnapshot = (value: unknown): value is ScrollSnapshot =>
  plain(value) &&
  point(value.window) &&
  Array.isArray(value.regions) &&
  value.regions.every((region: unknown) => plain(region) && typeof region.key === "string" && region.key.length > 0 && point(region));
const marker = (value: unknown): Marker | undefined => {
  if (!plain(value)) return;
  const entry = value[markerKey];
  if (
    plain(entry) &&
    typeof entry.page === "string" &&
    entry.page.length > 0 &&
    typeof entry.position === "number" &&
    Number.isSafeInteger(entry.position) &&
    entry.position >= 0 &&
    (entry.scroll === undefined || scrollSnapshot(entry.scroll))
  )
    return { page: entry.page, position: entry.position, ...(entry.scroll ? { scroll: entry.scroll } : {}) };
};
const mergeMarker = (value: unknown, entry: Marker): unknown =>
  value == null ? { [markerKey]: entry } : plain(value) ? { ...value, [markerKey]: entry } : value;
const basePosition = (): number => window.navigation?.currentEntry?.index ?? window.history.length - 1;
const entryKey = (entry: Entry): string => `${entry.page}:${entry.position}`;
const remember = (state: SwapState, entry: Entry, snapshot: ScrollSnapshot): void => {
  if (entry.page === undefined) return;
  const key = entryKey(entry);
  state.scroll.delete(key);
  state.scroll.set(key, snapshot);
  if (state.scroll.size > scrollLimit) state.scroll.delete(state.scroll.keys().next().value!);
};
const loadScroll = (): Map<string, ScrollSnapshot> => {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(scrollKey) ?? "null");
    if (Array.isArray(stored))
      return new Map(
        stored
          .filter(
            (item): item is [string, ScrollSnapshot] =>
              Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && scrollSnapshot(item[1]),
          )
          .slice(-scrollLimit),
      );
  } catch {
    // Storage can be disabled or contain malformed data; navigation must still work.
  }
  return new Map();
};
const savedScroll = (state: SwapState, entry: Entry): ScrollSnapshot | undefined => state.scroll.get(entryKey(entry)) ?? entry.scroll;
const newPage = (state: SwapState): string => `${state.token}:${++state.counter}`;
const currentEntry = (state: SwapState): Entry => marker(window.history.state) ?? state.currentEntry;
// Islands and dialogs own every entry of the shown page, including traversals hidden from nav. An entry of another
// page means a cross-page traversal has not committed, so the DOM still shows the tracked entry.
const shownEntry = (state: SwapState, current: Entry | undefined = marker(window.history.state)): Entry =>
  current?.page === state.currentPage ? current : state.shown;
const persistScroll = (writes: HistoryWrites, entry: Marker, snapshot: ScrollSnapshot): void => {
  if (JSON.stringify(entry.scroll) === JSON.stringify(snapshot)) return;
  try {
    writes.replace.call(window.history, mergeMarker(window.history.state, { ...entry, scroll: snapshot }), "");
  } catch {
    // A scroll snapshot must never prevent the caller's own history write.
  }
};
const patchHistory = (): HistoryWrites => {
  const history: History & { [historyKey]?: HistoryWrites } = window.history;
  if (history[historyKey]) return history[historyKey];
  const writes = { push: history.pushState, replace: history.replaceState };
  Object.defineProperty(history, historyKey, { value: writes });
  history.pushState = (value: unknown, ...args: [unused: string, url?: string | URL | null]) => {
    const state = shared[swapKey];
    if (!state || state.document !== document) return writes.push.call(history, value, ...args);
    const departing = currentEntry(state);
    const snapshot = captureScroll();
    const shown = shownEntry(state);
    const stored = marker(history.state);
    if (stored && entryKey(stored) === entryKey(shown)) persistScroll(writes, stored, snapshot);
    const entry = { page: state.currentPage, position: departing.position + 1 };
    writes.push.call(history, mergeMarker(value, entry), ...args);
    remember(state, shown, snapshot);
    state.currentEntry = entry;
    state.shown = entry;
  };
  history.replaceState = (value: unknown, ...args: [unused: string, url?: string | URL | null]) => {
    const state = shared[swapKey];
    if (!state || state.document !== document) return writes.replace.call(history, value, ...args);
    const entry = marker(history.state) ?? { page: state.currentPage, position: state.currentEntry.position };
    writes.replace.call(history, mergeMarker(value, entry), ...args);
    state.currentEntry = entry;
    if (entryKey(entry) === entryKey(state.shown)) state.shown = entry;
  };
  return writes;
};
const stillCurrent = (state: SwapState, traversal: Traversal): boolean => {
  const entry = marker(window.history.state);
  return (
    window.location.href === traversal.href &&
    entry?.page === traversal.entry.page &&
    (entry === undefined || entry.position === traversal.entry.position)
  );
};
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

/**
 * Install opt-in server HTML page swaps before islands add raw popstate listeners.
 * listenPopState is safe in either order. Repeated calls share the same cleanup.
 */
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
  const timing = window.performance.getEntriesByType("navigation")[0];
  const navigation = window.navigation;
  const writes = patchHistory();
  const initial = marker(window.history.state);
  const scrollRestoration = window.history.scrollRestoration;
  window.history.scrollRestoration = "manual";
  let observer: MutationObserver | undefined;
  const inputs = ["wheel", "touchstart", "keydown", "pointerdown"];
  const stopRestore = (): void => {
    if (!observer) return;
    observer.disconnect();
    observer = undefined;
    for (const input of inputs) window.removeEventListener(input, stopRestore, true);
  };
  const state: SwapState = {
    document,
    announcer,
    // Only tells this document's entries apart from a reloaded one's; crypto.randomUUID needs a secure context.
    token: Math.random().toString(36).slice(2),
    counter: 0,
    started: 0,
    // A reload keeps the entry's marker; that document then also shares history with other server pages.
    currentPage: initial?.page ?? "",
    currentEntry: initial ?? { position: basePosition() },
    shown: initial ?? { position: basePosition() },
    stopRestore,
    scroll: loadScroll(),
    decide: (event) => decide(event),
    // The navigation entry keeps the URL the document loaded from, also across a reinstall after a swap.
    headBase: timing?.name || window.location.href,
    uninstall: () => {
      if (shared[swapKey] !== state) return;
      stopRestore();
      window.removeEventListener("click", captureClick, true);
      window.removeEventListener("click", click);
      window.removeEventListener("submit", submit, true);
      window.removeEventListener("popstate", popstate, { capture: true });
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("pagehide", pagehide);
      navigation?.removeEventListener("navigate", onNavigate);
      window.history.scrollRestoration = scrollRestoration;
      announcer.remove();
      abort(state);
      if (shared[swapKey] === state) delete shared[swapKey];
    },
  };
  const snapshot = initial && savedScroll(state, initial);
  if (!initial) {
    const entry = { page: newPage(state), position: basePosition() };
    state.currentPage = entry.page;
    state.currentEntry = entry;
    state.shown = entry;
    if (window.history.state == null || plain(window.history.state))
      writes.replace.call(window.history, mergeMarker(window.history.state, entry), "");
  } else if (timing && "type" in timing && ["reload", "back_forward"].includes(String(timing.type)) && snapshot) {
    restoreScroll(snapshot);
    if (islandsPending(document)) {
      // Mounting replaces server regions and creates client-only ones; replay once, unless the person took over.
      observer = new MutationObserver(() => {
        if (!observer || islandsPending(document)) return;
        stopRestore();
        restoreScroll(snapshot);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      for (const input of inputs) window.addEventListener(input, stopRestore, { capture: true, passive: true });
    }
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
  let departure: { key: string; entry: Entry; scroll: ScrollSnapshot } | undefined;
  let fragment: "push" | "replace" | undefined;
  const onNavigate = (event: NavigateEvent): void => {
    departure =
      event.navigationType === "traverse"
        ? { key: event.destination.key, entry: marker(window.history.state) ?? { position: basePosition() }, scroll: captureScroll() }
        : undefined;
    fragment =
      event.hashChange && (event.navigationType === "push" || event.navigationType === "replace") ? event.navigationType : undefined;
  };
  const traverse = (entry: Entry): void => {
    state.currentEntry = entry;
    void runSwap(window.location.href, {}, { href: window.location.href, entry });
  };
  const decisions = new WeakMap<PopStateEvent, "page" | "nav">();
  const decide = (event: PopStateEvent): "page" | "nav" => {
    stopRestore();
    const known = decisions.get(event);
    if (known) {
      if (known === "nav") event.stopImmediatePropagation();
      return known;
    }
    const from =
      departure && departure.key === navigation?.currentEntry?.key ? departure : { entry: state.currentEntry, scroll: captureScroll() };
    const shown = shownEntry(state, from.entry);
    // History already left the shown page while its DOM stays: a cross-page traversal has not committed.
    const pending = from.entry.page !== state.currentPage;
    abort(state);
    departure = undefined;
    remember(state, shown, from.scroll);
    const fragmentMode = navigation
      ? fragment
      : event.state === null &&
          state.fragment?.href === window.location.href &&
          state.fragment.event.eventPhase === Event.NONE &&
          !state.fragment.event.defaultPrevented
        ? "push"
        : undefined;
    fragment = undefined;
    state.fragment = undefined;
    if (fragmentMode) {
      // A fragment entry belongs to the page of the entry it came from, which a pending traversal has not shown yet.
      const page = pending ? from.entry.page : state.currentPage;
      const entry = { page, position: from.entry.position + (fragmentMode === "push" ? 1 : 0) };
      if (page !== undefined) writes.replace.call(window.history, mergeMarker(window.history.state, { ...entry, page }), "");
      if (pending) {
        decisions.set(event, "nav");
        event.stopImmediatePropagation();
        traverse(entry);
        return "nav";
      }
      state.currentEntry = entry;
      state.shown = entry;
      decisions.set(event, "page");
      return "page";
    }
    const entry = marker(event.state);
    if (entry?.page === state.currentPage) {
      state.currentEntry = entry;
      state.shown = entry;
      const snapshot = savedScroll(state, entry);
      if (snapshot) window.scrollTo(snapshot.window.x, snapshot.window.y);
      decisions.set(event, "page");
      return "page";
    }
    decisions.set(event, "nav");
    event.stopImmediatePropagation();
    traverse(entry ?? { position: basePosition() });
    return "nav";
  };
  const popstate = (event: PopStateEvent): void => {
    decide(event);
  };
  const pageshow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    abort(state);
    const entry = marker(window.history.state);
    // A same-page return keeps the tracked entry: a popstate that follows still departs from the shown one.
    if (entry?.page !== state.currentPage) traverse(entry ?? { position: basePosition() });
  };
  const pagehide = (): void => {
    const shown = shownEntry(state);
    const snapshot = captureScroll();
    remember(state, shown, snapshot);
    const entry = marker(window.history.state);
    if (entry && entryKey(entry) === entryKey(shown)) persistScroll(writes, entry, snapshot);
    try {
      window.sessionStorage.setItem(scrollKey, JSON.stringify([...state.scroll]));
    } catch {
      // Disabled or full storage must never prevent navigation.
    }
  };
  shared[swapKey] = state;
  window.addEventListener("popstate", popstate, { capture: true });
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("pagehide", pagehide);
  navigation?.addEventListener("navigate", onNavigate);
  window.addEventListener("click", captureClick, true);
  window.addEventListener("click", click);
  window.addEventListener("submit", submit, true);
  document.body.append(announcer);
  return state.uninstall;
}

/** Fetch and swap a declared content column, or fall back to one document load. Never rejects. */
export async function swapPage(href: string, options: { replace?: boolean } = {}): Promise<void> {
  return runSwap(href, options);
}

async function runSwap(href: string, options: { replace?: boolean }, traversal?: Traversal): Promise<void> {
  if (typeof window === "undefined") return;
  const state = shared[swapKey];
  if (state) {
    state.stopRestore();
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
    if (traversal) {
      if (state && stillCurrent(state, traversal)) window.location.reload();
    } else loadDocument(requested.href, options);
    return;
  }
  const controller = new AbortController();
  state.active = controller;
  const active = () => {
    if (state.native?.controller === controller && state.native.event.eventPhase === Event.NONE && !state.native.event.defaultPrevented) {
      // Dispatch finished without prevention, so the browser's native default action ran and wins.
      if (state.active === controller) abort(state);
      else controller.abort();
      return false;
    }
    return (
      !controller.signal.aborted &&
      state.active === controller &&
      shared[swapKey] === state &&
      (!traversal || stillCurrent(state, traversal))
    );
  };
  const fail = (error?: unknown): void => {
    if (!active()) return;
    state.active = undefined;
    if (error !== undefined) console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    if (traversal) window.location.reload();
    else recover(requested.href, Boolean(options.replace));
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
      !inScope(finalUrl, context.scope) ||
      (traversal && finalUrl.href.split("#")[0] !== requested.href.split("#")[0])
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
    commit(state, context, next, fetched, finalUrl, requested, options, traversal);
  } catch (error) {
    fail(error);
  } finally {
    if (state.active === controller) state.active = undefined;
  }
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
  traversal?: Traversal,
): void => {
  // The commit owns the page from here: a navigation that cleanups or new islands start cannot stop it halfway.
  // A swap they start finds its captured root detached and loads its document; cleanups should not navigate.
  state.active = undefined;
  const owned = () => shared[swapKey] === state && context.root.isConnected && context.shell.contains(context.root);
  const recoverCommit = (replace: boolean): void => {
    if (!traversal) recover(requested.href, replace);
    else if (stillCurrent(state, traversal)) window.location.reload();
  };
  if (traversal && !stillCurrent(state, traversal)) return;
  // An island may have replaced the column while modules loaded; replacing a detached root would commit only history.
  if (!owned()) {
    recoverCommit(Boolean(options.replace));
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
      recoverCommit(Boolean(options.replace));
      return;
    }
    if (traversal && !stillCurrent(state, traversal)) return;
    const writes = patchHistory();
    let entry: Marker;
    if (traversal) {
      entry = marker(window.history.state) ?? { page: newPage(state), position: traversal.entry.position };
      if (!marker(window.history.state) && (window.history.state == null || plain(window.history.state))) {
        writes.replace.call(window.history, mergeMarker(window.history.state, entry), "");
        traversal.entry = marker(window.history.state) ?? traversal.entry;
      }
    } else {
      const departing = currentEntry(state);
      const shown = shownEntry(state);
      remember(state, shown, snapshot);
      const stored = marker(window.history.state);
      if (!options.replace && stored && entryKey(stored) === entryKey(shown)) persistScroll(writes, stored, snapshot);
      entry = { page: newPage(state), position: departing.position + (options.replace ? 0 : 1) };
      // History first: inserted resources with relative URLs resolve against the new page's URL.
      const write = options.replace ? writes.replace : writes.push;
      write.call(window.history, { [markerKey]: entry }, "", target.href);
    }
    committed = true;
    state.currentPage = entry.page;
    state.currentEntry = entry;
    state.shown = entry;
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
    const restored = traversal ? savedScroll(state, entry) : undefined;
    if (restored) restoreScroll(restored);
    else {
      if (!traversal) restoreScroll(snapshot, { window: false });
      window.scrollTo(0, 0);
      if (hashId) document.getElementById(hashId)?.scrollIntoView();
    }
    const focus = root.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6") ?? root;
    if (!focus.hasAttribute("tabindex")) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
    state.announcer.textContent = document.title;
  } catch (error) {
    console.error("[@k2b/ssr/nav] Page swap failed; falling back to document navigation.", error);
    recoverCommit(Boolean(options.replace) || committed);
  }
};
