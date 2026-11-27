import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicField, PublicGridRecord } from "../../../api/public-dto";
import "../ssr-test-plugin";
import { testFrame } from "./records-frame.test-fixture";

const { default: RecordsView } = await import("./RecordsView");

const timestamp = "2026-01-01T00:00:00.000Z";
const titleField: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Title",
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
const task = (id: string, title: string): PublicGridRecord => ({
  id,
  tableId: "TABLE1",
  data: { FIELD1: title },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

type RecordsViewProps = Parameters<typeof RecordsView>[0];

/** A table page as the server renders it; `overrides` narrow it to the case under test. */
const recordsViewProps = (overrides: Partial<RecordsViewProps>): RecordsViewProps => ({
  frame: testFrame(),
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
  viewId: null,
  fields: [titleField],
  tables: [],
  viewsByTable: {},
  forms: [],
  canReadTable: true,
  canWrite: false,
  canManageTable: false,
  canManageBase: false,
  trashMode: false,
  initialAdminMode: false,
  otherTables: [{ id: "TABLE1", name: "Tasks" }],
  fieldsByTable: { TABLE1: [titleField] },
  viewMode: false,
  initialState: {
    query: {},
    cursor: null,
    selectedRecordId: null,
    search: { q: "", fieldIds: [], override: false },
    calendar: { view: "month", date: "2026-01-01" },
    cardSize: "medium",
  },
  initialData: { items: [task("REC001", "Draft the brochure"), task("REC002", "Book the venue")], nextCursor: null },
  initialError: null,
  initialEventCursor: null,
  initialSelectedRecord: null,
  initialSelectedRecordDetail: null,
  documentTemplates: [],
  relationLabels: {},
  viewColumns: undefined,
  groupedExplode: false,
  activeRecordQuery: null,
  displayConfig: { mode: "table" },
  bulkSelectionLaunchers: [],
  recordActionLaunchers: [],
  workspaceRouteKey: "records:TABLE1::false",
  ...overrides,
});

test("server HTML shows the SSR records as loaded on v2, with no loading placeholder", () => {
  const html = renderToString(() => createComponent(RecordsView, recordsViewProps({})));
  expect(html).toContain("Draft the brochure");
  expect(html).toContain('data-k2-part="Table"');
  expect(html).toContain('aria-label="Search records"');
  expect(html).not.toContain('data-k2-part="Loading"');
  expect(html).not.toMatch(/\bclass="(?!k2-|ti )[^"]*"/);
});

test("server HTML shows a failed server read as its error with a retry, not as an empty table", () => {
  const html = renderToString(() =>
    createComponent(
      RecordsView,
      recordsViewProps({
        canWrite: true,
        initialData: { items: [], nextCursor: null },
        initialError: "The filter is invalid: unknown field.",
      }),
    ),
  );
  expect(html).toContain("Records could not be refreshed");
  expect(html).toContain("The filter is invalid: unknown field.");
  expect(html).toContain("Retry");
  expect(html).not.toContain("No records yet");
  expect(html).toContain("New record");
});

test("server HTML shows an empty table as one empty state whose action creates a record", () => {
  const empty = { initialData: { items: [], nextCursor: null } };
  const writer = renderToString(() => createComponent(RecordsView, recordsViewProps({ ...empty, canWrite: true })));
  expect(writer).toContain("No records yet.");
  expect(writer).toContain('data-k2-part="Empty"');
  // the head's button, the phone's floating action and the empty state's way out
  expect(writer.match(/New record/g)?.length).toBeGreaterThanOrEqual(2);

  // Only forms may add records here, and none is active: nothing offers to create.
  const noControl = renderToString(() =>
    createComponent(RecordsView, recordsViewProps({ ...empty, canWrite: true, disableDirectInsert: true })),
  );
  expect(noControl).toContain("No records yet.");
  expect(noControl).not.toContain("New record");
});
