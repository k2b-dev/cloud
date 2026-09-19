import { expect, test } from "bun:test";
import { type ComponentProps, createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { default: RecordDetails } = await import("./RecordDetails.island.tsx");
const { default: RecordsTable } = await import("./RecordsTable.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");
const timestamp = "2026-09-17T12:00:00.000Z";
const props = (): ComponentProps<typeof RecordDetails> => ({
  block: {
    id: "identity",
    type: "record",
    title: "Invoice",
    fieldIds: ["FIELD1", "FIELD2"],
    editableFieldIds: [],
    heading: { fieldId: "FIELD1", documentNumber: true },
    documents: { templateIds: ["DOC001"], preview: true },
  },
  baseId: "BASE01",
  tableName: "Invoices",
  auditPolicy: {},
  record: {
    id: "REC001",
    tableId: "TABLE1",
    data: { FIELD1: "Ada's workshop", FIELD2: "Consulting" },
    version: 1,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  fields: ["FIELD1", "FIELD2"].map((id, position) => ({
    id,
    tableId: "TABLE1",
    name: position ? "Subject" : "Customer",
    description: null,
    type: "text",
    config: {},
    position,
    required: false,
    presentable: true,
    hideInTable: false,
    defaultValue: null,
    indexed: false,
    uniqueConstraint: false,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })),
  relationLabels: {},
  fileEndpoints: {},
  filesByField: {},
  documents: [],
  documentPreviews: [{ name: "Invoice", url: "/preview" }],
  dateConfig: { timeZone: "Europe/Berlin" },
});

test("draft identity promotes the chosen field and offers preview without a contradictory empty message", () => {
  const html = renderToString(() => createComponent(RecordDetails, props()));
  expect(html).toMatch(/<h2[^>]*>.*Ada's workshop.*<\/h2>/);
  expect(html).toContain("Consulting");
  expect(html).toContain("Preview");
  expect(html).not.toContain("No documents");
  expect(html).not.toContain("Download PDF");
});

test("issued identity promotes the official number while keeping the customer and a visible download action", () => {
  const input = props();
  input.documents = [
    {
      id: "PDF001",
      baseId: "BASE01",
      tableId: "TABLE1",
      recordId: "REC001",
      templateId: "DOC001",
      number: "RE-2026-0042",
      filename: "RE-2026-0042.pdf",
      createdAt: timestamp,
      createdBy: null,
      tags: [],
      renderer: { kind: "html" },
      validationStatus: null,
      primaryArtifactKey: "pdf",
      artifacts: [],
      sourceRecordCount: 1,
      dataSnapshot: null,
      downloadUrl: "/document.pdf",
    },
  ];
  input.documentPreviews = [];
  const html = renderToString(() => createComponent(RecordDetails, input));
  expect(html).toMatch(/<h2[^>]*>RE-2026-0042<\/h2>/);
  expect(html).toContain("Ada's workshop");
  expect(html).toContain("Download PDF");
  expect(html).toContain('data-action-visibility="always"');
});

test("headings remain text while rich content and calculation errors stay readable", () => {
  const input = props();
  input.fields[0]!.type = "longtext";
  input.record.data.FIELD1 = "<img src=x onerror=alert(1)>";
  const html = renderToString(() => createComponent(RecordDetails, input));
  expect(html).not.toContain('<h2 class="k2b-panel-header__title is-medium"><img');
  expect(html).toContain("&lt;img");
  expect(html).toContain("<dt>Customer</dt>");
  input.record.fieldErrors = { FIELD1: "Cannot calculate this field" };
  const failed = renderToString(() => createComponent(RecordDetails, input));
  expect(failed).toMatch(/<h2[^>]*>Cannot calculate this field<\/h2>/);
});

test("document status cells show official identity and status without exposing download links", () => {
  const html = renderToString(() =>
    createComponent(RecordsTable, {
      title: "Invoices",
      emptyText: "No invoices",
      baseId: "BASE01",
      appId: "APP001",
      endpoint: "/records",
      result: {
        ok: true,
        mode: "rows",
        limit: 25,
        columns: [{ key: "subject", label: "Subject", tableId: "TABLE1", fieldId: "FIELD1", type: "text", sqlType: "text" }],
        rows: [{ tableId: "TABLE1", recordId: "REC001", values: { subject: "Consulting" } }],
        workflowStates: {
          REC001: {
            status: "ready",
            document: { id: "PDF001", number: "RE-2026-0042", blockId: "identity" },
            downloadUrl: "/document.pdf",
          },
        },
      },
    }),
  );
  expect(html).toContain("RE-2026-0042");
  expect(html).toContain('data-tone="ok"');
  expect(html).not.toContain('href="/document.pdf"');
});

test("empty record tables show guidance without headers or search, while invalid projections remain errors", () => {
  const input: ComponentProps<typeof RecordsTable> = {
    title: "Issued invoices",
    emptyText: "Completed invoices appear here.",
    baseId: "BASE01",
    appId: "APP001",
    searchable: true,
    result: { ok: true, mode: "rows", limit: 25, columns: [{ key: "subject", label: "Subject", type: "text", sqlType: "text" }], rows: [] },
  };
  const html = renderToString(() => createComponent(RecordsTable, input));
  expect(html).toContain("Completed invoices appear here.");
  expect(html).not.toContain("<thead");
  expect(html).not.toContain('type="search"');
  expect(html).toContain('aria-label="Issued invoices"');
  expect(html).not.toContain("k2b-paper");
  expect(html).not.toContain("k2b-data-table-panel");
  input.result.columns = [];
  const invalid = renderToString(() => createComponent(RecordsTable, input));
  expect(invalid).toContain('role="alert"');
  expect(invalid).toContain("Records unavailable");
  expect(invalid).toContain("k2b-paper");
  expect(invalid).not.toContain("Completed invoices appear here.");
});

test("custom app date columns use the locale and retain explicit formats", () => {
  const field = { ...props().fields[0]!, type: "date", config: {} };
  const input: ComponentProps<typeof RecordsTable> = {
    title: "Invoices",
    emptyText: "No invoices",
    baseId: "BASE01",
    appId: "APP001",
    dateConfig: { timeZone: "Europe/Berlin" },
    result: {
      ok: true,
      mode: "rows",
      limit: 25,
      columns: [
        { key: "due", label: "Due", tableId: "TABLE1", fieldId: "FIELD1", type: "date", sqlType: "date" },
        { key: "derived", label: "Derived date", type: "formula", sqlType: "date" },
      ],
      rows: [{ tableId: "TABLE1", recordId: "REC001", values: { due: "2026-09-15", derived: "2026-09-16" } }],
      presentation: { fields: [field] },
    },
  };
  const render = () =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-DE",
        get children() {
          return createComponent(RecordsTable, input);
        },
      }),
    );
  const localized = render();
  expect(localized).toContain("15.9.2026");
  expect(localized).toContain("16.9.2026");
  field.config = { format: { kind: "date", format: "iso" } };
  expect(render()).toContain("2026-09-15");
});

test("record detail dates and number fields respect the user's locale and configured decimals", () => {
  const input = props();
  input.fields[1]!.type = "date";
  input.record.data.FIELD2 = "2026-09-15";
  const render = () =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(RecordDetails, input);
        },
      }),
    );
  expect(render()).toContain("15.9.2026");
  input.fields[1]!.type = "number";
  input.fields[1]!.config = { decimalPlaces: 2, unit: "EUR" };
  input.record.data.FIELD2 = "22.6";
  expect(render()).toContain("22,60 EUR");
});

test("record compact facts retain semantic labels and separate object-list tables", () => {
  const input = props();
  input.block.layout = "compact";
  input.block.heading = undefined;
  input.block.documents = undefined;
  input.fields[1]!.type = "object_list";
  input.fields[1]!.config = {
    fields: [
      { id: "Amount", name: "Quantity", type: "number" },
      { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 999" } },
    ],
  };
  input.record.data.FIELD2 = [{ Amount: "1", Total1: "2" }];
  const html = renderToString(() => createComponent(RecordDetails, input));
  expect(html).toContain('data-layout="compact"');
  expect(html).toContain("<dt>Customer</dt>");
  expect(html).toContain("<table");
  expect(html).toContain('aria-label="Subject"');
  expect(html).not.toContain("999");
  expect(html).not.toContain("<dt>Subject</dt>");
  expect(html).not.toMatch(/<h[1-6][^>]*>Subject<\/h[1-6]>/);
  expect(html.match(/>Subject(?:<| )/g)?.length).toBe(1);
  expect(html).toContain('data-surface="paper"');
  input.block.fieldIds = ["FIELD2", "FIELD1"];
  const reordered = renderToString(() => createComponent(RecordDetails, input));
  expect(reordered.indexOf("<table")).toBeLessThan(reordered.indexOf("<dt>Customer</dt>"));
  input.record.fieldErrors = { FIELD2: "Snapshot unavailable" };
  const failed = renderToString(() => createComponent(RecordDetails, input));
  expect(failed).toContain("Snapshot unavailable");
  expect(failed).not.toContain("<table");
});

test("relative calendar dates are opt-in and retain the absolute date and field errors", () => {
  const input = props();
  input.relativeDateBase = "2026-09-17T12:00:00.000Z";
  input.block.relativeDates = ["FIELD2"];
  input.fields[1]!.type = "date";
  input.record.data.FIELD2 = "2026-09-17";
  const render = () => renderToString(() => createComponent(RecordDetails, input));
  expect(render()).toContain("today");
  expect(render()).toContain("9/17/2026");
  input.block.relativeDates = [];
  expect(render()).not.toContain("today");
  input.block.relativeDates = ["FIELD2"];
  input.fields[1]!.config = { includeTime: true };
  input.record.data.FIELD2 = "2026-09-17T00:00:00.000Z";
  expect(render()).not.toContain("today");
  input.fields[1]!.config = {};
  input.record.fieldErrors = { FIELD2: "Date unavailable" };
  expect(render()).toContain("Date unavailable");
  expect(render()).not.toContain("today");
});

test("summary records retain semantic labels, configured order and the final total", () => {
  const input = props();
  input.block.layout = "summary";
  input.block.heading = undefined;
  input.block.documents = undefined;
  const base = input.fields[0]!;
  input.fields = [
    { ...base, id: "TOTAL1", name: "Total", type: "number", config: { decimalPlaces: 2, unit: "EUR" } },
    { ...base, id: "NET001", name: "Net", type: "number", config: { decimalPlaces: 2, unit: "EUR" } },
    { ...base, id: "TAX001", name: "Tax", type: "number", config: { decimalPlaces: 2, unit: "EUR" } },
  ];
  input.block.fieldIds = ["NET001", "TAX001", "TOTAL1"];
  input.record.data = { TOTAL1: "119.00", NET001: "100.00", TAX001: "19.00" };
  const html = renderToString(() => createComponent(RecordDetails, input));
  expect(html).toMatch(/<dl[^>]*class="[^"]*custom-app-record-summary[^"]*"[^>]*data-layout="rows"/);
  expect(html.indexOf("<dt>Net</dt>")).toBeLessThan(html.indexOf("<dt>Tax</dt>"));
  expect(html.indexOf("<dt>Tax</dt>")).toBeLessThan(html.indexOf("<dt>Total</dt>"));
  expect(html.replace(/<!--.*?-->/g, "")).toMatch(/<dt>Total<\/dt><dd>119\.00 EUR<\/dd><\/div><\/dl>/);
  input.record.fieldErrors = { TOTAL1: "Total unavailable" };
  const failed = renderToString(() => createComponent(RecordDetails, input));
  expect(failed).toContain("<dt>Total</dt>");
  expect(failed).toContain("Total unavailable");
  expect(failed).not.toContain("119.00 EUR");
});
