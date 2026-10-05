import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { fakeLiveConnection } from "../live-test-utils";

const domTest = isServer ? test.skip : test;
const subscriptions = fakeLiveConnection();
/** The subscription of the island rendered last. */
const metadata = () => subscriptions.at(-1)!;
const changed = { type: "table.updated" };

domTest("structure changes preserve input, batch the notice, and reload only after explicit confirmation", async () => {
  const dom = createDomTestHarness();
  const { default: WorkspaceMetadataRefresh } = await import("./WorkspaceMetadataRefresh.island");
  const { workspaceLiveStatus } = await import("./workspace-live-state");
  const { prompts } = await import("@k2b/ui");
  const initial = { revision: "one", resources: { "table:TABLE1": "one" } };
  let snapshot = { ...initial, canWrite: true, canAdmin: true };
  let requests = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        requests++;
        return Response.json(snapshot);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  const input = document.createElement("input");
  input.value = "unsaved";
  document.body.append(input);
  delegateEvents(["click"]);
  const dispose = render(
    () =>
      createComponent(WorkspaceMetadataRefresh, {
        baseId: "BASE01",
        initialCursor: "s6t.page.7",
        revision: initial,
        activeKeys: ["table:TABLE1"],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    expect(metadata()).toMatchObject({ url: "/api/grids/live", channel: "metadata", scope: { base: "BASE01" }, cursor: "s6t.page.7" });
    // The page resumes from its own cursor: neither the start nor a return to the tab reads the revision.
    document.dispatchEvent(new Event("visibilitychange"));
    await Bun.sleep(300);
    expect(requests).toBe(0);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    snapshot = { ...snapshot, revision: "two", resources: { "table:TABLE1": "two" } };
    for (let i = 0; i < 20; i++) await metadata().deliver([changed]);
    await Bun.sleep(300);
    expect(requests).toBe(1);
    expect(dom.root.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(workspaceLiveStatus().revoked).toBe(false);
    expect(input.value).toBe("unsaved");
    expect(reload).not.toHaveBeenCalled();
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await Bun.sleep(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    button.click();
    await Bun.sleep(0);
    expect(reload).toHaveBeenCalledTimes(1);
    await metadata().deliver([changed]);
    await Bun.sleep(300);
    expect(dom.root.querySelectorAll('[role="status"]')).toHaveLength(1);
  } finally {
    dispose();
    expect(metadata().closed).toBe(true);
    fetchMock.mockRestore();
    reload.mockRestore();
    confirm.mockRestore();
    dom.cleanup();
  }
});

domTest("this tab's own structure writes and changes outside the active area stay silent", async () => {
  const dom = createDomTestHarness();
  const { default: WorkspaceMetadataRefresh } = await import("./WorkspaceMetadataRefresh.island");
  const { apiClient } = await import("../../../api/client");
  const initial: WorkspaceRevision = { revision: "one", resources: { "table:TABLE1": "one", "view:VIEW01": "one", "table:OTHER1": "one" } };
  let snapshot = { ...initial, canWrite: true, canAdmin: true };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        if (url.pathname === "/api/grids/views/VIEW01" && init?.method === "PATCH") {
          // Filtering in the grid rewrites the view source; the server reports the row it wrote.
          snapshot = { ...snapshot, revision: "two", resources: { ...snapshot.resources, "view:VIEW01": "own" } };
          return Response.json({ id: "VIEW01" }, { headers: { "X-Grids-Workspace-Revision": "view:VIEW01=own" } });
        }
        return Response.json(snapshot);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const dispose = render(
    () =>
      createComponent(WorkspaceMetadataRefresh, {
        baseId: "BASE01",
        initialCursor: null,
        revision: initial,
        activeKeys: ["table:TABLE1", "view:VIEW01"],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    const response = await apiClient.views[":viewId"].$patch({ param: { viewId: "VIEW01" }, json: { source: "from Items where x = 1" } });
    expect(response.ok).toBe(true);
    await metadata().deliver([{ type: "view.updated" }]);
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    // Another table or a new resource in the Base does not concern this area.
    snapshot = { ...snapshot, revision: "three", resources: { ...snapshot.resources, "table:OTHER1": "two", "form:NEW001": "one" } };
    await metadata().deliver([changed, { type: "form.created" }]);
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    // A foreign change to the active table does.
    snapshot = { ...snapshot, revision: "four", resources: { ...snapshot.resources, "table:TABLE1": "foreign" } };
    await metadata().deliver([changed]);
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("Workspace changed");
    expect(dom.root.textContent).not.toContain("paused");
  } finally {
    dispose();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});

domTest("revocation hides SSR content and closes resource dialogs immediately", async () => {
  const dom = createDomTestHarness();
  const { default: WorkspaceMetadataRefresh } = await import("./WorkspaceMetadataRefresh.island");
  const { dialogCore } = await import("@k2b/ui");
  const { workspaceLiveStatus } = await import("./workspace-live-state");
  const content = document.createElement("div");
  content.id = "grids-workspace-BASE01";
  content.textContent = "private";
  document.body.append(content);
  const close = spyOn(dialogCore, "close");
  const dispose = render(
    () =>
      createComponent(WorkspaceMetadataRefresh, {
        baseId: "BASE01",
        initialCursor: null,
        revision: { revision: "one", resources: {} },
        activeKeys: [],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    metadata().revoke("access_denied");
    expect(content.style.display).toBe("none");
    expect(workspaceLiveStatus().revoked).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(dom.root.textContent).toContain("Access denied");
  } finally {
    dispose();
    close.mockRestore();
    dom.cleanup();
  }
});

/** Waits for an outcome of timers (debounce, retry backoff, toast exit) instead of guessing their total duration. */
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The expected state did not occur in time");
    await Bun.sleep(20);
  }
};

domTest("a failed check is retried, and a lasting failure informs in a toast without moving the workspace", async () => {
  const dom = createDomTestHarness();
  const { default: WorkspaceMetadataRefresh } = await import("./WorkspaceMetadataRefresh.island");
  const initial = { revision: "one", resources: { "table:TABLE1": "one" } };
  let failuresLeft = 2;
  let requests = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        requests++;
        if (failuresLeft > 0) {
          failuresLeft--;
          return new Response("Bad gateway", { status: 502 });
        }
        return Response.json({ ...initial, canWrite: true, canAdmin: true });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const reloadAction = () =>
    Array.from(dom.document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Reload" && !dom.root.contains(button),
    );
  const dispose = render(
    () =>
      createComponent(WorkspaceMetadataRefresh, {
        baseId: "BASE01",
        initialCursor: null,
        revision: initial,
        activeKeys: ["table:TABLE1"],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    // Updates were missed while the network was still coming back.
    await metadata().resync();
    await until(() => requests === 3);
    expect(reloadAction()).toBeUndefined();

    failuresLeft = Number.POSITIVE_INFINITY;
    await metadata().deliver([changed]);
    await until(() => reloadAction() !== undefined);
    expect(requests).toBe(6);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();

    failuresLeft = 0;
    await metadata().deliver([changed]);
    await until(() => reloadAction() === undefined);
  } finally {
    dispose();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});

domTest("after live updates end, a successful check keeps the toast", async () => {
  const dom = createDomTestHarness();
  const { default: WorkspaceMetadataRefresh } = await import("./WorkspaceMetadataRefresh.island");
  const initial = { revision: "one", resources: { "table:TABLE1": "one" } };
  let requests = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        requests++;
        return Response.json({ ...initial, canWrite: true, canAdmin: true });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const reloadAction = () =>
    Array.from(dom.document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Reload" && !dom.root.contains(button),
    );
  const dispose = render(
    () =>
      createComponent(WorkspaceMetadataRefresh, {
        baseId: "BASE01",
        initialCursor: null,
        revision: initial,
        activeKeys: ["table:TABLE1"],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    // Live updates stopped for good, for example because the session ended.
    metadata().fail();
    await until(() => requests === 1);
    await Bun.sleep(300);
    expect(reloadAction()).toBeDefined();
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
  } finally {
    dispose();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});
