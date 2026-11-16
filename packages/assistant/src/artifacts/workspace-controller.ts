import type { PanesLayout, PanesNode } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { ChatWorkspaceSnapshot, SaveChatWorkspaceInput, SaveChatWorkspaceResult } from "../chat-workspace";
import { isWebAddress } from "../web-address";
import {
  closeWorkspaceTab,
  fileTab,
  openWorkspaceTab,
  type WorkspaceState,
  type WorkspaceTab,
  workspaceSelectionFromHref,
  workspaceSelectionHref,
  workspaceTabFromKey,
  workspaceTabId,
} from "./workspace-state";

/** Where the open tabs of a chat are kept for the person; the server's, so they follow to every device. */
export type ChatTabsStore = {
  load: (chatId: string) => Promise<ChatWorkspaceSnapshot>;
  save: (chatId: string, input: SaveChatWorkspaceInput) => Promise<SaveChatWorkspaceResult>;
};

type TabsState = WorkspaceState & { layout: PanesLayout | null; pinned: readonly string[] };

const SAVE_DELAY = 500;
/** The tab storage keeps at most this many tabs per chat (`ChatWorkspaceStateSchema`). */
const CHAT_TABS_KEPT = 24;
/** Longer web addresses do not fit a stored tab; they open in the person's own browser. */
const WEB_TAB_URL_MAX = 500;

/*
 * The few layout steps the controller needs, on the Panes layout data. Panes' own helpers stay with the tabs, which load
 * when the first one opens, so the chat's first frame does not carry them.
 */
const keepItems = (node: PanesNode, keep: ReadonlySet<string>): PanesNode | null => {
  if (node.type === "group") {
    const items = node.items.filter((item) => keep.has(item));
    if (!items.length) return null;
    return { ...node, items, active: items.includes(node.active) ? node.active : items[0]! };
  }
  const first = keepItems(node.first, keep);
  const second = keepItems(node.second, keep);
  return first && second ? { ...node, first, second } : (first ?? second);
};
const itemsOf = (node: PanesNode | null, into: string[] = []): string[] => {
  if (!node) return into;
  if (node.type === "group") into.push(...node.items);
  else {
    itemsOf(node.first, into);
    itemsOf(node.second, into);
  }
  return into;
};
/** Adds items to the first pane, in front of nothing: the person's arrangement of the others stays. */
const addToFirst = (node: PanesNode, items: readonly string[]): PanesNode =>
  node.type === "group" ? { ...node, items: [...node.items, ...items] } : { ...node, first: addToFirst(node.first, items) };
const activatePanesItem = (layout: PanesLayout, itemId: string): PanesLayout => {
  const visit = (node: PanesNode): PanesNode =>
    node.type === "group"
      ? node.items.includes(itemId)
        ? { ...node, active: itemId }
        : node
      : { ...node, first: visit(node.first), second: visit(node.second) };
  return layout.root ? { ...layout, root: visit(layout.root) } : layout;
};

/** The arrangement for these tabs: the given one where it still fits, every other tab added to its first group. */
const fitLayout = (layout: PanesLayout | null, tabs: readonly WorkspaceTab[]): PanesLayout | null => {
  const ids = tabs.map((tab) => workspaceTabId(tab.key));
  if (!ids.length) return null;
  const root = layout?.root ? keepItems(layout.root, new Set(ids)) : null;
  const missing = ids.filter((id) => !itemsOf(root).includes(id));
  if (!root) return { version: 2, root: { type: "group", items: ids, active: ids[0]! } };
  return { version: 2, root: missing.length ? addToFirst(root, missing) : root };
};

/** The stored tabs of a chat as the workspace shows them; tabs this version cannot open again are left out. */
const tabsFromSnapshot = (snapshot: ChatWorkspaceSnapshot): TabsState => {
  const tabs = snapshot.state.tabs.flatMap((stored) => {
    const tab = workspaceTabFromKey(stored.key, stored.title);
    return tab ? [tab] : [];
  });
  const front = snapshot.state.tabs.find((stored) => stored.id === snapshot.state.front)?.key ?? null;
  const layout = fitLayout(snapshot.state.layout, tabs);
  const active = tabs.some((tab) => tab.key === front) ? front : (tabs[0]?.key ?? null);
  return {
    tabs,
    active,
    layout: layout && active ? activatePanesItem(layout, workspaceTabId(active)) : layout,
    pinned: snapshot.state.tabs.filter((stored) => stored.pinned).map((stored) => stored.key),
  };
};

/** What the server keeps: tabs that can open again, their arrangement, the front tab, and what is pinned. */
const snapshotOf = (state: TabsState): ChatWorkspaceSnapshot["state"] => {
  // The newest tabs the contract keeps, the front tab always among them.
  const kept = state.tabs.filter((tab) => tab.kind !== "view");
  const tabs =
    kept.length <= CHAT_TABS_KEPT
      ? kept
      : [...kept.filter((tab) => tab.key !== state.active).slice(-(CHAT_TABS_KEPT - 1)), ...kept.filter((tab) => tab.key === state.active)];
  const layout = fitLayout(state.layout, tabs);
  return {
    tabs: tabs.map((tab) => ({
      id: workspaceTabId(tab.key),
      key: tab.key,
      title: tab.title.slice(0, 200),
      ...(state.pinned.includes(tab.key) ? { pinned: true } : {}),
    })),
    layout,
    front: tabs.some((tab) => tab.key === state.active) && state.active ? workspaceTabId(state.active) : null,
  };
};

/**
 * The tabs beside the chat. Which tabs are open, how they are arranged, and which is in front belong to the chat and
 * the person: they are kept on the server for each chat (`store`) and follow to every device. The URL names the front
 * tab and wins when the page loads.
 */
export function createArtifactWorkspace(
  initialHref?: string,
  options: {
    initial?: { chatId: string; snapshot: ChatWorkspaceSnapshot } | null;
    store?: ChatTabsStore;
    /** Saving failed; the tabs stay here and the next change tries again. */
    onSaveError?: () => void;
  } = {},
) {
  const empty = (): TabsState => ({ tabs: [], active: null, layout: null, pinned: [] });
  const initialTab = initialHref ? workspaceSelectionFromHref(initialHref) : null;
  const cache = new Map<string, { state: TabsState; revision: number }>();
  if (options.initial)
    cache.set(options.initial.chatId, { state: tabsFromSnapshot(options.initial.snapshot), revision: options.initial.snapshot.revision });
  const start = (): TabsState => {
    const stored = options.initial ? cache.get(options.initial.chatId)!.state : empty();
    if (!initialTab) return stored;
    const opened = openWorkspaceTab(stored, initialTab);
    const layout = fitLayout(stored.layout, opened.tabs);
    return { ...stored, ...opened, layout: layout && activatePanesItem(layout, workspaceTabId(initialTab.key)) };
  };
  const [state, setState] = createSignal<TabsState>(start());
  const [mobile, setMobile] = createSignal(state().tabs.length && initialTab ? "workspace" : "chat");
  const dirty = new Set<string>();
  let chatId: string | null = options.initial?.chatId ?? null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();
  const syncUrl = () =>
    window.history.replaceState(
      window.history.state,
      "",
      workspaceSelectionHref(window.location.href, state().tabs.find((tab) => tab.key === state().active) ?? null),
    );
  /** Sends the chat's tabs after a short pause; a newer state of another device wins over an older one here. */
  const flush = (chat: string) => {
    clearTimeout(timer);
    timer = undefined;
    const store = options.store;
    if (!store) return;
    const sent = state();
    saving = saving.then(async () => {
      // The revision the server acknowledged last, read when this save goes out, after any save before it.
      const revision = cache.get(chat)?.revision ?? 0;
      try {
        const result = await store.save(chat, { state: snapshotOf(sent), revision });
        if (!result.conflict) {
          cache.set(chat, { state: cache.get(chat)?.state ?? sent, revision: result.revision });
          return;
        }
        const theirs = tabsFromSnapshot(result);
        const newer = chatId === chat && state() !== sent;
        cache.set(chat, { state: newer ? state() : theirs, revision: result.revision });
        if (chatId === chat && !newer) setState(theirs);
        // Changes made meanwhile go out again on the server's revision.
        if (newer) changed();
      } catch {
        options.onSaveError?.();
      }
    });
  };
  const changed = () => {
    const chat = chatId;
    if (!chat) return;
    cache.set(chat, { state: state(), revision: cache.get(chat)?.revision ?? 0 });
    clearTimeout(timer);
    timer = setTimeout(() => flush(chat), SAVE_DELAY);
  };
  const update = (next: (current: TabsState) => TabsState) => {
    setState(next);
    syncUrl();
    changed();
  };
  const openInBrowser = (address: string) => {
    if (!isWebAddress(address)) return;
    const url = new URL(address);
    if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener,noreferrer");
  };
  const open = (tab: WorkspaceTab | null) => {
    if (!tab || (tab.kind === "web" && !isWebAddress(tab.url))) return;
    if (tab.kind === "web" && tab.url.length > WEB_TAB_URL_MAX) {
      openInBrowser(tab.url);
      return;
    }
    update((current) => {
      const opened = openWorkspaceTab(current, tab);
      const id = workspaceTabId(tab.key);
      // A new tab joins the first pane, in front; the arrangement of the others stays.
      const layout = fitLayout(current.layout, opened.tabs);
      return { ...current, ...opened, layout: layout && activatePanesItem(layout, id) };
    });
    setMobile("workspace");
  };
  const close = (key: string) => {
    dirty.delete(key);
    update((current) => {
      const closed = closeWorkspaceTab(current, key);
      const layout = fitLayout(current.layout, closed.tabs);
      return {
        ...current,
        ...closed,
        layout: layout && closed.active ? activatePanesItem(layout, workspaceTabId(closed.active)) : layout,
        pinned: current.pinned.filter((pinned) => pinned !== key),
      };
    });
    if (!state().tabs.length) setMobile("chat");
  };
  const belongs = (tab: WorkspaceTab) => !("conversationId" in tab) || chatId === null || tab.conversationId === chatId;
  const select = (key: string) => {
    if (state().active === key) return;
    update((current) => ({
      ...current,
      active: key,
      layout: current.layout && activatePanesItem(current.layout, workspaceTabId(key)),
    }));
  };
  return {
    state,
    mobile,
    setMobile,
    open,
    openInBrowser,
    rename: (key: string, title: string) =>
      update((current) => ({ ...current, tabs: current.tabs.map((tab) => (tab.key === key ? { ...tab, title } : tab)) })),
    /** Opens the tab the URL names, when it belongs to the chat shown; another chat's tab waits for that chat. */
    restore: () => {
      const tab = workspaceSelectionFromHref(window.location.href);
      if (tab && belongs(tab)) open(tab);
    },
    select,
    /** Panes reports a choice by its item id, also in its narrow row. */
    activateItem: (itemId: string) => {
      const tab = state().tabs.find((candidate) => workspaceTabId(candidate.key) === itemId);
      if (tab) select(tab.key);
    },
    setLayout: (layout: PanesLayout) => update((current) => ({ ...current, layout })),
    isPinned: (key: string) => state().pinned.includes(key),
    togglePin: (key: string) =>
      update((current) => ({
        ...current,
        pinned: current.pinned.includes(key) ? current.pinned.filter((pinned) => pinned !== key) : [...current.pinned, key],
      })),
    isDirty: (key: string) => dirty.has(key),
    setDirty: (key: string, value: boolean) => {
      value ? dirty.add(key) : dirty.delete(key);
    },
    close,
    /** Closes the tab of a deleted chat file, discarding its unsaved edits. */
    closeFile: (conversationId: string, path: string) => {
      const key = fileTab(conversationId, path).key;
      if (state().tabs.some((tab) => tab.key === key)) close(key);
    },
    hasDirty: () => dirty.size > 0,
    /**
     * Shows the tabs of another chat: what this device last had for it at once, then the server's, unless the person
     * changed something meanwhile. Unsaved changes of the chat left are sent first.
     */
    bindChat: (next: string | null) => {
      if (next === chatId) return;
      if (chatId && timer) flush(chatId);
      chatId = next;
      dirty.clear();
      const known = next ? cache.get(next) : undefined;
      setState(known?.state ?? empty());
      // The URL may name a tab of this chat, as after Back; it wins.
      const named = workspaceSelectionFromHref(window.location.href);
      if (named && belongs(named)) open(named);
      else syncUrl();
      if (!state().tabs.length) setMobile("chat");
      const store = options.store;
      if (!next || !store) return;
      const shown = state();
      void store
        .load(next)
        .then((snapshot) => {
          const theirs = tabsFromSnapshot(snapshot);
          if (chatId !== next) return cache.set(next, { state: theirs, revision: snapshot.revision });
          cache.set(next, { state: state() === shown ? theirs : state(), revision: snapshot.revision });
          if (state() === shown) {
            setState(theirs);
            if (named && belongs(named)) open(named);
            else syncUrl();
          } else changed();
        })
        .catch(() => undefined);
    },
    /** Waits until the last change reached the server; for tests and leaving the page. */
    saved: () => {
      if (chatId && timer) flush(chatId);
      return saving;
    },
  };
}
export type ArtifactWorkspaceController = ReturnType<typeof createArtifactWorkspace>;
