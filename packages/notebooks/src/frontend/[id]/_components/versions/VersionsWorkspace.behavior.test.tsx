import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import { notesContext, sampleNotes } from "../../notes/notes-list.fixture";
import { buildNoteUrl, buildVersionsUrl } from "../../../params";

const navigateTo = mock((_href: string) => {});
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const nav = await import("@k2b/ssr/nav");
    mock.module("@k2b/ssr/nav", () => ({ ...nav, navigateTo }));
    const { default: VersionsWorkspace } = await import("./VersionsWorkspace");
    const notice = await import("./restore-notice");
    const { toast } = await import("@k2b/ui");
    return { VersionsWorkspace, ...notice, toast };
  } finally {
    dom.cleanup();
  }
};
const loaded = isServer ? undefined : await load();
const base = notesContext(sampleNotes(3));
const ctx = { ...base, notebook: { ...base.notebook, id: "Book01" } };
const PAGE_GLOBALS = ["NodeFilter", "HTMLInputElement", "CSS"] as const;
/** The v2 toasts on the page, by their words. */
const toasts = (document: Document) => [...document.querySelectorAll('[data-k2-part="Toast"] li')].map((toast) => toast.textContent ?? "");

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for version history");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const flush = async () => {
  await Promise.resolve();
  await Bun.sleep(20);
};

describe("version history pagination", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("keeps existing versions and shows a retryable error for an invalid next page", async () => {
    const dom = createDomTestHarness();
    const { VersionsWorkspace } = loaded!;
    delegateEvents(["click"], dom.document);
    globalThis.fetch = Object.assign(
      () =>
        Promise.resolve(
          Response.json({
            data: [],
            pagination: { page: 1, per_page: 20, total: 21, total_pages: 2, has_next: true },
          }),
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    const dispose = render(
      () =>
        createComponent(VersionsWorkspace, {
          ctx,
          noteId: "note-1",
          noteTitle: "Runbook",
          isLocked: false,
          currentContentMd: "Current",
          dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
          initialVersions: [
            {
              id: "version-1",
              noteId: "note-1",
              createdBy: null,
              createdAt: "2026-08-11T10:00:00.000Z",
            },
          ],
          initialTotal: 21,
          initialVersionId: null,
        }),
      dom.root,
    );

    try {
      let loadMore: HTMLButtonElement | undefined;
      for (let attempt = 0; attempt < 10 && !loadMore; attempt++) {
        await flush();
        loadMore = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Load more"));
      }
      expect(loadMore).toBeDefined();
      loadMore!.click();
      await flush();

      await waitFor(() => dom.document.body.textContent?.includes("The server returned an invalid version page") ?? false);
      // the loaded version stays, the failure stands after it with its retry, and the count still says 21
      expect(dom.document.querySelectorAll('[data-k2-part="Row"]')).toHaveLength(1);
      expect([...dom.document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Retry")).toBe(true);
      expect(dom.document.querySelector('[data-k2-part="Section"]')?.textContent).toContain("21");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

describe("version history restore", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const { VersionsWorkspace, rememberRestoredVersion, showRestoredVersionNotice, toast } = loaded!;
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const path = "/api/notebooks/Book01/notes/Note01/versions/Version01";
  const messages = {
    versionRestored: "Version restored",
    undo: "Undo",
    restoreUndone: "Restore undone",
    restoreFailed: "Failed to restore content",
  };
  let dom: DomTestHarness;
  let dispose: (() => void) | undefined;
  let requests: Request[];
  let respond: (request: Request) => Promise<Response>;

  beforeEach(() => {
    dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    // The harness binds browser globals one by one; v2 toasts walk their text, menus and links read these too.
    for (const name of PAGE_GLOBALS) Object.defineProperty(globalThis, name, { configurable: true, value: Reflect.get(dom.window, name) });
    navigateTo.mockClear();
    requests = [];
    respond = async () => Response.json({ contentMd: "Saved content", yjsSnapshot: "" });
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
        requests.push(request);
        return respond(request);
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    toast.dismissAll();
    dispose?.();
    dispose = undefined;
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    for (const name of PAGE_GLOBALS) Reflect.deleteProperty(globalThis, name);
    dom.cleanup();
  });

  /** The version history, with Version01 open as the address says (`?version=Version01`), or none open. */
  const mount = (isLocked = false, open: string | null = "Version01") => {
    dispose = render(
      () =>
        createComponent(VersionsWorkspace, {
          ctx,
          noteId: "Note01",
          noteTitle: "Runbook",
          isLocked,
          currentContentMd: "Current",
          dateConfig: { locale: "en", timeZone: "UTC" },
          initialVersions: [{ id: "Version01", noteId: "Note01", createdBy: null, createdAt: "2026-08-11T10:00:00.000Z" }],
          initialTotal: 1,
          initialVersionId: open,
        }),
      dom.root,
    );
  };
  const button = (label: string) =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label);
  const primary = () => button("Restore this version");
  const select = async () => {
    await waitFor(() => dom.root.querySelector("article")?.textContent?.trim() === "Saved content");
  };
  const openToasts = () => Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])"));
  const hasToast = (message: string, variant: "error" | "success") =>
    openToasts().some(
      (element) =>
        element.dataset.tone === (variant === "error" ? "danger" : "success") &&
        element.querySelector(".k2b-toast__description")?.textContent === message,
    );
  const posts = () => requests.filter((request) => request.method === "POST");

  test("restores the selected version, keeps the action busy until it resolves, and carries Undo to the note", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    respond = async (request) => (request.method === "POST" ? pending : Response.json({ contentMd: "Saved content", yjsSnapshot: "" }));
    mount();
    await select();
    expect(primary()!.disabled).toBe(false);
    primary()!.click();
    await waitFor(() => posts().length === 1);
    expect(new URL(posts()[0]!.url).pathname).toBe(`${path}/restore`);
    expect(posts()[0]!.method).toBe("POST");
    expect(await posts()[0]!.text()).toBe("");
    // busy, so a second press does nothing, and the copy waits too
    expect(primary()!.getAttribute("aria-busy")).toBe("true");
    primary()!.click();
    expect(dom.root.querySelector<HTMLButtonElement>('button[aria-label="More restore options"]')!.disabled).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    release(Response.json({ note: { id: "Note01" }, changed: true, previousVersionId: "Previous01", versionId: "Version01" }));
    await waitFor(() => navigateTo.mock.calls.length === 1);
    expect(sessionStorage.getItem("notebooks.restoredVersion")).toBe("Note01 Previous01");
    expect(navigateTo).toHaveBeenCalledWith(buildNoteUrl("Book01", "Note01", "write"));
  });

  test("a denied restore shows the server error and enables the action again without navigating", async () => {
    respond = async (request) =>
      request.method === "POST"
        ? Response.json({ message: "Cannot restore locked note" }, { status: 403 })
        : Response.json({ contentMd: "Saved content", yjsSnapshot: "" });
    mount();
    await select();
    primary()!.click();
    await waitFor(() => toasts(dom.document).some((text) => text.includes("Cannot restore locked note")) && !primary()!.hasAttribute("aria-busy"));
    expect(primary()!.disabled).toBe(false);
    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([`${path}/restore`]);
    expect(primary()!.hasAttribute("aria-busy")).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  test("the restore menu restores a copy and navigates to its note", async () => {
    respond = async (request) =>
      request.method === "POST" ? Response.json({ id: "Copy01" }) : Response.json({ contentMd: "Saved content", yjsSnapshot: "" });
    mount();
    await select();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="More restore options"]')!.click();
    await waitFor(() => !!dom.document.querySelector('[role="menuitem"]'));
    const item = Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) =>
      element.textContent?.includes("Restore as copy"),
    );
    expect(item).toBeDefined();
    item!.click();
    await waitFor(() => navigateTo.mock.calls.length === 1);
    expect(posts().map((request) => ({ path: new URL(request.url).pathname, method: request.method }))).toEqual([
      { path: `${path}/copy`, method: "POST" },
    ]);
    expect(navigateTo).toHaveBeenCalledWith(buildNoteUrl("Book01", "Copy01"));
    expect(sessionStorage.length).toBe(0);
  });

  test("a locked note offers only the secondary copy action", async () => {
    respond = async (request) =>
      request.method === "POST" ? Response.json({ id: "Copy01" }) : Response.json({ contentMd: "Saved content", yjsSnapshot: "" });
    mount(true);
    await select();
    expect(primary()).toBeUndefined();
    expect(dom.root.querySelector('button[aria-label="More restore options"]')).toBeNull();
    expect(dom.root.textContent).toContain("Locked");
    // framed (secondary), the way a second deed looks
    expect(button("Restore as copy")!.dataset.variant).toBeUndefined();
    expect(button("Restore as copy")!.disabled).toBe(false);
    button("Restore as copy")!.click();
    await waitFor(() => navigateTo.mock.calls.length === 1);
    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([`${path}/copy`]);
    expect(navigateTo).toHaveBeenCalledWith(buildNoteUrl("Book01", "Copy01"));
  });

  test("a version opens from its row into the address, and back closes it", async () => {
    dom.window.history.replaceState(null, "", buildVersionsUrl("Book01", "Note01"));
    mount(false, null);
    expect(dom.root.querySelector("article")).toBeNull();
    expect(dom.root.textContent).toContain("Its saved content opens here");
    dom.root.querySelector<HTMLAnchorElement>('[data-k2-part="Row"] a')!.click();
    await select();
    expect(`${dom.window.location.pathname}${dom.window.location.search}`).toBe(`${buildVersionsUrl("Book01", "Note01")}&version=Version01`);
    dom.window.history.back();
    await waitFor(() => !dom.root.querySelector("article"));
    expect(dom.window.location.search).not.toContain("version=");
  });

  test("the restored notice appears once and Undo restores the previous version", async () => {
    respond = async () => Response.json({ note: { id: "Note01" }, changed: true, previousVersionId: "Version01", versionId: "Previous01" });
    rememberRestoredVersion("Note01", "Previous01");
    showRestoredVersionNotice({ notebookId: "Book01", noteId: "Note01", t: messages });
    expect(hasToast("Version restored", "success")).toBe(true);
    expect(sessionStorage.length).toBe(0);
    const before = openToasts();
    showRestoredVersionNotice({ notebookId: "Book01", noteId: "Note01", t: messages });
    expect(openToasts()).toEqual(before);
    const undo = Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-toast__action")).find(
      (element) => element.textContent === "Undo" && !element.closest("[data-closing]"),
    );
    expect(undo).toBeDefined();
    undo!.click();
    undo!.click();
    expect(hasToast("Version restored", "success")).toBe(false);
    await waitFor(() => hasToast("Restore undone", "success"));
    expect(posts().map((request) => ({ path: new URL(request.url).pathname, method: request.method }))).toEqual([
      { path: "/api/notebooks/Book01/notes/Note01/versions/Previous01/restore", method: "POST" },
    ]);
    expect(await posts()[0]!.text()).toBe("");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  test("a restored notice does not appear on another note", () => {
    rememberRestoredVersion("Note01", "Previous01");
    showRestoredVersionNotice({ notebookId: "Book01", noteId: "Other01", t: messages });
    expect(openToasts()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  test("Undo reports a server error instead of confirming a failed restore", async () => {
    respond = async () => Response.json({ message: "Cannot restore locked note" }, { status: 403 });
    rememberRestoredVersion("Note01", "Previous01");
    showRestoredVersionNotice({ notebookId: "Book01", noteId: "Note01", t: messages });
    const undo = Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-toast__action")).find(
      (element) => element.textContent === "Undo" && !element.closest("[data-closing]"),
    );
    undo!.click();
    await waitFor(() => hasToast("Cannot restore locked note", "error"));
    expect(hasToast("Restore undone", "success")).toBe(false);
    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([
      "/api/notebooks/Book01/notes/Note01/versions/Previous01/restore",
    ]);
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
