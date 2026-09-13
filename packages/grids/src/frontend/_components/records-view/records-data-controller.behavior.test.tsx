import { expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicGridRecord, PublicTableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";

const domTest = isServer ? test.skip : test;
type ProviderOptions = Parameters<typeof import("./grids-record-events-provider").createGridsRecordEventsProvider>[0];
let callbacks: ProviderOptions;
let applied: Array<string | null> = [];
mock.module("./grids-record-events-provider", () => ({
  createGridsRecordEventsProvider: (opts: ProviderOptions) => {
    callbacks = opts;
    return { connect: () => {}, dispose: () => {}, markApplied: (cursor: string | null) => applied.push(cursor) };
  },
}));
type FetchRecords = typeof import("./fetcher").fetchTableQuery;
let fetchRecords: FetchRecords;
mock.module("./fetcher", () => ({ fetchTableQuery: (...args: Parameters<FetchRecords>) => fetchRecords(...args) }));
const record = (id: string): PublicGridRecord => ({
  id,
  tableId: "TABLE1",
  data: {},
  version: 1,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  updatedBy: null,
});

const mount = async (onRefreshed: () => Promise<void> = async () => {}) => {
  const dom = createDomTestHarness();
  const { createRecordsDataController } = await import("./records-data-controller");
  let controller!: ReturnType<typeof createRecordsDataController>;
  let revoked = 0;
  applied = [];
  const query = { limit: 100, sort: [{ fieldId: "FIELD1", direction: "asc" }] } as RecordQuery;
  const dispose = render(
    () =>
      createComponent(() => {
        const [cursor, setCursor] = createSignal<string | null>(null);
        controller = createRecordsDataController({
          tableId: "TABLE1",
          trashMode: false,
          source: () => ({ tableId: "TABLE1", query, cursor: cursor(), calendar: { view: "month", date: "2026-09-01" } }),
          initialData: { items: [record("old")], nextCursor: null },
          initialEventCursor: null,
          locale: "en",
          cursor,
          setCursor,
          isGrouped: () => false,
          hasBlockingDialog: () => false,
          onOptimisticDelete: () => {},
          onRefreshed,
          onRevoked: () => {
            revoked++;
          },
          onFatal: () => {},
        });
        return (
          <div>
            {controller
              .items()
              .map((item) => item.id)
              .join(",")}
          </div>
        );
      }, {}),
    dom.root,
  );
  await Bun.sleep(0);
  return {
    dom,
    controller,
    query,
    revoked: () => revoked,
    dispose: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("record bursts and reconnect replace the canonical filtered slice without changing the query", async () => {
  let result: PublicTableQueryResult = { items: [record("old")], nextCursor: null };
  const queries: RecordQuery[] = [];
  fetchRecords = async (args) => {
    queries.push(args.query);
    return result;
  };
  const state = await mount();
  try {
    queries.length = 0;
    result = { items: [record("matching")], aggregates: {}, nextCursor: null };
    for (const [i, type] of (
      ["record.created", "record.updated", "record.deleted", "record.restored", "record.finalized"] as const
    ).entries()) {
      callbacks.onEvent?.(
        {
          v: 1,
          baseId: "BASE01",
          tableId: "TABLE1",
          recordId: "other",
          type,
          version: i + 1,
          changedFieldIds: [],
          actorId: null,
          occurredAt: "2026-09-01T00:00:00Z",
        },
        `s6t.test.${i}`,
      );
    }
    expect(applied).toEqual([]);
    await Bun.sleep(300);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sort).toEqual(state.query.sort);
    expect(state.controller.items().map((item) => item.id)).toEqual(["matching"]);
    expect(applied).toEqual(["s6t.test.4"]);
    result = { items: [record("after-reconnect")], nextCursor: null };
    callbacks.onReady?.("s6t.test.5");
    await Bun.sleep(300);
    expect(state.controller.items()[0]!.id).toBe("after-reconnect");
    expect(applied.at(-1)).toBe("s6t.test.5");
  } finally {
    state.dispose();
  }
});

domTest("a late query cannot repopulate records after access is revoked", async () => {
  fetchRecords = async () => ({ items: [record("old")], nextCursor: null });
  const state = await mount();
  let resolve!: (value: PublicTableQueryResult) => void;
  fetchRecords = () =>
    new Promise((r) => {
      resolve = r;
    });
  try {
    callbacks.onReady?.("s6t.test.5");
    await Bun.sleep(300);
    callbacks.onRevoked?.({ code: "access_denied", message: "Denied" });
    expect(state.controller.items()).toEqual([]);
    expect(state.revoked()).toBe(1);
    resolve({ items: [record("private")], nextCursor: null });
    await Bun.sleep(0);
    expect(state.controller.items()).toEqual([]);
    expect(applied).toEqual([]);
  } finally {
    state.dispose();
  }
});

domTest("failed reconciliation keeps the old result without a retry loop or cursor acknowledgement", async () => {
  fetchRecords = async () => ({ items: [record("old")], nextCursor: null });
  const state = await mount();
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    throw Error("offline");
  };
  try {
    callbacks.onReady?.("s6t.test.5");
    await Bun.sleep(600);
    expect(calls).toBe(1);
    expect(applied).toEqual([]);
    expect(state.controller.items()[0]!.id).toBe("old");
    expect(state.controller.livePending()).toBe(true);
  } finally {
    state.dispose();
  }
});

domTest("a denied canonical read revokes the result without waiting for the socket", async () => {
  fetchRecords = async () => ({ items: [record("old")], nextCursor: null });
  const state = await mount();
  fetchRecords = async () => {
    throw Object.assign(Error("Denied"), { status: 403 });
  };
  try {
    callbacks.onReady?.("s6t.test.6");
    await Bun.sleep(300);
    expect(state.revoked()).toBe(1);
    expect(state.controller.items()).toEqual([]);
    expect(applied).toEqual([]);
  } finally {
    state.dispose();
  }
});
