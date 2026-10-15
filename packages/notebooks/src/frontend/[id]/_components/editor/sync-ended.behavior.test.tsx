import { describe, expect, mock, spyOn, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { createCodeMirror } from "solid-codemirror";
import { Show } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { YjsProviderOptions } from "../../../lib/yjs";
import type { YjsProviderError } from "../../../lib/yjs/provider";
import { notebookWorkspaceMessages } from "../../messages";

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
const routeGet = mock(async ({ query: { href } }: { query: { href: string } }) => {
  const id = new URL(href, "http://localhost").pathname.split("/").at(-1)!;
  return Response.json({
    kind: "ok",
    state: {
      href,
      note: { id, title: id, lockedAt: null, historyIncomplete: false, yjsSnapshot: null },
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
const mountNoteEditor = ({ pending: initialPending = true, readOnly = false } = {}) => {
  let pending = initialPending;
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  window.history.replaceState({ shown: true }, "", editorHref);
  const { NoteEditor, LocaleProvider, yjs, prompts } = loaded!;
  const providers: Array<{ opts: YjsProviderOptions; dispose: ReturnType<typeof mock> }> = [];
  const provider = spyOn(yjs, "createYjsProvider").mockImplementation((opts) => {
    const dispose = mock(() => {});
    providers.push({ opts, dispose });
    return { connect: () => {}, resume: () => {}, dispose, hasUnsentChanges: () => pending };
  });
  const confirmed = spyOn(prompts, "confirm").mockResolvedValue(false);
  routeGet.mockClear();
  const doc = new Y.Doc();
  doc.getText("codemirror").insert(0, markdown);
  const initialSnapshot = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
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
          workspaceCursor={null}
          userId="User01"
          displayName="Reader"
          initialSnapshot={initialSnapshot}
          initialPanelOpen={false}
          initialRichMode="source"
          initialHref={editorHref.split("#")[0]!}
          initialDetail={detail("Note01")}
          readOnly={readOnly}
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
      if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
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
    window.history.replaceState({ back: true }, "", "/app/notebooks/Book01/notes/Third1?mode=write");
    window.dispatchEvent(new Event("popstate"));
    await flush();
    expect(editor.confirmed).toHaveBeenCalledTimes(1);
    expect(routeGet).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(shownHref);
    expect(window.history.state).toEqual({ back: true });
    expect(instance.dispose).not.toHaveBeenCalled();
    expect(editor.view()).toBe(view);
    expect(view.state.doc.toString()).toBe(text);
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

  test("leaving the note with unsent changes asks first", async () => {
    using editor = mount();
    const link = document.createElement("a");
    link.href = "/app/notebooks/Book01/Other1";
    let followed = 0;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      followed++;
    });
    editor.dom.root.append(link);
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    editor.end("NOTE_LOCKED");
    expect(unload()).toBe(true);
    link.click();
    await flush();
    expect(editor.confirmed).toHaveBeenCalledWith("Leave the note? Changes that are not saved will be lost.", {
      title: "Leave",
      icon: "ti ti-logout",
      variant: "danger",
      confirmText: "Leave",
    });
    expect(followed).toBe(0);
    editor.confirmed.mockResolvedValue(true);
    link.click();
    await flush();
    expect(followed).toBe(1);
    expect(unload()).toBe(false);
    expect(editor.confirmed).toHaveBeenCalledTimes(2);

    editor.setPending(false);
    editor.confirmed.mockClear();
    expect(unload()).toBe(false);
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
