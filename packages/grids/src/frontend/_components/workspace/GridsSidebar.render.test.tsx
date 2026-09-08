import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicOkWorkspaceState, PublicWorkflow } from "./workspace-public-state-model";

const { default: GridsSidebar } = await import("./GridsSidebar");

const workflow: PublicWorkflow = {
  id: "FLOW01",
  baseId: "BASE01",
  name: "Send approved loan agreement",
  description: null,
  source: "name: Send approved loan agreement",
  plan: {
    schemaVersion: 2,
    languageId: "grids",
    languageVersion: 1,
    sourceHash: "source",
    manifestHash: "manifest",
    catalogHash: "catalog",
    actionPolicies: {},
    inputs: [],
    triggers: [],
    steps: [],
    bindings: {},
  },
  diagnostics: [],
  enabled: true,
  position: 0,
  revision: 1,
  ownerUserId: null,
  deletedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const workflowState = (): PublicOkWorkspaceState => ({
  kind: "ok",
  base: {
    id: "BASE01",
    name: "Inventory",
    description: null,
    documentDefaults: {},
    createdBy: null,
    deletedAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
  title: [{ title: "Inventory" }],
  rememberPath: "/app/grids/BASE01",
  adminModeRequested: false,
  editModeToggleHref: "/app/grids/BASE01?edit=true",
  canManageBase: false,
  canCreateTables: false,
  canUseEditMode: true,
  canUseQueryWorkspace: true,
  metadataEventCursor: null,
  recordEventCursor: null,
  catalog: {
    customApps: [],
    workflows: [workflow],
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

describe("GridsSidebar workflows", () => {
  test("always exposes the canonical Documents workspace without requiring a template", () => {
    const state = workflowState();
    state.catalog.sidebarDocumentTemplates = [];

    const html = renderToString(() => createComponent(GridsSidebar, { state }));

    expect(html).toContain("Documents");
    expect(html).toContain("All documents");
    expect(html).toContain('/app/grids/BASE01/documents');
  });

  test("uses workflow rows as the selector without a duplicate overview item", () => {
    const html = renderToString(() => createComponent(GridsSidebar, { state: workflowState() }));

    expect(html).toContain("Send approved loan agreement");
    expect(html).not.toContain(">Overview<");
    expect(html).toContain("/app/grids/BASE01/workflows/FLOW01");
  });

  test("shows workflow creation in the sidebar only for base admins in Edit mode", () => {
    const editableState = workflowState();
    editableState.adminModeRequested = true;
    editableState.canManageBase = true;

    const editableHtml = renderToString(() => createComponent(GridsSidebar, { state: editableState }));
    const readOnlyHtml = renderToString(() => createComponent(GridsSidebar, { state: workflowState() }));

    expect(editableHtml).toContain("New workflow");
    expect(readOnlyHtml).not.toContain("New workflow");
  });

  test("shows workflow creation before the first workflow exists", () => {
    const state = workflowState();
    state.adminModeRequested = true;
    state.canManageBase = true;
    state.catalog.workflows = [];
    state.route = { kind: "empty" };

    const html = renderToString(() => createComponent(GridsSidebar, { state }));

    expect(html).toContain("Workflows");
    expect(html).toContain("New workflow");
    expect(html).not.toContain("Add workflow");
  });
});

describe("GridsSidebar Apps", () => {
  test("links base-admin builders and marks drafts", () => {
    const state = workflowState();
    state.canManageBase = true;
    state.catalog.customApps = [
      {
        id: "APP001",
        baseId: state.base.id,
        name: "Loan desk",
        icon: "clipboard",
        publishedAt: null,
        updatedAt: "2026-08-07T00:00:00.000Z",
        draftValid: true,
        publishedValid: false,
        hasUnpublishedChanges: true,
      },
    ];
    const summary = state.catalog.customApps[0]!;
    state.route = {
      kind: "customApp",
      app: {
        ...summary,
        draftDefinition: null,
        draftDiagnostics: [],
        draftCapabilities: null,
        publishedDefinition: null,
        publishedDiagnostics: [],
        publishedCapabilities: null,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      initialSettingsOpen: true,
    };

    const html = renderToString(() => createComponent(GridsSidebar, { state }));

    expect(html).toContain("Apps");
    expect(html).toContain("Loan desk");
    expect(html).toContain("/app/grids/BASE01/apps/APP001?edit=true");
    expect(html).toContain("settings=app");
    expect(html).toContain("draft");
  });

  test("shows app creation before the first app exists in Edit mode", () => {
    const state = workflowState();
    state.adminModeRequested = true;
    state.canManageBase = true;
    state.catalog.customApps = [];
    state.route = { kind: "empty" };

    const html = renderToString(() => createComponent(GridsSidebar, { state }));

    expect(html).toContain("Apps");
    expect(html).toContain("New app");
  });
});
