import { describe, expect, mock, spyOn, test } from "bun:test";
import { createCodeMirror } from "solid-codemirror";
import { Show } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import type { YjsProviderError } from "../../../lib/yjs/provider";

const refreshCurrentPath = mock(() => {});
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const nav = await import("@k2b/ssr/nav");
    mock.module("@k2b/ssr/nav", () => ({ ...nav, refreshCurrentPath }));
    const sync = await import("./sync-ended");
    const { formattingKeymap } = await import("./EditorToolbar");
    const { markdownExtension } = await import("../../../lib/editor/markdown");
    const ui = await import("@k2b/ui");
    const { clipboard } = await import("@k2b/stdlib/browser");
    return { ...sync, ...ui, clipboard, formattingKeymap, markdownExtension };
  } finally {
    dom.cleanup();
  }
};
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
    sync = createSyncEnded({ hasUnsentChanges: () => pending, resume, focusEditor: () => mirror.editorView()?.focus() });
    mirror = createCodeMirror({ value: markdown });
    mirror.createExtension(markdownExtension());
    mirror.createExtension(sync.extension);
    mirror.createExtension(() => (sync.ended() ? [] : formattingKeymap({ notebookId: "Book01" })));
    return (
      <LocaleProvider locale={locale}>
        <div ref={mirror.ref} />
        <Show when={sync.ended()}>
          {(ended) => <SyncEndedBar ended={ended()} markdown={() => mirror.editorView()!.state.doc.toString()} noteHref={() => notePath} />}
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
