import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicField, PublicGridRecord } from "../../../api/public-dto";
import "../ssr-test-plugin";

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

// The search and its spinner stand in the workspace head (RecordsHeadActions); the view dims nothing on its first paint.
const loadingState = (html: string) => ({
  recordsArea: html.match(/<div class="([^"]*transition-opacity[^"]*)"/)?.[1],
});

test("server HTML shows the SSR records as loaded, without the loading spinner or dimming", () => {
  const html = renderToString(() => createComponent(RecordsView, recordsViewProps({})));

  const { recordsArea } = loadingState(html);
  expect(html).toContain("Draft the brochure");
  expect(recordsArea).toBeDefined();
  expect(recordsArea).not.toContain("opacity-60");
});

test("server HTML shows a failed server read as an alert cell whose button loads the records again, not as an empty table that is loading", () => {
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

  const { recordsArea } = loadingState(html);
  expect(html).toContain("Could not refresh records");
  expect(html).toContain("The filter is invalid: unknown field.");
  expect(html).toContain("Load records");
  expect(html).not.toContain("No records yet");
  // The failed read keeps its grid and the head keeps "Add record"; the view itself offers no second one.
  expect(html).not.toContain("Add record");
  expect(recordsArea).not.toContain("opacity-60");
});

test("server HTML shows an empty table as one empty state whose quiet action adds a record; the filled one is the head's", () => {
  const empty = { initialData: { items: [], nextCursor: null } };
  const writer = renderToString(() => createComponent(RecordsView, recordsViewProps({ ...empty, canWrite: true })));
  expect(writer).toContain("No records yet");
  // The head's main action lives in the workspace head (records-head); the view adds only the empty state's way out.
  expect(writer.match(/Add record/g)).toHaveLength(1);
  expect(writer).not.toContain('data-variant="primary"');

  // Only forms may add records here, and none is active: the toolbar shows nothing, so the empty state has no action slot.
  const noControl = renderToString(() =>
    createComponent(RecordsView, recordsViewProps({ ...empty, canWrite: true, disableDirectInsert: true })),
  );
  expect(noControl).toContain("No records yet");
  expect(noControl).not.toContain("k2b-placeholder__action");
});
