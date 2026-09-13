import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { gridsService } from "../../../service";
import { loadWorkspaceRequest } from "./workspace-request-state";
import { loadGridsWorkspaceState } from "./workspace-state";

const loadWorkspaceState = (params: Parameters<typeof loadGridsWorkspaceState>[0]) =>
  loadGridsWorkspaceState(params, {
    loadRevision: async () => ({ revision: "fixture", resources: {} }),
    latestMetadataEventCursor: async () => null,
    latestRecordEventCursor: async () => null,
  });

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  shortId: "BASE1",
  name: "Forms Base",
  description: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const formTable = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "TBL01",
  baseId: base.id,
  kind: "stored" as const,
  name: "Hidden table",
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" as const },
  auditPolicy: {},
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const form = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "FORM1",
  tableId: formTable.id,
  name: "Intake",
  config: { fields: [] },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("loadGridsWorkspaceState — Base access boundary", () => {
  beforeEach(() => {
    spyOn(gridsService.base, "getByShortId").mockImplementation(async () => base as never);
    spyOn(gridsService.base, "catalog").mockImplementation(
      async () =>
        ({
          tables: [],
          tableLevels: {},
          fieldsByTable: { [formTable.id]: [] },
          viewsByTable: {},
          formsByTable: { [formTable.id]: [form] },
          formLevels: { [form.id]: "write" },
          formTables: [formTable],
          sidebarForms: [{ form, tableId: formTable.id }],
        }) as never,
    );
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => "none");
    spyOn(gridsService.table, "getByShortIdForBase").mockImplementation(async () => null);
    spyOn(gridsService.view, "getByShortIdForTable").mockImplementation(async () => null);
    spyOn(gridsService.workflow, "listForBase").mockImplementation(async () => []);
    spyOn(gridsService.workflow.launcher, "listForBase").mockImplementation(async () => []);
  });

  afterEach(() => mock.restore());

  test("rejects legacy form-only catalog entries without Base read access", async () => {
    const state = await loadWorkspaceState({
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        memberofGroupIds: [],
      },
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}`,
    });

    expect(state).toEqual({ kind: "accessDenied", title: "Access denied", message: "No access to this base" });
  });

  test("keeps metadata and record cursors on their matching SSR streams", async () => {
    spyOn(gridsService.permission, "resolve").mockImplementation(() => "read");
    const loadedStreams: string[] = [];
    const state = await loadGridsWorkspaceState(
      {
        user: {
          id: "44444444-4444-4444-8444-444444444444",
          memberofGroupIds: [],
        },
        baseShortId: base.shortId,
        href: `/app/grids/${base.shortId}`,
      },
      {
        loadRevision: async () => ({ revision: "fixture", resources: {} }),
        latestMetadataEventCursor: async (baseId) => {
          loadedStreams.push(`metadata:${baseId}`);
          return "metadata-cursor";
        },
        latestRecordEventCursor: async (baseId) => {
          loadedStreams.push(`records:${baseId}`);
          return "record-cursor";
        },
      },
    );

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.metadataEventCursor).toBe("metadata-cursor");
    expect(state.recordEventCursor).toBe("record-cursor");
    expect(loadedStreams.sort()).toEqual([`metadata:${base.id}`, `records:${base.id}`]);
  });

  test("keeps the healthy SSR cursor when the other stream is unavailable", async () => {
    spyOn(gridsService.permission, "resolve").mockImplementation(() => "read");
    const state = await loadGridsWorkspaceState(
      {
        user: {
          id: "44444444-4444-4444-8444-444444444444",
          memberofGroupIds: [],
        },
        baseShortId: base.shortId,
        href: `/app/grids/${base.shortId}`,
      },
      {
        loadRevision: async () => ({ revision: "fixture", resources: {} }),
        latestMetadataEventCursor: async () => {
          throw new Error("metadata stream unavailable");
        },
        latestRecordEventCursor: async () => "record-cursor",
      },
    );

    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.metadataEventCursor).toBeNull();
    expect(state.recordEventCursor).toBe("record-cursor");
  });

  test("does not expose the query workspace to form-only users", async () => {
    const state = await loadWorkspaceState({
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        memberofGroupIds: [],
      },
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/query`,
    });

    expect(state).toEqual({
      kind: "accessDenied",
      title: "Access denied",
      message: "No access to this base",
    });
  });

  test("does not resolve a hidden table through an unreadable view slug", async () => {
    spyOn(gridsService.table, "getByShortIdForBase").mockImplementation(async () => formTable as never);
    const listRecords = spyOn(gridsService.record, "list");
    const getRecord = spyOn(gridsService.record, "get");

    const state = await loadWorkspaceState({
      user: {
        id: "44444444-4444-4444-8444-444444444444",
        memberofGroupIds: [],
      },
      baseShortId: base.shortId,
      href: `/app/grids/${base.shortId}/table/${formTable.shortId}/view/missing?record=55555555-5555-4555-8555-555555555555`,
      activeTableSlug: formTable.shortId,
      activeViewSlug: "missing",
    });

    expect(state).toEqual({ kind: "accessDenied", title: "Access denied", message: "No access to this base" });
    expect(listRecords).not.toHaveBeenCalled();
    expect(getRecord).not.toHaveBeenCalled();
  });

  test("rejects a readable legacy table entry without Base read access", async () => {
    spyOn(gridsService.base, "catalog").mockImplementation(
      async () =>
        ({
          tables: [formTable],
          tableLevels: { [formTable.id]: "read" },
          fieldsByTable: { [formTable.id]: [] },
          viewsByTable: {},
          formsByTable: {},
          formLevels: {},
          formTables: [],
          sidebarForms: [],
        }) as never,
    );

    const request = await loadWorkspaceRequest(
      {
        user: {
          id: "44444444-4444-4444-8444-444444444444",
          memberofGroupIds: [],
        },
        baseShortId: base.shortId,
        href: `/app/grids/${base.shortId}`,
      },
      base as never,
      { metadata: null, records: null },
    );

    expect(request).toEqual({ kind: "accessDenied", title: "Access denied", message: "No access to this base" });
  });
});
