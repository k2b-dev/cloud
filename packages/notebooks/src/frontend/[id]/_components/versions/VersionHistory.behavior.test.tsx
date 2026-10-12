import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import { buildNoteUrl } from "../../../params";

const navigateTo = mock((_href: string) => {});
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const nav = await import("@k2b/ssr/nav");
    mock.module("@k2b/ssr/nav", () => ({ ...nav, navigateTo }));
    const { default: VersionHistory } = await import("./VersionHistory.island");
    const notice = await import("./restore-notice");
    const { toast } = await import("@k2b/ui");
    return { VersionHistory, ...notice, toast };
  } finally {
    dom.cleanup();
  }
};
const loaded = isServer ? undefined : await load();

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
    const { VersionHistory } = loaded!;
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
        createComponent(VersionHistory, {
          notebookId: "notebook-1",
          noteId: "note-1",
          noteTitle: "Runbook",
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

      expect(dom.document.body.textContent).toContain("The server returned an invalid version page");
      expect(dom.document.body.textContent).toContain("Retry");
      expect(dom.document.body.textContent).toContain("1 / 21");
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

  const { VersionHistory, rememberRestoredVersion, showRestoredVersionNotice, toast } = loaded!;
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
    dom.cleanup();
  });

  const mount = (isLocked = false) => {
    dispose = render(
      () =>
        createComponent(VersionHistory, {
          notebookId: "Book01",
          noteId: "Note01",
          noteTitle: "Runbook",
          isLocked,
          currentContentMd: "Current",
          dateConfig: { locale: "en", timeZone: "UTC" },
          initialVersions: [{ id: "Version01", noteId: "Note01", createdBy: null, createdAt: "2026-08-11T10:00:00.000Z" }],
          initialTotal: 1,
        }),
      dom.root,
    );
  };
  const button = (label: string) =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label);
  const primary = () => dom.root.querySelector<HTMLButtonElement>(".k2b-split-button__primary");
  const select = async () => {
    dom.root.querySelector<HTMLButtonElement>("button[aria-pressed]")!.click();
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
    expect(primary()!.disabled).toBe(true);
    await select();
    expect(button("Restore this version")).toBe(primary()!);
    expect(primary()!.disabled).toBe(false);
    primary()!.click();
    await waitFor(() => posts().length === 1);
    expect(new URL(posts()[0]!.url).pathname).toBe(`${path}/restore`);
    expect(posts()[0]!.method).toBe("POST");
    expect(await posts()[0]!.text()).toBe("");
    expect(primary()!.getAttribute("aria-busy")).toBe("true");
    expect(primary()!.disabled).toBe(true);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    release(Response.json({ note: { id: "Note01" }, changed: true, previousVersionId: "Previous01", versionId: "Version01" }));
    await waitFor(() => navigateTo.mock.calls.length === 1);
    expect(sessionStorage.getItem("notebooks.restoredVersion")).toBe("Note01 Previous01");
    expect(navigateTo).toHaveBeenCalledWith(buildNoteUrl("Book01", "Note01"));
  });

  test("a denied restore shows the server error and enables the action again without navigating", async () => {
    respond = async (request) =>
      request.method === "POST"
        ? Response.json({ message: "Cannot restore locked note" }, { status: 403 })
        : Response.json({ contentMd: "Saved content", yjsSnapshot: "" });
    mount();
    await select();
    primary()!.click();
    await waitFor(() => hasToast("Cannot restore locked note", "error") && !primary()!.disabled);
    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([`${path}/restore`]);
    expect(primary()!.hasAttribute("aria-busy")).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  test("the split-button menu restores a copy and navigates to its note", async () => {
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
    expect(primary()).toBeNull();
    expect(button("Restore this version")).toBeUndefined();
    expect(dom.root.querySelector(".k2b-split-button__menu-trigger")).toBeNull();
    expect(dom.root.textContent).toContain("Locked");
    expect(button("Restore as copy")!.dataset.variant).toBe("secondary");
    expect(button("Restore as copy")!.disabled).toBe(true);
    await select();
    expect(button("Restore as copy")!.disabled).toBe(false);
    button("Restore as copy")!.click();
    await waitFor(() => navigateTo.mock.calls.length === 1);
    expect(posts().map((request) => new URL(request.url).pathname)).toEqual([`${path}/copy`]);
    expect(navigateTo).toHaveBeenCalledWith(buildNoteUrl("Book01", "Copy01"));
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
