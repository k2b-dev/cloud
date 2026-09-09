import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

const { default: GridsWorkspace, routeClientState } = await import("./GridsWorkspace");

const workspaceState = (): PublicOkWorkspaceState => ({
  kind: "ok",
  base: {
    id: "DEMO01",
    name: "Inventory",
    description: null,
    documentDefaults: {},
    createdBy: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  title: [{ title: "Inventory" }],
  rememberPath: "/app/grids/demo1",
  adminModeRequested: false,
  editModeToggleHref: "/app/grids/demo1?edit=true",
  canManageBase: false,
  canCreateTables: false,
  canUseEditMode: false,
  canUseQueryWorkspace: false,
  metadataEventCursor: null,
  recordEventCursor: null,
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
  route: { kind: "empty" },
});

describe("GridsWorkspace", () => {
  test("All documents preserves resolved template access without granting extra rights", () => {
    const state = workspaceState();
    state.route = { kind: "documents", initialBrowserPage: { items: [], folders: [], path: [], cursor: null, hasMore: false } };
    state.catalog.documentTemplateLevels = { TMPL01: "admin", TMPL02: "write", TMPL03: "read" };
    expect(routeClientState(state).catalog.documentTemplateLevels).toEqual(state.catalog.documentTemplateLevels);
    expect(routeClientState(state).catalog.documentTemplateLevels.MISSING).toBeUndefined();
  });
  test("owns one content shell outside the interactive route island", () => {
    const html = renderToString(() =>
      createComponent(GridsWorkspace, {
        cloudUrl: "https://cloud.example",
        state: workspaceState(),
      }),
    );

    expect(html.match(/k2b-app-workspace__content/g)).toHaveLength(1);

    const contentClass = html.indexOf("k2b-app-workspace__content");
    const contentStart = html.lastIndexOf("<div", contentClass);
    const contentTagEnd = html.indexOf(">", contentClass);
    const routeIsland = html.indexOf("<solid-island", contentTagEnd);

    expect(contentStart).toBeGreaterThan(-1);
    expect(routeIsland).toBeGreaterThan(contentTagEnd);
    expect(html.slice(contentTagEnd + 1, routeIsland).trim()).toBe("");
  });
});
