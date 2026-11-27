import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
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
      activity: { $get: request("activity") },
      bases: {
        $get: request("bases"),
        ":baseId": { entries: { $get: request("entries") }, trash: { $get: request("trash") }, favorite: { $post: request("favorite") } },
      },
    },
  }));
}

// Load once, after the module mocks and outside any test, so the cold Solid transform of the workspace's source graph
// does not count against the 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      Workspace: (await import("../src/frontend/Workspace.island")).default,
      ui: await import("@k2b/ui"),
      derivePageTrail: (await import("@k2b/cloud/ssr/page-trail")).derivePageTrail,
      snapshotTitle: (await import("../src/frontend/trail")).snapshotTitle,
      PAGE_UP_EVENT: (await import("@k2b/cloud/ssr/layout-runtime")).PAGE_UP_EVENT,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

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

  test("a failing section stays inside the overview and retries; tiles and the way into storage keep working", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", "/app/filesv2");
    const { Workspace } = modules!;
    const base = {
      id: "home",
      name: "Alice",
      area: "cloud" as const,
      kind: "users" as const,
      status: "existing" as const,
      reason: null,
      indexEnabled: false,
      versioningEnabled: false,
    };
    const group = { ...base, id: "ipa", name: "Team", area: "freeipa" as const, kind: "groups" as const };
    const bases = { items: [base, group], issues: [{ area: "freeipa" as const, code: "unavailable" }], editor: null };
    const dispose = render(() => createComponent(Workspace, { initial: { ...initial, source: "/app/filesv2", bases } }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    // The storage entries come from the bases alone; favorites and "Recently by you" ask for themselves.
    expect(dom.root.querySelectorAll(".k2b-link-card")).toHaveLength(2);
    expect(apiRequests.map((request) => request.kind)).toEqual(["favorites", "activity", "recent"]);
    expect(dom.root.querySelectorAll(".filesv2-overview__skeleton-card")).toHaveLength(6);
    const unavailable = () => Response.json({ code: "unavailable", message: "Storage unavailable" }, { status: 503 });
    apiRequests[0]!.resolve(unavailable());
    apiRequests[1]!.resolve(unavailable());
    apiRequests[2]!.resolve(Response.json([]));
    await flush();
    expect(dom.root.querySelectorAll(".k2b-link-card")).toHaveLength(2);
    const sections = [...dom.root.querySelectorAll(".filesv2-overview__section")];
    expect(sections.map((section) => !!section.querySelector('.k2b-placeholder[data-state="error"]'))).toEqual([true, false, true]);
    for (const section of [sections[0]!, sections[2]!])
      [...section.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Try again"))!.click();
    await flush();
    expect(apiRequests.slice(3).map((request) => request.kind)).toEqual(["favorites", "activity", "recent"]);
    apiRequests[3]!.resolve(Response.json([]));
    apiRequests[4]!.resolve(Response.json({ items: [], next: null, visibleCount: 0, batches: [], exhausted: true }));
    apiRequests[5]!.resolve(Response.json([]));
    await flush();
    expect(dom.root.querySelector('.filesv2-overview .k2b-placeholder[data-state="error"]')).toBeNull();
    expect(sections[0]!.textContent).toContain("No favorites yet.");
    expect(sections[2]!.textContent).toContain("No activity of yours yet.");
    expect(dom.root.querySelectorAll(".k2b-link-card")).toHaveLength(2);
  });

  test("the favorites page loads, opens, removes at once and brings a favorite back when removing fails", async () => {
    const dom = createDomTestHarness();
    const { default: FavoritesPage } = await import("../src/frontend/FavoritesPage");
    const { LocaleProvider } = modules!.ui;
    const opened: string[] = [];
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(FavoritesPage, {
              initial: null,
              bases: [{ id: "home", label: "Persönlich" }],
              timeZone: "Europe/Berlin",
              now: "2026-10-20T12:30:00.000Z",
              onOpen: (entry) => opened.push(entry.entry.path),
            });
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(apiRequests.map((request) => request.kind)).toEqual(["favorites"]);
    expect(dom.root.querySelectorAll(".filesv2-favorites__skeleton-row")).toHaveLength(6);
    const make = (path: string) => ({
      base: { id: "home", name: "Home", kind: "users", area: "cloud" },
      entry: { path, name: path.split("/").at(-1), directory: false, size: 1, modified: "2026-10-20T10:00:00.000Z" },
      markedAt: "2026-10-20T10:00:00.000Z",
    });
    apiRequests[0]!.resolve(Response.json([make("Planung/Budget.xlsx"), make("Notizen.md")]));
    await flush();
    expect(dom.root.textContent).toContain("Budget.xlsx");
    expect(dom.root.textContent).toContain("Persönlich / Planung · heute, 12:00");
    [...dom.root.querySelectorAll<HTMLElement>(".k2b-file-grid__row")]
      .find((row) => row.textContent?.includes("Budget.xlsx"))!
      .querySelector<HTMLButtonElement>(".k2b-file-grid__open")!
      .click();
    expect(opened).toEqual(["Planung/Budget.xlsx"]);
    const star = () => [...dom.root.querySelectorAll<HTMLButtonElement>('button[aria-label="Aus Favoriten entfernen"]')];
    star()[0]!.click();
    await flush();
    // Gone at once; the failed request brings it back.
    expect(dom.root.textContent).not.toContain("Budget.xlsx");
    expect(apiRequests[1]!.kind).toBe("favorite");
    expect(apiRequests[1]!.input).toEqual({ param: { baseId: "home" }, json: { path: "Planung/Budget.xlsx", favorite: false } });
    apiRequests[1]!.resolve(Response.json({ code: "unavailable", message: "Storage unavailable" }, { status: 503 }));
    await flush();
    expect(dom.root.textContent).toContain("Budget.xlsx");
    for (const button of star()) button.click();
    await flush();
    for (const request of apiRequests.slice(2)) request.resolve(Response.json({ favorite: false }));
    await flush();
    expect(dom.root.textContent).toContain("Noch keine Favoriten");
  });

  test("a shares deep link remains account-scoped after its requested group disappears", async () => {
    const dom = createDomTestHarness();
    const { Workspace } = modules!;
    const dispose = render(() => createComponent(Workspace, { initial }), dom.root);
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
    expect(dom.root.querySelector("h1:not(.k2b-app-workspace__head-heading)")?.textContent).toBe("Shares");
    expect(dom.root.textContent).not.toContain("This directory is missing");
  });

  test("the way up moves between folders in place, so uploads and the editor guard keep working", async () => {
    const dom = createDomTestHarness();
    const source = "/app/filesv2?base=home&path=Documents%2FReports";
    dom.window.history.replaceState(null, "", source);
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
    const bases = { items: [base], issues: [], editor: null };
    const directory = (path: string) => ({ base, path, items: [], next: null });
    const { Workspace, PAGE_UP_EVENT } = modules!;
    const dispose = render(
      () =>
        createComponent(Workspace, {
          initial: { ...initial, source, bases, selectedId: base.id, directory: directory("Documents/Reports") },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    // Every read answers with its own folder, as the server would.
    const serve = async () => {
      for (let round = 0; round < 5; round++) {
        await flush();
        for (const request of apiRequests.splice(0)) {
          const path = (request.input as { query?: { path?: string } } | undefined)?.query?.path ?? "";
          request.resolve(Response.json(request.kind === "bases" ? bases : directory(path)));
        }
      }
    };
    await serve();
    const up = (href: string) => {
      const event = new dom.window.CustomEvent(PAGE_UP_EVENT, { cancelable: true, detail: { href } });
      dom.window.dispatchEvent(event);
      return event;
    };
    // Another app's page is no folder: Cloud loads it.
    expect(up("/app/mail").defaultPrevented).toBe(false);
    expect(up("/app/filesv2?base=home&path=Documents").defaultPrevented).toBe(true);
    await serve();
    expect(dom.window.location.search).toBe("?base=home&path=Documents");
  });
});
