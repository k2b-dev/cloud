import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent, createRoot, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { createWorkspaceState, type WorkspaceSnapshot } from "../src/frontend/workspace-state";

const apiRequests: Array<{ kind: string; input?: unknown; signal?: AbortSignal; resolve: (response: Response) => void }> = [];
const searches: unknown[] = [];
if (!isServer) {
  mock.module("@k2b/cloud/browser/search", () => ({ openGlobalSearch: (options: unknown) => searches.push(options) }));
  const request = (kind: string) => (_input?: unknown, options?: { init?: { signal?: AbortSignal } }) =>
    new Promise<Response>((resolve) => apiRequests.push({ kind, input: _input, signal: options?.init?.signal, resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      shares: { $get: request("shares") },
      recent: { $get: request("recent") },
      favorites: { $get: request("favorites") },
      bases: { $get: request("bases"), ":baseId": { entries: { $get: request("entries") } } },
    },
  }));
}

const initial: WorkspaceSnapshot = {
  source: "/app/filesv2?base=home",
  bases: { items: [], issues: [], editor: null },
  selectedId: null,
  directory: null,
  errorCode: null,
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
type Request = { source: string; signal: AbortSignal; resolve: (value: WorkspaceSnapshot) => void; reject: (error: Error) => void };

describe("Filesv2 progressive navigation", () => {
  if (isServer) {
    test.skip("requires DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    apiRequests.length = 0;
    searches.length = 0;
  });
  const setup = () => {
    const dom = createDomTestHarness();
    const requests: Request[] = [];
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createWorkspaceState({
        initial,
        load: (source, signal) => new Promise((resolve, reject) => requests.push({ source, signal, resolve, reject })),
      });
    });
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return { controller, requests, dispose };
  };

  test("SSR snapshot suppresses initial fetch; history commits only after its matching snapshot", async () => {
    const { controller, requests } = setup();
    await flush();
    expect(requests).toHaveLength(0);
    const commits: string[] = [];
    const source = "/app/filesv2?base=home&path=Documents";
    const completed = controller.navigate(source, () => commits.push(controller.snapshot().source));
    await flush();
    expect(requests).toHaveLength(1);
    expect(controller.pending()).toBe(true);
    expect(commits).toEqual([]);
    requests[0]!.resolve({ ...initial, source });
    await completed;
    expect(commits).toEqual([source]);
    expect(controller.pending()).toBe(false);
    expect(controller.committedSource()).toBe(source);
  });

  test("superseded requests abort and late out-of-order responses never change snapshot or history", async () => {
    const { controller, requests } = setup();
    await flush();
    const commits: string[] = [];
    const first = controller.navigate("/app/filesv2?base=first", () => commits.push("first"));
    await flush();
    const second = controller.navigate("/app/filesv2?base=second", () => commits.push("second"));
    await flush();
    await first;
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[1]!.resolve({ ...initial, source: requests[1]!.source });
    await second;
    requests[0]!.resolve({ ...initial, source: requests[0]!.source });
    await flush();
    expect(commits).toEqual(["second"]);
    expect(controller.snapshot().source).toBe("/app/filesv2?base=second");
  });

  test("failed target rolls back its source without a hidden read; retry reloads and clears the error", async () => {
    const { controller, requests } = setup();
    await flush();
    let commits = 0;
    const target = "/app/filesv2?base=home&path=unavailable";
    const failed = controller.navigate(target, () => commits++);
    await flush();
    requests[0]!.reject(new Error("Directory unavailable"));
    await failed;
    await flush();
    expect(controller.snapshot()).toEqual(initial);
    expect(controller.committedSource()).toBe(initial.source);
    expect(controller.failure()).toEqual({ source: target, message: "Directory unavailable" });
    expect(requests).toHaveLength(1);
    expect(commits).toBe(0);
    const retry = controller.navigate(target, () => commits++);
    await flush();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve({ ...initial, source: target });
    await retry;
    expect(controller.failure()).toBeNull();
    expect(commits).toBe(1);
  });

  test("selection-only URLs are retained for a failed history traversal without triggering a read", async () => {
    const { controller, requests } = setup();
    const selected = `${initial.source}&file=report.txt`;
    controller.rememberSource(selected);
    await flush();
    expect(requests).toHaveLength(0);
    let rollback = "";
    const navigation = controller.navigate(
      "/app/filesv2?base=gone",
      () => {},
      () => {
        rollback = controller.committedSource();
      },
    );
    await flush();
    requests[0]!.reject(new Error("Unavailable"));
    await navigation;
    expect(rollback).toBe(selected);
    expect(controller.snapshot()).toEqual(initial);
    expect(requests).toHaveLength(1);
  });

  test("same-target refresh reads again and failed history traversal invokes URL rollback", async () => {
    const { controller, requests } = setup();
    await flush();
    let rolledBack = false;
    const refreshing = controller.navigate(initial.source);
    await flush();
    requests[0]!.resolve({ ...initial });
    await refreshing;
    expect(requests).toHaveLength(1);
    const pop = controller.navigate(
      "/app/filesv2?base=gone",
      () => {},
      () => {
        rolledBack = true;
      },
    );
    await flush();
    requests[1]!.reject(new Error("Access changed"));
    await pop;
    expect(rolledBack).toBe(true);
    expect(controller.committedSource()).toBe(initial.source);
  });

  test("a failed refresh can retry the same committed URL", async () => {
    const { controller, requests } = setup();
    await flush();
    const failed = controller.navigate(initial.source);
    await flush();
    requests[0]!.reject(new Error("Offline"));
    await failed;
    const retry = controller.navigate(initial.source);
    await flush();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve({ ...initial });
    await retry;
    expect(controller.failure()).toBeNull();
  });

  test("dispose aborts outstanding navigation and settles the link callback", async () => {
    const { controller, requests, dispose } = setup();
    await flush();
    const pending = controller.navigate("/app/filesv2?base=other");
    await flush();
    dispose();
    await pending;
    expect(requests[0]!.signal.aborted).toBe(true);
  });
  test("workspace sidebar and folders enhance real hrefs; popstate reloads the matching view", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", initial.source);
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const base = {
      id: "home",
      area: "cloud" as const,
      kind: "users" as const,
      name: "Alice",
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const missing = { ...base, id: "missing", name: "Missing group", status: "missing" as const };
    const bases = { items: [base, missing], issues: [], editor: null };
    const directory = {
      base,
      path: "",
      items: [{ name: "Documents", path: "Documents", directory: true, size: 0, modified: "2026-09-17T00:00:00Z" }],
      next: null,
    };
    const dispose = render(() => createComponent(Workspace, { initial: { ...initial, bases, selectedId: base.id, directory } }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(apiRequests).toHaveLength(0);
    const link = (text: string) =>
      [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find(
        (entry) => entry.textContent?.includes(text) || entry.getAttribute("aria-label")?.includes(text),
      )!;
    // Search is an ordinary footer item with a visible label, directly above Recent; the icon grid is gone.
    expect(dom.root.querySelector(".k2b-app-workspace__sidebar-icon-grid")).toBeNull();
    const footer = dom.root.querySelector(".k2b-app-workspace__sidebar-footer")!;
    const footerLabels = [...footer.querySelectorAll<HTMLElement>("button, a")].map((item) => item.textContent?.trim());
    expect(footerLabels.slice(0, 2)).toEqual(["Search", "Recent"]);
    const search = footer.querySelector<HTMLButtonElement>("button")!;
    expect(search.getAttribute("title")).toBe("Search files");
    search.click();
    expect(searches).toEqual([{ query: "", scope: { appId: "filesv2", tag: "file", label: "Files", icon: "ti ti-folders" } }]);
    const missingLink = link("Missing group");
    expect(missingLink.getAttribute("href")).toBe("/app/filesv2?base=missing");
    missingLink.click();
    await flush();
    expect(dom.window.location.search).toBe("?base=home");
    apiRequests[0]!.resolve(Response.json(bases));
    await flush();
    expect(dom.window.location.search).toBe("?base=missing");
    const placeholder = dom.root.querySelector(".k2b-app-workspace__main .k2b-placeholder")!;
    expect(placeholder.textContent).toContain("Missing");
    expect(placeholder.getAttribute("data-variant")).toBe("panel");
    expect(placeholder.parentElement!.className).toContain("items-center justify-center");
    dom.window.history.replaceState(null, "", initial.source);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    apiRequests[1]!.resolve(Response.json(bases));
    await flush();
    apiRequests[2]!.resolve(Response.json(directory));
    await flush();
    expect(link("Documents").getAttribute("href")).toBe("/app/filesv2?base=home&path=Documents");
    link("Documents").click();
    await flush();
    expect(dom.window.location.search).toBe("?base=home");
    apiRequests[3]!.resolve(Response.json(bases));
    await flush();
    apiRequests[4]!.resolve(Response.json({ ...directory, path: "Documents", items: [] }));
    await flush();
    expect(dom.window.location.search).toBe("?base=home&path=Documents");
    expect(dom.root.querySelector(".k2b-app-workspace__main")!.textContent).toContain("This folder is empty");
    expect(apiRequests.map((request) => request.kind)).toEqual(["bases", "bases", "entries", "bases", "entries"]);
  });
  test("failures of enabled areas show a notice next to working storage; no issues and no storage stay quiet", async () => {
    const dom = createDomTestHarness();
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const base = {
      id: "ipa",
      area: "freeipa" as const,
      kind: "users" as const,
      name: "Alice",
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const directory = { base, path: "", items: [], next: null };
    const notices = () => [...dom.root.querySelectorAll(".k2b-inline-guidance")].map((node) => node.textContent);
    const mount = async (snapshot: Partial<WorkspaceSnapshot>) => {
      dom.window.history.replaceState(null, "", snapshot.source ?? initial.source);
      const dispose = render(
        () => createComponent(Workspace, { cloudUrl: "https://cloud.invalid", initial: { ...initial, ...snapshot } }),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
      };
      await flush();
      return dispose;
    };
    const source = "/app/filesv2?base=ipa";
    const failing = { items: [base], issues: [{ area: "cloud" as const, code: "local_linux_disabled" }], editor: null };
    let dispose = await mount({ source, bases: failing, selectedId: base.id, directory });
    expect(notices()).toEqual(["Cloud: Cloud files require local Linux identities to be enabled."]);
    expect(dom.root.textContent).toContain("This folder is empty");
    dispose();
    dispose = await mount({ source, bases: { items: [base], issues: [], editor: null }, selectedId: base.id, directory });
    expect(notices()).toEqual([]);
    expect(dom.root.textContent).toContain("This folder is empty");
    dispose();
    await mount({ source: "/app/filesv2" });
    expect(notices()).toEqual([]);
    expect(dom.root.textContent).toContain("No storage available");
    expect(dom.root.textContent).not.toContain("disabled");
  });
  test("marks load only while open, abort on close, refresh on reopen and use one compact ordered catalog", async () => {
    const dom = createDomTestHarness();
    const { MarksMenu, openMarksDialog } = await import("../src/frontend/MarksMenu");
    const [open, setOpen] = createSignal(false);
    const opened: string[] = [];
    const dispose = render(
      () =>
        createComponent(MarksMenu, {
          kind: "recent",
          get open() {
            return open();
          },
          close: () => setOpen(false),
          onOpen: (entry) => opened.push(entry.entry.path),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(apiRequests).toHaveLength(0);
    setOpen(true);
    await flush();
    expect(apiRequests[0]!.kind).toBe("recent");
    setOpen(false);
    await flush();
    expect(apiRequests[0]!.signal?.aborted).toBe(true);
    setOpen(true);
    await flush();
    const make = (path: string, at: string) => ({
      base: { id: "home", name: "Home", area: "cloud" },
      entry: { path, name: "Notes", directory: false, size: 1, modified: at },
      markedAt: at,
    });
    apiRequests[1]!.resolve(Response.json([make("old/Notes", "2026-01-01T00:00:00Z"), make("new/Notes", new Date().toISOString())]));
    await flush();
    apiRequests[0]!.resolve(Response.json([]));
    await flush();
    const entries = [...dom.root.querySelectorAll<HTMLButtonElement>("button")];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.textContent).toContain("new/Notes");
    expect(entries[0]!.querySelector("time")).not.toBeNull();
    entries[0]!.click();
    await flush();
    expect(open()).toBe(false);
    expect(opened).toEqual(["new/Notes"]);
    const modal = openMarksDialog({ kind: "favorites", title: "Favorites", onOpen: (entry) => opened.push(entry.entry.path) });
    await flush();
    expect(apiRequests[2]!.kind).toBe("favorites");
    const loadingViewport = dom.document.querySelector("dialog .k2b-scroll-area[data-viewport-size=compact]");
    expect(loadingViewport).not.toBeNull();
    apiRequests[2]!.resolve(Response.json([]));
    await flush();
    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog")!;
    expect(dialog.textContent).toContain("Mark files or folders as favorites");
    expect(dialog.querySelector(".k2b-scroll-area")).toBe(loadingViewport);
    dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }));
    await modal;
  });

  test("an unchanged current page still refreshes a visible expanded browser branch without navigation", async () => {
    const dom = createDomTestHarness();
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
    const interval = globalThis.setInterval;
    let poll: (() => void) | undefined;
    const timerSpy = spyOn(globalThis, "setInterval").mockImplementation((handler, delay, ...args) => {
      if (delay === 20_000 && typeof handler === "function") poll = handler;
      return interval(handler, delay, ...args);
    });
    const base = {
      id: "home",
      name: "Home",
      area: "cloud" as const,
      kind: "users" as const,
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const folder = { name: "Docs", path: "Docs", directory: true, size: 0, modified: "2026-01-01T00:00:00Z" };
    const directory = { base, path: "", items: [folder], next: null };
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const dispose = render(
      () =>
        createComponent(Workspace, {
          initial: { ...initial, bases: { items: [base], issues: [], editor: null }, selectedId: base.id, directory },
          cloudUrl: "https://cloud.test",
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      timerSpy.mockRestore();
      dom.cleanup();
    };
    await flush();
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
    await flush();
    dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
    await flush();
    expect(apiRequests).toHaveLength(1);
    apiRequests[0]!.resolve(
      Response.json({ ...directory, path: "Docs", items: [{ ...folder, name: "Old.txt", path: "Docs/Old.txt", directory: false }] }),
    );
    await flush();
    expect(dom.root.textContent).toContain("Old.txt");
    poll!();
    await flush();
    expect(apiRequests[1]!.input).toEqual({
      param: { baseId: "home" },
      query: { path: "", after: undefined, sort: "name", order: "asc", type: "all", groupFolders: "true" },
    });
    apiRequests[1]!.resolve(Response.json(directory));
    await flush();
    expect(apiRequests[2]!.input).toEqual({
      param: { baseId: "home" },
      query: { path: "Docs", after: undefined, sort: "name", order: "asc", type: "all", groupFolders: "true" },
    });
    apiRequests[2]!.resolve(
      Response.json({
        ...directory,
        path: "Docs",
        items: [{ ...folder, name: "External.txt", path: "Docs/External.txt", directory: false }],
      }),
    );
    await flush();
    expect(dom.root.textContent).toContain("External.txt");
    expect(dom.root.textContent).not.toContain("Old.txt");
    expect(apiRequests.map((item) => item.kind)).toEqual(["entries", "entries", "entries"]);
    expect(dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.getAttribute("aria-expanded")).toBe("true");
    poll!();
    await flush();
    const pending = apiRequests.at(-1)!;
    dispose();
    expect(pending.signal?.aborted).toBe(true);
  });

  test("a shares deep link remains account-scoped after its requested group disappears", async () => {
    const dom = createDomTestHarness();
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const dispose = render(() => createComponent(Workspace, { initial, cloudUrl: "https://cloud.test" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    dom.window.history.replaceState(null, "", "/app/filesv2?base=removed-group&view=shares");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    apiRequests[0]!.resolve(Response.json(initial.bases));
    await flush();
    expect(apiRequests[1]!.kind).toBe("shares");
    apiRequests[1]!.resolve(Response.json({ items: [], next: null }));
    await flush();
    expect(dom.root.querySelector("h1")?.textContent).toBe("Shares");
    expect(dom.root.textContent).not.toContain("This directory is missing");
  });

  test("unchanged root polling refreshes an expanded sidebar's children without fetching collapsed descendants", async () => {
    const dom = createDomTestHarness();
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
    const interval = globalThis.setInterval;
    let poll: (() => void) | undefined;
    const timerSpy = spyOn(globalThis, "setInterval").mockImplementation((handler, delay, ...args) => {
      if (delay === 20_000 && typeof handler === "function") poll = handler;
      return interval(handler, delay, ...args);
    });
    const base = {
      id: "home",
      name: "Home",
      area: "cloud" as const,
      kind: "users" as const,
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const folder = { name: "Docs", path: "Docs", directory: true, size: 0, modified: "2026-01-01T00:00:00Z" };
    const bases = { items: [base], issues: [], editor: null };
    const directory = { base, path: "", items: [folder], next: null };
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const dispose = render(
      () => createComponent(Workspace, { initial: { ...initial, bases, selectedId: base.id, directory }, cloudUrl: "https://cloud.test" }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      timerSpy.mockRestore();
      dom.cleanup();
    };
    await flush();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/filesv2?base=home&path=Docs"]')!.click();
    await flush();
    apiRequests[0]!.resolve(Response.json(bases));
    await flush();
    apiRequests[1]!.resolve(
      Response.json({ ...directory, path: "Docs", items: [{ ...folder, name: "Old nested folder", path: "Docs/Old" }] }),
    );
    await flush();
    dom.root.querySelector<HTMLAnchorElement>('a[href="/app/filesv2?base=home"]')!.click();
    await flush();
    apiRequests[2]!.resolve(Response.json(bases));
    await flush();
    apiRequests[3]!.resolve(Response.json(directory));
    await flush();
    const docs = [...dom.root.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]")].find(
      (node) => node.getAttribute("data-k2b-nav-tree-id") === JSON.stringify(["home", null, "Docs"]),
    )!;
    docs.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();
    expect(docs.getAttribute("aria-expanded")).toBe("true");
    const before = apiRequests.length;
    poll!();
    await flush();
    apiRequests[before]!.resolve(Response.json(directory));
    await flush();
    expect(apiRequests[before + 1]!.input).toEqual({
      param: { baseId: "home" },
      query: { path: "Docs", after: undefined, type: "directories" },
    });
    apiRequests[before + 1]!.resolve(
      Response.json({ ...directory, path: "Docs", items: [{ ...folder, name: "External nested folder", path: "Docs/External" }] }),
    );
    await flush();
    expect(dom.root.querySelector('[role="tree"]')!.textContent).toContain("External nested folder");
    expect(dom.root.querySelector('[role="tree"]')!.textContent).not.toContain("Old nested folder");
    expect(apiRequests).toHaveLength(before + 2);
    const root = [...dom.root.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]")].find(
      (node) => node.getAttribute("data-k2b-nav-tree-id") === JSON.stringify(["home", null, ""]),
    )!;
    root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await flush();
    poll!();
    await flush();
    apiRequests[before + 2]!.resolve(Response.json(directory));
    await flush();
    expect(apiRequests).toHaveLength(before + 3);
  });

  test("expired listing cursors restart once with the exact global query and visible feedback", async () => {
    const dom = createDomTestHarness();
    const base = {
      id: "home",
      name: "Home",
      area: "cloud" as const,
      kind: "users" as const,
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const directory = { base, path: "", items: [], next: null };
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const dispose = render(
      () =>
        createComponent(Workspace, {
          initial: { ...initial, bases: { items: [base], issues: [], editor: null }, selectedId: base.id, directory },
          cloudUrl: "https://cloud.test",
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    for (const request of apiRequests) request.resolve(Response.json(directory));
    await flush();
    apiRequests.length = 0;
    dom.window.history.replaceState({}, "", "/app/filesv2?base=home&after=expired&sort=size&order=desc&type=files&groupFolders=false");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    apiRequests[0]!.resolve(Response.json({ items: [base], issues: [], editor: null }));
    await flush();
    expect(apiRequests[1]!.input).toEqual({
      param: { baseId: "home" },
      query: { path: "", after: "expired", sort: "size", order: "desc", type: "files", groupFolders: "false" },
    });
    apiRequests[1]!.resolve(Response.json({ code: "cursor_invalid", message: "Listing changed" }, { status: 409 }));
    await flush();
    expect(apiRequests[2]!.kind).toBe("bases");
    apiRequests[2]!.resolve(Response.json({ items: [base], issues: [], editor: null }));
    await flush();
    expect(apiRequests[3]!.input).toEqual({
      param: { baseId: "home" },
      query: { path: "", after: undefined, sort: "size", order: "desc", type: "files", groupFolders: "false" },
    });
    apiRequests[3]!.resolve(Response.json(directory));
    await flush();
    expect(dom.window.location.search).not.toContain("after=");
    expect(dom.window.location.search).toContain("groupFolders=false");
    expect(dom.root.textContent).toContain("This folder changed. Showing the first page again.");
    // A separate directory-only read supplies the sidebar; it cannot reuse the file-filtered page.
    expect(apiRequests[4]!.input).toEqual({ param: { baseId: "home" }, query: { path: "", after: undefined, type: "directories" } });
    apiRequests[4]!.resolve(Response.json(directory));
    await flush();
    expect(apiRequests).toHaveLength(5);
  });
});
