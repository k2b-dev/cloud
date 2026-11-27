import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BaseSummary, FileEntry } from "../src/contracts";
import type { WorkspaceSnapshot } from "../src/frontend/workspace-state";
import { chain, current, entry, gone, page } from "./history-fixtures";

/*
 * The history wired into the real Files workspace: navigation, address state, SSR snapshots, old addresses and the
 * detail. Requests stay pending until a test answers them, so every transition is observed in order.
 */
type ApiRequest = { kind: string; input?: unknown; signal?: AbortSignal; settled?: boolean; resolve: (response: Response) => void };
const apiRequests: ApiRequest[] = [];
if (!isServer) {
  mock.module("@k2b/cloud/browser/search", () => ({ openGlobalSearch: () => {} }));
  const request = (kind: string) => (input?: unknown, options?: { init?: { signal?: AbortSignal } }) =>
    new Promise<Response>((resolve) => {
      const entry: ApiRequest = {
        kind,
        input,
        signal: options?.init?.signal,
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
          versions: {
            $get: request("versions"),
            restore: { $post: request("version-restore") },
            comment: { $post: request("version-comment") },
          },
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
// The detail reads its file again after a version list; this answers that read with the state it found.
const query = (request: ApiRequest) => (request.input as { query?: Record<string, string> } | undefined)?.query ?? {};

describe("Files history in the workspace", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  beforeEach(() => setSystemTime(new Date(NOW)));
  afterEach(() => {
    cleanup();
    apiRequests.length = 0;
    setSystemTime();
  });
  const mount = (initial: WorkspaceSnapshot) => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", initial.source);
    const dispose = render(() => createComponent(modules!.Workspace, { initial, timeZone: "Europe/Berlin", retentionDays: 365 }), dom.root);
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
    expect(apiRequests.filter((request) => request.kind !== "entries")).toHaveLength(0);
    const main = () => dom.root.querySelector(".k2b-app-workspace__main")!;
    expect(main().textContent).toContain("Lukas Pohl");
    expect(main().textContent).toContain("Messe 2026");
    // Activity is one of the places across all storage, above the storage tree, and marked as the current view.
    const activityLink = button(dom.root.querySelector(".k2b-app-workspace__sidebar-section")!, "Activity");
    expect(activityLink?.getAttribute("href")).toBe(source);

    // Resetting the filters writes the address at once and leads back to "Me"; the list reloads in place.
    main().querySelector<HTMLButtonElement>(".filesv2-history-head__filters > .filesv2-history-link")!.click();
    await flush();
    expect(dom.window.location.search).toBe("?view=activity&who=me");
    expect(pending("activity").input).toEqual({ query: { actor: "me" } });
    pending("activity").resolve(Response.json(page([])));
    await flush();
    expect(main().textContent).toContain("No activity of yours yet");

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

  for (const sourceKind of ["current", "snapshot"] as const)
    for (const raced of [false, true])
      test(`Activity checks a ${sourceKind} version list with a ${raced ? "changed" : "stable"} revision`, async () => {
        const itemId = "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
        const raw = current("vertrieb/Old/Proof.txt", { itemId, directory: false });
        if (raw.visibility !== "full") throw new Error("fixture side must be full");
        const changed = entry({
          action: "file.overwrite",
          after: { ...raw, source: sourceKind, publicBaseId: home.id, revision: "revision-3" },
        });
        const source = "/app/filesv2?view=activity";
        const dom = mount(snapshotOf({ source, activity: { filters: {}, page: page([changed]) } }));
        await flush();
        expect(pending("entry-by-id").input).toEqual({ param: { id: `n:${home.id}:${itemId}` } });
        const file: FileEntry = {
          name: "Proof.txt",
          path: "Current/Proof.txt",
          directory: false,
          size: 24,
          modified: NOW,
          revision: "revision-3",
        };
        pending("entry-by-id").resolve(Response.json({ base: home, entry: file }));
        await flush();
        expect(query(pending("versions"))).toEqual({ path: "Current/Proof.txt" });
        pending("versions").resolve(
          Response.json([
            { id: "saved-2", created: "2026-10-19T12:00:00.000Z", size: 20, pinned: false, comment: null, author: null },
            { id: "saved-1", created: "2026-10-18T12:00:00.000Z", size: 10, pinned: false, comment: null, author: null },
          ]),
        );
        await flush();
        pending("entry-by-id").resolve(Response.json({ base: home, entry: raced ? { ...file, revision: "revision-4" } : file }));
        await flush();
        if (raced) {
          expect(dom.root.textContent).not.toContain("Version 3");
          expect(button(dom.root, "Restore version 2")).toBeUndefined();
          expect(apiRequests.some((item) => item.kind === "version-restore")).toBe(false);
          return;
        }
        expect(dom.root.textContent).toContain("Version 3");
        button(dom.root, "Restore version 2")!.click();
        await flush();
        expect(pending("version-restore").input).toEqual({
          param: { baseId: home.id },
          json: { path: "Current/Proof.txt", id: "saved-2", expectedRevision: "revision-3" },
        });
        pending("version-restore").resolve(Response.json({ code: "revision_conflict", message: "The file changed" }, { status: 409 }));
        await flush();
        expect(dom.root.textContent).toContain("The file changed");
        expect(apiRequests.some((item) => item.kind === "activity")).toBe(false);
      });

  for (const status of [403, 404, 503])
    test(`Activity version evidence handles a snapshot read returning ${status}`, async () => {
      const raw = current("vertrieb/Proof.txt", { itemId: "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6", directory: false });
      if (raw.visibility !== "full") throw new Error("fixture side must be full");
      const changed = entry({ action: "file.overwrite", after: { ...raw, source: "snapshot", publicBaseId: home.id, revision: "r3" } });
      const source = "/app/filesv2?view=activity";
      const dom = mount(snapshotOf({ source, activity: { filters: {}, page: page([changed]) } }));
      await flush();
      pending("entry-by-id").resolve(Response.json({ code: "unavailable", message: "Evidence unavailable" }, { status }));
      await flush();
      expect(dom.root.querySelector(".filesv2-history-row__error") !== null).toBe(status === 503);
      expect(button(dom.root, "Try again") !== undefined).toBe(status === 503);
      expect(apiRequests.some((request) => request.kind === "versions")).toBe(false);
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

  // Leaving by a link or by Back now loads the v2 folder page, which ends the lookup with this page; unmount stays here.
  for (const denied of [false, true]) {
    test(`a deferred history target cannot report an obsolete ${denied ? "error" : "result"} after unmount`, async () => {
      const { toast } = await import("@k2b/ui");
      const report = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
      try {
        const oldPath = "Kunden/Angebote";
        const targetPath = "Archiv/Angebote";
        const moved = entry({ action: "item.move", before: gone(`team/${oldPath}`), after: current(`team/${targetPath}`) });
        const source = `/app/filesv2?base=${encodeURIComponent(home.id)}&path=${encodeURIComponent(oldPath)}`;
        const dom = mount(
          snapshotOf({
            source,
            moved: {
              baseId: home.id,
              path: oldPath,
              entry: moved,
              chain: chain({ endpoint: { baseId: home.id, path: targetPath, itemId: null }, certainty: "verified" }),
            },
          }),
        );
        await flush();
        button(dom.root, "Go there")!.click();
        await flush();
        const resolving = pending("entry");
        expect(resolving.signal?.aborted).toBe(false);
        cleanup();
        cleanup = () => {};
        expect(resolving.signal?.aborted).toBe(true);
        const count = apiRequests.length;
        // The mock deliberately ignores abort, as a transport or a completed response may do.
        resolving.resolve(
          denied
            ? Response.json({ code: "forbidden", message: "Access changed" }, { status: 403 })
            : Response.json({ base: home, entry: { name: "Angebote", path: targetPath, directory: true, size: 0, modified: NOW } }),
        );
        await flush();
        expect(apiRequests).toHaveLength(count);
        expect(report).not.toHaveBeenCalled();
      } finally {
        report.mockRestore();
      }
    });
  }

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
});
