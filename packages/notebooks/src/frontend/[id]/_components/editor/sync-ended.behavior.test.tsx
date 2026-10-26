import { describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { createCodeMirror } from "solid-codemirror";
import { Show } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { YjsProviderOptions } from "../../../lib/yjs";
import type { YjsProviderError } from "../../../lib/yjs/provider";
import { notebookWorkspaceMessages } from "../../messages";
import {
  ACTIVE_HEADING_EVENT,
  JUMP_TO_PARTICIPANT_EVENT,
  PRESENCE_LOCATIONS_EVENT,
  type PresenceLocationsEventDetail,
  RECONNECT_EVENT,
  SIDEBAR_FILTER_CHANGED_EVENT,
  SYNC_STATE_EVENT,
  SYNC_STATE_REQUEST_EVENT,
  type SyncStateEventDetail,
} from "../detail/events";

const refreshCurrentPath = mock(() => {});
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const nav = await import("@k2b/ssr/nav");
    mock.module("@k2b/ssr/nav", () => ({ ...nav, refreshCurrentPath }));
    const sync = await import("./sync-ended");
    const { formattingKeymap } = await import("./EditorToolbar");
    const { markdownExtension } = await import("../../../lib/editor/markdown");
    mock.module("@/api/client", () => ({ apiClient: { ":id": { "route-state": { $get: routeGet } } } }));
    const { default: NoteEditor } = await import("./NoteEditor.client");
    const { yjs } = await import("../../../lib/yjs");
    const softNavigation = await import("../../../lib/soft-navigation");
    const ui = await import("@k2b/ui");
    const { clipboard } = await import("@k2b/stdlib/browser");
    return { ...sync, ...ui, ...softNavigation, NoteEditor, yjs, clipboard, formattingKeymap, markdownExtension };
  } finally {
    dom.cleanup();
  }
};
const detail = (id: string) => ({
  noteAuthors: { createdBy: null, lastEditedBy: null },
  noteId: id,
  noteTitle: id,
  contentMd: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lockedAt: null,
  historyIncomplete: false,
  isLocked: false,
  tocItems: [],
  taskProgress: { total: 0, done: 0 },
  attachments: [],
  backlinks: [],
  namedBlocks: [],
});
/** The saved text the route state answers for each note; tests set it to model a save by someone else. */
const savedTexts = new Map<string, string>();
const routeGet = mock(async ({ query: { href } }: { query: { href: string } }) => {
  const id = new URL(href, "http://localhost").pathname.split("/").at(-1)!;
  return Response.json({
    kind: "ok",
    state: {
      href,
      note: { id, title: id, lockedAt: null, historyIncomplete: false, contentMd: savedTexts.get(id) ?? null },
      detail: detail(id),
    },
  });
});
const loaded = isServer ? undefined : await load();
const markdown = "# Keep me\n\nUnsaved **words**.";
const notePath = "/app/notebooks/Book01/Note01?mode=write";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Lets timers run until the condition holds or the deadline passes. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const waitFor = async (condition: () => boolean, timeoutMs: number) => {
  for (const deadline = performance.now() + timeoutMs; !condition() && performance.now() < deadline; ) await nextTask();
};

const mount = ({ pending: initialPending = true, locale = "en" } = {}) => {
  let pending = initialPending;
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { createSyncEnded, SyncEndedBar, LocaleProvider, clipboard, prompts, toast, formattingKeymap, markdownExtension } = loaded!;
  const resume = mock(() => {});
  const opened = spyOn(window, "open").mockReturnValue(null);
  const copied = spyOn(clipboard, "copy").mockResolvedValue(undefined);
  const confirmed = spyOn(prompts, "confirm").mockResolvedValue(false);
  const success = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const failure = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  refreshCurrentPath.mockClear();
  let sync!: ReturnType<typeof createSyncEnded>;
  let mirror!: ReturnType<typeof createCodeMirror>;
  const dispose = render(() => {
    sync = createSyncEnded({
      messages: () => notebookWorkspaceMessages.resolve([locale]).t,
      hasUnsentChanges: () => pending,
      resume,
      focusEditor: () => mirror.editorView()?.focus(),
    });
    mirror = createCodeMirror({ value: markdown });
    mirror.createExtension(markdownExtension());
    mirror.createExtension(sync.extension);
    mirror.createExtension(() => (sync.ended() ? [] : formattingKeymap({ notebookId: "Book01" })));
    return (
      <LocaleProvider locale={locale}>
        <div ref={mirror.ref} />
        <Show when={sync.ended()}>
          {(ended) => (
            <SyncEndedBar
              notebookId="Book01"
              sync={sync}
              ended={ended()}
              markdown={() => mirror.editorView()!.state.doc.toString()}
              noteHref={() => notePath}
            />
          )}
        </Show>
      </LocaleProvider>
    );
  }, dom.root);
  const button = (label: string) => {
    const found = Array.from(dom.root.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  return {
    dom,
    sync,
    mirror,
    resume,
    opened,
    copied,
    confirmed,
    success,
    failure,
    button,
    bar: () => dom.root.querySelector<HTMLElement>("[data-sync-ended]")!,
    end: (code: YjsProviderError["code"]) => sync.end({ code, message: "server reason" }),
    setPending: (value: boolean) => {
      pending = value;
      sync.refresh();
    },
    [Symbol.dispose]: () => {
      const resumed = resume.mock.calls.length;
      dispose();
      window.dispatchEvent(new Event("focus"));
      expect(resume).toHaveBeenCalledTimes(resumed);
      for (const spy of [opened, copied, confirmed, success, failure]) spy.mockRestore();
      dom.cleanup();
    },
  };
};

const editorHref = "/app/notebooks/Book01/notes/Note01?mode=write#heading-keep-me";
const otherHref = "/app/notebooks/Book01/notes/Other1?mode=write";
const beforeUnloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const mountNoteEditor = ({ pending: initialPending = true, readOnly = false } = {}) => {
  let pending = initialPending;
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const previousBindings = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["sessionStorage", "HTMLAnchorElement", "PopStateEvent", "Window"] as const) {
    previousBindings.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  window.history.replaceState({ shown: true }, "", editorHref);
  const { NoteEditor, LocaleProvider, yjs, prompts } = loaded!;
  const providers: Array<{
    opts: YjsProviderOptions;
    dispose: ReturnType<typeof mock>;
    reconnectNow: ReturnType<typeof mock>;
    connect: ReturnType<typeof mock>;
  }> = [];
  const provider = spyOn(yjs, "createYjsProvider").mockImplementation((opts) => {
    const dispose = mock(() => {});
    const reconnectNow = mock(() => {});
    const connect = mock(() => {});
    providers.push({ opts, dispose, reconnectNow, connect });
    return { reconnectNow, connect, resume: () => {}, dispose, hasUnsentChanges: () => pending };
  });
  const confirmed = spyOn(prompts, "confirm").mockResolvedValue(false);
  routeGet.mockClear();
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <NoteEditor
          noteId="Note01"
          noteTitle="Keep me"
          notebookId="Book01"
          noteLockedAt={null}
          historyIncomplete={false}
          notebookName="Book"
          appUrl="http://localhost"
          userId="User01"
          displayName="Reader"
          initialContent={markdown}
          initialPanelOpen={false}
          initialRichMode="source"
          initialHref={editorHref.split("#")[0]!}
          initialDetail={detail("Note01")}
          readOnly={readOnly}
          canWrite={!readOnly}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const view = () => EditorView.findFromDOM(dom.root.querySelector<HTMLElement>(".cm-editor")!)!;
  return {
    dom,
    providers,
    confirmed,
    view,
    setPending: (value: boolean) => {
      pending = value;
      providers.at(-1)?.opts.onUnsentChange?.();
    },
    end: () => providers.at(-1)!.opts.onFatal?.({ code: "NOTE_LOCKED", message: "locked" }),
    [Symbol.dispose]: () => {
      dispose();
      for (const [name, previous] of previousBindings) {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      }
      provider.mockRestore();
      confirmed.mockRestore();
      dom.cleanup();
    },
  };
};

const reasons = [
  ["SESSION_EXPIRED", "Session expired"],
  ["LOGIN_REQUIRED", "Session expired"],
  ["NOTE_NOT_FOUND", "Note not found"],
  ["ACCESS_REVOKED", "Access changed"],
  ["ACCESS_DENIED", "Access changed"],
  ["NOTE_LOCKED", "Note locked"],
  ["STORAGE_EXHAUSTED", "Storage is full"],
  ["BACKPRESSURE", "Connection closed"],
] as const;

describe("sync ended editor recovery", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("reading a note connects nothing; the first keystroke connects and stays on screen as it was typed", async () => {
    using editor = mountNoteEditor({ pending: false });
    const instance = editor.providers[0]!;
    expect(instance.connect).not.toHaveBeenCalled();
    expect(editor.view().state.doc.toString()).toBe(markdown);
    const end = editor.view().state.doc.length;
    editor.view().dispatch({ changes: { from: end, insert: " More" }, userEvent: "input.type" });
    editor.view().dispatch({ changes: { from: end + 5, insert: "!" }, userEvent: "input.type" });
    expect(instance.connect).toHaveBeenCalledTimes(1);
    expect(editor.view().state.doc.toString()).toBe(`${markdown} More!`);
    // Until the live note arrives, the typed words are unsent: leaving asks first.
    expect(beforeUnloadPrevented()).toBe(true);

    const ytext = instance.opts.doc.getText("codemirror");
    // The replay arrives as remote updates, as the provider applies them.
    instance.opts.doc.transact(() => ytext.insert(0, markdown), "remote");
    instance.opts.onReady?.();
    expect(ytext.toString()).toBe(`${markdown} More!`);
    // From now on every keystroke goes to Yjs.
    editor.view().dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" });
    expect(ytext.toString()).toBe(`> ${markdown} More!`);
    expect(instance.connect).toHaveBeenCalledTimes(1);
  });

  test("opening another note right after the first keystroke waits until the server confirmed the words", async () => {
    using editor = mountNoteEditor({ pending: true });
    const instance = editor.providers[0]!;
    editor.view().dispatch({ changes: { from: editor.view().state.doc.length, insert: " Last words." }, userEvent: "input.type" });
    routeGet.mockClear();
    const navigation = loaded!.requestSoftNoteNavigation(otherHref);
    await flush();
    // The other note does not load while the words exist only on screen.
    expect(routeGet).not.toHaveBeenCalled();
    expect(instance.dispose).not.toHaveBeenCalled();
    const ytext = instance.opts.doc.getText("codemirror");
    instance.opts.doc.transact(() => ytext.insert(0, markdown), "remote");
    instance.opts.onReady?.();
    expect(ytext.toString()).toBe(`${markdown} Last words.`);
    // In Yjs, but not yet confirmed: the other note still waits.
    await flush();
    expect(routeGet).not.toHaveBeenCalled();
    editor.setPending(false);
    await navigation;
    expect(routeGet).toHaveBeenCalledTimes(1);
    expect(editor.confirmed).not.toHaveBeenCalled();
  });

  test("edits another person made since the note was saved stay, and the first edits land where they were typed", async () => {
    using editor = mountNoteEditor({ pending: false });
    const instance = editor.providers[0]!;
    editor.view().dispatch({ changes: { from: editor.view().state.doc.length, insert: " Mine." }, userEvent: "input.type" });
    const ytext = instance.opts.doc.getText("codemirror");
    instance.opts.doc.transact(() => ytext.insert(0, `Intro from Ada\n\n${markdown}`), "remote");
    instance.opts.onReady?.();
    expect(editor.view().state.doc.toString()).toBe(`Intro from Ada\n\n${markdown} Mine.`);
    expect(ytext.toString()).toBe(editor.view().state.doc.toString());
    // A remote edit after the catch-up reaches the editor through Yjs.
    instance.opts.doc.transact(() => ytext.insert(0, "# "), "remote");
    expect(editor.view().state.doc.toString().startsWith("# Intro from Ada")).toBe(true);
  });

  test("before the first edit, a save by someone else replaces the shown text without connecting", async () => {
    using editor = mountNoteEditor({ pending: false });
    const instance = editor.providers[0]!;
    const updated = () =>
      window.dispatchEvent(
        new CustomEvent("notebooks.workspace.event", {
          detail: { cursor: null, event: { v: 1, type: "note.updated", notebookId: "Book01", note: { id: "Note01" } }, cover: () => {} },
        }),
      );
    savedTexts.set("Note01", `${markdown}\n\nAdded by Ada.`);
    try {
      updated();
      for (let tick = 0; tick < 10; tick++) await flush();
      expect(editor.view().state.doc.toString()).toBe(`${markdown}\n\nAdded by Ada.`);
      expect(instance.connect).not.toHaveBeenCalled();
      // Once the person types, the live note decides; a later save no longer replaces the text.
      editor.view().dispatch({ changes: { from: 0, insert: "Mine " }, userEvent: "input.type" });
      savedTexts.set("Note01", "Something else");
      updated();
      for (let tick = 0; tick < 10; tick++) await flush();
      expect(editor.view().state.doc.toString()).toBe(`Mine ${markdown}\n\nAdded by Ada.`);
      const ytext = instance.opts.doc.getText("codemirror");
      instance.opts.doc.transact(() => ytext.insert(0, `${markdown}\n\nAdded by Ada.`), "remote");
      instance.opts.onReady?.();
      expect(ytext.toString()).toBe(`Mine ${markdown}\n\nAdded by Ada.`);
    } finally {
      savedTexts.clear();
    }
  });

  test("Undo keys before the live note arrived do nothing and break nothing", async () => {
    using editor = mountNoteEditor({ pending: false });
    editor.view().dispatch({ changes: { from: 0, insert: "Draft " }, userEvent: "input.type" });
    // CodeMirror reports a failing key command to the console instead of throwing.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const key = new KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ...modifier, bubbles: true, cancelable: true });
        editor.view().contentDOM.dispatchEvent(key);
      }
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(editor.view().state.doc.toString()).toBe(`Draft ${markdown}`);
  });

  test("a note locked by someone else before the first edit opens again as the server shows it", async () => {
    using editor = mountNoteEditor({ pending: false });
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    routeGet.mockImplementationOnce(async () => Response.json({ kind: "fallback", reason: "readonly" }));
    try {
      window.dispatchEvent(
        new CustomEvent("notebooks.workspace.event", {
          detail: { cursor: null, event: { v: 1, type: "note.updated", notebookId: "Book01", note: { id: "Note01" } }, cover: () => {} },
        }),
      );
      for (let tick = 0; tick < 10; tick++) await flush();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(editor.providers[0]!.connect).not.toHaveBeenCalled();
    } finally {
      reload.mockRestore();
    }
  });

  test("before the first edit, a deleted note reopens, a lost history shows, and a failed read tries again", async () => {
    using editor = mountNoteEditor({ pending: false });
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const event = (body: Record<string, unknown>) =>
      window.dispatchEvent(
        new CustomEvent("notebooks.workspace.event", {
          detail: { cursor: null, event: { v: 1, notebookId: "Book01", ...body }, cover: () => {} },
        }),
      );
    try {
      event({ type: "note.updated", note: { id: "Note01", historyIncomplete: true } });
      for (let tick = 0; tick < 10; tick++) await flush();
      expect(editor.dom.root.textContent).toContain(notebookWorkspaceMessages.resolve(["en"]).t.historyIncompleteTitle);

      // One failed read is retried by the note itself.
      routeGet.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
      savedTexts.set("Note01", `${markdown}\n\nSaved by Ada.`);
      event({ type: "note.updated", note: { id: "Note01" } });
      // The retry waits about a second; poll for its result within a bounded deadline.
      const retried = `${markdown}\n\nSaved by Ada.`;
      await waitFor(() => editor.view().state.doc.toString() === retried, 5000);
      expect(editor.view().state.doc.toString()).toBe(retried);

      event({ type: "note.deleted", noteId: "Note01" });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(editor.providers[0]!.connect).not.toHaveBeenCalled();
    } finally {
      savedTexts.clear();
      reload.mockRestore();
    }
  });

  test("Undo takes back the edits made before the live note arrived as one step", async () => {
    using editor = mountNoteEditor({ pending: false });
    const instance = editor.providers[0]!;
    for (const word of [" one", " two"])
      editor.view().dispatch({ changes: { from: editor.view().state.doc.length, insert: word }, userEvent: "input.type" });
    const ytext = instance.opts.doc.getText("codemirror");
    // The replay arrives as remote updates, as the provider applies them.
    instance.opts.doc.transact(() => ytext.insert(0, markdown), "remote");
    instance.opts.onReady?.();
    expect(ytext.toString()).toBe(`${markdown} one two`);
    const undo = Array.from(editor.dom.root.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Undo");
    undo!.click();
    expect(ytext.toString()).toBe(markdown);
    expect(editor.view().state.doc.toString()).toBe(markdown);
  });

  test("a note that is only read reports itself saved and connected, so no offline notice appears", async () => {
    using editor = mountNoteEditor({ pending: false });
    expect(editor.providers[0]!.connect).not.toHaveBeenCalled();
    const states: SyncStateEventDetail[] = [];
    const listener = (event: Event) => states.push((event as CustomEvent<SyncStateEventDetail>).detail);
    window.addEventListener(SYNC_STATE_EVENT, listener);
    try {
      window.dispatchEvent(new Event(SYNC_STATE_REQUEST_EVENT));
      expect(states.at(-1)).toMatchObject({ connected: true, ended: false });
      expect(beforeUnloadPrevented()).toBe(false);
    } finally {
      window.removeEventListener(SYNC_STATE_EVENT, listener);
    }
  });

  test("a late panel receives sync and presence, requests reconnect and jumps without moving selection", async () => {
    using editor = mountNoteEditor({ pending: false });
    const instance = editor.providers[0]!;
    setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
    const { opts } = instance;
    expect(opts.awareness.getLocalState()?.user.userId).toBe("User01");
    const syncStates: SyncStateEventDetail[] = [];
    const locations: PresenceLocationsEventDetail[] = [];
    const active: Array<string | null> = [];
    const onSync = (event: Event) => syncStates.push((event as CustomEvent<SyncStateEventDetail>).detail);
    const onLocations = (event: Event) => locations.push((event as CustomEvent<PresenceLocationsEventDetail>).detail);
    const onActive = (event: Event) => active.push((event as CustomEvent<{ id: string | null }>).detail.id);
    window.addEventListener(SYNC_STATE_EVENT, onSync);
    window.addEventListener(PRESENCE_LOCATIONS_EVENT, onLocations);
    window.addEventListener(ACTIVE_HEADING_EVENT, onActive);
    try {
      opts.onConnectionChange?.(true);
      opts.onReady?.();
      const saved = syncStates.at(-1);
      expect(saved?.connected).toBe(true);
      expect(saved?.lastSavedAt).toEqual(expect.any(String));
      const text = opts.doc.getText("codemirror");
      const remoteId = opts.doc.clientID + 1;
      opts.awareness.getStates().set(remoteId, {
        user: { userId: "jana" },
        cursor: { head: Y.createRelativePositionFromTypeIndex(text, text.length) },
      });
      window.dispatchEvent(new Event(SYNC_STATE_REQUEST_EVENT));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(syncStates.at(-1)).toEqual(saved);
      expect(locations.at(-1)?.jana).toEqual({ writing: true, headingId: "keep-me", headingText: "Keep me" });
      expect(active).toHaveLength(1);
      const view = editor.view();
      const before = view.state.selection;
      const scroll = spyOn(EditorView, "scrollIntoView");
      try {
        window.dispatchEvent(new CustomEvent(JUMP_TO_PARTICIPANT_EVENT, { detail: { userId: "jana" } }));
        expect(scroll).toHaveBeenCalledWith(text.length, { y: "center" });
        expect(view.state.selection.eq(before)).toBe(true);
        window.dispatchEvent(new CustomEvent(JUMP_TO_PARTICIPANT_EVENT, { detail: { userId: "missing" } }));
        expect(scroll).toHaveBeenCalledTimes(1);
      } finally {
        scroll.mockRestore();
      }
      window.dispatchEvent(new Event(RECONNECT_EVENT));
      expect(instance.reconnectNow).toHaveBeenCalledTimes(1);
      opts.awareness.getStates().set(remoteId, { user: { userId: "jana" }, cursor: null });
      opts.awareness.emit("change", [{ added: [], updated: [remoteId], removed: [] }, "test"]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(locations.at(-1)?.jana?.writing).toBe(false);
    } finally {
      setSystemTime();
      window.removeEventListener(SYNC_STATE_EVENT, onSync);
      window.removeEventListener(PRESENCE_LOCATIONS_EVENT, onLocations);
      window.removeEventListener(ACTIVE_HEADING_EVENT, onActive);
    }
  });

  test("the storage notice survives retries until pending changes are saved", () => {
    using editor = mountNoteEditor();
    const { opts } = editor.providers[0]!;
    opts.onError?.({ code: "STORAGE_EXHAUSTED", message: "storage full" });
    const notice = editor.dom.root.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain("Live editing is unavailable");
    opts.onReady?.();
    expect(notice?.isConnected).toBe(true);
    editor.setPending(false);
    expect(notice?.isConnected).toBe(false);
  });

  test("soft requests ask before replacing the editor, cancel keeps text, confirm leaves once", async () => {
    using editor = mountNoteEditor();
    const instance = editor.providers[0]!;
    const view = editor.view();
    editor.end();
    let answer!: (leave: boolean) => void;
    editor.confirmed.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const cancelled = loaded!.requestSoftNoteNavigation(otherHref);
    const alsoCancelled = loaded!.requestSoftNoteNavigation(otherHref);
    await flush();
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(routeGet).not.toHaveBeenCalled();
    expect(instance.dispose).not.toHaveBeenCalled();
    answer(false);
    expect(await cancelled).toEqual({ kind: "superseded" });
    expect(await alsoCancelled).toEqual({ kind: "superseded" });
    expect(editor.view()).toBe(view);
    expect(view.state.doc.toString()).toBe(markdown);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(editorHref);

    editor.confirmed.mockResolvedValue(true);
    await loaded!.navigateToNotebookNote(otherHref);
    expect(editor.confirmed).toHaveBeenCalledTimes(2);
    expect(routeGet).toHaveBeenCalledTimes(1);
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search).toBe(otherHref);
    expect(editor.providers).toHaveLength(2);
    // The old guard is removed along with its editor instance.
    await loaded!.navigateToNotebookNote("/app/notebooks/Book01/notes/Third1?mode=write");
    expect(editor.confirmed).toHaveBeenCalledTimes(2);
  });

  test.each(["mount", "navigation"])("cancelled popstate restores the shown note URL after %s", async (source) => {
    using editor = mountNoteEditor({ pending: source === "mount" });
    const shownHref = source === "mount" ? editorHref : `${otherHref}#heading-other`;
    if (source === "navigation") {
      await loaded!.requestSoftNoteNavigation(shownHref);
      editor.setPending(true);
      routeGet.mockClear();
    }
    const instance = editor.providers.at(-1)!;
    const view = editor.view();
    const text = view.state.doc.toString();
    editor.end();
    const observedHrefs: string[] = [];
    const followUrl = () => observedHrefs.push(window.location.pathname + window.location.search + window.location.hash);
    window.addEventListener("popstate", followUrl);
    try {
      window.history.replaceState({ back: true }, "", "/app/notebooks/Book01/notes/Third1?mode=write&view=favorites");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      await flush();
      expect(observedHrefs).toEqual(["/app/notebooks/Book01/notes/Third1?mode=write&view=favorites", shownHref]);
    } finally {
      window.removeEventListener("popstate", followUrl);
    }
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(routeGet).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(shownHref);
    expect(window.history.state).toEqual({ back: true });
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(editor.view()).toBe(view);
    expect(view.state.doc.toString()).toBe(text);
  });

  test("two cancelled popstates sharing a prompt restore the shown URL only once", async () => {
    using editor = mountNoteEditor();
    editor.end();
    const answer = Promise.withResolvers<boolean>();
    editor.confirmed.mockImplementation(() => answer.promise);
    const length = window.history.length;
    const shownHref = window.location.href;
    window.history.replaceState({ back: true }, "", otherHref);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    answer.resolve(false);
    await flush();
    await flush();
    expect(window.history.length).toBe(length + 1);
    expect(window.location.href).toBe(shownHref);
    expect(beforeUnloadPrevented()).toBe(true);
  });

  test("a cancelled popstate keeps a sidebar filter chosen after the note opened", async () => {
    using editor = mountNoteEditor();
    editor.end();
    const filtered = "/app/notebooks/Book01/notes/Note01?mode=write&view=recents#heading-keep-me";
    window.history.replaceState(window.history.state, "", filtered);
    window.dispatchEvent(new Event(SIDEBAR_FILTER_CHANGED_EVENT));
    window.history.replaceState({ back: true }, "", "/app/notebooks/Book01/notes/Third1?mode=write");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    await flush();
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(filtered);
  });

  test("a cancelled request that manages its own history leaves the address and history alone", async () => {
    using editor = mountNoteEditor();
    editor.end();
    const length = window.history.length;
    const state = window.history.state;
    const observed = mock(() => {});
    window.addEventListener("popstate", observed);
    try {
      // The sidebar asks with push: false and changes the history itself only when the note opened.
      expect(await loaded!.requestSoftNoteNavigation(otherHref, { push: false })).toEqual({ kind: "superseded" });
    } finally {
      window.removeEventListener("popstate", observed);
    }
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(length);
    expect(window.history.state).toBe(state);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(editorHref);
    expect(observed).not.toHaveBeenCalled();
  });

  test("a confirmed search navigation that fails keeps warning before unload", async () => {
    using editor = mountNoteEditor();
    const view = editor.view();
    editor.end();
    editor.confirmed.mockResolvedValue(true);
    routeGet.mockImplementationOnce(async () => new Response(null, { status: 500 }));
    const detail: { target: { href: string }; handled?: Promise<boolean> } = { target: { href: otherHref } };
    window.dispatchEvent(new CustomEvent("cloud.search.navigate", { detail }));
    await expect(detail.handled).rejects.toThrow("Note navigation failed");
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(editor.view()).toBe(view);
    expect(beforeUnloadPrevented()).toBe(true);
  });

  test("a heading of the shown note opens in place without asking", async () => {
    using editor = mountNoteEditor();
    const view = editor.view();
    editor.end();
    const heading = "/app/notebooks/Book01/notes/Note01?mode=write#heading-other";
    expect(await loaded!.requestSoftNoteNavigation(heading)).toEqual({ kind: "applied", href: heading });
    expect(editor.confirmed).not.toHaveBeenCalled();
    expect(editor.providers[0]!.dispose).not.toHaveBeenCalled();
    expect(editor.view()).toBe(view);
  });

  test.each(["/app/notebooks/Book01/notes/Note01", "/app/notebooks/Book01/notes/Note01?mode=write#heading-other"])(
    "an anchor to the shown note keeps unsent text without asking: %s",
    async (href) => {
      using editor = mountNoteEditor();
      const view = editor.view();
      editor.end();
      const link = document.createElement("a");
      link.href = href;
      editor.dom.root.append(link);
      link.click();
      await flush();
      expect(editor.confirmed).not.toHaveBeenCalled();
      expect(beforeUnloadPrevented()).toBe(true);
      expect(editor.view()).toBe(view);
      expect(view.state.doc.toString()).toBe(markdown);
      expect(routeGet).not.toHaveBeenCalled();
    },
  );

  test("an anchor to another note asks once through soft navigation and cancel keeps the editor", async () => {
    using editor = mountNoteEditor();
    const view = editor.view();
    editor.end();
    const link = document.createElement("a");
    link.href = otherHref;
    const clicked = mock(() => {});
    link.addEventListener("click", clicked);
    editor.dom.root.append(link);
    link.click();
    await flush();
    // Notebook links reach their normal handlers rather than being stopped and replayed by the bar.
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(editor.view()).toBe(view);
    expect(view.state.doc.toString()).toBe(markdown);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(editorHref);
    expect(routeGet).not.toHaveBeenCalled();
    expect(beforeUnloadPrevented()).toBe(true);
  });

  test("changing the shown note's presentation mode asks before document fallback", async () => {
    using editor = mountNoteEditor();
    editor.end();
    const href = "/app/notebooks/Book01/notes/Note01?mode=readonly";
    expect(await loaded!.requestSoftNoteNavigation(href)).toEqual({ kind: "superseded" });
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(beforeUnloadPrevented()).toBe(true);
    editor.confirmed.mockResolvedValue(true);
    expect(await loaded!.requestSoftNoteNavigation(href)).toEqual({ kind: "fallback" });
    expect(editor.confirmed).toHaveBeenCalledTimes(2);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  test("a confirmed navigation superseded by the shown note restores the unsent text warning", async () => {
    using editor = mountNoteEditor();
    const view = editor.view();
    editor.end();
    editor.confirmed.mockResolvedValue(true);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    routeGet.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const leaving = loaded!.requestSoftNoteNavigation(otherHref);
    await started.promise;
    expect(beforeUnloadPrevented()).toBe(false);
    expect(await loaded!.requestSoftNoteNavigation(editorHref)).toEqual({ kind: "applied", href: editorHref });
    expect(await leaving).toEqual({ kind: "superseded" });
    expect(beforeUnloadPrevented()).toBe(true);
    expect(editor.view()).toBe(view);
    expect(view.state.doc.toString()).toBe(markdown);
    expect(editor.providers[0]!.dispose).not.toHaveBeenCalled();
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    response.resolve(Response.json({ kind: "fallback", reason: "superseded request" }));
    await flush();
    editor.confirmed.mockResolvedValue(false);
    expect(await loaded!.requestSoftNoteNavigation(otherHref)).toEqual({ kind: "superseded" });
    expect(editor.confirmed).toHaveBeenCalledTimes(2);
  });

  test("a confirmed navigation superseded by another pending leave keeps leave confirmed", async () => {
    using editor = mountNoteEditor();
    editor.end();
    editor.confirmed.mockResolvedValue(true);
    const firstStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<Response>();
    const secondStarted = Promise.withResolvers<void>();
    const secondResponse = Promise.withResolvers<Response>();
    routeGet.mockImplementationOnce(() => {
      firstStarted.resolve();
      return firstResponse.promise;
    });
    routeGet.mockImplementationOnce(() => {
      secondStarted.resolve();
      return secondResponse.promise;
    });
    const first = loaded!.requestSoftNoteNavigation(otherHref);
    await firstStarted.promise;
    const second = loaded!.requestSoftNoteNavigation("/app/notebooks/Book01/notes/Third1?mode=write");
    await secondStarted.promise;
    expect(await first).toEqual({ kind: "superseded" });
    expect(beforeUnloadPrevented()).toBe(false);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    firstResponse.resolve(Response.json({ kind: "fallback", reason: "superseded request" }));
    secondResponse.resolve(Response.json({ kind: "fallback", reason: "failed request" }));
    expect(await second).toEqual({ kind: "fallback" });
    await flush();
  });

  test("soft navigation without unsent text proceeds without a prompt", async () => {
    using editor = mountNoteEditor({ pending: false });
    editor.end();
    expect(await loaded!.requestSoftNoteNavigation(otherHref)).toEqual({ kind: "applied", href: otherHref });
    expect(editor.confirmed).not.toHaveBeenCalled();
    expect(editor.providers[0]!.dispose).toHaveBeenCalledTimes(1);
    editor.setPending(true);
    editor.end();
    expect(await loaded!.requestSoftNoteNavigation(editorHref)).toEqual({ kind: "superseded" });
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(routeGet).toHaveBeenCalledTimes(1);

    using reader = mountNoteEditor({ readOnly: true });
    reader.confirmed.mockClear();
    expect(reader.providers).toHaveLength(0);
    expect(reader.dom.root.querySelector("[data-sync-ended]")).toBeNull();
    expect(await loaded!.requestSoftNoteNavigation(otherHref)).toEqual({ kind: "fallback" });
    expect(reader.confirmed).not.toHaveBeenCalled();
  });

  test("concurrent leave guards share one promise and confirmation bypasses later guards", async () => {
    using editor = mount();
    expect(await editor.sync.confirmLeave()).toBe(true);
    editor.end("NOTE_LOCKED");
    let answer!: (leave: boolean) => void;
    editor.confirmed.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const first = editor.sync.confirmLeave();
    expect(editor.sync.confirmLeave()).toBe(first);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    answer(true);
    expect(await first).toBe(true);
    expect(await editor.sync.confirmLeave()).toBe(true);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("confirmed Reload does not also prevent beforeunload", async () => {
    using editor = mount();
    editor.end("NOTE_LOCKED");
    editor.confirmed.mockResolvedValue(true);
    editor.button("Reload").click();
    await flush();
    expect(refreshCurrentPath).toHaveBeenCalledTimes(1);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
  });

  test.each(reasons)("%s keeps pending text read-only and offers the recovery actions", async (code, title) => {
    using editor = mount();
    editor.mirror.editorView()!.focus();
    editor.end(code);
    expect(refreshCurrentPath).not.toHaveBeenCalled();
    expect(editor.mirror.editorView()!.state.readOnly).toBe(true);
    expect(editor.dom.root.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(editor.mirror.editorView()!.state.doc.toString()).toBe(markdown);
    expect(editor.bar().textContent).toContain(`Changes not saved. ${title}`);
    expect(editor.bar().querySelector('[role="alert"]')?.getAttribute("data-tone")).toBe("danger");
    const originalBar = editor.bar();
    const originalEnd = editor.sync.ended();
    editor.end(code);
    expect(editor.sync.ended()).toBe(originalEnd);
    expect(editor.bar()).toBe(originalBar);
    const signIn = code === "SESSION_EXPIRED" || code === "LOGIN_REQUIRED";
    expect(editor.bar().querySelectorAll("button")).toHaveLength(signIn ? 1 : 2);
    expect(document.activeElement).toBe(editor.button(signIn ? "Sign in again" : "Copy text"));
    if (signIn) {
      editor.button("Sign in again").click();
      expect(editor.opened).toHaveBeenCalledTimes(1);
      const [href, target, features] = editor.opened.mock.calls[0]!;
      const url = new URL(String(href), window.location.href);
      expect(url.pathname).toBe("/auth/login");
      expect(url.searchParams.get("redirectTo")).toBe(notePath);
      expect(target).toBe("_blank");
      expect(features).toBe("noopener");
    } else {
      editor.button("Copy text").click();
      await flush();
      expect(editor.copied).toHaveBeenCalledWith(markdown);
      expect(editor.success).toHaveBeenCalled();
      editor.button("Reload").click();
      await flush();
      expect(editor.confirmed).toHaveBeenCalledWith("Reload the note? Changes that are not saved will be lost.", {
        title: "Reload",
        icon: "ti ti-refresh",
        variant: "danger",
        confirmText: "Reload",
      });
      expect(refreshCurrentPath).not.toHaveBeenCalled();
      editor.confirmed.mockResolvedValue(true);
      editor.button("Reload").click();
      await flush();
      expect(refreshCurrentPath).toHaveBeenCalledTimes(1);
    }
  });

  test.each(reasons)("%s uses the same model with all changes saved", async (code, title) => {
    using editor = mount({ pending: false });
    editor.end(code);
    expect(editor.bar().textContent).toContain(`All changes saved. ${title}`);
    expect(editor.mirror.editorView()!.state.readOnly).toBe(true);
    expect(refreshCurrentPath).not.toHaveBeenCalled();
    expect(editor.bar().querySelector('[role="alert"]')?.getAttribute("data-tone")).toBe("warning");
    if (code === "SESSION_EXPIRED" || code === "LOGIN_REQUIRED") {
      expect(editor.bar().querySelectorAll("button")).toHaveLength(1);
      editor.button("Sign in again").click();
      expect(editor.opened).toHaveBeenCalledTimes(1);
    } else {
      editor.button("Reload").click();
      await flush();
      expect(editor.confirmed).not.toHaveBeenCalled();
      expect(refreshCurrentPath).toHaveBeenCalledTimes(1);
    }
  });

  test.each(["SESSION_EXPIRED", "LOGIN_REQUIRED"] as const)("%s resumes on focus or visibility and ready restores editing", (code) => {
    using editor = mount();
    editor.end(code);
    for (let count = 1; count <= 2; count++) {
      window.dispatchEvent(new Event("focus"));
      expect(editor.resume).toHaveBeenCalledTimes(count);
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(editor.resume).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(editor.resume).toHaveBeenCalledTimes(3);
    editor.sync.ready();
    expect(editor.bar()).toBeNull();
    expect(editor.mirror.editorView()!.state.readOnly).toBe(false);
    expect(editor.dom.root.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(editor.resume).toHaveBeenCalledTimes(3);
  });

  test("formatting shortcuts cannot change a note after sync ended", () => {
    using editor = mount();
    const view = editor.mirror.editorView()!;
    view.dispatch({ selection: { anchor: 2, head: 6 } });
    view.focus();
    const boldKey = () =>
      new KeyboardEvent("keydown", { key: "b", code: "KeyB", keyCode: 66, ctrlKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(boldKey());
    expect(view.state.doc.toString()).not.toBe(markdown);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown }, selection: { anchor: 2, head: 6 } });
    editor.end("SESSION_EXPIRED");
    view.focus();
    view.contentDOM.dispatchEvent(boldKey());
    expect(view.state.doc.toString()).toBe(markdown);
    editor.sync.ready();
    view.contentDOM.dispatchEvent(boldKey());
    expect(view.state.doc.toString()).not.toBe(markdown);
  });

  test("the save state follows late echoes and edits after the end", () => {
    using editor = mount();
    editor.end("BACKPRESSURE");
    const bar = editor.bar();
    editor.setPending(false);
    expect(editor.bar()).toBe(bar);
    expect(bar.textContent).toContain("All changes saved. Connection closed");
    expect(bar.querySelector('[role="alert"]')?.getAttribute("data-tone")).toBe("warning");
    editor.setPending(true);
    expect(bar.textContent).toContain("Changes not saved. Connection closed");
    editor.sync.ready();
    editor.setPending(false);
    expect(editor.sync.ended()).toBeNull();
  });

  test("resuming hands focus from the bar back to the note", () => {
    using editor = mount();
    editor.end("SESSION_EXPIRED");
    expect(document.activeElement).toBe(editor.button("Sign in again"));
    editor.sync.ready();
    expect(editor.mirror.editorView()!.hasFocus).toBe(true);

    const outside = document.createElement("button");
    editor.dom.root.append(outside);
    editor.end("SESSION_EXPIRED");
    outside.focus();
    editor.sync.ready();
    expect(document.activeElement).toBe(outside);
  });

  test("leaving the note for another route with unsent changes asks first", async () => {
    using editor = mountNoteEditor();
    const link = document.createElement("a");
    link.href = "/app/settings";
    let followed = 0;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      followed++;
    });
    editor.dom.root.append(link);
    editor.end();
    expect(beforeUnloadPrevented()).toBe(true);
    link.click();
    await flush();
    expect(editor.confirmed).toHaveBeenCalledWith("Leave the note? Changes that are not saved will be lost.", {
      title: "Leave",
      icon: "ti ti-logout",
      variant: "danger",
      confirmText: "Leave",
    });
    expect(followed).toBe(0);
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    editor.confirmed.mockResolvedValue(true);
    link.click();
    await flush();
    expect(followed).toBe(1);
    expect(beforeUnloadPrevented()).toBe(false);
    expect(editor.confirmed).toHaveBeenCalledTimes(2);

    editor.setPending(false);
    editor.confirmed.mockClear();
    expect(beforeUnloadPrevented()).toBe(false);
    link.click();
    expect(followed).toBe(2);
    expect(editor.confirmed).not.toHaveBeenCalled();
  });

  test("non-sign-in errors do not resume on focus", () => {
    using editor = mount();
    editor.end("NOTE_LOCKED");
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(editor.resume).not.toHaveBeenCalled();
  });

  test("German recovery labels and failed copying use the application messages", async () => {
    using editor = mount({ locale: "de" });
    editor.end("STORAGE_EXHAUSTED");
    expect(editor.bar().textContent).toContain("Nicht gespeichert. Speicher ist voll");
    editor.copied.mockRejectedValue(new Error("clipboard unavailable"));
    editor.button("Text kopieren").click();
    await flush();
    expect(editor.failure).toHaveBeenCalled();
    editor.button("Neu laden").click();
    await flush();
    expect(editor.confirmed.mock.calls[0]?.[0]).toBe("Notiz neu laden? Nicht gespeicherte Änderungen gehen verloren.");
    editor.end("SESSION_EXPIRED");
    editor.button("Erneut anmelden").click();
    expect(editor.opened).toHaveBeenCalledTimes(1);
  });
});
