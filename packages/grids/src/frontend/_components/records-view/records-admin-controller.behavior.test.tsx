import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicForm } from "../../../api/public-dto";
import type {
  ColumnSpec,
  FieldColumnSpec,
  RecordDisplayConfig,
  RecordQuery,
  TableAuditPolicy,
  TableMutationPolicy,
} from "../../../contracts";

const domTest = isServer ? test.skip : test;

const TABLE_ID = "TABLE1";

const makeField = (id: string, name: string, position: number, options: { hideInTable?: boolean } = {}): PublicField => ({
  id,
  tableId: TABLE_ID,
  name,
  description: null,
  icon: null,
  type: "text",
  config: {},
  position,
  required: false,
  presentable: false,
  hideInTable: options.hideInTable ?? false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-09-27T00:00:00Z",
  updatedAt: "2026-09-27T00:00:00Z",
});

type ApiRequest = { method: string; path: string; body: Record<string, unknown> | undefined };

/** Serves the field and table writes of the records admin flow and keeps field names unique like the server. */
const installGridsApi = (initialFields: PublicField[]) => {
  const originalFetch = globalThis.fetch;
  const requests: ApiRequest[] = [];
  const fields = [...initialFields];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      requests.push({ method, path, body });
      if (method === "POST" && path === `/api/grids/fields/by-table/${TABLE_ID}`) {
        const name = String(body?.name);
        if (fields.some((field) => field.name.trim().toLowerCase() === name.trim().toLowerCase())) {
          return Response.json({ message: "The field name must be unique within this Table." }, { status: 409 });
        }
        const created = makeField(`FIELD${fields.length + 1}`, name, fields.length);
        fields.push(created);
        return Response.json(created);
      }
      const field = fields.find((candidate) => path === `/api/grids/fields/${candidate.id}`);
      if (method === "PATCH" && field) {
        Object.assign(field, body);
        return Response.json(field);
      }
      if (method === "PATCH" && path === `/api/grids/tables/${TABLE_ID}`) return Response.json({ id: TABLE_ID, columns: body?.columns });
      return Response.json({ message: `Unexpected ${method} ${path}` }, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    tableWrites: () => requests.filter((request) => request.method === "PATCH" && request.path === `/api/grids/tables/${TABLE_ID}`),
    fieldWrites: () => requests.filter((request) => request.method === "PATCH" && request.path.startsWith("/api/grids/fields/")),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

/** Solid delegates events to the document that was current when a module first loaded; bind them to this test's document. */
const createHarness = () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "input"], dom.document);
  return dom;
};

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};

const buttonNamed = (document: Document, label: string) =>
  Array.from(document.querySelectorAll("button")).findLast((node) => node.textContent?.trim() === label);
const fieldTypeButton = (document: Document, label: string) =>
  Array.from(document.querySelectorAll("button")).find((node) => node.querySelector(".min-w-0 > div")?.textContent === label);
const inputFor = (document: Document, label: string) => {
  const node = Array.from(document.querySelectorAll("label")).findLast((node) => node.textContent?.trim().replace(/\s*\*$/, "") === label);
  return node ? (document.getElementById(node.htmlFor) as HTMLInputElement | null) : null;
};
const change = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Wires the default table view's column and admin controllers the way RecordsView does. */
const createDefaultTableView = async (initial: { fields: PublicField[]; columns: FieldColumnSpec[] }) => {
  const { createRecordsAdminController } = await import("./records-admin-controller");
  const { createRecordsViewColumnController, isFieldColumn } = await import("./records-view-columns");
  const [tableName, setTableName] = createSignal("People");
  const [tableDescription, setTableDescription] = createSignal<string | null>(null);
  const [tableIcon, setTableIcon] = createSignal<string | null>(null);
  const [tableColumns, setTableColumns] = createSignal<FieldColumnSpec[]>(initial.columns);
  const [tableDisplayConfig, setTableDisplayConfig] = createSignal<RecordDisplayConfig>({ mode: "table" });
  const [tableAuditPolicy, setTableAuditPolicy] = createSignal<TableAuditPolicy>({});
  const [tableMutationPolicy, setTableMutationPolicy] = createSignal<TableMutationPolicy>({ mode: "all" });
  const [disableDirectInsert, setDisableDirectInsert] = createSignal(false);
  const [fields, setFields] = createSignal<PublicField[]>(initial.fields);
  const [forms, setForms] = createSignal<PublicForm[]>([]);
  const [, setViewDisplayConfig] = createSignal<RecordDisplayConfig | null>(null);
  const [query, setQuery] = createSignal<RecordQuery>({});
  const [viewColumns, setViewColumns] = createSignal<ColumnSpec[] | undefined>(undefined);
  const columns = createRecordsViewColumnController({
    props: { activeView: null, tableId: TABLE_ID, baseId: "BASE01" },
    fields,
    setFields,
    tableColumns,
    setTableColumns,
    query,
    setQuery,
    viewColumns,
    setViewColumns,
    groupBy: () => [],
    aggregations: () => [],
    isGrouped: () => false,
    isSavedView: () => false,
    syncUrl: () => {},
    locale: () => "en",
  });
  const admin = createRecordsAdminController({
    baseId: "BASE01",
    tableId: TABLE_ID,
    tableKind: "stored",
    tableName,
    setTableName,
    tableDescription,
    setTableDescription,
    tableIcon,
    setTableIcon,
    tableColumns,
    setTableColumns,
    tableDisplayConfig,
    setTableDisplayConfig,
    tableAuditPolicy,
    setTableAuditPolicy,
    tableMutationPolicy,
    setTableMutationPolicy,
    disableDirectInsert,
    setDisableDirectInsert,
    fields,
    setFields,
    hiddenFields: columns.hiddenFlatFields,
    showColumns: columns.showFlatViewColumns,
    forms,
    setForms,
    otherTables: [],
    fieldsByTable: {},
    canManageTable: true,
    canManageBase: true,
    fieldCreatedDisplayFailed: "The field was created, but the table display could not be updated.",
    refetch: () => {},
    setViewDisplayConfig,
  });
  const visibleFieldIds = () => (columns.effectiveViewColumns() ?? []).filter(isFieldColumn).map((column) => column.fieldId);
  return { admin, columns, fields, tableColumns, visibleFieldIds };
};

const addTextField = async (document: Document, admin: { openAddField: () => Promise<void> }, name: string) => {
  const done = admin.openAddField();
  await until(() => Boolean(fieldTypeButton(document, "Text")));
  fieldTypeButton(document, "Text")!.click();
  await until(() => Boolean(inputFor(document, "Name")));
  change(inputFor(document, "Name")!, name);
  buttonNamed(document, "Create")!.click();
  return done;
};

domTest("editing one field on a new table keeps every created field visible", async () => {
  const dom = createHarness();
  const api = installGridsApi([]);
  const { dialogCore } = await import("@k2b/ui");
  try {
    const { admin, fields, tableColumns, visibleFieldIds } = await createDefaultTableView({ fields: [], columns: [] });

    for (const name of ["First name", "Last name", "Activities"]) await addTextField(dom.document, admin, name);
    expect(fields().map((field) => field.name)).toEqual(["First name", "Last name", "Activities"]);
    expect(tableColumns()).toEqual([]);
    expect(visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);

    // Saving without a display change keeps the derived column list.
    admin.openFieldSettings(fields()[2]!);
    await until(() => Boolean(inputFor(dom.document, "Table column name")));
    change(inputFor(dom.document, "Name")!, "Tasks");
    buttonNamed(dom.document, "Save")!.click();
    await until(() => !dialogCore.isOpen());
    expect(fields()[2]!.name).toBe("Tasks");
    expect(api.tableWrites()).toEqual([]);
    expect(visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);

    // A display change writes the complete list with only the edited column changed.
    admin.openFieldSettings(fields()[1]!);
    await until(() => Boolean(inputFor(dom.document, "Table column name")));
    change(inputFor(dom.document, "Table column name")!, "Surname");
    buttonNamed(dom.document, "Save")!.click();
    await until(() => !dialogCore.isOpen());
    expect(api.tableWrites().map((request) => request.body?.columns)).toEqual([
      [{ fieldId: "FIELD1" }, { fieldId: "FIELD2", label: "Surname" }, { fieldId: "FIELD3" }],
    ]);
    expect(visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});

domTest("the default table view shows fields its column list hides again", async () => {
  const dom = createHarness();
  const initial = {
    fields: [
      makeField("FIELD1", "First name", 0),
      makeField("FIELD2", "Last name", 1),
      makeField("FIELD3", "Internal note", 2, { hideInTable: true }),
    ],
    columns: [{ fieldId: "FIELD1" }],
  };
  const api = installGridsApi(initial.fields);
  const { dialogCore } = await import("@k2b/ui");
  const { RecordsAdminToolbar } = await import("./RecordsAdminToolbar");
  const view = await createDefaultTableView(initial);
  const dispose = render(
    () => (
      <RecordsAdminToolbar
        savedView={false}
        activeViewAvailable={false}
        canEditActiveView={false}
        hiddenViewColumnCount={view.columns.hiddenViewColumnCount()}
        allowForms
        formsButtonLabel="Forms"
        onOpenTableSettings={() => {}}
        onAddField={() => void view.admin.openAddField()}
        onOpenForms={() => {}}
        onOpenTemplates={() => {}}
        onOpenViewSettings={() => {}}
        onAddViewColumn={view.columns.openAddViewColumnDialog}
        onDone={() => {}}
      />
    ),
    dom.root,
  );
  try {
    expect(view.visibleFieldIds()).toEqual(["FIELD1"]);
    buttonNamed(dom.document, "Add column")!.click();
    await until(() => dom.document.querySelectorAll('[role="option"]').length > 0);
    expect(Array.from(dom.document.querySelectorAll('[role="option"]'), (option) => option.getAttribute("aria-label"))).toEqual([
      "Last name",
      "Internal note",
    ]);
    dom.document.querySelector<HTMLButtonElement>('[role="option"][aria-label="Last name"]')!.click();
    dom.document.querySelector<HTMLButtonElement>('[role="option"][aria-label="Internal note"]')!.click();
    await until(() => buttonNamed(dom.document, "Add columns")?.disabled === false);
    buttonNamed(dom.document, "Add columns")!.click();
    await until(() => api.tableWrites().length === 1 && view.fields()[2]!.hideInTable === false);
    expect(api.tableWrites()[0]!.body?.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }]);
    expect(api.fieldWrites()).toEqual([{ method: "PATCH", path: "/api/grids/fields/FIELD3", body: { hideInTable: false } }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
    expect(buttonNamed(dom.document, "Add column")).toBeUndefined();

    // A field added afterwards appears next to the restored columns without a reload.
    await addTextField(dom.document, view.admin, "Activities");
    expect(api.tableWrites().at(-1)!.body?.columns).toEqual([
      { fieldId: "FIELD1" },
      { fieldId: "FIELD2" },
      { fieldId: "FIELD3" },
      { fieldId: "FIELD4" },
    ]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3", "FIELD4"]);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dispose();
    api.restore();
    dom.cleanup();
  }
});

domTest("a new field named like a hidden field offers to show that column", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "First name", 0), makeField("FIELD2", "Last name", 1)],
    columns: [{ fieldId: "FIELD1" }],
  };
  const api = installGridsApi(initial.fields);
  const { dialogCore } = await import("@k2b/ui");
  try {
    const view = await createDefaultTableView(initial);

    // A visible field keeps the plain conflict error.
    void addTextField(dom.document, view.admin, "First name");
    await until(() => dom.document.body.textContent?.includes("The field name must be unique within this Table.") === true);
    expect(buttonNamed(dom.document, "Show column")).toBeUndefined();
    buttonNamed(dom.document, "Close")!.click();
    await until(() => !dialogCore.isOpen());

    const adding = addTextField(dom.document, view.admin, " last NAME ");
    await until(() => Boolean(buttonNamed(dom.document, "Show column")));
    expect(dom.document.body.textContent).toContain("A field named “Last name” already exists but is hidden from this table.");
    buttonNamed(dom.document, "Show column")!.click();
    await adding;
    await until(() => api.tableWrites().length === 1);
    expect(api.tableWrites()[0]!.body?.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2"]);
    expect(view.fields()).toHaveLength(2);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});
