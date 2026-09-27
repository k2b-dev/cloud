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
const LOADED_AT = "2026-09-27T00:00:00.000Z";

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

/**
 * Serves the records admin flow like the Grids API: field names stay unique, field creation and deletion keep the
 * table's column list current and change its version, a column write naming an older version conflicts, and one
 * naming an unknown field is rejected.
 */
const installGridsApi = (initialFields: PublicField[], options: { columns?: FieldColumnSpec[]; failFieldWrites?: boolean } = {}) => {
  const originalFetch = globalThis.fetch;
  const requests: ApiRequest[] = [];
  const fields = [...initialFields];
  const table = { columns: [...(options.columns ?? [])], updatedAt: LOADED_AT };
  let version = 0;
  let fieldCount = fields.length;
  const touchTable = () => {
    version += 1;
    table.updatedAt = new Date(Date.parse(LOADED_AT) + version * 1000).toISOString();
  };
  const createField = (name: string) => {
    fieldCount += 1;
    const created = makeField(`FIELD${fieldCount}`, name, fieldCount - 1);
    fields.push(created);
    if (table.columns.length > 0 && !created.hideInTable) table.columns = [...table.columns, { fieldId: created.id }];
    touchTable();
    return created;
  };
  const tableJson = () => ({ id: TABLE_ID, columns: table.columns, displayConfig: { mode: "table" }, updatedAt: table.updatedAt });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      requests.push({ method, path, body });
      if (path === `/api/grids/fields/by-table/${TABLE_ID}`) {
        if (method === "GET") return Response.json(fields);
        const name = String(body?.name);
        if (fields.some((field) => field.name.trim().toLowerCase() === name.trim().toLowerCase())) {
          return Response.json({ message: "The field name must be unique within this Table." }, { status: 409 });
        }
        return Response.json(createField(name));
      }
      if (path.endsWith("/dependents")) return Response.json({ hasBlocking: false, dependents: [] });
      const field = fields.find((candidate) => path === `/api/grids/fields/${candidate.id}`);
      if (method === "PATCH" && field && options.failFieldWrites) throw new TypeError("Failed to fetch");
      if (method === "PATCH" && field) {
        Object.assign(field, body);
        return Response.json(field);
      }
      if (method === "DELETE" && field) {
        fields.splice(fields.indexOf(field), 1);
        table.columns = table.columns.filter((column) => column.fieldId !== field.id);
        touchTable();
        return new Response(null, { status: 204 });
      }
      if (path === `/api/grids/tables/${TABLE_ID}`) {
        if (method === "GET") return Response.json(tableJson());
        if (body?.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== table.updatedAt) {
          return Response.json({ message: "This Table changed since you loaded it." }, { status: 409 });
        }
        const columns = body?.columns as FieldColumnSpec[] | undefined;
        if (columns?.some((column) => !fields.some((field) => field.id === column.fieldId))) {
          return Response.json({ message: "The Table configuration references an unknown field." }, { status: 400 });
        }
        if (columns) table.columns = columns;
        touchTable();
        return Response.json(tableJson());
      }
      return Response.json({ message: `Unexpected ${method} ${path}` }, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    table,
    /** Another tab, user, or the CLI creates a field. */
    createFieldElsewhere: createField,
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
const toggleCheckbox = (document: Document, label: string) => {
  const input = Array.from(document.querySelectorAll("label.k2b-checkbox-card"))
    .find((node) => node.querySelector(".k2b-checkbox-card__text")?.textContent === label)
    ?.querySelector("input");
  if (!input) throw new Error(`No checkbox named ${label}`);
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

/** Wires the default table view's column and admin controllers the way RecordsView does. */
const createDefaultTableView = async (initial: {
  fields: PublicField[];
  columns: FieldColumnSpec[];
  viewColumns?: ColumnSpec[];
  renderMode?: RecordDisplayConfig["mode"];
}) => {
  const { createRecordsAdminController } = await import("./records-admin-controller");
  const { createRecordsViewColumnController, isFieldColumn } = await import("./records-view-columns");
  const [tableName, setTableName] = createSignal("People");
  const [tableDescription, setTableDescription] = createSignal<string | null>(null);
  const [tableIcon, setTableIcon] = createSignal<string | null>(null);
  const [tableColumns, setTableColumns] = createSignal<FieldColumnSpec[]>(initial.columns);
  const [tableUpdatedAt, setTableUpdatedAt] = createSignal(LOADED_AT);
  const [tableDisplayConfig, setTableDisplayConfig] = createSignal<RecordDisplayConfig>({ mode: "table" });
  const [tableAuditPolicy, setTableAuditPolicy] = createSignal<TableAuditPolicy>({});
  const [tableMutationPolicy, setTableMutationPolicy] = createSignal<TableMutationPolicy>({ mode: "all" });
  const [disableDirectInsert, setDisableDirectInsert] = createSignal(false);
  const [fields, setFields] = createSignal<PublicField[]>(initial.fields);
  const [forms, setForms] = createSignal<PublicForm[]>([]);
  const [, setViewDisplayConfig] = createSignal<RecordDisplayConfig | null>(null);
  const [query, setQuery] = createSignal<RecordQuery>({});
  const [viewColumns, setViewColumns] = createSignal<ColumnSpec[] | undefined>(initial.viewColumns);
  const columns = createRecordsViewColumnController({
    props: { activeView: null, tableId: TABLE_ID, baseId: "BASE01" },
    fields,
    setFields,
    tableColumns,
    setTableColumns,
    tableUpdatedAt,
    setTableUpdatedAt,
    query,
    setQuery,
    viewColumns,
    setViewColumns,
    groupBy: () => [],
    aggregations: () => [],
    isGrouped: () => false,
    isSavedView: () => false,
    renderMode: () => initial.renderMode ?? "table",
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
    tableUpdatedAt,
    setTableUpdatedAt,
    reloadTableColumns: columns.reloadTableColumns,
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
    refetch: () => {},
    setViewDisplayConfig,
  });
  const visibleFieldIds = () => (columns.effectiveViewColumns() ?? []).filter(isFieldColumn).map((column) => column.fieldId);
  return { admin, columns, fields, setFields, tableColumns, tableUpdatedAt, visibleFieldIds };
};

type DefaultTableView = Awaited<ReturnType<typeof createDefaultTableView>>;

const renderAdminToolbar = async (root: HTMLElement, view: DefaultTableView) => {
  const { RecordsAdminToolbar } = await import("./RecordsAdminToolbar");
  return render(
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
    root,
  );
};

/** Shows the named columns through "Add column" and returns every column it offered. */
const addColumns = async (document: Document, names: string[]) => {
  buttonNamed(document, "Add column")!.click();
  await until(() => document.querySelectorAll('[role="option"]').length > 0);
  const offered = Array.from(document.querySelectorAll('[role="option"]'), (option) => option.getAttribute("aria-label"));
  for (const name of names) document.querySelector<HTMLButtonElement>(`[role="option"][aria-label="${name}"]`)!.click();
  await until(() => buttonNamed(document, "Add columns")?.disabled === false);
  buttonNamed(document, "Add columns")!.click();
  return offered;
};

const editField = async (document: Document, view: DefaultTableView, field: PublicField, edit: () => void) => {
  const { dialogCore } = await import("@k2b/ui");
  view.admin.openFieldSettings(field);
  await until(() => Boolean(inputFor(document, "Table column name")));
  edit();
  buttonNamed(document, "Save")!.click();
  await until(() => !dialogCore.isOpen());
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
    const view = await createDefaultTableView({ fields: [], columns: [] });
    const { fields, tableColumns, visibleFieldIds } = view;

    for (const name of ["First name", "Last name", "Activities"]) await addTextField(dom.document, view.admin, name);
    expect(fields().map((field) => field.name)).toEqual(["First name", "Last name", "Activities"]);
    expect(tableColumns()).toEqual([]);
    expect(visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);

    // Saving without a display change keeps the derived column list.
    await editField(dom.document, view, fields()[2]!, () => change(inputFor(dom.document, "Name")!, "Tasks"));
    expect(fields()[2]!.name).toBe("Tasks");
    expect(api.tableWrites()).toEqual([]);
    expect(visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);

    // A display change writes the complete list with only the edited column changed.
    await editField(dom.document, view, fields()[1]!, () => change(inputFor(dom.document, "Table column name")!, "Surname"));
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
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  const view = await createDefaultTableView(initial);
  const dispose = await renderAdminToolbar(dom.root, view);
  try {
    expect(view.visibleFieldIds()).toEqual(["FIELD1"]);
    expect(await addColumns(dom.document, ["Last name", "Internal note"])).toEqual(["Last name", "Internal note"]);
    await until(() => api.tableWrites().length === 1 && view.fields()[2]!.hideInTable === false);
    expect(api.tableWrites()[0]!.body?.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }]);
    expect(api.fieldWrites()).toEqual([{ method: "PATCH", path: "/api/grids/fields/FIELD3", body: { hideInTable: false } }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
    expect(buttonNamed(dom.document, "Add column")).toBeUndefined();

    // A field added afterwards appears next to the restored columns without a reload; the server adds its column.
    await addTextField(dom.document, view.admin, "Activities");
    expect(api.tableWrites()).toHaveLength(1);
    expect(api.table.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }, { fieldId: "FIELD4" }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3", "FIELD4"]);
    expect(view.tableUpdatedAt()).toBe(api.table.updatedAt);
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
  const api = installGridsApi(initial.fields, { columns: initial.columns });
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

domTest("hiding and showing fields on a new table keeps its column list derived", async () => {
  const dom = createHarness();
  const initial = {
    fields: [
      makeField("FIELD1", "First name", 0),
      makeField("FIELD2", "Last name", 1),
      makeField("FIELD3", "Internal note", 2),
      makeField("FIELD4", "Notes", 3, { hideInTable: true }),
    ],
    columns: [],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  const view = await createDefaultTableView(initial);
  const dispose = await renderAdminToolbar(dom.root, view);
  try {
    // "Hide in table" alone hides a derived column; no column list is stored.
    await editField(dom.document, view, view.fields()[2]!, () => toggleCheckbox(dom.document, "Hide in table"));
    expect(view.fields()[2]!.hideInTable).toBe(true);
    expect(view.tableColumns()).toEqual([]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2"]);

    // "Add column" clears the setting and the column returns at its field position.
    expect(await addColumns(dom.document, ["Notes"])).toEqual(["Internal note", "Notes"]);
    await until(() => view.fields()[3]!.hideInTable === false);
    expect(api.fieldWrites().at(-1)).toEqual({ method: "PATCH", path: "/api/grids/fields/FIELD4", body: { hideInTable: false } });
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD4"]);

    await editField(dom.document, view, view.fields()[2]!, () => toggleCheckbox(dom.document, "Hide in table"));
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3", "FIELD4"]);

    // Fields created elsewhere, for example through the CLI, keep appearing.
    view.setFields((current) => [...current, makeField("FIELD5", "Activities", 4)]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3", "FIELD4", "FIELD5"]);
    expect(api.tableWrites()).toEqual([]);
    expect(view.tableColumns()).toEqual([]);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dispose();
    api.restore();
    dom.cleanup();
  }
});

domTest("unsaved computed columns leave the table and Hide in table alone until they are cleared", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "First name", 0), makeField("FIELD2", "Internal note", 1, { hideInTable: true })],
    columns: [{ fieldId: "FIELD1" }],
    viewColumns: [{ fieldId: "FIELD1" }, { kind: "computed" as const, id: "computed_total", label: "Total", expression: "1" }],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  try {
    const view = await createDefaultTableView(initial);
    view.columns.showFlatViewColumns(["FIELD2"]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2"]);
    // Writes start synchronously, so none is pending here.
    expect(api.tableWrites()).toEqual([]);
    expect(api.fieldWrites()).toEqual([]);

    // Once the columns are stored on the table, the shown field no longer hides in the table either.
    view.columns.clearComputedColumns();
    await until(() => view.fields()[1]!.hideInTable === false);
    expect(api.tableWrites().map((request) => request.body?.columns)).toEqual([[{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }]]);
    expect(api.fieldWrites()).toEqual([{ method: "PATCH", path: "/api/grids/fields/FIELD2", body: { hideInTable: false } }]);
  } finally {
    api.restore();
    dom.cleanup();
  }
});

domTest("clearing unsaved computed columns keeps a new table's column list derived", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "First name", 0), makeField("FIELD2", "Last name", 1)],
    columns: [],
    viewColumns: [
      { fieldId: "FIELD1" },
      { fieldId: "FIELD2" },
      { kind: "computed" as const, id: "computed_total", label: "Total", expression: "1" },
    ],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  try {
    const view = await createDefaultTableView(initial);
    view.columns.clearComputedColumns();
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2"]);
    expect(view.tableColumns()).toEqual([]);
    // Writes start synchronously, so none is pending here.
    expect(api.tableWrites()).toEqual([]);
  } finally {
    api.restore();
    dom.cleanup();
  }
});

domTest("columns are only offered where records render as a table", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "First name", 0), makeField("FIELD2", "Internal note", 1, { hideInTable: true })],
    columns: [],
    renderMode: "cards" as const,
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  const view = await createDefaultTableView(initial);
  const dispose = await renderAdminToolbar(dom.root, view);
  try {
    expect(buttonNamed(dom.document, "Add column")).toBeUndefined();
    void addTextField(dom.document, view.admin, "Internal note");
    await until(() => dom.document.body.textContent?.includes("The field name must be unique within this Table.") === true);
    expect(buttonNamed(dom.document, "Show column")).toBeUndefined();
    expect(api.fieldWrites()).toEqual([]);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dispose();
    api.restore();
    dom.cleanup();
  }
});

domTest("a failed Hide in table update after Add column reports the mismatch", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "First name", 0), makeField("FIELD2", "Internal note", 1, { hideInTable: true })],
    columns: [{ fieldId: "FIELD1" }],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns, failFieldWrites: true });
  const { dialogCore } = await import("@k2b/ui");
  try {
    const view = await createDefaultTableView(initial);
    view.columns.showFlatViewColumns(["FIELD2"]);
    await until(
      () => dom.document.body.textContent?.includes("The column was added, but its field is still set to “Hide in table”.") === true,
    );
    expect(api.tableWrites().map((request) => request.body?.columns)).toEqual([[{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }]]);
    expect(view.fields()[1]!.hideInTable).toBe(true);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});

const deleteFieldThroughEditor = async (document: Document, view: DefaultTableView, field: PublicField) => {
  const { dialogCore } = await import("@k2b/ui");
  view.admin.openFieldSettings(field);
  await until(() => Boolean(buttonNamed(document, "Delete field")));
  buttonNamed(document, "Delete field")!.click();
  await until(() => Boolean(buttonNamed(document, "Delete")));
  buttonNamed(document, "Delete")!.click();
  await until(() => !dialogCore.isOpen());
};

domTest("fields added after deleting listed fields stay visible without a reload", async () => {
  const dom = createHarness();
  const initial = {
    fields: [
      makeField("FIELD1", "Name", 0),
      makeField("FIELD2", "Status", 1),
      makeField("FIELD3", "Owner", 2),
      makeField("FIELD4", "Notes", 3),
    ],
    columns: [{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }, { fieldId: "FIELD4" }],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  try {
    const view = await createDefaultTableView(initial);
    await deleteFieldThroughEditor(dom.document, view, view.fields()[2]!);
    await deleteFieldThroughEditor(dom.document, view, view.fields()[2]!);
    expect(view.tableColumns()).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }]);

    await addTextField(dom.document, view.admin, "Responsible");
    await addTextField(dom.document, view.admin, "Activity");
    expect(api.table.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD5" }, { fieldId: "FIELD6" }]);
    expect(view.tableColumns()).toEqual(api.table.columns);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD5", "FIELD6"]);
    // The server keeps the column list current; the browser writes no column list of its own.
    expect(api.tableWrites()).toEqual([]);
    expect(view.tableUpdatedAt()).toBe(api.table.updatedAt);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});

domTest("a column change from an outdated table reloads it instead of dropping a field", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "Name", 0), makeField("FIELD2", "Status", 1)],
    columns: [{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  try {
    const view = await createDefaultTableView(initial);
    api.createFieldElsewhere("Activities");

    view.columns.moveViewColumnInline({ fieldId: "FIELD2" }, -1);
    await until(() => dom.document.body.textContent?.includes("The table's columns changed in the meantime") === true);
    expect(api.table.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
    expect(view.fields().map((field) => field.id)).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
    while (dialogCore.isOpen()) dialogCore.close();

    // Trying again builds on the reloaded table, and quick successive changes each build on the previous save.
    view.columns.moveViewColumnInline({ fieldId: "FIELD2" }, -1);
    view.columns.moveViewColumnInline({ fieldId: "FIELD3" }, -1);
    await until(() => api.tableWrites().length === 3 && view.tableUpdatedAt() === api.table.updatedAt);
    expect(api.table.columns).toEqual([{ fieldId: "FIELD2" }, { fieldId: "FIELD3" }, { fieldId: "FIELD1" }]);
    expect(view.visibleFieldIds()).toEqual(["FIELD2", "FIELD3", "FIELD1"]);
    expect(dialogCore.isOpen()).toBe(false);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});

domTest("a field save over an outdated column list reloads the table and saves again on retry", async () => {
  const dom = createHarness();
  const initial = {
    fields: [makeField("FIELD1", "Name", 0), makeField("FIELD2", "Status", 1)],
    columns: [{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }],
  };
  const api = installGridsApi(initial.fields, { columns: initial.columns });
  const { dialogCore } = await import("@k2b/ui");
  try {
    const view = await createDefaultTableView(initial);
    view.admin.openFieldSettings(view.fields()[0]!);
    await until(() => Boolean(inputFor(dom.document, "Table column name")));
    api.createFieldElsewhere("Activities");

    change(inputFor(dom.document, "Table column name")!, "Full name");
    buttonNamed(dom.document, "Save")!.click();
    await until(() => dom.document.body.textContent?.includes("The table's columns changed in the meantime") === true);
    expect(api.table.columns).toEqual([{ fieldId: "FIELD1" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }]);

    buttonNamed(dom.document, "Save")!.click();
    await until(() => !dialogCore.isOpen());
    expect(api.fieldWrites()).toHaveLength(1);
    expect(api.table.columns).toEqual([{ fieldId: "FIELD1", label: "Full name" }, { fieldId: "FIELD2" }, { fieldId: "FIELD3" }]);
    expect(view.tableColumns()).toEqual(api.table.columns);
    expect(view.visibleFieldIds()).toEqual(["FIELD1", "FIELD2", "FIELD3"]);
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    api.restore();
    dom.cleanup();
  }
});
