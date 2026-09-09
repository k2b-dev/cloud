import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

const state = (): PublicOkWorkspaceState => ({
  kind: "ok",
  base: {
    id: "BASE01",
    name: "Inventory",
    description: "Team workspace",
    documentDefaults: {},
    createdBy: null,
    deletedAt: null,
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
  },
  title: [{ title: "Inventory" }],
  rememberPath: "/app/grids/BASE01",
  adminModeRequested: true,
  editModeToggleHref: "/app/grids/BASE01",
  canManageBase: true,
  canCreateTables: true,
  canUseEditMode: true,
  canUseQueryWorkspace: true,
  metadataEventCursor: null,
  recordEventCursor: null,
  navigation: { revision: 3, groups: [] },
  route: { kind: "overview" },
  catalog: {
    customApps: [],
    workflows: [],
    workflowLaunchers: [],
    workflowLevels: {},
    tables: [],
    tableLevels: {},
    fieldsByTable: {},
    viewsByTable: {},
    formsByTable: {},
    documentTemplatesByTable: {},
    documentTemplateLevels: {},
    sidebarForms: [],
    sidebarDocumentTemplates: [],
  },
});
const flush = () => Bun.sleep(20);

describe("Base navigation interactions", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("overview tabs use the SSR URL, preserve other params and restore browser history", async () => {
    const dom = createDomTestHarness();
    const { default: Overview } = await import("./BaseOverview");
    const current = state();
    current.navigation = { revision: 1, groups: [{ id: "GROUP1", name: "Loan desk", entries: [] }] };
    current.rememberPath = "/app/grids/BASE01?tab=resources";
    window.history.replaceState(null, "", "/app/grids/BASE01?edit=true&tab=resources");
    const dispose = render(() => createComponent(Overview, { state: current }), dom.root);
    try {
      const selected = () => dom.root.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
      expect(selected()).toBe("All resources");
      const tabs = dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabs[0]!.click();
      expect(selected()).toBe("Groups");
      expect(window.location.search).toBe("?edit=true&tab=groups");
      expect(dom.root.querySelector('[role="tabpanel"]')?.textContent).toContain("Loan desk");
      expect(dom.root.querySelector("input")).toBeNull();
      window.history.replaceState(null, "", "/app/grids/BASE01?edit=true&tab=resources");
      window.dispatchEvent(new Event("popstate"));
      expect(selected()).toBe("All resources");
      expect(dom.root.querySelector("input")).not.toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("field option sections collapse through the header without remounting inputs", async () => {
    const dom = createDomTestHarness();
    const { DetailPanel } = await import("@k2b/ui");
    const input = document.createElement("input");
    input.value = "Unsaved";
    const dispose = render(
      () => createComponent(DetailPanel.Section, { collapsible: true, title: "Appearance", icon: "ti ti-palette", children: input }),
      dom.root,
    );
    try {
      const expand = dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
      const collapse = dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
      const panel = document.getElementById(expand.getAttribute("aria-controls")!)!;
      expect(panel.hidden).toBe(true);
      expand.focus();
      expand.click();
      await Promise.resolve();
      expect(panel.hidden).toBe(false);
      expect(document.activeElement).toBe(collapse);
      expect(collapse.closest("header")?.textContent).toContain("Appearance");
      collapse.click();
      await Promise.resolve();
      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(expand);
      expand.click();
      expect(panel.querySelector("input")).toBe(input);
      expect(input.value).toBe("Unsaved");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("New only offers permitted resources and opens the existing table dialog without creating on cancel", async () => {
    const dom = createDomTestHarness();
    const { default: NewResource } = await import("../sidebar/NewResourceButton.island");
    const dispose = render(
      () =>
        createComponent(NewResource, {
          baseId: "BASE01",
          tables: [],
          fieldsByTable: {},
          tableLevels: {},
          canCreateTables: true,
          canManageBase: false,
        }),
      dom.root,
    );
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        throw new Error("Unexpected request");
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      dom.root.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
      const choice = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Store records"),
      );
      expect(choice).toBeDefined();
      expect(document.body.textContent).not.toContain("Automate actions");
      expect(document.body.textContent).not.toContain("Collect records");
      choice!.click();
      await flush();
      expect(document.body.textContent).toContain("New table");
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      await flush();
      expect(requests).toBe(0);
      expect(dom.root.querySelector<HTMLButtonElement>("button")!.disabled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      dispose();
      dom.cleanup();
    }
  });

  test("Documents expands without shared groups and contains All documents", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["keydown", "click"], dom.document);
    const { default: Grouped } = await import("./GroupedNavigation.island");
    const dispose = render(
      () =>
        createComponent(Grouped, {
          baseId: "DOCB01",
          groups: [],
          resources: [
            {
              type: "documentTemplate",
              id: "TPL001",
              name: "Loan agreement",
              icon: "ti ti-file-type-pdf",
              href: "/app/grids/DOCB01/document/TABLE1/TPL001?edit=true",
            },
          ],
          active: null,
          initialExpanded: [],
          forms: [],
          fields: {},
          editMode: true,
          dateConfig: undefined,
        }),
      dom.root,
    );
    try {
      const branch = dom.root.querySelector<HTMLElement>('[role="treeitem"]')!;
      expect(branch.getAttribute("aria-expanded")).toBe("false");
      branch.focus();
      branch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await flush();
      expect(dom.root.querySelector('[role="treeitem"]')?.getAttribute("aria-expanded")).toBe("true");
      expect(dom.root.querySelector('a[href="/app/grids/DOCB01/documents?edit=true"]')?.textContent).toContain("All documents");
      expect(dom.root.querySelector('a[href="/app/grids/DOCB01/document/TABLE1/TPL001?edit=true"]')?.textContent).toContain(
        "Loan agreement",
      );
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("editor retains input focus, protects unsaved changes and preserves the draft after a conflict", async () => {
    const dom = createDomTestHarness();
    const { default: Settings } = await import("../settings/BaseSettingsPanel");
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    const config = {
      revision: 3,
      groups: [
        { id: "GROUP1", name: "Loans", entries: [] },
        { id: "GROUP2", name: "Items", entries: [] },
      ],
    };
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return init?.method === "PUT"
          ? Response.json({ message: "Navigation changed in another session." }, { status: 409 })
          : Response.json(config);
      },
      { preconnect: originalFetch.preconnect },
    );
    const dispose = render(() => createComponent(Settings, { base: state().base, accessEntries: [], navigationResources: [] }), dom.root);
    const button = (text: string) => Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)!;
    try {
      button("Navigation").click();
      await flush();
      const name = dom.root.querySelector<HTMLInputElement>("input")!;
      name.focus();
      name.value = "Loan desk";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      expect(dom.document.activeElement).toBe(name);
      expect(dom.root.querySelector("input")).toBe(name);
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
      button("Save changes").click();
      await flush();
      expect(dom.root.textContent).toContain("Navigation changed in another session.");
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Loan desk");
      expect(JSON.parse(String(calls.at(-1)?.body))).toEqual({
        ...config,
        groups: [{ ...config.groups[0], name: "Loan desk" }, config.groups[1]],
      });
      expect(button("Save changes").disabled).toBe(false);
      expect(button("Reload navigation")).toBeDefined();
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Move down"]')!.click();
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Items");
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.click();
      expect(Array.from(dom.root.querySelectorAll<HTMLInputElement>("input[required]")).map((item) => item.value)).toEqual(["Loan desk"]);
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Loan desk");
      button("Add group").click();
      expect(dom.root.querySelectorAll("input[required]")).toHaveLength(2);
      button("General").click();
      await flush();
      expect(dom.document.body.textContent).toContain("Discard unsaved changes?");
      expect(dom.root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Navigation");
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"))
        .find((item) => item.textContent?.trim() === "Cancel")!
        .click();
      await flush();
      expect(dom.root.querySelectorAll("input[required]")).toHaveLength(2);
      button("Discard").click();
      await flush();
      expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Loans");
      button("General").click();
      await flush();
      expect(dom.root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("General");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("overview groups compact resources and has no editor even for admins", async () => {
    const dom = createDomTestHarness();
    const { default: Overview } = await import("./BaseOverview");
    const current = state();
    current.catalog.customApps = [
      {
        id: "APP001",
        baseId: "BASE01",
        name: "Loan desk",
        icon: null,
        publishedAt: null,
        updatedAt: "2026-09-09T00:00:00Z",
        draftValid: true,
        publishedValid: false,
        hasUnpublishedChanges: true,
      },
    ];
    const dispose = render(() => createComponent(Overview, { state: current }), dom.root);
    try {
      expect(dom.root.textContent).toContain("Team workspace");
      expect(dom.root.textContent).not.toContain("Edit navigation");
      expect(dom.root.textContent).toContain("App (draft)");
      expect(dom.root.querySelector("h3")?.textContent).toContain("Apps");
      expect(dom.root.querySelector("li a")?.textContent).toContain("Loan desk");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("sidebar branches are keyboard-operable and share cookie state across mobile and desktop", async () => {
    const dom = createDomTestHarness();
    const { default: Grouped } = await import("./GroupedNavigation.island");
    delegateEvents(["keydown", "click"], dom.document);
    const { parseNavigationExpansion } = await import("../sidebar/GridsSettingsStore");
    const props = {
      baseId: "BASE01",
      groups: [{ id: "GROUP1", name: "Loans", entries: [{ type: "workflow" as const, id: "FLOW01" }] }],
      resources: [
        { type: "workflow" as const, id: "FLOW01", name: "Approve loan", icon: "ti ti-route", href: "/app/grids/BASE01/workflows/FLOW01" },
      ],
      active: null,
      forms: [],
      fields: {},
      editMode: false,
      dateConfig: undefined,
    };
    const dispose = render(() => [createComponent(Grouped, props), createComponent(Grouped, props)], dom.root);
    try {
      const groups = () =>
        Array.from(dom.root.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter((row) => row.textContent?.includes("Loans"));
      expect(groups()).toHaveLength(2);
      expect(groups().map((row) => row.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
      groups()[0]!.focus();
      groups()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await flush();
      expect({ expanded: groups().map((row) => row.getAttribute("aria-expanded")), cookie: document.cookie }).toEqual({
        expanded: ["false", "false"],
        cookie: expect.any(String),
      });
      expect(parseNavigationExpansion(document.cookie, "BASE01")).toEqual([]);
      groups()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await flush();
      expect(groups().every((row) => row.getAttribute("aria-expanded") === "true")).toBe(true);
      expect(parseNavigationExpansion(document.cookie, "BASE01")).toEqual(["group:GROUP1"]);
      expect(dom.root.querySelector('a[href="/app/grids/BASE01/workflows/FLOW01"]')).not.toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
