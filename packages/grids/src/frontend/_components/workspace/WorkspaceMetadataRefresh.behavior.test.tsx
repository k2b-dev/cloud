import { expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { WorkspaceRevision } from "../../../service/workspace-revision";

const domTest = isServer ? test.skip : test;
type Options = Parameters<typeof import("./grids-metadata-events-provider").createGridsMetadataEventsProvider>[0];
let callbacks: Options;
mock.module("./grids-metadata-events-provider", () => ({
  createGridsMetadataEventsProvider: (opts: Options) => {
    callbacks = opts;
    return { connect: () => {}, dispose: () => {}, markApplied: () => {} };
  },
}));

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
        initialCursor: null,
        revision: initial,
        activeKeys: ["table:TABLE1"],
        canWrite: true,
        canAdmin: true,
      }),
    dom.root,
  );
  try {
    callbacks.onReady?.(null);
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    snapshot = { ...snapshot, revision: "two", resources: { "table:TABLE1": "two" } };
    for (let i = 0; i < 20; i++) callbacks.onEvent?.(`s6t.test.${i}`);
    await Bun.sleep(300);
    expect(requests).toBe(2);
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
    callbacks.onReady?.(null);
    await Bun.sleep(300);
    expect(dom.root.querySelectorAll('[role="status"]')).toHaveLength(1);
  } finally {
    dispose();
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
    callbacks.onReady?.(null);
    await Bun.sleep(300);
    const response = await apiClient.views[":viewId"].$patch({ param: { viewId: "VIEW01" }, json: { source: "from Items where x = 1" } });
    expect(response.ok).toBe(true);
    callbacks.onEvent?.("s6t.test.own");
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    // Another table or a new resource in the Base does not concern this area.
    snapshot = { ...snapshot, revision: "three", resources: { ...snapshot.resources, "table:OTHER1": "two", "form:NEW001": "one" } };
    callbacks.onEvent?.("s6t.test.other");
    await Bun.sleep(300);
    expect(dom.root.querySelector('[role="status"]')).toBeNull();
    // A foreign change to the active table does.
    snapshot = { ...snapshot, revision: "four", resources: { ...snapshot.resources, "table:TABLE1": "foreign" } };
    callbacks.onEvent?.("s6t.test.foreign");
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
    callbacks.onRevoked?.({ code: "access_denied", message: "denied" });
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
