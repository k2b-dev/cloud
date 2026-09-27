import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField } from "../../../api/public-dto";

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

const mount = async (searchableFields: PublicField[]) => {
  const dom = createDomTestHarness();
  const { default: RecordsPrimaryToolbar } = await import("./RecordsPrimaryToolbar");
  const [busy, setBusy] = createSignal(false);
  const [needsManualRefresh, setNeedsManualRefresh] = createSignal(false);
  const dispose = render(
    () =>
      createComponent(RecordsPrimaryToolbar, {
        searchableFields,
        search: { q: "", fieldIds: [] },
        trashMode: false,
        canReadTable: true,
        tableKind: "stored",
        baseId: "BASE01",
        tableId: "TABLE1",
        recordCountText: "3 records",
        get busy() {
          return busy();
        },
        get needsManualRefresh() {
          return needsManualRefresh();
        },
        liveRefreshing: false,
        cardsMode: false,
        viewMode: false,
        cardSize: "medium",
        recordMetaCount: 0,
        bulkSelectionEnabled: false,
        selectedBulkCount: 0,
        bulkQueueing: false,
        bulkLaunchers: [],
        queryHref: "/app/grids/BASE01/query",
        onSearchChange: () => {},
        onRefresh: () => {},
        onCardSizeChange: () => {},
        onOpenRecordMetadata: () => {},
        onClearBulkSelection: () => {},
        onQueueBulkWorkflow: () => {},
        onExport: () => {},
        onOpenCombinedAudit: () => {},
      }),
    dom.root,
  );
  const row = dom.root.firstElementChild as HTMLElement;
  return {
    row,
    elements: () => Array.from(row.querySelectorAll("*")),
    searchIcons: () => Array.from(row.querySelectorAll(".k2b-text-input__icon > i")).map((icon) => icon.className),
    searchInput: () => row.querySelector<HTMLInputElement>('input[name="grids-record-search"]'),
    setBusy,
    setNeedsManualRefresh,
    dispose: () => {
      dispose();
      dom.cleanup();
    },
  };
};

// happy-dom has no layout engine: an unchanged element list with unchanged classes
// and inline styles is what keeps every width in the row identical.
const withoutBusyIcon = (html: string) => html.replaceAll("ti ti-loader-2 k2b-spin", "ti ti-search").replace(' aria-busy="true"', "");

domTest("loading turns only the search icon into a spinner and keeps the toolbar row unchanged", async () => {
  const toolbar = await mount([field]);
  try {
    const idle = toolbar.row.outerHTML;
    const elements = toolbar.elements();
    expect(toolbar.searchIcons()).toEqual(["ti ti-search", "ti ti-search"]);
    expect(toolbar.searchInput()?.hasAttribute("aria-busy")).toBe(false);

    toolbar.setBusy(true);
    expect(toolbar.searchIcons()).toEqual(["ti ti-loader-2 k2b-spin", "ti ti-loader-2 k2b-spin"]);
    expect(toolbar.searchInput()?.getAttribute("aria-busy")).toBe("true");
    expect(toolbar.row.textContent).not.toContain("Updates available");
    const busyElements = toolbar.elements();
    expect(busyElements).toHaveLength(elements.length);
    expect(busyElements.every((element, index) => element === elements[index])).toBe(true);
    expect(withoutBusyIcon(toolbar.row.outerHTML)).toBe(idle);

    toolbar.setBusy(false);
    expect(toolbar.row.outerHTML).toBe(idle);
  } finally {
    toolbar.dispose();
  }
});

domTest("a table without a search bar shows no loading indicator", async () => {
  const toolbar = await mount([]);
  try {
    const idle = toolbar.row.outerHTML;
    toolbar.setBusy(true);
    expect(toolbar.row.outerHTML).toBe(idle);
    expect(idle).not.toContain("k2b-spin");
  } finally {
    toolbar.dispose();
  }
});

domTest("the manual refresh appears only when a live reconciliation needs a retry", async () => {
  const toolbar = await mount([field]);
  try {
    expect(toolbar.row.textContent).not.toContain("Updates available");
    toolbar.setNeedsManualRefresh(true);
    expect(toolbar.row.textContent).toContain("Updates available");
  } finally {
    toolbar.dispose();
  }
});
