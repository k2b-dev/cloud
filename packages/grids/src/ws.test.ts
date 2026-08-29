import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  createWorkspaceWebSocketSession,
  isWorkspaceAccessRefreshCurrent,
  resolveWorkspaceEventCursor,
  sendWorkspaceMessage,
  workspaceCloseCodeForError,
} from "./ws";

const baseId = "11111111-1111-4111-8111-111111111111";
const workflowId = "22222222-2222-4222-8222-222222222222";
const tableId = "33333333-3333-4333-8333-333333333333";
const recordId = "44444444-4444-4444-8444-444444444444";
const publicBaseId = "BASE01";
const publicWorkflowId = "WORK01";
const publicTableId = "TABL01";
const publicRecordId = "RECD01";

const testSocket = (sendStatus = 1) => {
  const messages: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const socket = {
    send: (raw: string) => {
      messages.push(JSON.parse(raw));
      return sendStatus;
    },
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
    },
  } as unknown as ServerWebSocket<unknown>;
  return { socket, messages, closes };
};

const metadataSubscribe = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "grids.metadata.subscribe",
    payload: { baseId: publicBaseId, sessionToken: "session", fromCursor: "1-0", ...overrides },
  });

const workflowSubscribe = () =>
  JSON.stringify({
    type: "grids.workflow-runs.subscribe",
    payload: { workflowId: publicWorkflowId, sessionToken: "session", fromCursor: "1-0" },
  });

const recordsSubscribe = () =>
  JSON.stringify({
    type: "grids.records.subscribe",
    payload: { tableId: publicTableId, sessionToken: "session", fromCursor: "1-0" },
  });

const socket = (status: number) =>
  ({
    send: () => status,
  }) as unknown as ServerWebSocket<unknown>;

const workspaceSession = (
  token: string | null,
  overrides: NonNullable<Parameters<typeof createWorkspaceWebSocketSession>[1]> = {},
  locale = "en",
) =>
  createWorkspaceWebSocketSession(
    token,
    {
      resolvePublicId: async (type, id) => {
        if (type === "base" && id === publicBaseId) return baseId;
        if (type === "table" && id === publicTableId) return tableId;
        if (type === "workflow" && id === publicWorkflowId) return workflowId;
        return null;
      },
      projectPublicId: async (type, id) => (type === "base" && id === baseId ? publicBaseId : null),
      projectRecordEvent: async (event) => ({ ...event, baseId: publicBaseId, tableId: publicTableId, recordId: publicRecordId }),
      projectMetadataEvent: async (event) => ({
        ...event,
        baseId: publicBaseId,
        resource: { ...event.resource, id: publicTableId, ...(event.resource.tableId ? { tableId: publicTableId } : {}) },
      }),
      ...overrides,
    },
    locale,
  );

describe("Grids websocket delivery", () => {
  test("accepts only messages written without backpressure or drops", () => {
    expect(sendWorkspaceMessage(socket(12), "event", { ok: true })).toBe(true);
    expect(sendWorkspaceMessage(socket(-1), "event", { ok: true })).toBe(false);
    expect(sendWorkspaceMessage(socket(0), "event", { ok: true })).toBe(false);
  });

  test("treats closed-socket send failures as undelivered", () => {
    const closed = {
      send: () => {
        throw new Error("closed");
      },
    } as unknown as ServerWebSocket<unknown>;
    expect(sendWorkspaceMessage(closed, "event")).toBe(false);
  });

  test("reconnects cursor-backed streams after transient delivery failures", () => {
    expect(workspaceCloseCodeForError("backpressure")).toBe(1012);
    expect(workspaceCloseCodeForError("stream_failed")).toBe(1012);
    expect(workspaceCloseCodeForError("internal_error")).toBe(1011);
    expect(workspaceCloseCodeForError("access_denied")).toBe(1008);
  });
});

describe("Grids websocket access refresh", () => {
  test("discards results after the subscription changes", () => {
    const subscription = { kind: "metadata" as const, baseId, publicBaseId: "BASE01" };
    const ctx = { phase: "subscribed" as const, sessionToken: "first-session", subscription };

    expect(isWorkspaceAccessRefreshCurrent(ctx, subscription, "first-session")).toBe(true);
    expect(isWorkspaceAccessRefreshCurrent({ ...ctx, subscription: { ...subscription } }, subscription, "first-session")).toBe(false);
  });

  test("discards results after the session or phase changes", () => {
    const subscription = { kind: "metadata" as const, baseId, publicBaseId: "BASE01" };

    expect(
      isWorkspaceAccessRefreshCurrent({ phase: "subscribed", sessionToken: "new-session", subscription }, subscription, "old-session"),
    ).toBe(false);
    expect(
      isWorkspaceAccessRefreshCurrent({ phase: "closing", sessionToken: "old-session", subscription }, subscription, "old-session"),
    ).toBe(false);
  });
});

describe("Grids websocket cursor baseline", () => {
  test("preserves a client cursor without loading a new baseline", async () => {
    let latestCalls = 0;
    const cursor = await resolveWorkspaceEventCursor("7-4", async () => {
      latestCalls++;
      return "9-1";
    });

    expect(cursor).toBe("7-4");
    expect(latestCalls).toBe(0);
  });

  test("uses the latest cursor or the empty-stream baseline", async () => {
    expect(await resolveWorkspaceEventCursor(null, async () => "9-1")).toBe("9-1");
    expect(await resolveWorkspaceEventCursor(undefined, async () => null)).toBe("0-0");
  });
});

describe("Grids websocket server sessions", () => {
  test("localizes protocol presentation without changing stable error codes", async () => {
    const socket = testSocket();
    const session = workspaceSession(null, {}, "de-CH");
    session.open(socket.socket);
    session.message("{");
    await session.drain();

    expect(socket.messages).toEqual([
      { type: "grids.records.error", payload: { code: "invalid_json", message: "Ungültige JSON-Nutzlast" } },
    ]);
    expect(socket.closes).toEqual([{ code: 1008, reason: "invalid_json" }]);
  });

  test("closes malformed, non-text, oversized, and invalid subscription messages terminally", async () => {
    const cases: unknown[] = [
      "{",
      new Uint8Array([1, 2, 3]),
      "x".repeat(16_001),
      JSON.stringify({ type: "grids.metadata.subscribe", payload: { baseId: "not-a-uuid" } }),
    ];

    for (const message of cases) {
      const socket = testSocket();
      const session = workspaceSession(null);
      session.open(socket.socket);
      session.message(message);
      await session.drain();
      expect(socket.closes).toHaveLength(1);
      expect(socket.closes[0]?.code).toBe(1008);
      expect(socket.messages[0]?.type).toBe("grids.records.error");
    }
  });

  test("preserves metadata access errors and does not start a denied stream", async () => {
    let streamCalls = 0;
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateBaseAccess: async () => ({ ok: false, code: "access_denied", message: "Access denied" }),
      metadataEvents: (() => {
        streamCalls++;
        return (async function* () {})();
      }) as never,
    });
    session.open(socket.socket);
    session.message(metadataSubscribe());
    await session.drain();

    expect(streamCalls).toBe(0);
    expect(socket.messages).toEqual([{ type: "grids.metadata.error", payload: { code: "access_denied", message: "Access denied" } }]);
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
  });

  test("reports initial workflow access failures on the workflow channel", async () => {
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateWorkflowAccess: async () => ({ ok: false, code: "access_denied", message: "Access denied" }),
    });
    session.open(socket.socket);
    session.message(workflowSubscribe());
    await session.drain();

    expect(socket.messages).toEqual([{ type: "grids.workflow-runs.error", payload: { code: "access_denied", message: "Access denied" } }]);
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
  });

  test("delivers accepted events and terminates after periodic permission revocation", async () => {
    const refresh: { current: (() => void) | null } = { current: null };
    let readable = true;
    let canceled = 0;
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateBaseAccess: async () => ({ ok: true, baseId }),
      evaluateSubscriptionAccess: async () =>
        readable ? { ok: true, baseId } : { ok: false, code: "access_denied", message: "Access denied" },
      latestMetadataCursor: async () => "9-0",
      metadataEvents: async function* ({ signal }: { signal?: AbortSignal }) {
        yield {
          cursor: "9-1",
          data: {
            v: 1,
            type: "table.updated",
            baseId,
            resource: { kind: "table", id: "22222222-2222-4222-8222-222222222222" },
            actorId: null,
            occurredAt: "2026-01-01T00:00:00.000Z",
          },
        };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      } as never,
      schedule: ((callback: () => void) => {
        refresh.current = callback;
        return 1;
      }) as never,
      cancel: (() => {
        canceled++;
      }) as never,
    });
    session.open(socket.socket);
    session.message(metadataSubscribe({ fromCursor: null }));
    await session.drain();
    await Bun.sleep(0);

    expect(socket.messages.slice(0, 2).map((message) => message.type)).toEqual(["grids.metadata.ready", "grids.metadata.event"]);
    expect(socket.messages[0]?.payload?.cursor).toBe("9-0");
    expect(socket.messages[1]?.payload?.cursor).toBe("9-1");

    readable = false;
    if (!refresh.current) throw new Error("Expected access refresh callback");
    refresh.current();
    await Bun.sleep(0);
    expect(socket.messages.at(-1)).toEqual({
      type: "grids.metadata.revoked",
      payload: { code: "access_denied", message: "Access was revoked", baseId: publicBaseId },
    });
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
    expect(canceled).toBe(1);
  });

  test("localizes access revocation while preserving its protocol code", async () => {
    const refresh: { current: (() => void) | null } = { current: null };
    const socket = testSocket();
    const session = workspaceSession(
      "session",
      {
        evaluateBaseAccess: async () => ({ ok: true, baseId }),
        evaluateSubscriptionAccess: async () => ({ ok: false, code: "access_denied", message: "ignored" }),
        latestMetadataCursor: async () => "1-0",
        metadataEvents: async function* ({ signal }: { signal?: AbortSignal }) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        } as never,
        schedule: ((callback: () => void) => {
          refresh.current = callback;
          return 1;
        }) as never,
        cancel: (() => undefined) as never,
      },
      "de-DE",
    );
    session.open(socket.socket);
    session.message(metadataSubscribe());
    await session.drain();

    if (!refresh.current) throw new Error("Expected access refresh callback");
    refresh.current();
    await Bun.sleep(0);

    expect(socket.messages.at(-1)).toEqual({
      type: "grids.metadata.revoked",
      payload: { code: "access_denied", message: "Der Zugriff wurde entzogen", baseId: publicBaseId },
    });
    expect(socket.closes).toEqual([{ code: 1008, reason: "access_denied" }]);
  });

  test("delivers metadata events for every resource in a readable base", async () => {
    const tableIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateBaseAccess: async () => ({ ok: true, baseId }),
      evaluateSubscriptionAccess: async () => ({ ok: true, baseId }),
      latestMetadataCursor: async () => "9-0",
      metadataEvents: async function* ({ signal }: { signal?: AbortSignal }) {
        for (let index = 0; index < tableIds.length; index++) {
          yield {
            cursor: `9-${index + 1}`,
            data: {
              v: 1,
              type: "table.updated",
              baseId,
              resource: { kind: "table", id: tableIds[index], tableId: tableIds[index] },
              actorId: null,
              occurredAt: "2026-01-01T00:00:00.000Z",
            },
          };
        }
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      } as never,
      schedule: (() => 1) as never,
      cancel: (() => undefined) as never,
    });
    session.open(socket.socket);
    session.message(metadataSubscribe({ fromCursor: null }));
    await session.drain();
    await Bun.sleep(0);

    expect(socket.messages.filter((message) => message.type === "grids.metadata.event")).toHaveLength(2);
    expect(socket.messages.filter((message) => message.type === "grids.metadata.event").map((message) => message.payload?.cursor)).toEqual([
      "9-1",
      "9-2",
    ]);
    await session.close();
  });

  test("delivers full record event payloads for readable bases", async () => {
    const socket = testSocket();
    const access = { ok: true as const, baseId, tableId };
    const session = workspaceSession("session", {
      evaluateRecordsAccess: async () => access,
      evaluateSubscriptionAccess: async () => access,
      latestRecordCursor: async () => "1-0",
      recordEvents: async function* ({ signal }: { signal?: AbortSignal }) {
        yield {
          cursor: "1-1",
          data: {
            v: 1,
            type: "record.updated",
            baseId,
            tableId,
            recordId,
            version: 2,
            changedFieldIds: [],
            actorId: null,
            occurredAt: "2026-01-01T00:00:00.000Z",
          },
        };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      } as never,
      schedule: (() => 1) as never,
      cancel: (() => undefined) as never,
    });

    session.open(socket.socket);
    session.message(recordsSubscribe());
    await session.drain();
    await Bun.sleep(0);

    const eventMessage = socket.messages.find((message) => message.type === "grids.records.event");
    expect(eventMessage?.payload?.cursor).toBe("1-1");
    expect(eventMessage?.payload?.tableId).toBe(publicTableId);
    expect(eventMessage?.payload?.event).toMatchObject({ recordId: publicRecordId, version: 2 });
    await session.close();
  });

  test("aborts replaced and closed streams without emitting a terminal stream error", async () => {
    const signals: AbortSignal[] = [];
    let canceled = 0;
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateBaseAccess: async () => ({ ok: true, baseId }),
      latestMetadataCursor: async () => "1-0",
      metadataEvents: (({ signal }: { signal?: AbortSignal }) => {
        if (signal) signals.push(signal);
        return (async function* () {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        })();
      }) as never,
      schedule: (() => 1) as never,
      cancel: (() => {
        canceled++;
      }) as never,
    });
    session.open(socket.socket);
    session.message(metadataSubscribe());
    await session.drain();
    session.message(metadataSubscribe({ fromCursor: "2-0" }));
    await session.drain();

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(socket.messages.filter((message) => message.type === "grids.metadata.ready")).toHaveLength(2);
    await session.close();
    expect(signals[1]?.aborted).toBe(true);
    expect(canceled).toBe(2);
    expect(socket.closes).toEqual([]);
  });

  test("bounds queued client work and closes with a retryable backpressure code", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const socket = testSocket();
    const session = workspaceSession("session", {
      evaluateBaseAccess: async () => {
        await blocked;
        return { ok: true, baseId };
      },
    });
    session.open(socket.socket);
    for (let index = 0; index < 9; index++) session.message(metadataSubscribe());
    expect(socket.closes).toEqual([{ code: 1012, reason: "backpressure" }]);
    release();
    await session.drain();
  });
});
