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

const loadingState = (html: string) => ({
  searchInput: html.match(/<input name="grids-record-search"[^>]*>/)?.[0],
  searchIcon: html.match(/k2b-text-input__icon[^>]*>(.*?)<\/span>/)?.[1],
  recordsArea: html.match(/<div class="([^"]*transition-opacity[^"]*)"/)?.[1],
});

test("server HTML shows the SSR records as loaded, without the loading spinner or dimming", () => {
  const html = renderToString(() => createComponent(RecordsView, recordsViewProps({})));

  const { searchInput, searchIcon, recordsArea } = loadingState(html);
  expect(html).toContain("Draft the brochure");
  expect(searchInput).toBeDefined();
  expect(searchInput).not.toContain("aria-busy");
  expect(searchIcon).toContain("ti ti-search");
  expect(searchIcon).not.toContain("k2b-spin");
  expect(recordsArea).toBeDefined();
  expect(recordsArea).not.toContain("opacity-60");
});

test("server HTML shows a failed server read as its error with a retry, not as an empty table that is loading", () => {
  const html = renderToString(() =>
    createComponent(
      RecordsView,
      recordsViewProps({ initialData: { items: [], nextCursor: null }, initialError: "The filter is invalid: unknown field." }),
    ),
  );

  const { searchInput, searchIcon, recordsArea } = loadingState(html);
  expect(html).toContain("Could not refresh records");
  expect(html).toContain("The filter is invalid: unknown field.");
  expect(html).toContain("Retry");
  expect(searchInput).not.toContain("aria-busy");
  expect(searchIcon).not.toContain("k2b-spin");
  expect(recordsArea).not.toContain("opacity-60");
});
