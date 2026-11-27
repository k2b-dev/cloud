/**
 * The history entries of dialogs and of other transient UI that Back should close: a same-URL entry each, Back or
 * Forward closes what was opened after the entry it shows, and a closed one leaves the history again with one
 * synthetic Back. Framework-free and without other modules of the library, so a v2 island takes only this when its
 * question holds an entry. The dialogs of `dialog-core` register their own entries here through `attach`.
 */

/**
 * Every copy of the library on a page (each island bundles its own) numbers its entries from a start of its own, so a
 * copy never takes another copy's marker for its own and stops that copy's Back; within a copy the numbers rise.
 */
let nextHistoryId = ((globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 0) + 1) * 2 ** 20;
/** The history state key that marks a dialog's same-URL entry. */
const HISTORY_MARKER = "k2bDialog";

const historyRecord = (): Record<string, unknown> =>
  typeof history.state === "object" && history.state !== null ? { ...history.state } : {};
const historyMarker = (): unknown => historyRecord()[HISTORY_MARKER];
const historySnapshot = () => ({ href: location.href, length: history.length });

/** Checked by shape: a test harness or an iframe may create the event in another realm. */
const isPopState = (value: unknown): value is PopStateEvent =>
  typeof value === "object" && value !== null && "type" in value && value.type === "popstate" && "state" in value;

export type HistoryEntry = { historyId?: number };
type HistoryHolder = HistoryEntry & { onBack: () => void };

/** What the owner of open dialogs tells the history and does when the history moves. */
export type DialogHistoryOwner = {
  /** The entries of the dialogs open now. */
  open: () => Iterable<HistoryEntry>;
  /** Back or Forward moved: close the dialogs whose entry it left (`kept` says which ids stay). */
  traversed: (kept: (id: number | undefined) => boolean) => void;
  /** The page content changes (island disposal): close every dialog, as a document load would. */
  disposing: () => void;
};

export const createDialogHistory = () => {
  let owner: DialogHistoryOwner | undefined;
  /** Markers of this history's entries in the browser history, oldest first. */
  let historyIds: number[] = [];
  const issued = new Set<number>();
  /**
   * Markers forgotten during island disposal. Their entries stay in `historyIds` as barriers: a synthetic Back never
   * crosses one, because the router may have replaced that entry with another page.
   */
  const forgotten = new Set<number>();
  const deadMarker = (marker: unknown): marker is number => typeof marker === "number" && forgotten.has(marker);
  const ownMarker = (marker: unknown): marker is number => typeof marker === "number" && issued.has(marker);
  /** The address of each own entry that a dialog named with `historyUrl`. */
  const ownUrls = new Map<number, string>();
  let seen: ReturnType<typeof historySnapshot> | undefined;
  let traversalFrom: { href: string; marker: unknown } | undefined;
  let syntheticFrom: { href: string; marker: unknown } | undefined;
  const historyHolders = new Set<HistoryHolder>();
  let historySyncScheduled = false;
  let disposingIslands = false;
  /** Settles when the synthetic Back that removes closed entries has arrived. */
  let returning: Promise<void> | undefined;
  let resolveReturning: (() => void) | undefined;

  const live = () => new Set([...(owner?.open() ?? []), ...historyHolders].map((entry) => entry.historyId));

  /** Outside island disposal, closed entries leave with one Back to the newest live dialog or holder, or to the page. */
  const syncHistory = () => {
    if (returning) {
      void returning.then(() => {
        if (historySyncScheduled) syncHistory();
      });
      return;
    }
    historySyncScheduled = false;
    const openIds = live();
    const current = historyIds.at(-1);
    let steps = 0;
    while (historyIds.length > 0 && !openIds.has(historyIds.at(-1)) && !deadMarker(historyIds.at(-1))) {
      historyIds.pop();
      steps++;
    }
    // Someone else moved the history meanwhile; leave it alone.
    if (steps === 0 || historyMarker() !== current || location.href !== seen?.href || history.length !== seen?.length) return;
    const back = new Promise<void>((resolve) => {
      resolveReturning = resolve;
    });
    returning = back;
    void back.then(() => {
      if (returning === back) returning = undefined;
    });
    syntheticFrom = { href: location.href, marker: current };
    history.go(-steps);
  };

  const release = (entry: HistoryEntry) => {
    if (entry.historyId === undefined) return;
    // During a content swap the router owns history. Forget the marker without moving history; its entry stays a
    // barrier for later synthetic Backs and is left for the router to replace.
    if (disposingIslands) {
      issued.delete(entry.historyId);
      forgotten.add(entry.historyId);
      entry.historyId = undefined;
      return;
    }
    if (historySyncScheduled) return;
    historySyncScheduled = true;
    queueMicrotask(syncHistory);
  };

  /** Traversals this history already handled: a page swap router also reports the ones it hides from listeners. */
  const handled = new WeakSet<PopStateEvent>();
  /** Back or Forward moved to another entry: close dialogs and holders opened after the one it shows. */
  const onPopState = (event: PopStateEvent) => {
    if (handled.has(event)) return;
    handled.add(event);
    const resolveBack = resolveReturning;
    // Without the Navigation API, only our synthetic Back has a known departure.
    const from = typeof navigation !== "undefined" ? traversalFrom : resolveBack ? syntheticFrom : undefined;
    traversalFrom = undefined;
    syntheticFrom = undefined;
    resolveReturning = undefined;
    try {
      const marker = historyMarker();
      // A dialog's own address (`historyUrl`) changes only between its entry and the page: still a dialog-only traversal.
      const ownAddress = (entry: unknown, href: string) => ownMarker(entry) && ownUrls.get(entry) === href;
      const sameAddress = from && (from.href === location.href || ownAddress(from.marker, from.href) || ownAddress(marker, location.href));
      if (from && sameAddress && from.marker !== marker && (ownMarker(from.marker) || ownMarker(marker))) {
        event.stopImmediatePropagation();
      }
      // Own entries are ordered by id. A retired entry reached by Forward stays tracked, so closing the dialogs
      // beneath it also removes it. A forgotten entry keeps the holders opened before it and stays a barrier.
      historyIds = ownMarker(marker) || deadMarker(marker) ? [...historyIds.filter((id) => id < marker), marker] : [];
      owner?.traversed((id) => id === undefined || historyIds.includes(id));
      for (const holder of [...historyHolders].reverse()) {
        if (holder.historyId === undefined || historyIds.includes(holder.historyId)) continue;
        historyHolders.delete(holder);
        release(holder);
        holder.onBack();
      }
    } finally {
      seen = historySnapshot();
      resolveBack?.();
    }
  };

  /**
   * Island disposal means the page content changes, as a document load would: every dialog closes, and entries that
   * are not live any more are forgotten without moving history (the router owns it now).
   */
  const onIslandDispose = () => {
    if (!disposingIslands) {
      disposingIslands = true;
      queueMicrotask(() => {
        disposingIslands = false;
      });
      // Entries released just before, whose Back has not started yet, stay as well: the router owns history now.
      // A Back already on its way still settles through `returning`.
      historySyncScheduled = false;
      const open = live();
      for (const id of historyIds) {
        if (open.has(id) || !issued.delete(id)) continue;
        forgotten.add(id);
      }
    }
    owner?.disposing();
  };

  /** `@k2b/ssr/nav` stops a traversal to another server page before later listeners and reports it here. */
  const onHiddenPopState = (event: Event) => {
    const detail: unknown = "detail" in event ? event.detail : undefined;
    if (isPopState(detail)) onPopState(detail);
  };
  /** The page leaves while a synthetic Back is on its way: no popstate comes, and nothing waits for one any more. */
  const onPageHide = () => {
    const done = resolveReturning;
    resolveReturning = undefined;
    syntheticFrom = undefined;
    done?.();
  };
  const onNavigate = (event: NavigateEvent) => {
    if (event.navigationType === "traverse") traversalFrom = { href: location.href, marker: historyMarker() };
  };
  /** The window whose history this listens to; a test harness may replace the window between dialogs. */
  let listening: { window: Window; navigation?: Navigation } | undefined;
  const listen = () => {
    if (listening?.window === window) return;
    listening?.window.removeEventListener("popstate", onPopState, { capture: true });
    listening?.window.removeEventListener("ssr:nav-popstate", onHiddenPopState, { capture: true });
    listening?.window.removeEventListener("ssr:island-dispose", onIslandDispose, { capture: true });
    listening?.window.removeEventListener("pagehide", onPageHide);
    listening?.navigation?.removeEventListener("navigate", onNavigate);
    window.addEventListener("popstate", onPopState, { capture: true });
    window.addEventListener("ssr:nav-popstate", onHiddenPopState, { capture: true });
    // Capture opens the disposal window before target listeners can release history holders.
    window.addEventListener("ssr:island-dispose", onIslandDispose, { capture: true });
    window.addEventListener("pagehide", onPageHide);
    const current = typeof navigation !== "undefined" ? navigation : undefined;
    current?.addEventListener("navigate", onNavigate);
    listening = { window, navigation: current };
  };
  // Chromium runs a window's popstate listeners in the order they were added, capture or not. A history is created
  // before islands mount and add their navigation listeners, so it listens from the start.
  if (typeof window !== "undefined") listen();

  /** Returns whether the dialog's own address already was the page's address: a reload or a shared link brought it. */
  const push = (entry: HistoryEntry, url?: string): boolean => {
    listen();
    const previous = historyRecord();
    // A reload or Forward never brings back a dialog or its sensitive transient state.
    const stale = historyIds.length === 0 && previous[HISTORY_MARKER] !== undefined;
    if (stale) delete previous[HISTORY_MARKER];
    entry.historyId = ++nextHistoryId;
    issued.add(entry.historyId);
    historyIds.push(entry.historyId);
    // Only a dialog that names itself in the URL resumes the entry a reload left behind; the page entry stays below.
    const here = url !== undefined && new URL(url, location.href).href === location.href;
    const resume = stale && here;
    if (resume) history.replaceState({ ...previous, [HISTORY_MARKER]: entry.historyId }, "");
    else {
      if (stale) history.replaceState(previous, "");
      const kept = history.state;
      const alone = history.length === 1;
      history.pushState({ ...previous, [HISTORY_MARKER]: entry.historyId }, "", url);
      // A page whose history takes no entries (WebKit for a page set from markup) stays at its one entry. A history of
      // one has nothing ahead that a push could cut, so it took no entry: Back has nothing to close, and no Back is sent
      // at the end or waited for. (A longer history may keep its length while it takes one, over cut Forward entries.)
      if (alone && history.length === 1) {
        history.replaceState(kept, "");
        historyIds.pop();
        issued.delete(entry.historyId);
        entry.historyId = undefined;
        seen = historySnapshot();
        return here;
      }
    }
    if (url !== undefined) ownUrls.set(entry.historyId, location.href);
    seen = historySnapshot();
    return here;
  };

  /** Before a new entry: closed ones leave the history first; returns what to wait for, if a Back is on its way. */
  const ready = (): Promise<void> | undefined => {
    if (historySyncScheduled) syncHistory();
    return returning;
  };

  /** Non-dialog participation in the same history stack. Releasing never calls onBack. */
  const hold = (onBack: () => void): (() => void) => {
    const holder: HistoryHolder = { onBack };
    historyHolders.add(holder);
    const pushWhenReady = () => {
      if (!historyHolders.has(holder)) return;
      // Just like a dialog's open: remove closed entries before adding another one.
      const waiting = ready();
      if (waiting) void waiting.then(pushWhenReady);
      else push(holder);
    };
    pushWhenReady();
    return () => {
      if (!historyHolders.delete(holder)) return;
      release(holder);
    };
  };

  /**
   * Settles once released entries have left history or were forgotten during island disposal. A caller that navigates
   * waits for it, as a dialog's result waits: a Back still on its way would otherwise land behind the new entry.
   */
  const settled = async (): Promise<void> => {
    while (historySyncScheduled || returning) {
      if (!returning) syncHistory();
      if (returning) await returning;
    }
  };

  /** The owner of the dialogs whose entries live here (one per history). */
  const attach = (next: DialogHistoryOwner) => {
    owner = next;
  };

  return { attach, listen, push, release, ready, hold, settled };
};

export type DialogHistory = ReturnType<typeof createDialogHistory>;

/** The history the library's dialogs and its other transient UI share in this copy of the library. */
export const sharedDialogHistory: DialogHistory = createDialogHistory();
