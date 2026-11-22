import { describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicField, PublicGridRecord, PublicTable, PublicView } from "../../../api/public-dto";
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
  liveCursor: null,
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
    state.route = {
      kind: "documents",
      canWriteDocuments: false,
      initialCatalog: { q: "", view: "folders", path: [], workflow: null, template: null, table: null, mediaType: null, sort: "newest" },
      facets: { workflows: [], templates: [], tables: [], mediaTypes: [] },
      initialBrowserPage: { items: [], folders: [], path: [], cursor: null, hasMore: false },
    };
    state.catalog.documentTemplateLevels = { TMPL01: "admin", TMPL02: "write", TMPL03: "read" };
    expect(routeClientState(state).catalog.documentTemplateLevels).toEqual(state.catalog.documentTemplateLevels);
    expect(routeClientState(state).catalog.documentTemplateLevels.MISSING).toBeUndefined();
  });
  test("serializes the server clock for the route island's first history render", () => {
    const now = "2026-11-12T23:59:00.000Z";
    setSystemTime(new Date(now));
    try {
      const html = renderToString(() => createComponent(GridsWorkspace, { state: workspaceState() }));
      expect(html).toContain(now);
      expect(html).toContain("&quot;now&quot;");
    } finally {
      setSystemTime();
    }
  });

  test("owns one content shell outside the interactive route island", () => {
    const html = renderToString(() =>
      createComponent(GridsWorkspace, {
        state: workspaceState(),
      }),
    );

    // Count elements, not mentions: a detail panel's size rule also names the content area.
    const contentShell = /class="[^"]*\bk2b-app-workspace__content\b/g;
    expect(html.match(contentShell)).toHaveLength(1);

    const contentClass = html.search(contentShell);
    const contentStart = html.lastIndexOf("<div", contentClass);
    const contentTagEnd = html.indexOf(">", contentClass);
    const routeIsland = html.indexOf("<solid-island", contentTagEnd);

    expect(contentStart).toBeGreaterThan(-1);
    expect(routeIsland).toBeGreaterThan(contentTagEnd);
    expect(html.slice(contentTagEnd + 1, routeIsland).trim()).toBe("");
  });
  test("serializes the table's rows into one island's props only", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const table: PublicTable = {
      id: "TABLE1",
      baseId: "DEMO01",
      name: "Articles",
      description: null,
      icon: null,
      kind: "stored",
      columns: [],
      displayConfig: { mode: "table" },
      auditPolicy: {},
      mutationPolicy: { mode: "all" },
      position: 0,
      disableDirectInsert: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    const field: PublicField = {
      id: "FIELD1",
      tableId: table.id,
      name: "Name",
      description: "",
      type: "text",
      config: {},
      position: 0,
      required: false,
      presentable: true,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const row = (id: string): PublicGridRecord => ({
      id,
      tableId: table.id,
      data: { FIELD1: `Row value ${id}` },
      version: 1,
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const state = workspaceState();
    state.catalog.tables = [table];
    state.catalog.tableLevels = { [table.id]: "read" };
    state.catalog.fieldsByTable = { [table.id]: [field] };
    state.catalog.viewsByTable = { [table.id]: [] };
    state.route = {
      kind: "records",
      activeTable: table,
      activeView: null,
      fields: [field],
      formsForTable: [],
      canReadTable: true,
      canWriteRecords: false,
      canManageActiveTable: false,
      canEditActiveView: false,
      otherTables: [{ id: table.id, name: table.name }],
      initialState: {
        query: {},
        cursor: null,
        selectedRecordId: null,
        search: { q: "", fieldIds: [], override: false },
        calendar: { view: "month", date: "2026-01-01" },
        cardSize: "medium",
      },
      initialData: { items: [row("REC001"), row("REC002")], nextCursor: null },
      initialError: null,
      initialSelectedRecord: null,
      initialSelectedRecordDetail: null,
      documentTemplates: [],
      relationLabels: {},
      activeViewColumns: undefined,
      groupedExplode: false,
      activeRecordQuery: null,
      displayConfig: { mode: "table" },
      bulkSelectionLaunchers: [],
      recordActionLaunchers: [],
    };

    const html = renderToString(() => createComponent(GridsWorkspace, { state }));
    const props = [...html.matchAll(/data-props="([^"]*)"/g)].map((match) => match[1]!);
    const carrying = props.filter((value) => value.includes("Row value REC001"));
    // Rows are the largest part of a table page; a second island with the whole state doubled the HTML (#3849).
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.match(/Row value REC00\d/g)).toHaveLength(2);
    // The navigation island still knows the active table.
    expect(props.some((value) => !value.includes("Row value") && value.includes("table:TABLE1"))).toBe(true);
  });

  test("a table page shows its views as tabs and the one main action in the workspace head", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const table = {
      id: "TABLE1",
      baseId: "DEMO01",
      name: "Articles",
      description: null,
      icon: null,
      kind: "stored",
      columns: [],
      displayConfig: { mode: "table" },
      auditPolicy: {},
      mutationPolicy: { mode: "all" },
      position: 0,
      disableDirectInsert: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    } satisfies PublicTable;
    const view: PublicView = {
      id: "VIEW01",
      tableId: table.id,
      name: "Open articles",
      description: null,
      icon: null,
      source: "from Articles",
      ui: {},
      ownerUserId: null,
      position: 0,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const page = (canWriteRecords: boolean) => {
      const state = workspaceState();
      state.catalog.tables = [table];
      state.catalog.viewsByTable = { [table.id]: [view] };
      state.route = {
        kind: "records",
        activeTable: table,
        activeView: null,
        fields: [],
        formsForTable: [],
        canReadTable: true,
        canWriteRecords,
        canManageActiveTable: false,
        canEditActiveView: false,
        otherTables: [{ id: table.id, name: table.name }],
        initialState: {
          query: {},
          cursor: null,
          selectedRecordId: null,
          search: { q: "", fieldIds: [], override: false },
          calendar: { view: "month", date: "2026-01-01" },
          cardSize: "medium",
        },
        initialData: { items: [], nextCursor: null },
        initialError: null,
        initialSelectedRecord: null,
        initialSelectedRecordDetail: null,
        documentTemplates: [],
        relationLabels: {},
        activeViewColumns: undefined,
        groupedExplode: false,
        activeRecordQuery: null,
        displayConfig: { mode: "table" },
        bulkSelectionLaunchers: [],
        recordActionLaunchers: [],
      };
      return renderToString(() => createComponent(GridsWorkspace, { state }));
    };

    const writer = page(true);
    const head = writer.slice(writer.indexOf("k2b-app-workspace__head"), writer.indexOf("k2b-app-workspace__content"));
    expect(head).toContain(">All records<");
    expect(head).toContain('href="/app/grids/DEMO01/table/TABLE1"');
    expect(head).toContain('href="/app/grids/DEMO01/table/TABLE1/view/VIEW01"');
    expect(head).toContain(">Open articles<");
    // The one filled action links to the create flow, which the records view opens in place once it runs.
    expect(head).toMatch(/<a[^>]*data-workspace-primary[^>]*>/);
    expect(head).toContain('href="/app/grids/DEMO01/table/TABLE1?new=1"');
    expect(head).toContain('aria-haspopup="dialog"');
    expect(head).toContain("Add record");

    const reader = page(false);
    const readerHead = reader.slice(reader.indexOf("k2b-app-workspace__head"), reader.indexOf("k2b-app-workspace__content"));
    expect(readerHead).toContain(">All records<");
    expect(readerHead).not.toContain("data-workspace-primary");
  });
});
