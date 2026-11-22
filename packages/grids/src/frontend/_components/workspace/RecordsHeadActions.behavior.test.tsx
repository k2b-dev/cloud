import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField } from "../../../api/public-dto";
import { onRecordsHeadCommand, publishRecordsHeadStatus, type RecordsHeadCommand } from "../records-view/records-head-bus";

const domTest = isServer ? test.skip : test;
const field: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Name",
  description: null,
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
  createdAt: "2026-09-09T00:00:00Z",
  updatedAt: "2026-09-09T00:00:00Z",
};
const status = (overrides: Partial<Parameters<typeof publishRecordsHeadStatus>[1]> = {}) => ({
  busy: false,
  search: { q: "", fieldIds: [] },
  searchableFields: [field],
  selectedCount: 0,
  queueing: false,
  ...overrides,
});

const mount = async (tableId: string, searchableFields: PublicField[]) => {
  const dom = createDomTestHarness();
  const { default: RecordsHeadActions } = await import("./RecordsHeadActions.island");
  const dispose = render(
    () =>
      createComponent(RecordsHeadActions, {
        baseId: "BASE01",
        tableId,
        tableName: "Devices",
        tableKind: "stored",
        searchableFields,
        initialSearch: { q: "", fieldIds: [] },
        trashMode: false,
        canReadTable: true,
        queryHref: `/app/grids/BASE01/table/${tableId}/query`,
        bulkLaunchers: [],
      }),
    dom.root,
  );
  return {
    root: dom.root,
    searchInput: () => dom.root.querySelector<HTMLInputElement>('input[name="grids-record-search"]'),
    searchIcon: () => dom.root.querySelector(".k2b-text-input__icon > i")?.className,
    dispose: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("the head's search follows the records view: its spinner while records load, and a search the view cleared", async () => {
  const head = await mount("TABLEA", [field]);
  try {
    expect(head.searchIcon()).toBe("ti ti-search");
    publishRecordsHeadStatus("TABLEA", status({ busy: true, search: { q: "lamp", fieldIds: [] } }));
    expect(head.searchIcon()).toBe("ti ti-loader-2 k2b-spin");
    expect(head.searchInput()?.getAttribute("aria-busy")).toBe("true");
    expect(head.searchInput()?.value).toBe("lamp");
    publishRecordsHeadStatus("TABLEA", status());
    expect(head.searchIcon()).toBe("ti ti-search");
    expect(head.searchInput()?.value).toBe("");
  } finally {
    head.dispose();
  }
});

domTest("a status for another table leaves the head alone, and a table without searchable fields shows no search", async () => {
  const head = await mount("TABLEB", []);
  try {
    expect(head.searchInput()).toBeNull();
    publishRecordsHeadStatus("TABLEX", status({ busy: true }));
    expect(head.searchInput()).toBeNull();
    publishRecordsHeadStatus("TABLEB", status());
    expect(head.searchInput()).not.toBeNull();
  } finally {
    head.dispose();
  }
});

domTest("clearing the search sends one search command to the records view of its table", async () => {
  const head = await mount("TABLEC", [field]);
  const received: RecordsHeadCommand[] = [];
  const stop = onRecordsHeadCommand("TABLEC", (command) => received.push(command));
  try {
    publishRecordsHeadStatus("TABLEC", status({ search: { q: "lamp", fieldIds: [] } }));
    const clear = head.root.querySelector<HTMLButtonElement>(".k2b-input-shell__clear");
    if (!clear) throw new Error("the search has no clear button");
    clear.click();
    expect(received).toEqual([{ kind: "search", q: "", fieldIds: [] }]);
  } finally {
    stop();
    head.dispose();
  }
});
