import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridRecord, PublicTableQueryResult, PublicView } from "../../../api/public-dto";
import type { GroupBySpec } from "../../../contracts";

const domTest = isServer ? test.skip : test;
const timestamp = "2026-01-01T00:00:00.000Z";

mock.module("./grids-record-events-provider", () => ({
  createGridsRecordEventsProvider: () => ({ connect: () => {}, dispose: () => {}, markApplied: () => {} }),
}));
mock.module("./fetcher", () => ({ fetchTableQuery: async () => memberPage }));

const field = (id: string, name: string, position: number, extra: Partial<PublicField> = {}): PublicField => ({
  id,
  tableId: "TABLE1",
  name,
  description: "",
  type: "text",
  config: {},
  position,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...extra,
});
const titleField = field("FIELD1", "Title", 0, { presentable: true });
const peopleField = field("FIELD2", "People", 1, { type: "relation", config: { targetTableId: "TABLE2" } });
const statusField = field("FIELD3", "Status", 2, {
  type: "select",
  config: { options: [{ id: "open", label: "Open" }] },
});
const tableFields = [titleField, peopleField, statusField];

const task = (id: string, title: string, people: string[]): PublicGridRecord => ({
  id,
  tableId: "TABLE1",
  data: { FIELD1: title, FIELD2: people, FIELD3: "open" },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const memberPage: PublicTableQueryResult = {
  items: [task("REC001", "Draft the brochure", ["PERSON1", "PERSON2"]), task("REC002", "Book the venue", ["PERSON1"])],
  nextCursor: null,
  relationLabels: { PERSON1: "Mara Lind", PERSON2: "Jonas Berg" },
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await Bun.sleep(5);
  }
};

/**
 * Opens one group of a saved grouped view. The server narrows the view's `fields` to its output columns, which for
 * `group by` without columns is the group field alone; the table's full field list arrives in `fieldsByTable`.
 */
const openGroupMembers = async (groupField: PublicField, groupKey: string) => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const groupBy: GroupBySpec[] = [{ fieldId: groupField.id }];
  const aggregations = [{ fieldId: "*", agg: "count" as const, label: "count" }];
  const view: PublicView & { query: { groupBy: GroupBySpec[]; aggregations: typeof aggregations }; displayConfig: { mode: "table" } } = {
    id: "VIEW01",
    tableId: "TABLE1",
    name: "Grouped tasks",
    description: null,
    icon: null,
    source: `from table {TABLE1} group by {${groupField.id}} aggregate count(*) as count`,
    ui: {},
    ownerUserId: null,
    position: 0,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    query: { groupBy, aggregations },
    displayConfig: { mode: "table" },
  };
  const { default: RecordsView } = await import("./RecordsView");
  const dispose = render(
    () =>
      createComponent(RecordsView, {
        cloudUrl: "http://localhost",
        baseId: "BASE01",
        tableId: "TABLE1",
        tableKind: "stored",
        tableName: "Tasks",
        tableDescription: null,
        tableColumns: [],
        tableUpdatedAt: timestamp,
        tableAuditPolicy: {},
        tableMutationPolicy: { mode: "all" },
        disableDirectInsert: false,
        viewId: view.id,
        fields: [groupField],
        tables: [],
        viewsByTable: {},
        forms: [],
        canReadTable: true,
        canWrite: false,
        canManageTable: false,
        canManageBase: false,
        trashMode: false,
        initialAdminMode: false,
        activeView: view,
        canEditActiveView: false,
        otherTables: [{ id: "TABLE1", name: "Tasks" }],
        fieldsByTable: { TABLE1: tableFields },
        viewMode: true,
        initialState: {
          query: { groupBy, aggregations },
          cursor: null,
          selectedRecordId: null,
          search: { q: "", fieldIds: [], override: false },
          calendar: { view: "month", date: "2026-01-01" },
          cardSize: "medium",
        },
        initialData: {
          items: [],
          buckets: [{ keys: [groupKey], values: { "*__count": 2 } }],
          relationLabels: { PERSON1: "Mara Lind" },
          nextCursor: null,
        },
        initialEventCursor: null,
        initialSelectedRecord: null,
        initialSelectedRecordDetail: null,
        documentTemplates: [],
        relationLabels: { PERSON1: "Mara Lind" },
        viewColumns: undefined,
        searchableFields: [],
        groupedExplode: groupField.type === "relation",
        activeRecordQuery: view.query,
        displayConfig: { mode: "table" },
        bulkSelectionLaunchers: [],
        recordActionLaunchers: [],
        workspaceRouteKey: "records:TABLE1:VIEW01:false",
      }),
    dom.root,
  );
  const members = () => Array.from(dom.root.querySelectorAll(".k2b-detail-panel__action-title")).map((title) => title.textContent?.trim());
  const cleanup = () => {
    dispose();
    dom.cleanup();
    Object.assign(globalThis, { IntersectionObserver: previousObserver });
  };
  try {
    const groupRow = () => dom.root.querySelector<HTMLElement>("tbody tr");
    await waitFor(() => groupRow() !== null);
    groupRow()?.click();
    await waitFor(() => members().length === 2);
    return { members: members(), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};

for (const [label, groupField, groupKey] of [
  ["a relation", peopleField, "PERSON1"],
  ["a select field", statusField, "open"],
] as const) {
  domTest(`a saved view grouped by ${label} names group members by the table's label field`, async () => {
    const { members, cleanup } = await openGroupMembers(groupField, groupKey);
    try {
      expect(members).toEqual(["Draft the brochure", "Book the venue"]);
    } finally {
      cleanup();
    }
  });
}
