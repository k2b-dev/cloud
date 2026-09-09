import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { gridsService } from "../../../service";
import * as publicResources from "../../../service/public-resources";
import { loadGridsWorkspaceState } from "./workspace-state";

const loadWorkspaceState = (params: Parameters<typeof loadGridsWorkspaceState>[0]) =>
  loadGridsWorkspaceState(params, {
    latestMetadataEventCursor: async () => null,
    latestRecordEventCursor: async () => null,
  });

const viewerId = "44444444-4444-4444-8444-444444444444";
const selectedRecordId = "77777777-7777-4777-8777-777777777777";
const selectedRecordPublicId = "REC001";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  shortId: "BASE01",
  name: "GQL Base",
  description: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const table = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "TABL01",
  baseId: base.id,
  name: "Orders",
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" as const },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const statusField = {
  id: "88888888-8888-4888-8888-888888888888",
  shortId: "STAT01",
  tableId: table.id,
  name: "Status",
  description: null,
  icon: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const savedView = {
  id: "99999999-9999-4999-8999-999999999999",
  shortId: "VIEW01",
  tableId: table.id,
  name: "Open orders",
  description: null,
  icon: null,
  source: `from table {${table.shortId}}\nwhere {${statusField.shortId}} = 'Open'\nsort {${statusField.shortId}} asc`,
  ui: { displayConfig: { mode: "table" as const } },
  ownerUserId: null,
  position: 0,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let baseLevel: "none" | "read" | "write" | "admin" = "read";
let catalogTables: unknown[] = [table];
let catalogTableLevels: Record<string, "none" | "read" | "write" | "admin"> = { [table.id]: "read" };
let catalogFieldsByTable: Record<string, unknown[]> = { [table.id]: [statusField] };
let catalogViewsByTable: Record<string, unknown[]> = { [table.id]: [] };
let lookupTable: typeof table | null = null;
let lookupView: typeof savedView | null = null;
let lastRecordListParams: Record<string, unknown> | null = null;
let lastRecordGroupParams: Record<string, unknown> | null = null;
let lastRelationLabelViewer: { userId: string | null } | undefined;
let recordGetCalls = 0;
let recordListRecordForId: unknown | null = null;

const user = {
  id: viewerId,
  roles: [],
  memberofGroupIds: [],
};

describe("loadGridsWorkspaceState — GQL-backed views", () => {
  beforeEach(() => {
    baseLevel = "read";
    catalogTables = [table];
    catalogTableLevels = { [table.id]: "read" };
    catalogFieldsByTable = { [table.id]: [statusField] };
    catalogViewsByTable = { [table.id]: [] };
    lookupTable = null;
    lookupView = null;
    lastRecordListParams = null;
    lastRecordGroupParams = null;
    lastRelationLabelViewer = undefined;
    recordGetCalls = 0;
    recordListRecordForId = null;

    spyOn(gridsService.base, "getByShortId").mockImplementation(async () => base as never);
    spyOn(gridsService.base, "catalog").mockImplementation(
      async () =>
        ({
          tables: catalogTables,
          tableLevels: catalogTableLevels,
          fieldsByTable: catalogFieldsByTable,
          viewsByTable: catalogViewsByTable,
          formsByTable: { [table.id]: [] },
          formLevels: {},
          formTables: [],
          sidebarForms: [],
        }) as never,
    );
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => baseLevel);
    spyOn(gridsService.table, "getByShortIdForBase").mockImplementation(
      async (_baseId, idOrSlug) =>
        (lookupTable && (lookupTable.id === idOrSlug || lookupTable.shortId === idOrSlug) ? lookupTable : null) as never,
    );
    spyOn(gridsService.view, "getByShortIdForTable").mockImplementation(
      async (_tableId, idOrSlug) =>
        (lookupView && (lookupView.id === idOrSlug || lookupView.shortId === idOrSlug) ? lookupView : null) as never,
    );
    spyOn(gridsService.field, "listByTable").mockImplementation(async () => [statusField] as never);
    spyOn(publicResources, "resolveStoredPublicId").mockImplementation(async (_kind, publicId) =>
      publicId === selectedRecordPublicId ? selectedRecordId : null,
    );
    spyOn(gridsService.workflow, "listForBase").mockImplementation(async () => []);
    spyOn(gridsService.workflow, "listEnabledForBase").mockImplementation(async () => []);
    spyOn(gridsService.workflow.launcher, "listForBase").mockImplementation(async () => []);
    spyOn(gridsService.record, "list").mockImplementation(async (params) => {
      lastRecordListParams = params;
      const ids = (params.recordMeta as { ids?: unknown[] } | null | undefined)?.ids;
      const items = ids?.includes(selectedRecordId) && recordListRecordForId ? [recordListRecordForId] : [];
      return { ok: true, data: { items, aggregates: {}, nextCursor: null, filePreviews: {} } } as never;
    });
    spyOn(gridsService.record, "group").mockImplementation(async (params) => {
      lastRecordGroupParams = params;
      const limit = Number(params.limit ?? 0);
      return {
        ok: true,
        data: {
          buckets: Array.from({ length: limit }, (_, index) => ({ keys: [`group-${index}`], values: {} })),
          explode: false,
          nextCursor: limit > 0 ? "next-group-page" : null,
        },
      } as never;
    });
    spyOn(gridsService.record, "get").mockImplementation(async () => {
      recordGetCalls += 1;
      return null;
    });
    spyOn(gridsService.relations, "buildLabelCache").mockImplementation(async (_records, _fields, viewer) => {
      lastRelationLabelViewer = viewer;
      return {};
    });
    spyOn(gridsService.relations, "buildLabelCacheForGroupedKeys").mockImplementation(async () => ({}));
  });

  afterEach(() => mock.restore());

  test("opens the base overview without implicitly querying the first table", async () => {
    const state = await loadWorkspaceState({ href: "/app/grids/BASE01", baseShortId: base.shortId, user });
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.route.kind).toBe("overview");
    expect(lastRecordListParams).toBeNull();
    expect(recordGetCalls).toBe(0);
  });

  test("loads records views from canonical GQL source instead of cached RecordQuery JSON", async () => {
    catalogViewsByTable = { [table.id]: [savedView] };
    lookupTable = table;
    lookupView = savedView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${savedView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: savedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.route.kind).toBe("records");
    if (state.route.kind !== "records") return;
    expect(state.route.initialState.query.filter).toEqual({ fieldId: statusField.id, op: "equals", value: "Open" });
    expect(state.route.initialState.query.sort).toEqual([{ fieldId: statusField.id, direction: "asc" }]);
    expect(lastRecordListParams?.filter).toEqual({ fieldId: statusField.id, op: "equals", value: "Open" });
    expect(lastRelationLabelViewer?.userId).toBe(user.id);
  });

  test("routes aggregate-only saved views to the query-result runtime without listing records", async () => {
    const aggregateView = {
      ...savedView,
      id: "66666666-6666-4666-8666-666666666666",
      shortId: "COUNT1",
      name: "Orders count",
      source: `from table {${table.shortId}}\naggregate count(*) as orders`,
    };
    catalogViewsByTable = { [table.id]: [aggregateView] };
    lookupTable = table;
    lookupView = aggregateView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${aggregateView.shortId}?cursor=signed-cursor`,
      activeTableSlug: table.shortId,
      activeViewSlug: aggregateView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "queryResultView") return;
    expect(state.route.activeView.id).toBe(aggregateView.id);
    expect(state.route.initialCursor).toBe("signed-cursor");
    expect(state.route.initialResult).toBeNull();
    expect(lastRecordListParams).toBeNull();
  });

  test("hydrates grouped aggregate sort into the client records state", async () => {
    const groupedView = {
      ...savedView,
      source: `from table {${table.shortId}}\ngroup by {${statusField.shortId}}\naggregate count(*) as rows\nsort {${statusField.shortId}} asc, rows desc`,
    };
    catalogViewsByTable = { [table.id]: [groupedView] };
    lookupTable = table;
    lookupView = groupedView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${groupedView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: groupedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "records") return;
    expect(state.route.initialState.query.groupSort).toEqual([{ fieldId: "*", agg: "count", direction: "desc" }]);
  });

  test("hydrates large grouped limits as bounded cursor pages", async () => {
    const groupedView = {
      ...savedView,
      source: `from table {${table.shortId}}\ngroup by {${statusField.shortId}}\naggregate count(*) as rows\nlimit 2500`,
    };
    catalogViewsByTable = { [table.id]: [groupedView] };
    lookupTable = table;
    lookupView = groupedView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${groupedView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: groupedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "records") return;
    expect(lastRecordGroupParams?.limit).toBe(100);
    expect(state.route.initialData.buckets).toHaveLength(100);
    expect(state.route.initialData.nextCursor).toBe("next-group-page");
  });

  test("loads a directly addressed view when the catalog snapshot omits its table", async () => {
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = savedView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${savedView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: savedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.route.kind).toBe("records");
    if (state.route.kind !== "records") return;
    expect(state.catalog.tables).toEqual([]);
    expect(state.route.activeTable.id).toBe(table.id);
    expect(state.route.activeView?.id).toBe(savedView.id);
    expect(state.route.fields.map((field) => field.id)).toEqual([statusField.id]);
    expect(state.route.canWriteRecords).toBe(false);
  });

  test("does not let URL query state expand a directly addressed view during SSR", async () => {
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = savedView;

    const hostileFilter = encodeURIComponent(JSON.stringify({ fieldId: statusField.id, op: "equals", value: "Closed" }));
    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${savedView.shortId}` + `?filter=${hostileFilter}&q=Closed&trash=1`,
      activeTableSlug: table.shortId,
      activeViewSlug: savedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "records") return;
    expect(lastRecordListParams?.filter).toEqual({ fieldId: statusField.id, op: "equals", value: "Open" });
    expect(lastRecordListParams?.search).toBeNull();
    expect(lastRecordListParams?.deletedOnly).toBe(false);
    expect(state.route.initialState.query.filter).toEqual({ fieldId: statusField.id, op: "equals", value: "Open" });
    expect(state.route.initialState.query.deletedOnly).toBeUndefined();
  });

  test("loads a directly addressed query-result view when the catalog snapshot omits its table", async () => {
    const aggregateView = {
      ...savedView,
      id: "66666666-6666-4666-8666-666666666666",
      shortId: "COUNT1",
      name: "Orders count",
      source: `from table {${table.shortId}}\naggregate count(*) as orders`,
    };
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = aggregateView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${aggregateView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: aggregateView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "queryResultView") return;
    expect(state.catalog.tables).toEqual([]);
    expect(state.route.activeView.id).toBe(aggregateView.id);
    expect(state.route.fields).toEqual([]);
    expect(state.route.canManageActiveTable).toBe(false);
    expect(lastRecordListParams).toBeNull();
  });

  test("defers joined sources in a directly addressed view to the trusted query runtime", async () => {
    const hiddenJoinView = {
      ...savedView,
      id: "55555555-5555-4555-8555-555555555555",
      shortId: "JOIN01",
      name: "Joined orders",
      source: `from table {${table.shortId}} as orders\njoin table {HIDN01} as hidden on orders.id = hidden.id`,
    };
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = hiddenJoinView;

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${hiddenJoinView.shortId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: hiddenJoinView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "queryResultView") return;
    expect(state.route.activeView.id).toBe(hiddenJoinView.id);
    expect(state.route.fields).toEqual([]);
    expect(lastRecordListParams).toBeNull();
  });

  test("loads selected records through the saved view query when the catalog snapshot omits its table", async () => {
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = savedView;
    recordListRecordForId = {
      id: selectedRecordId,
      tableId: table.id,
      data: { [statusField.id]: "Open" },
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${savedView.shortId}?record=${selectedRecordPublicId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: savedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.route.kind).toBe("records");
    if (state.route.kind !== "records") return;
    expect(recordGetCalls).toBe(0);
    expect(state.route.initialSelectedRecord?.id).toBe(selectedRecordId);
    expect(lastRecordListParams?.recordMeta).toEqual({ ids: [selectedRecordId] });
    expect(lastRecordListParams?.filter).toEqual({ fieldId: statusField.id, op: "equals", value: "Open" });
  });

  test("does not expose a selected record outside a view's explicit limit during SSR", async () => {
    const limitedView = { ...savedView, source: `${savedView.source}\nlimit 1` };
    catalogTables = [];
    catalogTableLevels = {};
    catalogFieldsByTable = {};
    lookupTable = table;
    lookupView = limitedView;
    recordListRecordForId = {
      id: selectedRecordId,
      tableId: table.id,
      data: { [statusField.id]: "Open" },
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const state = await loadWorkspaceState({
      user,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${table.shortId}/view/${limitedView.shortId}?record=${selectedRecordPublicId}`,
      activeTableSlug: table.shortId,
      activeViewSlug: limitedView.shortId,
    });

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok" || state.route.kind !== "records") return;
    expect(recordGetCalls).toBe(0);
    expect(state.route.initialSelectedRecord).toBeNull();
    expect(lastRecordListParams?.limit).toBe(1);
    expect(lastRecordListParams?.recordMeta).toBeNull();
  });

  test("does not treat Cloud admin role as Grids base access", async () => {
    baseLevel = "none";
    catalogTables = [];
    catalogTableLevels = {};
    const adminUser = { ...user, roles: ["admin", "user", "local", "local/user"] };

    const state = await loadWorkspaceState({
      user: adminUser,
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}`,
    });

    expect(state.kind).toBe("accessDenied");
    if (state.kind !== "accessDenied") return;
    expect(state.message).toBe("No access to this base");
  });
});
