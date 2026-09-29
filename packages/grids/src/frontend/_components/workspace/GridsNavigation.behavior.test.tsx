import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

const state = (canManageBase: boolean): PublicOkWorkspaceState => ({
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
  adminModeRequested: false,
  editModeToggleHref: "/app/grids/BASE01?edit=true",
  canManageBase,
  canCreateTables: canManageBase,
  canUseEditMode: canManageBase,
  canUseQueryWorkspace: false,
  metadataEventCursor: null,
  recordEventCursor: null,
  navigation: { revision: 1, groups: [] },
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

describe("Grids phone navigation", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  // Phones hide the sidebar; the Cloud phone menu renders the navigation that GridsNavigation provides.
  const phoneMenu = async (canManageBase: boolean) => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const { Navigation } = await import("@k2b/ui");
    const { readWorkspaceNavigation } = await import("@k2b/cloud/browser/testing");
    const { default: GridsNavigation } = await import("./GridsNavigation.island");
    const disposeProvider = render(() => createComponent(GridsNavigation, { state: state(canManageBase) }), dom.root);
    await Bun.sleep(0);
    const provided = readWorkspaceNavigation();
    if (!provided) throw new Error("GridsNavigation did not provide the workspace navigation.");
    const menu = dom.document.createElement("nav");
    dom.document.body.append(menu);
    const disposeMenu = render(() => createComponent(Navigation, { navigation: provided.navigation, label: provided.label }), menu);
    const settings = () =>
      Array.from(menu.querySelectorAll<HTMLElement>("a, button")).find((item) => item.textContent?.trim() === "Settings");
    return {
      dom,
      settings,
      dispose: () => {
        disposeMenu();
        disposeProvider();
        dom.cleanup();
      },
    };
  };

  test("offers base settings only to people who manage the base, like the desktop sidebar", async () => {
    const member = await phoneMenu(false);
    try {
      expect(member.settings()).toBeUndefined();
    } finally {
      member.dispose();
    }
  });

  test("opens base settings from the phone menu", async () => {
    const manager = await phoneMenu(true);
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(new URL(input instanceof Request ? input.url : input.toString(), "http://localhost").pathname);
        return Response.json([]);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const settings = manager.settings();
      if (!settings) throw new Error("The phone menu has no Settings entry for a base manager.");
      settings.click();
      for (let attempt = 0; attempt < 50 && !manager.dom.document.querySelector("dialog"); attempt++) await Bun.sleep(10);
      expect(requests[0]).toBe("/api/grids/access/by-base/BASE01");
      expect(manager.dom.document.querySelector("dialog")?.textContent).toContain("General");
    } finally {
      globalThis.fetch = originalFetch;
      manager.dispose();
    }
  });
});
