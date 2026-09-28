import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import type { Field, GridRecord, Table } from "../../../service";
import { gridsService } from "../../../service";
import { loadInitialRecords } from "./workspace-records-query";

afterEach(() => mock.restore());

const timestamp = "2026-01-01T00:00:00.000Z";
const tableId = "22222222-2222-4222-8222-222222222222";
const customersTableId = "33333333-3333-4333-8333-333333333333";
const linkedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const filteredId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const user = { id: "44444444-4444-4444-8444-444444444444", memberofGroupIds: [] };
const table: Table = {
  id: tableId,
  shortId: "TABL01",
  baseId: "11111111-1111-4111-8111-111111111111",
  kind: "stored",
  name: "Orders",
  description: null,
  icon: null,
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const customer: Field = {
  id: "55555555-5555-4555-8555-555555555555",
  shortId: "CUST01",
  tableId,
  name: "Customer",
  description: null,
  type: "relation",
  config: { targetTableId: customersTableId },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const order: GridRecord = {
  id: "66666666-6666-4666-8666-666666666666",
  shortId: "ORDR01",
  tableId,
  data: { [customer.id]: [linkedId] },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

test("the first render labels the records a relation filter names, also when the page does not link them", async () => {
  const filter = { fieldId: customer.id, op: "notContainsAny" as const, value: [filteredId] };
  spyOn(gridsService.record, "list").mockImplementation(
    async () => ({ ok: true, data: { items: [order], nextCursor: null, filePreviews: {} } }) as never,
  );
  spyOn(gridsService.relations, "buildLabelCache").mockImplementation(async () => ({ [linkedId]: "Acme" }));
  const filterLabels = spyOn(gridsService.relations, "buildFilterLabelCache").mockImplementation(async () => ({ [filteredId]: "Globex" }));

  const initial = await loadInitialRecords({
    activeTable: table,
    fields: [customer],
    recordsState: {
      query: { filter },
      cursor: null,
      selectedRecordId: null,
      search: { q: "", fieldIds: [] },
      calendar: { view: "month", date: "2026-01-01" },
      cardSize: "medium",
    },
    activeView: null,
    displayConfig: { mode: "table" },
    trashMode: false,
    user,
  });

  expect(filterLabels).toHaveBeenCalledWith(filter, [customer], { userId: user.id, userGroups: [] });
  expect(initial.relationLabels).toEqual({ [linkedId]: "Acme", [filteredId]: "Globex" });
});

for (const [label, groupBy] of [
  ["listed", []],
  ["grouped", [{ fieldId: customer.id }]],
] as const) {
  test(`a failed ${label} read gives the page no records and the failure's message`, async () => {
    const failure = fail(err.badInput("The cursor is invalid."));
    spyOn(gridsService.record, "list").mockImplementation(async () => failure as never);
    spyOn(gridsService.record, "group").mockImplementation(async () => failure as never);
    spyOn(gridsService.relations, "buildFilterLabelCache").mockImplementation(async () => ({}));

    const initial = await loadInitialRecords({
      activeTable: table,
      fields: [customer],
      recordsState: {
        query: { groupBy: [...groupBy] },
        cursor: "stale",
        selectedRecordId: null,
        search: { q: "", fieldIds: [] },
        calendar: { view: "month", date: "2026-01-01" },
        cardSize: "medium",
      },
      activeView: null,
      displayConfig: { mode: "table" },
      trashMode: false,
      user,
    });

    expect(initial.error).toBe("The cursor is invalid.");
    expect(initial.records.items).toEqual([]);
    expect(initial.groupedBuckets).toEqual([]);
  });
}
