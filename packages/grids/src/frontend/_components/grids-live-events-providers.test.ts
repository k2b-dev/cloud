import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GridsWorkflowRunEvent } from "../../lib/workflow-run-events";

type ProviderError = { code: string; message: string };
type ProviderControls = {
  resetCursor: () => void;
  markApplied: (cursor: string | null | undefined) => void;
  terminate: (error: ProviderError) => void;
};
type ProviderOptions = {
  url: string | (() => string);
  initialCursor?: string | null;
  activity?: "always" | "visible";
  subscribe: (cursor: string | null) => unknown;
  parse: (raw: string) => { type?: unknown; payload?: unknown } | null;
  onMessage: (message: { type?: unknown; payload?: unknown }, controls: ProviderControls) => void;
  onFatal?: (error: ProviderError) => void;
};
type ProviderCall = {
  options: ProviderOptions;
  connectCount: number;
  disposeCount: number;
  markedCursors: Array<string | null | undefined>;
  controlCursors: Array<string | null | undefined>;
  terminations: ProviderError[];
};

const providerCalls: ProviderCall[] = [];

mock.module("@valentinkolb/cloud/browser/live", () => ({
  createLiveWebSocket: (options: ProviderOptions) => {
    const call: ProviderCall = {
      options,
      connectCount: 0,
      disposeCount: 0,
      markedCursors: [],
      controlCursors: [],
      terminations: [],
    };
    providerCalls.push(call);
    return {
      connect: () => call.connectCount++,
      markApplied: (cursor: string | null | undefined) => call.markedCursors.push(cursor),
      dispose: () => call.disposeCount++,
    };
  },
}));

const { createGridsRecordEventsProvider } = await import("./records-view/grids-record-events-provider");
const { createGridsMetadataEventsProvider } = await import("./workspace/grids-metadata-events-provider");
const { createWorkflowRunEventsProvider } = await import("./workflows/workflow-run-events-provider");

const TABLE_ID = "011d8753-3ef9-4ebe-b7ed-fab4bb08c8e1";
const OTHER_TABLE_ID = "111d8753-3ef9-4ebe-b7ed-fab4bb08c8e1";
const BASE_ID = "85232148-725f-47af-999a-8379a83ef5f2";
const OTHER_BASE_ID = "95232148-725f-47af-999a-8379a83ef5f2";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";

const controlsFor = (call: ProviderCall, order?: string[]): ProviderControls => ({
  resetCursor: () => {
    call.controlCursors.push(null);
    order?.push("reset");
  },
  markApplied: (cursor) => {
    order?.push(`mark:${cursor}`);
    call.controlCursors.push(cursor);
  },
  terminate: (error) => {
    order?.push(`terminate:${error.code}`);
    call.terminations.push(error);
    call.options.onFatal?.(error);
  },
});

const deliver = (call: ProviderCall, message: unknown, order?: string[]) => {
  const parsed = call.options.parse(JSON.stringify(message));
  if (!parsed) throw new Error("Expected a valid provider message");
  call.options.onMessage(parsed, controlsFor(call, order));
};

const recordEvent = (tableId = TABLE_ID, cursor = "s6t.test.7") => ({
  type: "grids.records.event",
  payload: {
    tableId,
    cursor,
    event: {
      v: 1,
      type: "record.created",
      baseId: BASE_ID,
      tableId,
      recordId: "55555555-5555-4555-8555-555555555555",
      version: 1,
      changedFieldIds: [],
      actorId: null,
      occurredAt: "2026-05-29T00:00:00.000Z",
    },
  },
});

const metadataEvent = (baseId = BASE_ID, cursor = "s6t.test.8") => ({
  type: "grids.metadata.event",
  payload: {
    baseId,
    cursor,
    event: {
      v: 1,
      type: "table.updated",
      baseId,
      resource: { kind: "table", id: TABLE_ID, tableId: TABLE_ID },
      actorId: null,
      occurredAt: "2026-05-31T00:00:00.000Z",
    },
  },
});

const workflowEvent = (workflowId = WORKFLOW_ID, cursor = "s6t.test.9") => {
  const event: GridsWorkflowRunEvent = {
    v: 1,
    baseId: BASE_ID,
    workflowId,
    run: {
      id: "55555555-5555-4555-8555-555555555555",
      workflowId,
      launcherId: null,
      baseId: BASE_ID,
      workflowRevision: 1,
      mode: "execute",
      channel: "scanner",
      status: "succeeded",
      error: null,
      resultMessage: "Returned",
      createdAt: "2026-07-11T00:00:00.000Z",
      startedAt: "2026-07-11T00:00:00.100Z",
      finishedAt: "2026-07-11T00:00:00.200Z",
    },
    steps: [],
    scope: { kind: "workflow" },
  };
  return { type: "grids.workflow-runs.event", payload: { cursor, event } };
};

beforeEach(() => {
  providerCalls.length = 0;
});

describe("Grids record live events adapter", () => {
  test("subscribes with table, cursor, and visible activity", () => {
    const provider = createGridsRecordEventsProvider({ tableId: TABLE_ID, initialCursor: "s6t.test.6" });
    const call = providerCalls[0]!;

    provider.connect();

    expect(call.options.url).toBe("/api/grids/ws");
    expect(call.options.activity).toBe("visible");
    expect(call.options.initialCursor).toBe("s6t.test.6");
    expect(call.options.subscribe("s6t.test.7")).toEqual({
      type: "grids.records.subscribe",
      payload: { tableId: TABLE_ID, fromCursor: "s6t.test.7" },
    });
    expect(call.connectCount).toBe(1);
  });

  test("marks the server baseline only after accepting the ready message", () => {
    const order: string[] = [];
    createGridsRecordEventsProvider({ tableId: TABLE_ID, onReady: () => order.push("ready") });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.records.ready", payload: { tableId: OTHER_TABLE_ID, cursor: "s6t.test.6" } }, order);
    deliver(call, { type: "grids.records.ready", payload: { tableId: TABLE_ID, cursor: "s6t.test.6" } }, order);

    expect(order).toEqual(["ready", "mark:s6t.test.6"]);
    expect(call.controlCursors).toEqual(["s6t.test.6"]);
  });

  test("does not mark a ready baseline rejected by the consumer", () => {
    createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      onReady: () => {
        throw new Error("Ready failed");
      },
    });
    const call = providerCalls[0]!;

    expect(() => deliver(call, { type: "grids.records.ready", payload: { tableId: TABLE_ID, cursor: "s6t.test.6" } })).toThrow(
      "Ready failed",
    );
    expect(call.controlCursors).toEqual([]);
  });

  test("never persists malformed stream cursors", () => {
    const cursors: Array<string | null> = [];
    createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      onEvent: (_event, cursor) => cursors.push(cursor),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.records.ready", payload: { tableId: TABLE_ID, cursor: "invalid" } });
    deliver(call, recordEvent(TABLE_ID, "invalid"));

    expect(call.controlCursors).toEqual([null]);
    expect(cursors).toEqual([null]);
  });

  test("accepts scoped events without advancing the cursor for the consumer", () => {
    const received: Array<{ event: unknown; cursor: string | null }> = [];
    const provider = createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      onEvent: (event, cursor) => received.push({ event, cursor }),
    });
    const call = providerCalls[0]!;

    deliver(call, recordEvent(OTHER_TABLE_ID));
    deliver(call, recordEvent());
    deliver(call, { type: "grids.records.event", payload: { tableId: TABLE_ID, cursor: "s6t.test.7" } });

    expect(received).toHaveLength(2);
    expect(received[0]?.cursor).toBe("s6t.test.7");
    expect(received[1]).toEqual({ event: null, cursor: "s6t.test.7" });
    expect(call.controlCursors).toEqual([]);

    provider.markApplied("s6t.test.7");
    expect(call.markedCursors).toEqual(["s6t.test.7"]);
  });

  test("keeps recoverable errors separate and terminates after revocation", () => {
    const callbacks: string[] = [];
    createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      onError: (error) => callbacks.push(`error:${error.code}`),
      onRevoked: (error) => callbacks.push(`revoked:${error.code}`),
      onFatal: (error) => callbacks.push(`fatal:${error.code}`),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.records.error", payload: { code: "stream_failed", message: "Retry" } });
    deliver(call, { type: "grids.records.revoked", payload: { code: "access_denied", message: "Denied" } });

    expect(callbacks).toEqual(["error:stream_failed", "revoked:access_denied"]);
    expect(call.terminations).toEqual([{ code: "access_denied", message: "Denied" }]);
  });

  test("localizes record stream fallback errors with language fallback", () => {
    const messages: string[] = [];
    createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      locale: "de-CH",
      onRevoked: (error) => messages.push(error.message),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.records.revoked" });

    expect(messages).toEqual(["Dein Zugriff auf diese Tabelle hat sich geändert. Lade die Seite neu."]);
  });
});

describe("Grids metadata live events adapter", () => {
  test("marks a matching ready baseline after the consumer accepts it", () => {
    const order: string[] = [];
    createGridsMetadataEventsProvider({ baseId: BASE_ID, onReady: () => order.push("ready") });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.metadata.ready", payload: { baseId: OTHER_BASE_ID, cursor: "s6t.test.7" } }, order);
    deliver(call, { type: "grids.metadata.ready", payload: { baseId: BASE_ID, cursor: "s6t.test.7" } }, order);

    expect(order).toEqual(["ready", "mark:s6t.test.7"]);
    expect(call.controlCursors).toEqual(["s6t.test.7"]);
  });

  test("subscribes by base and accepts only matching metadata without implicit acknowledgement", () => {
    const cursors: Array<string | null> = [];
    const provider = createGridsMetadataEventsProvider({
      baseId: BASE_ID,
      initialCursor: "s6t.test.7",
      onEvent: (cursor) => cursors.push(cursor),
    });
    const call = providerCalls[0]!;

    expect(call.options.activity).toBe("visible");
    expect(call.options.initialCursor).toBe("s6t.test.7");
    expect(call.options.subscribe("s6t.test.8")).toEqual({
      type: "grids.metadata.subscribe",
      payload: { baseId: BASE_ID, fromCursor: "s6t.test.8" },
    });

    deliver(call, metadataEvent(OTHER_BASE_ID));
    deliver(call, metadataEvent());
    expect(cursors).toEqual(["s6t.test.8"]);
    expect(call.controlCursors).toEqual([]);

    provider.markApplied("s6t.test.8");
    expect(call.markedCursors).toEqual(["s6t.test.8"]);
  });

  test("routes transient errors and terminates terminal metadata errors", () => {
    const callbacks: string[] = [];
    createGridsMetadataEventsProvider({
      baseId: BASE_ID,
      onError: (error) => callbacks.push(`error:${error.code}`),
      onFatal: (error) => callbacks.push(`fatal:${error.code}`),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.metadata.error", payload: { code: "stream_failed", message: "Retry" } });
    deliver(call, { type: "grids.metadata.error", payload: { code: "backpressure", message: "Retry later" } });
    deliver(call, { type: "grids.metadata.error", payload: { code: "internal_error", message: "Stop" } });

    expect(callbacks).toEqual(["error:stream_failed", "error:backpressure", "fatal:internal_error"]);
    expect(call.terminations).toEqual([{ code: "internal_error", message: "Stop" }]);
  });
});

describe("Grids workflow-run live events adapter", () => {
  test("marks a matching ready baseline after the consumer accepts it", () => {
    const order: string[] = [];
    createWorkflowRunEventsProvider({ workflowId: WORKFLOW_ID, onReady: () => order.push("ready") });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.workflow-runs.ready", payload: { workflowId: OTHER_WORKFLOW_ID, cursor: "s6t.test.8" } }, order);
    deliver(call, { type: "grids.workflow-runs.ready", payload: { workflowId: WORKFLOW_ID, cursor: "s6t.test.8" } }, order);

    expect(order).toEqual(["ready", "mark:s6t.test.8"]);
    expect(call.controlCursors).toEqual(["s6t.test.8"]);
  });

  test("subscribes to the workflow and marks accepted events after the callback", () => {
    const order: string[] = [];
    createWorkflowRunEventsProvider({
      workflowId: WORKFLOW_ID,
      onEvent: () => order.push("event"),
    });
    const call = providerCalls[0]!;

    expect(call.options.activity).toBe("visible");
    expect(call.options.subscribe(null)).toEqual({
      type: "grids.workflow-runs.subscribe",
      payload: {
        workflowId: WORKFLOW_ID,
        fromCursor: null,
      },
    });

    deliver(call, workflowEvent(OTHER_WORKFLOW_ID), order);
    deliver(call, workflowEvent(), order);

    expect(order).toEqual(["event", "mark:s6t.test.9"]);
    expect(call.controlCursors).toEqual(["s6t.test.9"]);
  });

  test("does not mark a workflow event when its consumer rejects it", () => {
    createWorkflowRunEventsProvider({
      workflowId: WORKFLOW_ID,
      onEvent: () => {
        throw new Error("Consumer failed");
      },
    });
    const call = providerCalls[0]!;

    expect(() => deliver(call, workflowEvent())).toThrow("Consumer failed");
    expect(call.controlCursors).toEqual([]);
  });

  test("preserves workflow errors and terminates after revocation", () => {
    const callbacks: string[] = [];
    createWorkflowRunEventsProvider({
      workflowId: WORKFLOW_ID,
      onError: (error) => callbacks.push(`error:${error.code}`),
      onRevoked: (error) => callbacks.push(`revoked:${error.code}`),
      onFatal: (error) => callbacks.push(`fatal:${error.code}`),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.workflow-runs.error", payload: { code: "stream_failed", message: "Retry" } });
    deliver(call, { type: "grids.workflow-runs.revoked", payload: { code: "access_denied", message: "Denied" } });

    expect(callbacks).toEqual(["error:stream_failed", "revoked:access_denied"]);
    expect(call.terminations).toEqual([{ code: "access_denied", message: "Denied" }]);
  });

  test("terminates workflow subscriptions on initial authorization failures", () => {
    const callbacks: string[] = [];
    createWorkflowRunEventsProvider({
      workflowId: WORKFLOW_ID,
      onError: (error) => callbacks.push(`error:${error.code}`),
      onFatal: (error) => callbacks.push(`fatal:${error.code}`),
    });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.workflow-runs.error", payload: { code: "access_denied", message: "Denied" } });

    expect(callbacks).toEqual(["fatal:access_denied"]);
    expect(call.terminations).toEqual([{ code: "access_denied", message: "Denied" }]);
  });
});

describe("Grids cursor resynchronization", () => {
  test("drops pre-migration initial cursors", () => {
    createGridsRecordEventsProvider({ tableId: TABLE_ID, initialCursor: "1-0" });
    createGridsMetadataEventsProvider({ baseId: BASE_ID, initialCursor: "1-0" });
    expect(providerCalls.map((call) => call.options.initialCursor)).toEqual([null, null]);
  });

  test("resets stale cursors on every stream before reconnecting", () => {
    createGridsRecordEventsProvider({ tableId: TABLE_ID });
    createGridsMetadataEventsProvider({ baseId: BASE_ID });
    createWorkflowRunEventsProvider({ workflowId: WORKFLOW_ID });
    for (const [index, kind] of ["records", "metadata", "workflow-runs"].entries()) {
      const call = providerCalls[index]!;
      deliver(call, { type: `grids.${kind}.error`, payload: { code: "resync_required", message: "Reload" } });
      expect(call.controlCursors).toEqual([null]);
      expect(call.terminations).toEqual([]);
    }
  });
});
