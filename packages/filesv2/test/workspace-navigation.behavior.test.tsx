import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { createWorkspaceState, type WorkspaceSnapshot } from "../src/frontend/workspace-state";

const apiRequests: Array<{ kind: string; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const request = (kind: string) => () => new Promise<Response>((resolve) => apiRequests.push({ kind, resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: { bases: { $get: request("bases"), ":baseId": { entries: { $get: request("entries") } } } },
  }));
}

const initial: WorkspaceSnapshot = {
  source: "/app/filesv2?base=home",
  bases: { items: [], issues: [] },
  selectedId: null,
  directory: null,
  errorCode: null,
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
type Request = { source: string; signal: AbortSignal; resolve: (value: WorkspaceSnapshot) => void; reject: (error: Error) => void };

describe("Files v2 progressive navigation", () => {
  if (isServer) {
    test.skip("requires DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    apiRequests.length = 0;
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
    const bases = { items: [base, missing], issues: [] };
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
      [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent?.includes(text))!;
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
});
