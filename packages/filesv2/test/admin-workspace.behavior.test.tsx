import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent, createRoot, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { AdminResult, ArchiveEntry, InventoryEntry } from "../src/contracts";
import { type AdminSnapshot, adminHref, parseAdminLocation } from "../src/frontend/admin-location";

const requests: Array<{ kind: string; input: unknown; signal: AbortSignal; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const request = (kind: string) => (input: unknown, options: { init: { signal: AbortSignal } }) =>
    new Promise<Response>((resolve) => requests.push({ kind, input: structuredClone(input), signal: options.init.signal, resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      admin: {
        $get: request("inventory"),
        operations: { ":id": { retry: { $post: request("retry") } } },
        configuration: { $put: request("configuration") },
        root: { refresh: { $post: request("root-refresh") } },
        entries: { $get: request("entries"), $delete: request("delete-entry") },
        versions: { $get: request("versions"), $delete: request("delete-version") },
        directories: { create: { $post: request("create") }, archive: { $post: request("archive") }, delete: { $post: request("delete") } },
        archives: { $get: request("archives"), ":id": { restore: { $post: request("restore") }, $delete: request("delete-archive") } },
      },
    },
  }));
}
const result: AdminResult = {
  configuration: {
    url: "http://filegate:4000",
    tokenConfigured: true,
    cloud: {
      enabled: true,
      root: "cloud",
      prefix: "",
      homes: "users",
      groups: "groups",
      archive: "archive",
      autoCreate: false,
      autoArchive: true,
    },
    freeipa: { enabled: false, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" },
  },
  availability: { localLinuxEnabled: true, freeipaEnabled: false },
  items: [],
  next: null,
  issue: null,
  root: {
    name: "cloud",
    indexEnabled: false,
    versioningEnabled: false,
    files: null,
    directories: null,
    bytes: null,
    versions: 0,
    versionBytes: 0,
    activeUploads: 0,
    available: 1000,
    capacity: 2000,
  },
};
const makeInitial = (view = "overview"): AdminSnapshot => ({
  source: adminHref(parseAdminLocation(`/admin/filesv2?view=${view}`)),
  result,
  browse: null,
  archives: null,
});
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

describe("Files v2 admin workspace", () => {
  if (isServer) {
    test.skip("requires DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });
  const setup = async (view = "overview", root = result.root) => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const initial = makeInitial(view);
    initial.result = { ...initial.result, root };
    dom.window.history.replaceState(null, "", initial.source);
    const { default: AdminWorkspace } = await import("../src/frontend/AdminWorkspace.island");
    const dispose = render(() => createComponent(AdminWorkspace, { initial }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const tab = (name: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.includes(name))!;
    return { dom, tab, initial };
  };

  test("SSR seed performs no fetch; tabs commit after matching reads and failed popstate restores URL", async () => {
    const { dom, tab, initial } = await setup();
    await flush();
    expect(requests).toHaveLength(0);
    expect(dom.root.textContent).toContain("Unknown");
    expect(dom.root.textContent).toContain("Atomic conflict checks: Unknown");
    expect(dom.root.textContent).toContain("Unix execution: Unknown");
    expect(dom.root.textContent).toContain("No filesystem scan is available");
    tab("Directories").click();
    await flush();
    expect(dom.window.location.href).toContain("view=overview");
    requests[0]!.resolve(Response.json(result));
    await flush();
    expect(dom.window.location.href).toContain("view=directories");
    expect(dom.root.textContent).toContain("No entries match this view.");
    tab("Archive").click();
    await flush();
    requests[1]!.resolve(Response.json(result));
    await flush();
    expect(requests[2]!.kind).toBe("archives");
    expect(dom.window.location.href).toContain("view=directories");
    requests[2]!.resolve(Response.json({ items: [], next: null }));
    await flush();
    expect(dom.window.location.href).toContain("view=archive");
    const committed = dom.window.location.pathname + dom.window.location.search;
    dom.window.history.replaceState(null, "", initial.source);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flush();
    requests[3]!.resolve(Response.json({ code: "unavailable", message: "private transport info" }, { status: 503 }));
    await flush();
    expect(dom.window.location.pathname + dom.window.location.search).toBe(committed);
    expect(dom.root.textContent).toContain("Storage could not be loaded");
    expect(dom.root.textContent).not.toContain("private transport info");
    tab("Directories").click();
    await flush();
    requests[4]!.resolve(Response.json(result));
    await flush();
    expect(dom.window.location.href).toContain("view=directories");
    expect(dom.root.textContent).not.toContain("Storage could not be loaded");
  });

  test("disabled archives render the area explanation without issuing a forbidden browse request", async () => {
    const { dom, tab } = await setup();
    tab("Archive").click();
    await flush();
    requests[0]!.resolve(Response.json({ ...result, issue: "area_disabled", root: null }));
    await flush();
    expect(requests).toHaveLength(1);
    expect(dom.window.location.href).toContain("view=archive");
    expect(dom.root.textContent).toContain("Enable this area in Settings");
    expect(dom.root.textContent).not.toContain("Storage could not be loaded");
  });
  test.each([
    { complete: false, freshness: "observed" as const, source: "filesystem" as const, notice: "The last scan was incomplete", showDate: false },
    { complete: true, freshness: "unknown" as const, source: "index" as const, notice: "Cached index statistics do not confirm", showDate: false },
    { complete: true, freshness: "observed" as const, source: "filesystem" as const, notice: "Totals reflect the last completed filesystem scan", showDate: true },
  ])("overview explains observed statistics: $notice", async (state) => {
    const { dom } = await setup("overview", {
      ...result.root!, managed: true, executionEnabled: false,
      observation: { complete: state.complete, freshness: state.freshness, source: state.source, started: "2026-09-19T10:00:00Z", completed: "2026-09-19T10:01:00Z" },
    });
    await flush();
    expect(dom.root.textContent).toContain("Atomic conflict checks: On");
    expect(dom.root.textContent).toContain("Unix execution: Off");
    expect(dom.root.textContent).toContain(state.notice);
    expect(dom.root.textContent?.includes("Last complete scan:")).toBe(state.showDate);
  });

  test("the single overview refresh updates root statistics before reloading the snapshot", async () => {
    const { dom } = await setup();
    expect(dom.root.textContent).not.toContain("Refresh statistics");
    const refresh = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Refresh")!;
    refresh.click();
    await flush();
    expect(requests[0]!.kind).toBe("root-refresh");
    expect(requests[0]!.input).toEqual({ json: { area: "cloud" } });
    requests[0]!.resolve(Response.json(result.root));
    await flush();
    expect(requests[1]!.kind).toBe("inventory");
    requests[1]!.resolve(Response.json(result));
    await flush();
    expect(dom.root.textContent).toContain("Action completed.");
  });

  test("directory filters share the search form and preserve a typed search when changing kind", async () => {
    const { dom } = await setup("directories");
    const form = dom.root.querySelector<HTMLFormElement>("form")!;
    const input = form.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(form.textContent).toContain("State");
    expect(form.textContent).toContain("Storage area: Cloud");
    expect(form.textContent).toContain("Directory type: Users");
    expect(form.querySelector('button[type="submit"]')?.getAttribute("aria-label")).toBe("Search");
    input.value = "alice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const kind = [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Directory type"))!;
    kind.click();
    await flush();
    const groups = [...dom.document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')].find(
      (button) => button.textContent?.trim() === "Groups",
    )!;
    groups.click();
    await flush();
    expect(requests[0]!.input).toMatchObject({ query: { kind: "groups", q: "alice", after: undefined } });
    requests[0]!.resolve(Response.json(result));
    await flush();
    expect(dom.window.location.search).toContain("kind=groups");
    expect(dom.window.location.search).toContain("q=alice");
  });

  test("settings have one local automation pair, fixed dirty footer, discard and guarded navigation", async () => {
    const { dom, tab } = await setup("settings");
    await flush();
    expect(dom.root.querySelectorAll('[role="switch"]').length).toBe(4);
    expect(dom.root.textContent).toContain("FreeIPA directories are created and archived only through explicit administrative actions");
    const input = dom.root.querySelector<HTMLInputElement>('input[name="filegate-url"]')!;
    input.value = "http://changed:4000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    const footer = dom.root.querySelector(".k2b-settings-page__footer")!;
    expect(footer.textContent).toContain("Save");
    tab("Directories").click();
    await flush();
    expect(requests).toHaveLength(0);
    expect(dom.document.querySelector(".k2b-dialog__panel")?.textContent).toContain("Discard your unsaved settings");
    const cancel = [...dom.document.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button")].find((node) =>
      node.textContent?.includes("Cancel"),
    )!;
    cancel.click();
    await flush();
    expect(input.value).toBe("http://changed:4000");
    const discard = [...footer.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Discard"))!;
    discard.click();
    await flush();
    expect(input.value).toBe(result.configuration.url);
    tab("Directories").click();
    await flush();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(Response.json(result));
    await flush();
    expect(dom.window.location.href).toContain("view=directories");
  });

  test("deletion requires exact path and failure preserves retry; pending archive operation is honest", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { createAdminActions } = await import("../src/frontend/admin-actions");
    let dispose!: () => void;
    let refreshed = 0;
    const initial = makeInitial("directories");
    const actions = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAdminActions({
        snapshot: () => initial,
        location: () => parseAdminLocation(initial.source),
        refresh: async () => {
          refreshed++;
        },
      });
    });
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const row: InventoryEntry = {
      identityId: null,
      baseId: null,
      operationId: null,
      area: "cloud",
      kind: "users",
      name: "old-user",
      path: "users/old-user",
      status: "orphaned",
      reason: null,
      uid: null,
      gid: null,
      actions: { create: false, adopt: false, browse: true, archive: true, delete: true, retire: false },
    };
    const pending = actions.directory("delete", row);
    await flush();
    expect(requests).toHaveLength(0);
    const form = dom.document.querySelector<HTMLFormElement>(".k2b-dialog__panel")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    input.value = "users/other";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(requests).toHaveLength(0);
    expect(dom.document.body.textContent).toContain("The path does not match");
    input.value = row.path;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(requests[0]!.input).toEqual({ json: { area: "cloud", kind: "users", name: "old-user", confirmPath: "users/old-user" } });
    requests[0]!.resolve(Response.json({ code: "binding_conflict", message: "Directory changed." }, { status: 409 }));
    await pending;
    expect(actions.error()?.message).toBe("Directory changed.");
    expect(refreshed).toBe(0);
    expect(actions.busy()).toBe(false);
    const archive = actions.directory("archive", row);
    await flush();
    const archiveForm = dom.document.querySelector<HTMLFormElement>(".k2b-dialog__panel")!;
    expect(archiveForm.querySelector<HTMLInputElement>("input")!.value).toBe("archive");
    archiveForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    requests[1]!.resolve(Response.json({ id: "op", state: "pending", path: "archive/old-user" }));
    await archive;
    expect(actions.notice()).toBe("In progress");
    expect(actions.error()).toBeNull();
    expect(refreshed).toBe(1);
  });
  test("archive retry uses the pending operation ID rather than the archived record", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { createAdminActions } = await import("../src/frontend/admin-actions");
    let dispose!: () => void;
    const initial = makeInitial("archive");
    const actions = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAdminActions({ snapshot: () => initial, location: () => parseAdminLocation(initial.source), refresh: async () => {} });
    });
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const row: ArchiveEntry = {
      id: "archive-record",
      operationId: "pending-restore",
      canRetry: true,
      area: "cloud",
      kind: "users",
      name: "old-user",
      path: "archive/old-user",
      originalPath: "users/old-user",
      state: "archived",
      createdAt: "2026-09-17T00:00:00Z",
      canRestore: false,
      canDelete: false,
    };
    const retry = actions.archive("retry", row);
    await flush();
    expect(requests).toHaveLength(0);
    dom.document.querySelector<HTMLButtonElement>('.k2b-dialog__actions button[data-variant="primary"]')!.click();
    await flush();
    expect(requests[0]!.kind).toBe("retry");
    expect(requests[0]!.input).toEqual({ param: { id: "pending-restore" } });
    requests[0]!.resolve(Response.json({ id: "pending-restore", state: "complete", path: "users/old-user" }));
    await retry;
    expect(actions.notice()).toBe("Action completed.");
  });
  test("inventory keeps rows compact, offers permitted creation directly and explains states in Details", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { default: Inventory } = await import("../src/frontend/Inventory");
    const { createAdminActions } = await import("../src/frontend/admin-actions");
    const initial = makeInitial("directories");
    const row: InventoryEntry = {
      identityId: "eligible-user",
      baseId: null,
      operationId: null,
      area: "cloud",
      kind: "users",
      name: "alice",
      path: "users/alice",
      status: "missing",
      reason: "missing",
      uid: null,
      gid: null,
      actions: { create: true, adopt: false, browse: false, archive: false, delete: false, retire: false },
    };
    const inaccessible = { ...row, identityId: null, name: "bob", path: "users/bob", actions: { ...row.actions, create: false } };
    let actions!: ReturnType<typeof createAdminActions>;
    const dispose = render(() => {
      actions = createAdminActions({
        snapshot: () => initial,
        location: () => parseAdminLocation(initial.source),
        refresh: async () => {},
      });
      return createComponent(Inventory, {
        items: [row, inaccessible],
        location: parseAdminLocation(initial.source),
        busy: false,
        onNavigate: async () => {},
        onAction: (kind, item) => void actions.directory(kind, item),
      });
    }, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.root.textContent).not.toContain("This directory has not been created yet");
    const create = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].filter((node) =>
      node.textContent?.includes("Create directory"),
    );
    expect(create).toHaveLength(1);
    create[0]!.click();
    await flush();
    expect(dom.document.querySelector(".k2b-dialog__body")?.textContent).toContain("users/alice");
    expect(requests).toHaveLength(0);
    dom.document.querySelector<HTMLButtonElement>('.k2b-dialog__actions button[data-variant="secondary"]')!.click();
    await flush();
    const details = actions.directory("details", row);
    await flush();
    const detailsPanel = dom.document.querySelector(".k2b-dialog__panel")!;
    expect(detailsPanel.textContent).toContain("This directory has not been created yet");
    expect(detailsPanel.textContent).toContain("Directory details");
    expect(detailsPanel.textContent).toContain("Filegate service account");
    expect(detailsPanel.textContent).not.toContain("Unknown / Unknown");
    [...detailsPanel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Close")!.click();
    await details;
  });
  test("admin version deletion requires the full path and reloads only after a successful deletion", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { default: AdminVersions } = await import("../src/frontend/AdminVersions");
    const locator = { area: "cloud" as const, kind: "users" as const, name: "alice", path: "report.txt" };
    const dispose = render(() => createComponent(AdminVersions, {
      locator, name: "report.txt", fullPath: "home/alice/report.txt", onClose: () => {},
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    expect(requests[0]!.input).toEqual({ query: locator });
    requests[0]!.resolve(Response.json([{ id: "v1", created: "2026-09-19T12:00:00Z", size: 42, pinned: false, comment: "Old draft", author: "Alice" }]));
    await flush();
    expect(dom.root.textContent).toContain("Old draft");
    const remove = () => [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Delete version permanently"))!;
    remove().click();
    await flush();
    const form = dom.document.querySelector<HTMLFormElement>(".k2b-dialog__panel")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    expect(form.textContent).toContain("v1");
    input.value = "report.txt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(requests).toHaveLength(1);
    expect(form.textContent).toContain("The path does not match");
    input.value = "home/alice/report.txt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(requests[1]!.input).toEqual({ json: { ...locator, id: "v1", confirmPath: "home/alice/report.txt" } });
    expect(remove().disabled).toBe(true);
    requests[1]!.resolve(Response.json({ deleted: true }));
    await flush();
    expect(requests[2]!.kind).toBe("versions");
    requests[2]!.resolve(Response.json([]));
    await flush();
    expect(dom.root.textContent).toContain("No earlier versions");
    expect(dom.root.textContent).not.toContain("Old draft");
  });

  test("admin version history shows sanitized load errors and cancels a pending read when closed", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { default: AdminVersions } = await import("../src/frontend/AdminVersions");
    const dispose = render(() => createComponent(AdminVersions, {
      locator: { area: "cloud", kind: "users", name: "alice", path: "report.txt" },
      name: "report.txt", fullPath: "home/alice/report.txt", onClose: () => {},
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    requests[0]!.resolve(Response.json({ code: "unavailable", message: "private backend detail" }, { status: 503 }));
    await flush();
    expect(dom.root.textContent).not.toContain("private backend detail");
    expect(dom.root.textContent).toContain("The action could not be completed");
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Refresh")!.click();
    await flush();
    expect(requests[1]!.signal.aborted).toBe(false);
    dispose();
    await flush();
    expect(requests[1]!.signal.aborted).toBe(true);
  });

  test("admin file rows expose version history lazily, while folders do not", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    const { default: AdminBrowser } = await import("../src/frontend/AdminBrowser");
    const [enabled, setEnabled] = createSignal<boolean | undefined>();
    const dispose = render(() => createComponent(AdminBrowser, {
      get versioningEnabled() { return enabled(); },
      browse: {
        area: "cloud", kind: "users", name: "alice", archiveId: null, basePath: "home/alice", path: "", next: null,
        items: [
          { path: "report.txt", name: "report.txt", directory: false, size: 42, modified: "2026-09-19T12:00:00Z" },
          { path: "notes", name: "notes", directory: true, size: 0, modified: "2026-09-19T12:00:00Z" },
        ],
      },
      location: parseAdminLocation("/admin/filesv2?view=directories&area=cloud&kind=users&name=alice"),
      busy: false, onNavigate: async () => {}, onDelete: () => {},
    }), dom.root);
    cleanup = () => { dispose(); dom.cleanup(); };
    await flush();
    expect(requests).toHaveLength(0);
    expect(dom.root.textContent).not.toContain("Versions");
    setEnabled(false);
    await flush();
    expect(dom.root.textContent).not.toContain("Versions");
    setEnabled(true);
    await flush();
    const versions = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.includes("Versions"));
    expect(versions).toHaveLength(1);
    versions[0]!.click();
    await flush();
    expect(requests[0]!.input).toEqual({ query: { area: "cloud", kind: "users", name: "alice", path: "report.txt", archiveId: undefined } });
    expect(dom.document.querySelector(".k2b-dialog__panel")?.textContent).toContain("home/alice/report.txt");
    dispose();
    await flush();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(dom.document.querySelector(".k2b-dialog__panel")).toBeNull();
  });

});
