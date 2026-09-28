import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridRecord, PublicTableQueryResult, PublicView } from "../../../api/public-dto";
import type { GroupBySpec, RecordQuery } from "../../../contracts";

const domTest = isServer ? test.skip : test;
const timestamp = "2026-01-01T00:00:00.000Z";

mock.module("./grids-record-events-provider", () => ({
  createGridsRecordEventsProvider: () => ({ connect: () => {}, dispose: () => {}, markApplied: () => {} }),
}));
type FetchRecords = typeof import("./fetcher").fetchTableQuery;
let fetchRecords: FetchRecords = async () => memberPage;
mock.module("./fetcher", () => ({ fetchTableQuery: (...args: Parameters<FetchRecords>) => fetchRecords(...args) }));

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

type RecordsViewProps = Parameters<typeof import("./RecordsView").default>[0];

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
  fields: tableFields,
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
  fieldsByTable: { TABLE1: tableFields },
  viewMode: false,
  initialState: {
    query: {},
    cursor: null,
    selectedRecordId: null,
    search: { q: "", fieldIds: [], override: false },
    calendar: { view: "month", date: "2026-01-01" },
    cardSize: "medium",
  },
  initialData: memberPage,
  initialError: null,
  initialEventCursor: null,
  initialSelectedRecord: null,
  initialSelectedRecordDetail: null,
  documentTemplates: [],
  relationLabels: memberPage.relationLabels ?? {},
  viewColumns: undefined,
  groupedExplode: false,
  activeRecordQuery: null,
  displayConfig: { mode: "table" },
  bulkSelectionLaunchers: [],
  recordActionLaunchers: [],
  workspaceRouteKey: "records:TABLE1::false",
  ...overrides,
});

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
      createComponent(
        RecordsView,
        recordsViewProps({
          viewId: view.id,
          fields: [groupField],
          activeView: view,
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
          relationLabels: { PERSON1: "Mara Lind" },
          groupedExplode: groupField.type === "relation",
          activeRecordQuery: view.query,
          workspaceRouteKey: "records:TABLE1:VIEW01:false",
        }),
      ),
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

domTest(
  "the first client render shows the server's records as loaded, and a search shows the loading state until its records arrive",
  async () => {
    const dom = createDomTestHarness();
    delegateEvents(["input"], dom.document);
    const previousObserver = globalThis.IntersectionObserver;
    Object.assign(globalThis, {
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    const queries: string[] = [];
    let resolveSearch!: (page: PublicTableQueryResult) => void;
    fetchRecords = (args) => {
      queries.push(args.query.search?.q ?? "");
      return new Promise((resolve) => {
        resolveSearch = resolve;
      });
    };
    const { default: RecordsView } = await import("./RecordsView");
    const dispose = render(() => createComponent(RecordsView, recordsViewProps({})), dom.root);
    const searchInput = () => dom.root.querySelector<HTMLInputElement>('input[name="grids-record-search"]')!;
    const searchIcons = () => Array.from(dom.root.querySelectorAll(".k2b-text-input__icon > i")).map((icon) => icon.className);
    const recordsDimmed = () => dom.root.querySelector(".transition-opacity")!.classList.contains("opacity-60");
    try {
      await Bun.sleep(0);
      expect(queries).toEqual([]);
      expect(dom.root.textContent).toContain("Draft the brochure");
      expect(searchIcons()).toEqual(["ti ti-search", "ti ti-search"]);
      expect(searchInput().hasAttribute("aria-busy")).toBe(false);
      expect(recordsDimmed()).toBe(false);

      searchInput().value = "venue";
      searchInput().dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => queries.length === 1);
      expect(queries).toEqual(["venue"]);
      expect(searchIcons()).toEqual(["ti ti-loader-2 k2b-spin", "ti ti-loader-2 k2b-spin"]);
      expect(searchInput().getAttribute("aria-busy")).toBe("true");
      expect(recordsDimmed()).toBe(true);

      resolveSearch({ items: [memberPage.items![1]!], nextCursor: null, relationLabels: { PERSON1: "Mara Lind" } });
      await waitFor(() => !searchInput().hasAttribute("aria-busy"));
      expect(searchIcons()).toEqual(["ti ti-search", "ti ti-search"]);
      expect(recordsDimmed()).toBe(false);
      expect(dom.root.textContent).toContain("Book the venue");
      expect(dom.root.textContent).not.toContain("Draft the brochure");
    } finally {
      dispose();
      dom.cleanup();
      Object.assign(globalThis, { IntersectionObserver: previousObserver });
      fetchRecords = async () => memberPage;
    }
  },
);

domTest("a failed server read shows its error without repeating the read, and the error stays until a retry loads records", async () => {
  const dom = createDomTestHarness();
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  let reads = 0;
  let settleRead!: { resolve: (page: PublicTableQueryResult) => void; reject: (error: Error) => void };
  fetchRecords = () => {
    reads++;
    return new Promise((resolve, reject) => {
      settleRead = { resolve, reject };
    });
  };
  const { default: RecordsView } = await import("./RecordsView");
  const dispose = render(
    () =>
      createComponent(
        RecordsView,
        recordsViewProps({
          initialData: { items: [], nextCursor: null },
          initialError: "This value could not be calculated. Check the formula and its input values.",
          relationLabels: {},
        }),
      ),
    dom.root,
  );
  const retryButton = () =>
    Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Retry") ?? null;
  try {
    await Bun.sleep(0);
    expect(reads).toBe(0);
    expect(dom.root.textContent).toContain("Could not refresh records");
    expect(dom.root.textContent).toContain("This value could not be calculated.");

    retryButton()!.click();
    await waitFor(() => reads === 1);
    settleRead.reject(new Error("The filter is invalid: unknown field."));
    await waitFor(() => dom.root.textContent?.includes("The filter is invalid: unknown field.") === true);
    expect(dom.root.textContent).not.toContain("This value could not be calculated.");

    retryButton()!.click();
    await waitFor(() => reads === 2);
    settleRead.resolve(memberPage);
    await waitFor(() => dom.root.textContent?.includes("Draft the brochure") === true);
    expect(dom.root.textContent).not.toContain("Could not refresh records");
    expect(retryButton()).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
    Object.assign(globalThis, { IntersectionObserver: previousObserver });
    fetchRecords = async () => memberPage;
  }
});

const notesField = field("FIELD4", "Notes", 1);

/**
 * Serves the field calls of a records page like the Grids API. A deleted field moves to the Base trash, and
 * `restoreElsewhere` brings it back the way Base settings or the CLI do, without telling the page.
 */
const installFieldApi = (initialFields: PublicField[]) => {
  const originalFetch = globalThis.fetch;
  const live = [...initialFields];
  const trash: PublicField[] = [];
  let created = 0;
  let version = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (path === "/api/grids/fields/by-table/TABLE1") {
        if (method === "GET") return Response.json(live);
        created += 1;
        const next = field(`NEW00${created}`, String(body.name), live.length + trash.length, { type: String(body.type ?? "text") });
        live.push(next);
        version += 1;
        return Response.json(next);
      }
      if (path === "/api/grids/tables/TABLE1") {
        const updatedAt = new Date(Date.parse(timestamp) + version * 1000).toISOString();
        return Response.json({ id: "TABLE1", columns: [], displayConfig: { mode: "table" }, updatedAt });
      }
      if (path.endsWith("/dependents")) return Response.json({ hasBlocking: false, dependents: [] });
      const target = live.find((candidate) => path === `/api/grids/fields/${candidate.id}`);
      if (method === "DELETE" && target) {
        live.splice(live.indexOf(target), 1);
        trash.push(target);
        version += 1;
        return new Response(null, { status: 204 });
      }
      return Response.json({ message: `Unexpected ${method} ${path}` }, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    restoreElsewhere: (fieldId: string) => {
      const [restored] = trash.splice(
        trash.findIndex((candidate) => candidate.id === fieldId),
        1,
      );
      live.splice(restored!.position, 0, restored!);
      version += 1;
    },
    uninstall: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

/** Opens a table page in edit mode for someone who manages the table, with the field calls served by `installFieldApi`. */
const mountTableEditor = async (overrides: Partial<RecordsViewProps>) => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "input"], dom.document);
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const initialFields = overrides.fields ?? [];
  const api = installFieldApi(initialFields);
  const reads: Array<{ query: RecordQuery; signal?: AbortSignal }> = [];
  fetchRecords = async (args, options) => {
    reads.push({ query: args.query, signal: options?.signal });
    return memberPage;
  };
  const { default: RecordsView } = await import("./RecordsView");
  const { dialogCore } = await import("@k2b/ui");
  const dispose = render(
    () =>
      createComponent(
        RecordsView,
        recordsViewProps({
          canWrite: true,
          canManageTable: true,
          initialAdminMode: true,
          fieldsByTable: { TABLE1: initialFields },
          ...overrides,
        }),
      ),
    dom.root,
  );
  const document = dom.document;
  const buttonNamed = (label: string) =>
    Array.from(document.querySelectorAll("button")).findLast((node) => node.textContent?.trim() === label);
  const scope = () => document.querySelector<HTMLElement>('[role="combobox"][aria-label="Search record columns"]');
  /** Lists the fields the search scope offers and the ones it has selected. */
  const readScope = () => {
    const listbox = document.getElementById(scope()?.getAttribute("aria-controls") ?? "");
    if (!listbox) return null;
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    return {
      offered: options.map((option) => option.getAttribute("aria-label")),
      selected: options
        .filter((option) => option.getAttribute("aria-selected") === "true")
        .map((option) => option.getAttribute("aria-label")),
    };
  };
  const addTextField = async (name: string) => {
    buttonNamed("Add field")!.click();
    const textType = () =>
      Array.from(document.querySelectorAll("button")).find((node) => node.querySelector(".min-w-0 > div")?.textContent === "Text");
    await waitFor(() => Boolean(textType()));
    textType()!.click();
    const nameInput = () => {
      const label = Array.from(document.querySelectorAll("label")).findLast(
        (node) => node.textContent?.trim().replace(/\s*\*$/, "") === "Name",
      );
      return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
    };
    await waitFor(() => Boolean(nameInput()));
    nameInput()!.value = name;
    nameInput()!.dispatchEvent(new Event("input", { bubbles: true }));
    buttonNamed("Create")!.click();
    await waitFor(() => !dialogCore.isOpen());
  };
  const deleteField = async (name: string) => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Field settings settings for ${name}"]`)!.click();
    await waitFor(() => Boolean(buttonNamed("Delete field")));
    buttonNamed("Delete field")!.click();
    await waitFor(() => Boolean(buttonNamed("Delete")));
    buttonNamed("Delete")!.click();
    await waitFor(() => !dialogCore.isOpen());
  };
  return {
    api,
    reads,
    searchInput: () => document.querySelector<HTMLInputElement>('input[name="grids-record-search"]'),
    readScope,
    addTextField,
    deleteField,
    cleanup: () => {
      while (dialogCore.isOpen()) dialogCore.close();
      dispose();
      api.uninstall();
      dom.cleanup();
      Object.assign(globalThis, { IntersectionObserver: previousObserver });
      fetchRecords = async () => memberPage;
    },
  };
};

domTest("a new table shows the search as soon as it has a searchable field", async () => {
  const page = await mountTableEditor({ fields: [], initialData: { items: [], nextCursor: null }, relationLabels: {} });
  try {
    expect(page.searchInput()).toBeNull();
    await page.addTextField("Keyword");
    await waitFor(() => page.searchInput() !== null);
    expect(page.readScope()).toEqual({ offered: ["Keyword"], selected: [] });
  } finally {
    page.cleanup();
  }
});

/** A page whose URL searches "venue" in the Notes field only. */
const searchingNotes = (): Partial<RecordsViewProps> => ({
  fields: [titleField, notesField],
  initialState: { ...recordsViewProps({}).initialState, search: { q: "venue", fieldIds: [notesField.id], override: true } },
});

domTest("deleting a field removes it from the search scope and from a search that was limited to it", async () => {
  const page = await mountTableEditor(searchingNotes());
  try {
    expect(page.readScope()).toEqual({ offered: ["Title", "Notes"], selected: ["Notes"] });

    await page.deleteField("Notes");
    expect(page.readScope()).toEqual({ offered: ["Title"], selected: [] });
    // Reads started while the field was being deleted are cancelled, since naming it fails; the search keeps its text.
    await waitFor(() => page.reads.length > 0);
    const namesDeletedField = (read: { query: RecordQuery }) => read.query.search?.fieldIds?.includes(notesField.id) === true;
    expect(page.reads.filter(namesDeletedField).every((read) => read.signal?.aborted)).toBe(true);
    expect(page.reads.at(-1)?.query.search).toEqual({ q: "venue", fieldIds: [] });
    expect(page.searchInput()?.value).toBe("venue");
    expect(new URL(window.location.href).searchParams.get("qFields")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("q")).toBe("venue");
  } finally {
    page.cleanup();
  }
});

domTest("going back to a search limited to a deleted field searches the remaining fields", async () => {
  const page = await mountTableEditor(searchingNotes());
  try {
    await page.deleteField("Notes");
    const readsBeforeBack = page.reads.length;

    // Back lands on an older history entry that still limits the search to the deleted field.
    window.history.replaceState(null, "", `/app/grids/BASE01/table/TABLE1?q=stage&qFields=${notesField.id}`);
    window.dispatchEvent(new Event("popstate"));
    await waitFor(() => page.reads.length > readsBeforeBack);

    expect(page.reads.slice(readsBeforeBack).map((read) => read.query.search)).toEqual([{ q: "stage", fieldIds: [] }]);
    expect(page.readScope()).toEqual({ offered: ["Title"], selected: [] });
    expect(page.searchInput()?.value).toBe("stage");
  } finally {
    page.cleanup();
  }
});

domTest("going back in a saved view keeps a search in a table field outside the view's columns", async () => {
  const dom = createDomTestHarness();
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const reads: RecordQuery[] = [];
  fetchRecords = async (args) => {
    reads.push(args.query);
    return memberPage;
  };
  const query: RecordQuery = { columns: [{ fieldId: titleField.id }], search: { q: "venue", fieldIds: [notesField.id] } };
  const view: PublicView & { query: RecordQuery; displayConfig: { mode: "table" } } = {
    id: "VIEW01",
    tableId: "TABLE1",
    name: "Venue tasks",
    description: null,
    icon: null,
    source: `from table {TABLE1} search 'venue' in {${notesField.id}} select {${titleField.id}}`,
    ui: {},
    ownerUserId: null,
    position: 0,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    query,
    displayConfig: { mode: "table" },
  };
  const { default: RecordsView } = await import("./RecordsView");
  const dispose = render(
    () =>
      createComponent(
        RecordsView,
        recordsViewProps({
          viewId: view.id,
          fields: [titleField],
          fieldsByTable: { TABLE1: [titleField, notesField] },
          activeView: view,
          viewMode: true,
          activeRecordQuery: query,
          workspaceRouteKey: "records:TABLE1:VIEW01:false",
        }),
      ),
    dom.root,
  );
  try {
    // Back lands on an entry where the person changed the text of the view's search.
    window.history.replaceState(null, "", `/app/grids/BASE01/table/TABLE1/view/VIEW01?q=stage&qFields=${notesField.id}`);
    window.dispatchEvent(new Event("popstate"));
    await waitFor(() => reads.length > 0);

    expect(reads.map((read) => read.search)).toEqual([{ q: "stage", fieldIds: [notesField.id] }]);
  } finally {
    dispose();
    dom.cleanup();
    Object.assign(globalThis, { IntersectionObserver: previousObserver });
    fetchRecords = async () => memberPage;
  }
});

domTest("a field restored elsewhere returns to the search scope with the table's next field read", async () => {
  const page = await mountTableEditor(searchingNotes());
  try {
    await page.deleteField("Notes");
    expect(page.readScope()).toEqual({ offered: ["Title"], selected: [] });

    // Base settings restores the field from the trash; adding a field makes the page read the table's fields again.
    page.api.restoreElsewhere(notesField.id);
    await page.addTextField("Due");
    await waitFor(() => page.readScope()?.offered.length === 3);
    // The restored field is offered again, but the search that dropped it stays as the person left it.
    expect(page.readScope()).toEqual({ offered: ["Title", "Notes", "Due"], selected: [] });
    expect(page.searchInput()?.value).toBe("venue");
  } finally {
    page.cleanup();
  }
});
