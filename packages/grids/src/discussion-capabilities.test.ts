import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { assertResourceOpenLink, assertResourceView, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { type CapabilityExecutionContext, capabilityResultSchema, discussionsIssues, type PermissionLevel } from "@k2b/cloud/contracts";
import * as settings from "@k2b/cloud/services/settings";
import { gridsCapabilities } from "./capabilities";
import { BaseSchema, GridRecordSchema, TableSchema } from "./contracts";
import { gridsService } from "./service";

const timestamp = "2026-11-01T00:00:00.000Z";
const accountId = "11111111-1111-4111-8111-111111111111";
const base = BaseSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "BASE01",
  name: "Projects",
  description: null,
  createdBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const table = TableSchema.parse({
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "TABLE1",
  baseId: base.id,
  kind: "stored",
  name: "Tasks",
  description: null,
  columns: [],
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const record = GridRecordSchema.parse({
  id: "44444444-4444-4444-8444-444444444444",
  shortId: "REC001",
  tableId: table.id,
  data: {},
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const context = (scopes = ["grids:admin"], boundBase?: string): CapabilityExecutionContext => ({
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: accountId,
      name: "Discussion reader",
      kind: boundBase ? "resource_bound" : "standalone",
      status: "active",
      delegatedUserId: null,
      appId: boundBase ? "grids" : null,
      resourceType: boundBase ? "base" : null,
      resourceId: boundBase ?? null,
      createdBy: null,
      createdAt: timestamp,
    },
    delegatedUser: null,
    scopes,
  },
  accessSubject: { type: "service_account", serviceAccountId: accountId },
  user: null,
  locale: "en",
  requestId: "grids-discussion-unit",
  origin: "app",
  signal: new AbortController().signal,
});
const grant = (level: PermissionLevel, baseId = base.id) => ({
  resourceType: "base" as const,
  resourceId: baseId,
  principalTier: "serviceAccount" as const,
  level,
});

const grants = spyOn(gridsService.permission, "loadBaseGrantsForSubject");
const getBase = spyOn(gridsService.base, "get");
const getBaseById = spyOn(gridsService.base, "getByShortId");
const listVisible = spyOn(gridsService.base, "listVisible");
const getTable = spyOn(gridsService.table, "get");
const getRecordById = spyOn(gridsService.record, "getByShortId");
const getRecord = spyOn(gridsService.record, "get");
const getSetting = spyOn(settings, "get");
const spies = [grants, getBase, getBaseById, listVisible, getTable, getRecordById, getRecord, getSetting];

beforeEach(() => {
  for (const spy of spies) spy.mockReset();
  grants.mockResolvedValue([grant("write")]);
  getBase.mockResolvedValue(base);
  getBaseById.mockResolvedValue(base);
  listVisible.mockResolvedValue({ items: [base], total: 1 });
  getTable.mockResolvedValue(table);
  getRecordById.mockResolvedValue(record);
  getRecord.mockResolvedValue(record);
  getSetting.mockResolvedValue("UTC");
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const readBase = (caller = context()) => gridsCapabilities.queries["base.read"].run({ id: base.shortId }, caller);
const readRecord = (caller = context()) => gridsCapabilities.queries["record.read"].run({ id: record.shortId }, caller);
const containers = (input: unknown = {}, caller = context()) => {
  const query = gridsCapabilities.queries["base.containers"];
  return query.run(query.input.parse(input), caller);
};

describe("Grids discussion provider", () => {
  test("compiles record inside base with compatible readers and a closed-world container query", () => {
    const manifest = compileCapabilityManifest("grids", gridsCapabilities);
    expect(manifest.discussions).toEqual({ item: "record", containers: "base.containers" });
    expect(manifest.resourceTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "base", view: true }),
        expect.objectContaining({ type: "record", container: "base", view: true }),
      ]),
    );
    expect(discussionsIssues(manifest)).toEqual([]);
  });

  for (const permission of ["read", "write", "admin"] as const) {
    for (const locale of ["en", "de"] as const) {
      test(`${permission} readers return authorized views and open links in ${locale}`, async () => {
        grants.mockResolvedValue([grant(permission)]);
        const caller = { ...context(), locale };
        const container = await readBase(caller);
        const item = await readRecord(caller);
        if (!container.ok) throw container.error;
        if (!item.ok) throw item.error;
        capabilityResultSchema(gridsCapabilities.queries["base.read"].data).parse(container.data);
        capabilityResultSchema(gridsCapabilities.queries["record.read"].data).parse(item.data);
        expect(assertResourceView(container.data)).toEqual({ title: base.name, permission });
        expect(assertResourceView(item.data, { type: "grids.base", id: base.shortId })).toEqual({
          title: "Tasks · REC001",
          permission,
          container: { ref: { type: "grids.base", id: base.shortId }, title: base.name },
        });
        assertResourceOpenLink(container.data);
        assertResourceOpenLink(item.data);
        expect(item.data.links).toContainEqual({ rel: "open", href: "/app/grids/BASE01/table/TABLE1?record=REC001" });
        expect(grants).toHaveBeenCalledWith({ baseId: base.id, subject: caller.accessSubject }, undefined);
      });
    }
  }

  test("missing or denied resources return no view or container title", async () => {
    grants.mockResolvedValue([]);
    expect((await readBase()).ok).toBe(false);
    expect((await readRecord()).ok).toBe(false);
    expect(getRecord).not.toHaveBeenCalled();
    expect(getBase).not.toHaveBeenCalled();
    getBaseById.mockResolvedValue(null);
    getRecordById.mockResolvedValue(null);
    expect((await readBase()).ok).toBe(false);
    expect((await readRecord()).ok).toBe(false);
  });

  test("credential scope caps both reader permissions and rejects credentials without read scope", async () => {
    grants.mockResolvedValue([grant("admin")]);
    for (const read of [readBase, readRecord]) {
      const result = await read(context(["grids:read"]));
      if (!result.ok) throw result.error;
      expect(assertResourceView(result.data).permission).toBe("read");
      expect((await read(context([]))).ok).toBe(false);
    }
    expect((await containers({}, context([]))).ok).toBe(false);
    expect(listVisible).not.toHaveBeenCalled();
  });

  test("resource-bound credentials cannot read or list another base", async () => {
    const caller = context(["grids:read"], "55555555-5555-4555-8555-555555555555");
    expect((await readBase(caller)).ok).toBe(false);
    expect((await readRecord(caller)).ok).toBe(false);
    const listed = await containers({}, caller);
    expect(listed.ok && listed.data.data.items).toEqual([]);
    expect(listVisible).toHaveBeenCalledWith(expect.objectContaining({ baseId: "55555555-5555-4555-8555-555555555555" }));
    expect(grants).not.toHaveBeenCalled();
  });

  test("lists only currently readable bases using the incoming access subject", async () => {
    const caller = context();
    const result = await containers({ query: "Projects" }, caller);
    if (!result.ok) throw result.error;
    expect(result.data.data).toEqual({ items: [{ ref: { type: "grids.base", id: "BASE01" }, title: "Projects" }], next: null });
    expect(listVisible).toHaveBeenCalledWith({
      userId: null,
      userGroups: [],
      serviceAccountId: accountId,
      query: "Projects",
      limit: 50,
      offset: 0,
    });
    expect(grants).toHaveBeenCalledWith({ baseId: base.id, subject: caller.accessSubject }, undefined);
    grants.mockResolvedValue([]);
    const denied = await containers();
    expect(denied.ok && denied.data.data.items).toEqual([]);
  });

  test("opaque pagination advances past denied candidates and supports a changed limit", async () => {
    listVisible.mockResolvedValueOnce({ items: [base], total: 3 });
    grants.mockResolvedValueOnce([]);
    const first = await containers({ limit: 1 });
    if (!first.ok || !first.data.data.next) throw new Error("Expected continuation after the denied candidate");
    expect(first.data.data.items).toEqual([]);
    expect(first.data.data.next).not.toBe("1");
    // A paginated Query's page mirrors its continuation cursor.
    expect(first.data.page).toEqual({ hasMore: true, nextCursor: first.data.data.next });
    listVisible.mockResolvedValueOnce({
      items: [
        { ...base, shortId: "BASE02" },
        { ...base, shortId: "BASE03" },
      ],
      total: 3,
    });
    const second = await containers({ cursor: first.data.data.next, limit: 2 });
    if (!second.ok) throw second.error;
    expect(listVisible).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1, limit: 2 }));
    expect(second.data.data.items.map((item) => item.ref.id)).toEqual(["BASE02", "BASE03"]);
    expect(second.data.data.next).toBeNull();
    expect(second.data.page).toEqual({ hasMore: false });
    capabilityResultSchema(gridsCapabilities.queries["base.containers"].data).parse(second.data);
  });

  test("rejects malformed cursors and honours cancellation before returning candidates", async () => {
    expect((await containers({ cursor: "not-a-cursor" })).ok).toBe(false);
    expect(listVisible).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(containers({}, { ...context(), signal: controller.signal })).rejects.toThrow();
  });
});
