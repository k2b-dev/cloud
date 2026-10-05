import { expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicGridRecord, PublicTableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import { fakeLiveConnection } from "../live-test-utils";

const domTest = isServer ? test.skip : test;
const subscriptions = fakeLiveConnection();
/** The subscription of the controller mounted last. */
const records = () => subscriptions.at(-1)!;
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

const liveEvent = (recordId: string, type = "record.updated", version: number | null = 2) => ({
  type,
  tableId: "TABLE1",
  recordId,
  version,
});

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};

const mount = async ({
  initialData = { items: [record("old")], nextCursor: null },
  initialEventCursor = null,
  visibility = "visible",
}: {
  initialData?: PublicTableQueryResult;
  initialEventCursor?: string | null;
  visibility?: DocumentVisibilityState;
} = {}) => {
  const dom = createDomTestHarness();
  Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
  const { createRecordsDataController } = await import("./records-data-controller");
  let controller!: ReturnType<typeof createRecordsDataController>;
  let revoked = 0;
  const query = { limit: 100, sort: [{ fieldId: "FIELD1", direction: "asc" }] } as RecordQuery;
  const dispose = render(
    () =>
      createComponent(() => {
        const [cursor, setCursor] = createSignal<string | null>(null);
        controller = createRecordsDataController({
          tableId: "TABLE1",
          trashMode: false,
          source: () => ({ tableId: "TABLE1", query, cursor: cursor(), calendar: { view: "month", date: "2026-09-01" } }),
          initialData,
          initialError: null,
          initialEventCursor,
          cursor,
          setCursor,
          isGrouped: () => false,
          hasBlockingDialog: () => false,
          onOptimisticDelete: () => {},
          onRefreshed: async () => {},
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

domTest("an update burst and a resync replace the canonical filtered slice without changing the query", async () => {
  let result: PublicTableQueryResult = { items: [record("old")], nextCursor: null };
  const queries: RecordQuery[] = [];
  fetchRecords = async (args) => {
    queries.push(args.query);
    return result;
  };
  const state = await mount({ initialEventCursor: "s6t.page.3" });
  try {
    expect(records()).toMatchObject({ url: "/api/grids/live", channel: "records", scope: { table: "TABLE1" }, cursor: "s6t.page.3" });
    // The view resumes from the page's cursor and reads nothing on its own.
    expect(queries).toHaveLength(0);
    result = { items: [record("matching")], aggregates: {}, nextCursor: null };
    await records().deliver(
      (["record.created", "record.updated", "record.deleted", "record.restored", "record.finalized"] as const).map((type, i) =>
        liveEvent("OTHER1", type, i + 1),
      ),
    );
    await Bun.sleep(300);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sort).toEqual(state.query.sort);
    expect(state.controller.items().map((item) => item.id)).toEqual(["matching"]);
    result = { items: [record("after-resync")], nextCursor: null };
    await records().resync();
    await Bun.sleep(300);
    expect(state.controller.items()[0]!.id).toBe("after-resync");
  } finally {
    state.dispose();
  }
  expect(records().closed).toBe(true);
});

domTest("an update announces the record to open dialogs and removes a deleted one at once", async () => {
  fetchRecords = async () => ({ items: [record("KEPT01")], nextCursor: null });
  const state = await mount({ initialData: { items: [record("GONE01"), record("KEPT01")], nextCursor: null } });
  const announced: unknown[] = [];
  const announce = (event: Event) => announced.push((event as CustomEvent).detail);
  document.addEventListener("grids:record-live-change", announce);
  try {
    await records().deliver([liveEvent("GONE01", "record.deleted", null)]);
    expect(announced).toEqual([liveEvent("GONE01", "record.deleted", null)]);
    expect(state.controller.items().map((item) => item.id)).toEqual(["KEPT01"]);
  } finally {
    document.removeEventListener("grids:record-live-change", announce);
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
    await records().deliver([liveEvent("OTHER1")]);
    await Bun.sleep(300);
    records().revoke("access_denied");
    expect(state.controller.items()).toEqual([]);
    expect(state.revoked()).toBe(1);
    resolve({ items: [record("private")], nextCursor: null });
    await Bun.sleep(0);
    expect(state.controller.items()).toEqual([]);
  } finally {
    state.dispose();
  }
});

domTest("failed reconciliation keeps the old result without a retry loop", async () => {
  fetchRecords = async () => ({ items: [record("old")], nextCursor: null });
  const state = await mount();
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    throw Error("offline");
  };
  try {
    await records().deliver([liveEvent("OTHER1")]);
    await Bun.sleep(600);
    expect(calls).toBe(1);
    expect(state.controller.items()[0]!.id).toBe("old");
    expect(state.controller.livePending()).toBe(true);
    expect(state.controller.needsManualRefresh()).toBe(true);
    expect(state.controller.busy()).toBe(false);

    fetchRecords = async () => ({ items: [record("fresh")], nextCursor: null });
    const retry = state.controller.refreshVisibleRecords();
    expect(state.controller.needsManualRefresh()).toBe(true);
    expect(state.controller.busy()).toBe(true);
    await retry;
    expect(state.controller.needsManualRefresh()).toBe(false);
    expect(state.controller.busy()).toBe(false);
    expect(state.controller.items()[0]!.id).toBe("fresh");
  } finally {
    state.dispose();
  }
});

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

domTest("a return to the tab reconciles values that change without an update of this table", async () => {
  const state = await mount({ initialEventCursor: "s6t.test.3" });
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    return { items: [record(`fresh-${calls}`)], nextCursor: null };
  };
  try {
    // Lookups, rollups, and time-relative values can change while the tab is away.
    setVisibility("hidden");
    expect(state.controller.livePending()).toBe(false);
    setVisibility("visible");
    expect(state.controller.busy()).toBe(true);
    await until(() => calls === 1 && !state.controller.busy());
    expect(state.controller.items()[0]!.id).toBe("fresh-1");
  } finally {
    state.dispose();
  }
});

domTest("a resync retries a reconciliation that failed before it", async () => {
  const state = await mount({ initialEventCursor: "s6t.test.3" });
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    if (calls === 1) throw Error("offline");
    return { items: [record("fresh")], nextCursor: null };
  };
  try {
    await records().deliver([liveEvent("OTHER1")]);
    await until(() => state.controller.needsManualRefresh());
    await records().resync();
    expect(state.controller.needsManualRefresh()).toBe(false);
    await until(() => state.controller.items()[0]!.id === "fresh" && !state.controller.busy());
    expect(state.controller.needsManualRefresh()).toBe(false);
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
    await records().deliver([liveEvent("OTHER1")]);
    await Bun.sleep(300);
    expect(state.revoked()).toBe(1);
    expect(state.controller.items()).toEqual([]);
  } finally {
    state.dispose();
  }
});

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await Bun.sleep(5);
  }
};

domTest("relation labels follow each refetch and stay with earlier pages when more records load", async () => {
  const state = await mount({ initialData: { items: [record("old")], nextCursor: null, relationLabels: { REL001: "Acme" } } });
  try {
    expect(state.controller.relationLabels()).toEqual({ REL001: "Acme" });

    fetchRecords = async () => ({ items: [record("a")], nextCursor: "page-2", relationLabels: { REL002: "Globex" } });
    await records().resync();
    await waitFor(() => state.controller.items()[0]?.id === "a");
    expect(state.controller.relationLabels()).toEqual({ REL002: "Globex" });

    fetchRecords = async () => ({ items: [record("b")], nextCursor: null, relationLabels: { REL003: "Initech" } });
    state.controller.loadNextPage();
    await waitFor(() => state.controller.items().length === 2);
    expect(state.controller.relationLabels()).toEqual({ REL002: "Globex", REL003: "Initech" });
  } finally {
    state.dispose();
  }
});

domTest("without the page's cursor, the view reads its records once at the start", async () => {
  const queries: RecordQuery[] = [];
  // A record changed between the page's read and the subscription, which starts at the current position.
  fetchRecords = async (args) => {
    queries.push(args.query);
    return { items: [record("missed")], nextCursor: null };
  };
  const state = await mount();
  try {
    expect(records().cursor).toBeNull();
    await until(() => state.controller.items()[0]?.id === "missed");
    await Bun.sleep(300);
    expect(queries).toHaveLength(1);
  } finally {
    state.dispose();
  }
});
