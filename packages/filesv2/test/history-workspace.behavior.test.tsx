import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BaseSummary, DirectoryResult, FileEntry, ShareView } from "../src/contracts";
import type { WorkspaceSnapshot } from "../src/frontend/workspace-state";
import { chain, current, entry, gone, page, snapshot } from "./history-fixtures";

/*
 * The history wired into the real Files workspace: navigation, address state, SSR snapshots, old addresses and the
 * detail. Requests stay pending until a test answers them, so every transition is observed in order.
 */
type ApiRequest = { kind: string; input?: unknown; settled?: boolean; resolve: (response: Response) => void };
const apiRequests: ApiRequest[] = [];
if (!isServer) {
  mock.module("@k2b/cloud/browser/search", () => ({ openGlobalSearch: () => {} }));
  const request = (kind: string) => (input?: unknown) =>
    new Promise<Response>((resolve) => {
      const entry: ApiRequest = {
        kind,
        input,
        resolve: (response) => {
          entry.settled = true;
          resolve(response);
        },
      };
      apiRequests.push(entry);
    });
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        $get: request("bases"),
        ":baseId": {
          entries: { $get: request("entries") },
          search: { $get: request("search") },
          entry: { $get: request("entry") },
          versions: { $get: request("versions"), restore: { $post: request("version-restore") } },
          trash: { $get: request("trash") },
          thumbnail: { $post: request("thumbnail") },
        },
      },
      entries: { ":id": { $get: request("entry-by-id") } },
      activity: {
        $get: request("activity"),
        ":activityId": {
          chain: { $get: request("chain") },
          recovery: { $get: request("recovery") },
          restore: { $post: request("restore") },
          "move-back": { $post: request("move-back") },
          recheck: { $post: request("recheck") },
        },
      },
      shares: {
        $get: request("shares"),
        ":shareId": { access: { $get: request("share-access") } },
        ":id": { revoke: { $post: request("revoke") } },
      },
      admin: { shares: { ":id": { revoke: { $post: request("admin-revoke") } } } },
      recent: { $get: request("recent") },
      favorites: { $get: request("favorites") },
    },
  }));
}

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { Workspace: (await import("../src/frontend/Workspace.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const pending = (kind: string) => {
  const found = [...apiRequests].reverse().find((request) => request.kind === kind && !request.settled);
  if (!found) throw new Error(`no pending ${kind} request; saw ${apiRequests.map((request) => request.kind).join(", ")}`);
  return found;
};

// Fictional storage of the approved mockup; the base ID has the canonical shape stable refs require.
const home: BaseSummary = {
  id: "cloud:groups:0b4c9a52-5f7e-4c47-9d2e-6c1f1f0a7b11",
  area: "cloud",
  kind: "groups",
  name: "Team Vertrieb",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
  stableIds: true,
};
const bases = { items: [home], issues: [], editor: null };
const NOW = "2026-10-20T12:30:00.000Z";
const snapshotOf = (patch: Partial<WorkspaceSnapshot> & Pick<WorkspaceSnapshot, "source">): WorkspaceSnapshot => ({
  bases,
  selectedId: home.id,
  directory: null,
  errorCode: null,
  now: NOW,
  ...patch,
});
const query = (request: ApiRequest) => (request.input as { query?: Record<string, string> } | undefined)?.query ?? {};

describe("Files history in the workspace", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    apiRequests.length = 0;
  });
  const mount = (initial: WorkspaceSnapshot) => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", initial.source);
    const dispose = render(
      () => createComponent(modules!.Workspace, { initial, cloudUrl: "https://cloud.test", timeZone: "Europe/Berlin", retentionDays: 365 }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return dom;
  };
  const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")].find((element) => element.textContent?.trim() === label);

  test("Activity renders its SSR page without a request and keeps its filters in the address across change and back", async () => {
    const moved = entry({
      action: "item.move",
      before: gone("vertrieb/Kunden/Messe 2026"),
      after: current("vertrieb/Projekte/Messe 2026", { itemId: "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6" }),
    });
    const source = `/app/filesv2?view=activity&base=${encodeURIComponent(home.id)}`;
    const dom = mount(snapshotOf({ source, activity: { filters: { baseId: home.id }, page: page([moved]) } }));
    await flush();
    expect(apiRequests).toHaveLength(0);
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(main().textContent).toContain("Lukas Pohl");
    expect(main().textContent).toContain("Messe 2026");
    // Activity is one of the places across all storage, above the storage tree, and marked as the current view.
    const activityLink = button(dom.root.querySelector(".k2b-app-workspace__sidebar-section")!, "Activity");
    expect(activityLink?.getAttribute("href")).toBe(source);

    // Resetting the filters writes the address at once; the list reloads in place and keeps the new filters.
    button(main(), "Reset")!.click();
    await flush();
    expect(dom.window.location.search).toBe("?view=activity");
    expect(pending("activity").input).toEqual({ query: {} });
    pending("activity").resolve(Response.json(page([])));
    await flush();
    expect(main().textContent).toContain("No activity yet");

    // Back loads the earlier address and its filters return with it.
    dom.window.history.replaceState(null, "", source);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    pending("bases").resolve(Response.json(bases));
    await flush();
    expect(query(pending("activity"))).toEqual({ baseId: home.id });
    pending("activity").resolve(Response.json(page([moved])));
    await flush();
    expect(main().textContent).toContain("Messe 2026");
    expect(dom.window.location.search).toBe(`?view=activity&base=${encodeURIComponent(home.id)}`);
  });

  test("a failed Activity load keeps its filters beside Try again, and an empty page with more pages claims nothing", async () => {
    const source = `/app/filesv2?view=activity&base=${encodeURIComponent(home.id)}&when=7`;
    const dom = mount(snapshotOf({ source }));
    await flush();
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(query(pending("activity")).baseId).toBe(home.id);
    expect(query(pending("activity")).from).toBe("2026-10-13T12:30:00.000Z");
    pending("activity").resolve(Response.json({ code: "unavailable", message: "Storage unavailable" }, { status: 503 }));
    await flush();
    expect(main().textContent).toContain("The activity could not be loaded");
    expect(dom.window.location.search).toContain("when=7");
    button(main(), "Try again")!.click();
    await flush();
    pending("activity").resolve(Response.json(page([], "cursor-2")));
    await flush();
    // Nothing visible on this page proves nothing about older pages.
    expect(main().textContent).not.toContain("No entries for these filters");
    expect(main().textContent).toContain("Nothing matching so far");
    button(main(), "Load older entries")!.click();
    await flush();
    expect(query(pending("activity")).cursor).toBe("cursor-2");
  });

  test("an empty ordinary search offers the same words in the history", async () => {
    const directory: DirectoryResult & { query: string } = { base: home, path: "", items: [], next: null, query: "Angebote 2025" };
    const dom = mount(snapshotOf({ source: `/app/filesv2?base=${encodeURIComponent(home.id)}&q=Angebote+2025`, directory }));
    await flush();
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(main().textContent).toContain("No matches for “Angebote 2025”");
    button(main(), "Search in history")!.click();
    await flush();
    pending("bases").resolve(Response.json(bases));
    await flush();
    expect(dom.window.location.search).toBe("?view=activity&q=Angebote+2025");
    expect(query(pending("activity"))).toEqual({ q: "Angebote 2025" });
    const trashed = entry({ action: "item.trash", before: gone("vertrieb/Kunden/Angebote 2025") });
    pending("activity").resolve(Response.json(page([trashed])));
    await flush();
    expect(main().textContent).toContain("1 match in history");
    expect(main().textContent).toContain("In trash");
  });

  test("an old folder address names where the folder went and opens it only after a fresh check", async () => {
    const itemId = "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
    const moved = entry({
      action: "item.move",
      via: "agent",
      before: gone("vertrieb/Kunden/Angebote 2025"),
      after: current("vertrieb/Archiv/2025/Angebote 2025", { itemId }),
    });
    const movedChain = chain({ endpoint: { baseId: home.id, path: "Archiv/2025/Angebote 2025", itemId }, certainty: "verified" });
    const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=${encodeURIComponent("Kunden/Angebote 2025")}`;
    const dom = mount(snapshotOf({ source, moved: { baseId: home.id, path: "Kunden/Angebote 2025", entry: moved, chain: movedChain } }));
    await flush();
    expect(apiRequests).toHaveLength(0);
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(main().textContent).toContain("This folder has moved");
    expect(main().textContent).toContain("Team Vertrieb › Archiv › 2025");
    expect(main().textContent).toContain("Team Vertrieb › Kunden › Angebote 2025");
    expect(button(main(), "View history")!.getAttribute("href")).toBe("/app/filesv2?view=activity&q=Angebote+2025");
    button(main(), "Go there")!.click();
    await flush();
    expect(pending("entry-by-id").input).toEqual({ param: { id: `n:${home.id}:${itemId}` } });
    const folder: FileEntry = { name: "Angebote 2025", path: "Archiv/2025/Angebote 2025", directory: true, size: 0, modified: NOW };
    pending("entry-by-id").resolve(Response.json({ base: home, entry: folder }));
    await flush();
    pending("bases").resolve(Response.json(bases));
    await flush();
    pending("entries").resolve(Response.json({ base: home, path: folder.path, items: [], next: null }));
    await flush();
    expect(new URL(dom.window.location.href).searchParams.get("path")).toBe("Archiv/2025/Angebote 2025");
  });

  test("a client navigation to a vanished folder uses the same history lookup and stays an error without one", async () => {
    const directory = { base: home, path: "", items: [], next: null };
    const dom = mount(snapshotOf({ source: `/app/filesv2?base=${encodeURIComponent(home.id)}`, directory }));
    await flush();
    const old = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=Kunden`;
    dom.window.history.replaceState(null, "", old);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    pending("bases").resolve(Response.json(bases));
    await flush();
    pending("entries").resolve(Response.json({ code: "not_found", message: "Not found" }, { status: 404 }));
    await flush();
    expect(query(pending("activity"))).toEqual({ baseId: home.id, path: "Kunden", scope: "item" });
    // Without an approved relative path, even an apparent ancestor cannot scope the opened old address.
    const ancestor = entry({ action: "item.move", before: snapshot("vertrieb"), after: snapshot("archiv/vertrieb") });
    pending("activity").resolve(Response.json(page([ancestor])));
    await flush();
    expect(apiRequests.some((request) => request.kind === "chain")).toBe(false);
    expect(dom.root.querySelector(".k2b-app-workspace__main")!.textContent).not.toContain("has moved");
  });

  test("SSR and client old-descendant notices agree, pass the old path, and never open the ancestor", async () => {
    setSystemTime(new Date(NOW));
    try {
      const oldPath = "Kunden/Angebote";
      const moved = entry({
        action: "item.move",
        before: gone("opaque/base/Kunden", { directory: true, relativePath: "Kunden" }),
        after: current("opaque/base/Archiv/Kunden", { itemId: "ancestor-id" }),
      });
      const endpoint = { baseId: home.id, path: "Archiv/Kunden/Angebote", itemId: null };
      const movedChain = chain({ endpoint, certainty: "probable" });
      const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=${encodeURIComponent(oldPath)}`;
      const dom = mount(snapshotOf({ source, moved: { baseId: home.id, path: oldPath, entry: moved, chain: movedChain } }));
      await flush();
      const notice = () => dom.root.querySelector(".filesv2-history-moved")!;
      const initialText = notice().textContent;
      expect(initialText).toContain("“Angebote” is probably now in Team Vertrieb › Archiv › Kunden");
      expect(apiRequests).toHaveLength(0);
      expect(dom.window.location.search).toBe(new URL(source, "https://files.test").search);
      expect(button(notice(), "Move back")).toBeUndefined();
      // Navigate away and back: the browser must ask the same question as SSR, including the descendant path.
      dom.window.history.replaceState(null, "", `/app/filesv2?base=${encodeURIComponent(home.id)}`);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await flush();
      pending("bases").resolve(Response.json(bases));
      await flush();
      pending("entries").resolve(Response.json({ base: home, path: "", items: [], next: null }));
      await flush();
      dom.window.history.replaceState(null, "", source);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await flush();
      pending("bases").resolve(Response.json(bases));
      await flush();
      pending("entries").resolve(Response.json({ code: "not_found", message: "Not found" }, { status: 404 }));
      await flush();
      expect(query(pending("activity"))).toEqual({ baseId: home.id, path: oldPath, scope: "item" });
      pending("activity").resolve(Response.json(page([moved])));
      await flush();
      expect(pending("chain").input).toEqual({ param: { activityId: moved.id }, query: { oldPath } });
      pending("chain").resolve(Response.json(movedChain));
      await flush();
      expect(notice().textContent).toBe(initialText);
      expect(apiRequests.some((request) => request.kind === "entry-by-id" || request.kind === "entry")).toBe(false);
      expect(dom.window.location.search).toBe(new URL(source, "https://files.test").search);
      button(notice(), "Go there")!.click();
      await flush();
      // Navigation rechecks the child path; the ancestor stable ID never enters an entry request.
      expect(pending("entry").input).toEqual({ param: { baseId: home.id }, query: { path: endpoint.path } });
      expect(apiRequests.some((request) => request.kind === "entry-by-id")).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test("the file detail shows its SSR history under the versions and numbers versions the list holds", async () => {
    const file: FileEntry = { name: "Proof.bin", path: "Kunden/Proof.bin", directory: false, size: 3_400_000, modified: NOW };
    const directory = { base: home, path: "Kunden", items: [file], next: null };
    const restored = entry({
      action: "version.restore",
      actor: { kind: "user", userId: "mia", name: "Mia Schulz" },
      after: {
        ...(current(file.path, { directory: false }) as Extract<ReturnType<typeof current>, { visibility: "full" }>),
        versionId: "v-1",
      },
    });
    const request = { baseId: home.id, path: file.path, scope: "item" as const };
    const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=Kunden&file=${encodeURIComponent(file.path)}`;
    const dom = mount(
      snapshotOf({
        source,
        directory,
        detail: { base: home, entry: file },
        history: { source: JSON.stringify(request), page: page([restored]) },
      }),
    );
    await flush();
    expect(apiRequests.some((item) => item.kind === "activity")).toBe(false);
    const inspector = () => dom.root.querySelector("#filesv2-inspector, [id*='filesv2-inspector']")!;
    expect(inspector().textContent).toContain("Mia Schulz");
    expect(button(inspector(), "All in Activity")!.getAttribute("href")).toBe(
      `/app/filesv2?view=activity&base=${encodeURIComponent(home.id)}&path=Kunden%2FProof.bin`,
    );
    pending("versions").resolve(
      Response.json([
        { id: "v-2", created: "2026-10-19T15:20:00.000Z", size: 1, pinned: false, comment: null, author: null },
        { id: "v-1", created: "2026-10-13T08:30:00.000Z", size: 1, pinned: false, comment: null, author: null },
      ]),
    );
    pending("shares").resolve(Response.json({ items: [], next: null }));
    await flush();
    expect(inspector().textContent).toContain("Version 1");
    expect(inspector().textContent).toContain("Version 2 ·");
  });
  test("item links preserve server matching, page past 50 and retry a failed page without losing loaded links", async () => {
    const file: FileEntry = { name: "Proof.bin", path: "Kunden/Proof.bin", directory: false, size: 3, modified: NOW };
    const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=Kunden&file=${encodeURIComponent(file.path)}`;
    const request = { baseId: home.id, path: file.path, scope: "item" as const };
    const dom = mount(
      snapshotOf({
        source,
        directory: { base: home, path: "Kunden", items: [file], next: null },
        detail: { base: home, entry: file },
        history: { source: JSON.stringify(request), page: page([]) },
      }),
    );
    await flush();
    const inspector = () => dom.root.querySelector("#filesv2-inspector, [id*='filesv2-inspector']")!;
    expect(query(pending("shares"))).toEqual({ baseId: home.id, path: file.path });
    pending("shares").resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
    await flush();
    expect(inspector().querySelector('[role="alert"]')?.textContent).toContain("could not");
    button(inspector(), "Try again")!.click();
    await flush();
    expect(query(pending("shares"))).toEqual({ baseId: home.id, path: file.path });
    const link = (index: number): ShareView => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Link ${index}`,
      kind: "download",
      managementMode: "admin",
      passwordProtected: false,
      url: null,
      note: null,
      publicNote: null,
      base: { id: home.id, name: "Team Vertrieb" },
      scope: "Old",
      items: ["Old/Proof.bin"],
      createdBy: "Current creator",
      createdAt: NOW,
      expiresAt: null,
      state: "active",
      accessCount: 0,
      lastAccessedAt: null,
      maxFileSize: 1,
      maxTotalSize: 1,
      showUploadNames: false,
    });
    const after = "10000000-0000-4000-8000-000000000050";
    pending("shares").resolve(Response.json({ items: Array.from({ length: 50 }, (_, i) => link(i + 1)), next: after }));
    await flush();
    expect(inspector().querySelectorAll(".filesv2-share-facts")).toHaveLength(50);
    button(inspector(), "Load more")!.click();
    await flush();
    expect(query(pending("shares"))).toEqual({ baseId: home.id, path: file.path, after });
    pending("shares").resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
    await flush();
    expect(inspector().querySelectorAll(".filesv2-share-facts")).toHaveLength(50);
    button(inspector(), "Try again")!.click();
    await flush();
    expect(query(pending("shares"))).toEqual({ baseId: home.id, path: file.path, after });
    pending("shares").resolve(Response.json({ items: [link(51)], next: null }));
    await flush();
    expect(inspector().querySelectorAll(".filesv2-share-facts")).toHaveLength(51);
    expect(inspector().textContent).toContain("Link 51");
    expect(button(inspector(), "Load more")).toBeUndefined();
    // Management mode came from the service. Both routes still recheck authority on the server.
    const { revokeShare } = await import("../src/frontend/history-api");
    const revoked = revokeShare(link(51), "Failed");
    expect(pending("admin-revoke").input).toEqual({ param: { id: link(51).id } });
    pending("admin-revoke").resolve(Response.json({ ...link(51), state: "revoked" }));
    await revoked;
    const own = { ...link(1), managementMode: "creator" as const };
    const ownRevoke = revokeShare(own, "Failed");
    expect(pending("revoke").input).toEqual({ param: { id: own.id } });
    pending("revoke").resolve(Response.json({ ...own, state: "revoked" }));
    await ownRevoke;
  });
  test("restoring a trashed hit goes through the recovery endpoint and shows a refusal beside the action", async () => {
    const trashed = entry({
      action: "item.trash",
      before: gone("vertrieb/Kunden/Angebote 2025", { directory: true, publicBaseId: home.id }),
    });
    const source = "/app/filesv2?view=activity&q=Angebote+2025";
    const dom = mount(snapshotOf({ source, selectedId: null, activity: { filters: { q: "Angebote 2025" }, page: page([trashed]) } }));
    await flush();
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(pending("recovery").input).toEqual({ param: { activityId: trashed.id } });
    expect(button(main(), "Restore")).toBeUndefined();
    const trash = { baseId: home.id, id: "33333333-3333-4333-8333-333333333333", canRestore: true };
    pending("recovery").resolve(Response.json({ oldLocation: { baseId: home.id, path: "Kunden" }, trash, canMoveBack: false }));
    await flush();
    button(main(), "Restore")!.click();
    await flush();
    expect(pending("restore").input).toEqual({ param: { activityId: trashed.id }, json: {} });
    pending("restore").resolve(Response.json({ code: "forbidden", message: "You may not write to Kunden." }, { status: 403 }));
    await flush();
    expect(main().querySelector('[role="alert"]')?.textContent).toContain("You may not write to Kunden.");
    // The trash of the storage the server named stays one step away.
    button(main(), "Show in trash")!.click();
    await flush();
    pending("bases").resolve(Response.json(bases));
    await flush();
    expect(dom.window.location.search).toBe(`?base=${encodeURIComponent(home.id)}&view=trash`);
  });

  test("an overwrite that produced the current revision restores the newest retained version with the existing endpoint", async () => {
    const file: FileEntry = { name: "Proof.bin", path: "Kunden/Proof.bin", directory: false, size: 1, modified: NOW, revision: "rev-3" };
    const directory = { base: home, path: "Kunden", items: [file], next: null };
    const overwrite = entry({
      action: "file.overwrite",
      via: "office",
      actor: { kind: "user", userId: "mia", name: "Mia Schulz" },
      after: {
        ...(current(file.path, { directory: false }) as Extract<ReturnType<typeof current>, { visibility: "full" }>),
        revision: "rev-3",
      },
    });
    const older = entry({
      action: "file.overwrite",
      after: {
        ...(current(file.path, { directory: false }) as Extract<ReturnType<typeof current>, { visibility: "full" }>),
        revision: "rev-2",
      },
    });
    const request = { baseId: home.id, path: file.path, scope: "item" as const };
    const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=Kunden&file=${encodeURIComponent(file.path)}`;
    const dom = mount(
      snapshotOf({
        source,
        directory,
        detail: { base: home, entry: file },
        history: { source: JSON.stringify(request), page: page([overwrite, older]) },
      }),
    );
    await flush();
    const inspector = () => dom.root.querySelector("#filesv2-inspector, [id*='filesv2-inspector']")!;
    // Before the version list arrives, nothing claims a number.
    expect(button(inspector(), "Restore version 2")).toBeUndefined();
    pending("versions").resolve(
      Response.json([
        { id: "v-1", created: "2026-10-13T08:30:00.000Z", size: 1, pinned: false, comment: null, author: null },
        { id: "v-2", created: "2026-10-19T15:20:00.000Z", size: 1, pinned: false, comment: null, author: null },
      ]),
    );
    pending("shares").resolve(Response.json({ items: [], next: null }));
    await flush();
    expect(inspector().textContent).toContain("Version 3");
    // Only the change that produced today's revision offers a restore; an older overwrite names no version.
    expect([...inspector().querySelectorAll("button")].filter((item) => item.textContent?.trim() === "Restore version 2")).toHaveLength(1);
    button(inspector(), "Restore version 2")!.click();
    await flush();
    expect(pending("version-restore").input).toEqual({ param: { baseId: home.id }, json: { path: file.path, id: "v-2" } });
  });
});
