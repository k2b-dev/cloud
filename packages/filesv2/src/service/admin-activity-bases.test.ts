import { expect, test } from "bun:test";
import { baseId, historyBinding, historyFixture, publicBaseId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import type { Binding } from "../data/bases";
import { createActivityReader } from "./activity-reader";

const call = testCall(testActor);

test("admin base names recheck the canonical guard before each page and never load file context", async () => {
  const f = historyFixture();
  let reads = 0;
  const reader = createActivityReader({
    ...f.deps,
    requestContext: async () => {
      throw new Error("Base labels must not inspect membership or storage");
    },
    data: {
      ...f.deps.data!,
      activityBases: async () => {
        reads++;
        return { items: [historyBinding], next: null };
      },
    },
  });
  await expect(reader.adminActivityBases(call)).rejects.toMatchObject({ status: 403 });
  expect(reads).toBe(0);
  f.setAdmin(true);
  expect(await reader.adminActivityBases(call)).toEqual({
    items: [
      {
        id: publicBaseId,
        bindingId: baseId,
        area: "cloud",
        name: "Deleted account",
        displayName: null,
        kind: "users",
        root: historyBinding.root,
        path: historyBinding.path,
      },
    ],
    next: null,
  });
  expect(await reader.adminActivityBases({ ...call, locale: "de" })).toMatchObject({ items: [{ name: "Gelöschtes Konto" }] });
  f.setAdmin(false);
  await expect(reader.adminActivityBases(call, { after: baseId })).rejects.toMatchObject({ status: 403 });
  expect(reads).toBe(2);
  expect(f.requests).toEqual([]);
});

test("admin base search resolves current names and continues within the existing 500 candidate budget", async () => {
  const f = historyFixture();
  f.setAdmin(true);
  const recorded: Binding[] = Array.from({ length: 701 }, (_, index) => ({
    ...historyBinding,
    id: `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    identity_id: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    identity_name: "Obsolete base label",
    lifecycle: "archived",
  }));
  let reads = 0;
  const id = (row: Binding) => row.id;
  const reader = createActivityReader({
    ...f.deps,
    displayNames: async (entries) => entries.map((entry) => ({ ...entry, displayName: "Current name" })),
    data: {
      ...f.deps.data!,
      activityBases: async (after, limit, budget) => {
        budget.check();
        reads++;
        expect(limit).toBe(50);
        const rest = recorded.filter((row) => !after || id(row) > after);
        return { items: rest.slice(0, limit), next: rest.length > limit ? id(rest[limit - 1]!) : null };
      },
    },
  });
  const first = await reader.adminActivityBases(call, { q: "Current" });
  expect(first.items).toHaveLength(50);
  expect(first.items[0]?.name).toBe("Current name");
  expect(first.next).toBe(id(recorded[49]!));
  const missing = await reader.adminActivityBases(call, { q: "Obsolete" });
  expect(missing).toEqual({ items: [], next: id(recorded[499]!) });
  expect(reads).toBe(11);
  expect(await reader.adminActivityBases(call, { q: "Obsolete", after: missing.next! })).toEqual({ items: [], next: null });
});

test("base input rejects invalid cursors and cancellation prevents SQL and directory work", async () => {
  const f = historyFixture();
  f.setAdmin(true);
  for (const input of [
    { after: "not-a-base" },
    { after: publicBaseId },
    { baseId: "cloud:users:invalid" },
    { bindingIds: "invalid" },
    { bindingIds: Array(51).fill(baseId).join(",") },
    { q: "" },
    { q: "a".repeat(4097) },
    { limit: 51 },
  ])
    await expect(f.reader.adminActivityBases(call, input)).rejects.toMatchObject({ code: "invalid_activity_filter" });
  const controller = new AbortController();
  controller.abort(new Error("client left"));
  await expect(f.reader.adminActivityBases({ ...call, requestAbort: controller.signal })).rejects.toThrow("client left");
  expect(f.requests).toEqual([]);
});

test("distinct historical bindings of one public ID are all returned and cursor continuation does not skip them", async () => {
  const f = historyFixture();
  f.setAdmin(true);
  const recorded: Binding[] = Array.from({ length: 53 }, (_, index) => ({
    ...historyBinding,
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    root: index % 2 ? "old-cloud" : "cloud",
    path: `archive/location-${index}`,
    lifecycle: "archived",
  }));
  const lookups: unknown[] = [];
  const reader = createActivityReader({
    ...f.deps,
    displayNames: async (entries) => {
      // Repeated bindings do not fan out identical directory lookups.
      expect(entries).toHaveLength(1);
      return entries.map((entry) => ({ ...entry, displayName: "Current Alice" }));
    },
    data: {
      ...f.deps.data!,
      activityBases: async (after, limit, budget, filter) => {
        budget.check();
        lookups.push(filter);
        const rows = recorded.filter((row) => (!after || row.id > after) && (!filter?.bindingIds || filter.bindingIds.includes(row.id)));
        return { items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
      },
    },
  });
  const first = await reader.adminActivityBases(call, { baseId: publicBaseId });
  const second = await reader.adminActivityBases(call, { baseId: publicBaseId, after: first.next! });
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(3);
  expect(second.next).toBeNull();
  expect(new Set([...first.items, ...second.items].map((base) => base.bindingId)).size).toBe(53);
  expect(new Set([...first.items, ...second.items].map((base) => base.id))).toEqual(new Set([publicBaseId]));
  expect(second.items[0]).toMatchObject({ displayName: "Current Alice", name: "Current Alice", path: "archive/location-50" });
  expect(lookups).toEqual([
    { baseId: publicBaseId, bindingIds: undefined },
    { baseId: publicBaseId, bindingIds: undefined },
  ]);
  const exact = await reader.adminActivityBases(call, { bindingIds: recorded[52]!.id });
  expect(exact.items.map((base) => base.bindingId)).toEqual([recorded[52]!.id]);
});
