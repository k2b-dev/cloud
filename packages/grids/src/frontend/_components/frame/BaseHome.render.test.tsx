import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicTable } from "../../../api/public-dto";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import "../ssr-test-plugin";

const { default: BaseHome } = await import("./BaseHome.island.tsx");
const { resourcesQuery } = await import("./resources-query");
const { LocaleProvider } = await import("@k2b/ui");

const table = (id: string, name: string): PublicTable => ({
  id,
  baseId: "BASE01",
  name,
  description: null,
  icon: null,
  kind: "stored",
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
  deletedAt: null,
});

const fixture = (options: { edit?: boolean; groups?: boolean; route?: "overview" | "empty"; tables?: PublicTable[] } = {}) => {
  const tables = options.tables ?? [table("TABLE1", "Loans"), table("TABLE2", "Devices")];
  const state = {
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
    adminModeRequested: options.edit ?? false,
    editModeToggleHref: options.edit ? "/app/grids/BASE01" : "/app/grids/BASE01?edit=true",
    canManageBase: true,
    canCreateTables: true,
    canUseEditMode: true,
    canUseQueryWorkspace: true,
    liveCursor: null,
    navigation: {
      revision: 1,
      groups: options.groups ? [{ id: "GROUP1", name: "Loan desk", entries: [{ type: "table", id: "TABLE1" }] }] : [],
    },
    route: { kind: options.route ?? "overview" },
    catalog: {
      customApps: [],
      workflows: [],
      workflowLaunchers: [],
      workflowLevels: {},
      tables,
      tableLevels: Object.fromEntries(tables.map((each) => [each.id, "admin"])),
      fieldsByTable: {},
      viewsByTable: {
        TABLE1: [{ id: "VIEW01", tableId: "TABLE1", name: "Open loans", icon: null }],
      },
      formsByTable: {},
      documentTemplatesByTable: {},
      documentTemplateLevels: {},
      sidebarForms: [],
      sidebarDocumentTemplates: [],
    },
  } as unknown as PublicOkWorkspaceState;
  return state;
};

const renderHome = (options: Parameters<typeof fixture>[0] & { address?: string; locale?: string; tab?: "groups" | "resources" } = {}) => {
  const locale = options.locale ?? "en";
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BaseHome, {
          state: fixture(options),
          query: resourcesQuery(locale).parse(options.address ?? "").state,
          tab: options.tab ?? "resources",
        });
      },
    }),
  );
};

describe("Grids base home on v2", () => {
  test("lists what the base holds by kind with the base's places in the sidebar", () => {
    const html = renderHome();
    expect(html).toContain('data-k2-part="Workspace"');
    expect(html).toContain('data-k2-part="Nav"');
    // sidebar: the base with overview and query, tables with their views one level in, edit mode and settings at the foot
    expect(html).toContain("Overview");
    expect(html).toContain('href="/app/grids/BASE01/query"');
    expect(html).toContain('href="/app/grids/BASE01/table/TABLE1/view/VIEW01"');
    expect(html).toContain("Edit mode");
    expect(html).toContain("Settings");
    // the list: one section per kind, every row opens its page
    expect(html).toContain('data-k2-part="Section"');
    expect(html).toContain('href="/app/grids/BASE01/table/TABLE2"');
    expect(html).toContain("Open loans");
    expect(html).toContain("3 entries");
    expect(html).toContain("Team workspace");
    // outside edit mode nothing is created from here; nothing loads on the first picture
    expect(html).not.toContain(">New<");
    expect(html).not.toContain('data-k2-part="Loading"');
    expect(html).not.toMatch(/\bclass="(?!k2-|ti )[^"]*"/);
  });

  test("narrows the entries by kind and search from the address", () => {
    const html = renderHome({ address: "type=view&q=open" });
    expect(html).toContain("1 of 3 entries");
    expect(html).toContain("Open loans");
    expect(html).not.toContain('href="/app/grids/BASE01/table/TABLE2"><');
    const none = renderHome({ address: "q=zzz" });
    expect(none).toContain("Nothing in this base matches.");
    expect(none).toContain("Show everything");
  });

  test("offers curated groups as tabs and shows the open group", () => {
    const html = renderHome({ groups: true, tab: "groups" });
    expect(html).toContain('data-k2-part="Tabs"');
    expect(html).toContain("Loan desk");
    expect(html).toContain("All resources");
  });

  test("edit mode keeps edit in every link and offers New", () => {
    const html = renderHome({ edit: true });
    expect(html).toContain('href="/app/grids/BASE01/table/TABLE1?edit=true"');
    expect(html).toContain("Done editing");
    expect(html).toContain("New");
  });

  test("a base without tables says what to do next", () => {
    const html = renderHome({ route: "empty", tables: [] });
    expect(html).toContain("No tables yet. Turn on Edit mode to create one.");
  });

  test("German copy", () => {
    const html = renderHome({ locale: "de" });
    expect(html).toContain("Übersicht");
    expect(html).toContain("Tabellen");
    expect(html).toContain("3 Einträge");
  });
});
