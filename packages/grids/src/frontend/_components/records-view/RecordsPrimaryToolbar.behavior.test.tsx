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
  const [liveRefreshing, setLiveRefreshing] = createSignal(false);
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
        get liveRefreshing() {
          return liveRefreshing();
        },
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
    setLiveRefreshing,
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
    const refresh = () =>
      Array.from(toolbar.row.querySelectorAll("button")).find((button) => button.textContent?.includes("Updates available"));
    expect(refresh()?.querySelector("i")?.className).toBe("ti ti-refresh");

    // The retry uses the @k2b/ui Button loading state, whose spinner honors reduced motion.
    toolbar.setLiveRefreshing(true);
    expect(refresh()?.disabled).toBe(true);
    expect(refresh()?.getAttribute("aria-busy")).toBe("true");
    expect(Array.from(refresh()?.querySelectorAll("i") ?? []).map((icon) => icon.className)).toEqual(["ti ti-loader-2 k2b-spin"]);
  } finally {
    toolbar.dispose();
  }
});

const sharedParent = (first: Element, second: Element) => {
  let node = first.parentElement;
  while (node && !node.contains(second)) node = node.parentElement;
  if (!node) throw new Error("elements share no ancestor");
  return node;
};
const classes = (element: Element | null) => Array.from(element?.classList ?? []);

domTest("search and scope stay one unbroken unit while the count and actions wrap together", async () => {
  const toolbar = await mount([field]);
  try {
    const search = toolbar.searchInput();
    const scope = toolbar.row.querySelector('[role="combobox"]');
    const count = Array.from(toolbar.row.querySelectorAll("span")).find((span) => span.textContent === "3 records");
    const actions = Array.from(toolbar.row.querySelectorAll("button")).find((button) => button.textContent?.includes("Actions"));
    if (!search || !scope || !count || !actions) throw new Error("toolbar controls missing");

    // Layout classes are the contract here: the search unit never wraps, and the row
    // gives it 24rem before the count and actions move to their own line as one group.
    const searchUnit = sharedParent(search, scope);
    expect(classes(searchUnit)).toEqual(expect.arrayContaining(["flex", "flex-nowrap"]));
    expect(classes(searchUnit)).not.toContain("flex-wrap");
    expect(searchUnit.contains(count)).toBe(false);
    expect(searchUnit.parentElement?.parentElement).toBe(toolbar.row);
    expect(classes(searchUnit.parentElement)).toContain("flex-[1_1_24rem]");
    // The scope shrinks to 10rem only on narrow units; with room it grows to 16rem so selected column pills stay readable.
    const scopeSlot = Array.from(searchUnit.children).find((child) => child.contains(scope)) ?? null;
    expect(classes(scopeSlot)).toEqual(expect.arrayContaining(["min-w-40", "flex-[0_1_16rem]"]));

    const trailing = sharedParent(count, actions);
    expect(trailing.parentElement).toBe(toolbar.row);
    expect(trailing.contains(search)).toBe(false);
    expect(classes(trailing)).toContain("ml-auto");
    expect(classes(toolbar.row)).toContain("flex-wrap");
  } finally {
    toolbar.dispose();
  }
});
