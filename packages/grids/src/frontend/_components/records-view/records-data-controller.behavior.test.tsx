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

const liveEvent = (recordId: string) => ({
  v: 1 as const,
  baseId: "BASE01",
  tableId: "TABLE1",
  recordId,
  type: "record.updated" as const,
  version: 2,
  changedFieldIds: [],
  actorId: null,
  occurredAt: "2026-09-01T00:00:00Z",
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
          initialData,
          initialError: null,
          initialEventCursor,
          locale: "en",
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

domTest("only the first ready after mount skips the read that would repeat the SSR read", async () => {
  const state = await mount({ initialEventCursor: "s6t.test.3" });
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    return { items: [record(`fresh-${calls}`)], nextCursor: null };
  };
  try {
    // Scheduling a reconciliation marks it pending synchronously, so nothing pending means no read.
    callbacks.onReady?.("s6t.test.3");
    expect(state.controller.livePending()).toBe(false);
    expect(state.controller.busy()).toBe(false);

    // A reconnect resumes from the same cursor but can have missed cross-table and time-relative changes.
    callbacks.onReady?.("s6t.test.3");
    expect(state.controller.busy()).toBe(true);
    await until(() => calls === 1 && !state.controller.busy());
    expect(state.controller.items()[0]!.id).toBe("fresh-1");

    callbacks.onEvent?.(liveEvent("other"), "s6t.test.4");
    await until(() => applied.at(-1) === "s6t.test.4" && !state.controller.busy());
    callbacks.onReady?.("s6t.test.4");
    expect(state.controller.busy()).toBe(true);
    await until(() => calls === 3 && !state.controller.busy());
    expect(state.controller.items()[0]!.id).toBe("fresh-3");
  } finally {
    state.dispose();
  }
});

domTest("a page that was hidden before its first ready reconciles when it returns", async () => {
  for (const hide of ["at mount", "after mount"] as const) {
    const state = await mount({ initialEventCursor: "s6t.test.3", visibility: hide === "at mount" ? "hidden" : "visible" });
    let calls = 0;
    fetchRecords = async () => {
      calls++;
      return { items: [record("fresh")], nextCursor: null };
    };
    try {
      if (hide === "after mount") setVisibility("hidden");
      setVisibility("visible");
      callbacks.onReady?.("s6t.test.3");
      expect(state.controller.busy()).toBe(true);
      await until(() => calls === 1 && !state.controller.busy());
      expect(state.controller.items()[0]!.id).toBe("fresh");
    } finally {
      state.dispose();
    }
  }
});

domTest("the first ready still retries a reconciliation that failed before it", async () => {
  const state = await mount({ initialEventCursor: "s6t.test.3" });
  let calls = 0;
  fetchRecords = async () => {
    calls++;
    if (calls === 1) throw Error("offline");
    return { items: [record("fresh")], nextCursor: null };
  };
  try {
    callbacks.onError?.({ code: "stream_failed", message: "Live updates failed." });
    await until(() => state.controller.needsManualRefresh());
    callbacks.onReady?.("s6t.test.3");
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
    callbacks.onReady?.("s6t.test.6");
    await Bun.sleep(300);
    expect(state.revoked()).toBe(1);
    expect(state.controller.items()).toEqual([]);
    expect(applied).toEqual([]);
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
    callbacks.onReady?.("s6t.test.7");
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
