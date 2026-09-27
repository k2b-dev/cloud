import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridRecord, PublicTableQueryResult } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const timestamp = "2026-01-01T00:00:00.000Z";
const nameField: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Name",
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
const customerField: PublicField = {
  ...nameField,
  id: "FIELD2",
  name: "Customer",
  type: "relation",
  config: { targetTableId: "TABLE2" },
  position: 1,
};
const statusField: PublicField = { ...nameField, id: "FIELD3", name: "Status", position: 2, presentable: false };
const member = (id: string, name: string, customerId: string): PublicGridRecord => ({
  id,
  tableId: "TABLE1",
  data: { FIELD1: name, FIELD2: [customerId], FIELD3: "Open" },
  version: 1,
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const pages: Record<string, PublicTableQueryResult> = {
  first: { items: [member("REC001", "Invoice 1", "REC101")], nextCursor: "page-2", relationLabels: { REC101: "Acme" } },
  "page-2": { items: [member("REC002", "Invoice 2", "REC102")], nextCursor: null, relationLabels: { REC102: "Globex" } },
};
mock.module("../records-view/fetcher", () => ({
  fetchTableQuery: async (args: { cursor?: string | null }) => pages[args.cursor ?? "first"],
}));

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await Bun.sleep(5);
  }
};

domTest("group members name linked records on every loaded page", async () => {
  const dom = createDomTestHarness();
  let reachEnd: (() => void) | undefined;
  const previousObserver = globalThis.IntersectionObserver;
  Object.assign(globalThis, {
    IntersectionObserver: class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        reachEnd = () => callback([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    },
  });
  const { default: GroupDetailPanel } = await import("./GroupDetailPanel");
  const dispose = render(
    () =>
      createComponent(GroupDetailPanel, {
        tableId: "TABLE1",
        fields: [nameField, customerField, statusField],
        query: {},
        groupBy: [{ fieldId: "FIELD3" }],
        aggregations: [],
        bucket: { keys: ["Open"], values: { "*__count": 2 } },
        relationLabels: {},
        onClose: () => {},
        onOpenRecord: () => {},
      }),
    dom.root,
  );
  const members = () => Array.from(dom.root.querySelectorAll(".k2b-detail-panel__action-title")).map((title) => title.textContent?.trim());
  try {
    await waitFor(() => members().length === 1);
    expect(members()).toEqual(["Invoice 1 · Acme"]);

    reachEnd?.();
    await waitFor(() => members().length === 2);
    expect(members()).toEqual(["Invoice 1 · Acme", "Invoice 2 · Globex"]);
    expect(dom.root.textContent).not.toContain("Unavailable record");
  } finally {
    dispose();
    dom.cleanup();
    Object.assign(globalThis, { IntersectionObserver: previousObserver });
  }
});
