import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicTable } from "../../../api/public-dto";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import type { HomeActivity } from "./base-activity-model";
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

const renderHome = (
  options: Parameters<typeof fixture>[0] & {
    address?: string;
    locale?: string;
    tab?: "groups" | "resources";
    activity?: HomeActivity;
  } = {},
) => {
  const locale = options.locale ?? "en";
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BaseHome, {
          state: fixture(options),
          query: resourcesQuery(locale).parse(options.address ?? "").state,
          tab: options.tab ?? "resources",
          activity: options.activity,
        });
      },
    }),
  );
};

const activity: HomeActivity = {
  total: 1_654,
  points: [3, 5, 4, 6, 1, 0, 7, 9, 6, 8, 5, 1, 0, 23],
  tables: { TABLE2: { total: 1_284, points: [2, 4, 3, 5, 1, 0, 6, 8, 5, 7, 4, 1, 0, 20] } },
  pendingFinalizations: 3,
  failedRuns24h: 2,
  recent: [
    {
      tableId: "TABLE2",
      recordShortId: "REC001",
      title: "Kitchen front oak",
      updatedAt: "2026-08-20T10:00:00.000Z",
      person: { name: "Mira Solberg" },
    },
    { tableId: "TABLE2", recordShortId: "REC002", title: null, updatedAt: "2026-08-20T09:00:00.000Z", person: null },
  ],
};

describe("Grids base home on v2", () => {
  test("leads with new records today, their trend and the exceptions, and names who changed what last", () => {
    const html = renderHome({ activity });
    // the hero: the figure with its real trend, the records of the base, what waits and what failed
    expect(html).toContain("23 new today");
    expect(html).toContain("1,654 records in 1 table");
    expect(html).toContain("3 finalizations waiting");
    expect(html).toContain("2 runs failed (24 h)");
    expect(html).toContain("New records per day over 14 days, 78 in all");
    // a table row carries its records and its days
    expect(html).toContain("Table · 1,284 records");
    expect(html).toContain("new records in 14 days");
    // the last changes: a person's face and name, a change without a person, the record's table
    expect(html).toContain("Recently changed");
    expect(html).toContain("Kitchen front oak");
    expect(html).toContain("Record REC002");
    expect(html).toContain('href="/app/grids/BASE01/table/TABLE2?record=REC001"');
  });

  test("writes large exception counts with the locale's separators", () => {
    const html = renderHome({ activity: { ...activity, pendingFinalizations: 1_204, failedRuns24h: 1_087 } });
    expect(html).toContain("1,204 finalizations waiting");
    expect(html).toContain("1,087 runs failed (24 h)");
  });

  test("a base without a readable table shows no hero", () => {
    const html = renderHome({ activity: { ...activity, total: 0, tables: {}, pendingFinalizations: 0, failedRuns24h: 0, recent: [] } });
    expect(html).not.toContain("new today");
    expect(html).not.toContain("Recently changed");
  });

  test("says nothing of activity it was not given", () => {
    const html = renderHome();
    expect(html).not.toContain("new today");
    expect(html).not.toContain("Recently changed");
  });

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
    // each row carries the mark of its kind; the count stands once, in the filter bar, not as a status row of its own
    expect(html).toContain('data-k2-part="Mark"');
    expect(html).not.toContain('data-k2-part="StatusRow"');
    // the base's purpose lives in its settings, not as a band of its own on the home
    // outside edit mode nothing is created from here; nothing loads on the first picture
    expect(html).not.toContain(">New<");
    expect(html).not.toContain('data-k2-part="Loading"');
    expect(html).not.toMatch(/\bclass="(?!k2-|ti )[^"]*"/);
  });

  test("narrows the entries by kind and search from the address", () => {
    const html = renderHome({ address: "type=view&q=open" });
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
    expect(html).toContain("Übersicht");
  });
});
