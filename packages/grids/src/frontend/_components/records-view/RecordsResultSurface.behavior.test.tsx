import { expect, test } from "bun:test";
import { batch, createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridRecord } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
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

/** An empty table whose empty state offers "Add record"; `addRecord` stands in for a finished create dialog. */
const mountEmptyTable = async () => {
  const dom = createDomTestHarness();
  delegateEvents(["focusin", "focusout"], dom.document);
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  const [items, setItems] = createSignal<PublicGridRecord[]>([]);
  const [selectedRecordId, setSelectedRecordId] = createSignal<string | null>(null);
  const { Button } = await import("@k2b/ui");
  const { default: RecordsResultSurface } = await import("./RecordsResultSurface");
  const outside = dom.document.createElement("button");
  outside.textContent = "Elsewhere";
  dom.document.body.append(outside);
  const dispose = render(
    () =>
      createComponent(RecordsResultSurface, {
        grouped: false,
        mode: "table",
        trashMode: false,
        loading: false,
        cursor: null,
        nextCursor: null,
        tableId: "TABLE1",
        viewId: null,
        baseId: "BASE01",
        fieldsByTable: { TABLE1: [titleField] },
        fields: [titleField],
        get items() {
          return items();
        },
        buckets: [],
        groupBy: [],
        aggregations: [],
        groupedExplode: false,
        relationLabels: {},
        selectedGroup: null,
        get selectedRecordId() {
          return selectedRecordId();
        },
        highlightedRecordIds: new Set<string>(),
        filePreviews: {},
        displayConfig: { mode: "table" },
        calendarState: { view: "month", date: "2026-01-01" },
        cardSize: "medium",
        viewColumns: undefined,
        aggregates: {},
        aggregationSpecs: [],
        groupedColumnOrder: [],
        hiddenGroupedColumnIds: undefined,
        adminMode: false,
        canManageTable: false,
        savedView: false,
        canEditView: false,
        resultNarrowed: false,
        onClearResultNarrowing: () => {},
        readFailed: false,
        get emptyAction() {
          return createComponent(Button, { type: "button", children: "Add record" });
        },
        bulkSelection: undefined,
        onRecordClick: () => {},
        onCalendarChange: () => {},
        onGroupClick: () => {},
        onLoadMore: () => {},
        onFieldSettings: () => {},
        onViewColumnSettings: () => {},
        onViewColumnMove: () => {},
        onGroupedColumnSettings: () => {},
        onGroupedColumnMove: () => {},
      }),
    dom.root,
  );
  return {
    dom,
    outside,
    addButton: () => Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Add record")) ?? null,
    /** The created record arrives selected, as RecordsView's onRecordCreated does. */
    addRecord: () =>
      batch(() => {
        setItems([task("REC001", "Draft the brochure"), task("REC002", "Book the venue")]);
        setSelectedRecordId("REC002");
      }),
    cleanup: () => {
      dispose();
      outside.remove();
      dom.cleanup();
      Object.assign(globalThis, { IntersectionObserver: previousObserver });
    },
  };
};

domTest("focus on the empty state's action moves to the new selected row when the first record arrives", async () => {
  const table = await mountEmptyTable();
  try {
    table.addButton()!.focus();
    expect(table.dom.document.activeElement).toBe(table.addButton());

    table.addRecord();
    await Bun.sleep(0);
    expect(table.addButton()).toBeNull();
    const active = table.dom.document.activeElement as HTMLElement | null;
    expect(active?.tagName).toBe("TR");
    expect(active?.textContent).toContain("Book the venue");
  } finally {
    table.cleanup();
  }
});

domTest("a record arriving while focus is elsewhere leaves focus where it is", async () => {
  const table = await mountEmptyTable();
  try {
    table.addButton()!.focus();
    table.outside.focus();

    table.addRecord();
    await Bun.sleep(0);
    expect(table.dom.document.activeElement).toBe(table.outside);
  } finally {
    table.cleanup();
  }
});
