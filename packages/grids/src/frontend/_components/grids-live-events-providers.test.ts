import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GridsWorkflowRunEvent } from "../../lib/workflow-run-events";

type ProviderError = { code: string; message: string };
type ProviderControls = {
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

const recordEvent = (tableId = TABLE_ID, cursor = "7-1") => ({
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

const metadataEvent = (baseId = BASE_ID, cursor = "8-1") => ({
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

const workflowEvent = (workflowId = WORKFLOW_ID, cursor = "9-1") => {
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
    const provider = createGridsRecordEventsProvider({ tableId: TABLE_ID, initialCursor: "6-9" });
    const call = providerCalls[0]!;

    provider.connect();

    expect(call.options.url).toBe("/api/grids/ws");
    expect(call.options.activity).toBe("visible");
    expect(call.options.initialCursor).toBe("6-9");
    expect(call.options.subscribe("7-1")).toEqual({
      type: "grids.records.subscribe",
      payload: { tableId: TABLE_ID, fromCursor: "7-1" },
    });
    expect(call.connectCount).toBe(1);
  });

  test("marks the server baseline only after accepting the ready message", () => {
    const order: string[] = [];
    createGridsRecordEventsProvider({ tableId: TABLE_ID, onReady: () => order.push("ready") });
    const call = providerCalls[0]!;

    deliver(call, { type: "grids.records.ready", payload: { tableId: OTHER_TABLE_ID, cursor: "6-8" } }, order);
    deliver(call, { type: "grids.records.ready", payload: { tableId: TABLE_ID, cursor: "6-9" } }, order);

    expect(order).toEqual(["ready", "mark:6-9"]);
    expect(call.controlCursors).toEqual(["6-9"]);
  });

  test("does not mark a ready baseline rejected by the consumer", () => {
    createGridsRecordEventsProvider({
      tableId: TABLE_ID,
      onReady: () => {
        throw new Error("Ready failed");
      },
    });
    const call = providerCalls[0]!;

    expect(() => deliver(call, { type: "grids.records.ready", payload: { tableId: TABLE_ID, cursor: "6-9" } })).toThrow("Ready failed");
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
    deliver(call, { type: "grids.records.event", payload: { tableId: TABLE_ID, cursor: "7-2" } });

    expect(received).toHaveLength(2);
    expect(received[0]?.cursor).toBe("7-1");
    expect(received[1]).toEqual({ event: null, cursor: "7-2" });
    expect(call.controlCursors).toEqual([]);

    provider.markApplied("7-2");
    expect(call.markedCursors).toEqual(["7-2"]);
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

    deliver(call, { type: "grids.metadata.ready", payload: { baseId: OTHER_BASE_ID, cursor: "7-8" } }, order);
    deliver(call, { type: "grids.metadata.ready", payload: { baseId: BASE_ID, cursor: "7-9" } }, order);

    expect(order).toEqual(["ready", "mark:7-9"]);
    expect(call.controlCursors).toEqual(["7-9"]);
  });

  test("subscribes by base and accepts only matching metadata without implicit acknowledgement", () => {
    const cursors: Array<string | null> = [];
    const provider = createGridsMetadataEventsProvider({
      baseId: BASE_ID,
      initialCursor: "7-9",
      onEvent: (cursor) => cursors.push(cursor),
    });
    const call = providerCalls[0]!;

    expect(call.options.activity).toBe("visible");
    expect(call.options.initialCursor).toBe("7-9");
    expect(call.options.subscribe("8-0")).toEqual({
      type: "grids.metadata.subscribe",
      payload: { baseId: BASE_ID, fromCursor: "8-0" },
    });

    deliver(call, metadataEvent(OTHER_BASE_ID));
    deliver(call, metadataEvent());
    expect(cursors).toEqual(["8-1"]);
    expect(call.controlCursors).toEqual([]);

    provider.markApplied("8-1");
    expect(call.markedCursors).toEqual(["8-1"]);
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

    deliver(call, { type: "grids.workflow-runs.ready", payload: { workflowId: OTHER_WORKFLOW_ID, cursor: "8-8" } }, order);
    deliver(call, { type: "grids.workflow-runs.ready", payload: { workflowId: WORKFLOW_ID, cursor: "8-9" } }, order);

    expect(order).toEqual(["ready", "mark:8-9"]);
    expect(call.controlCursors).toEqual(["8-9"]);
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

    expect(order).toEqual(["event", "mark:9-1"]);
    expect(call.controlCursors).toEqual(["9-1"]);
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
