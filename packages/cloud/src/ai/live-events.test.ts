import { describe, expect, test } from "bun:test";
import { parseAiSse } from "./client/transport";
import { AiLiveClientMessageSchema, type AiLiveServerMessage, aiTurnEventMessage, parseAiLiveServerMessage } from "./live-events";
import type { AiStreamEvent } from "./protocol";
import { encodeSseEvent } from "./stream";

describe("AI multiplexed live protocol", () => {
  test("accepts strict turn subscribe and unsubscribe messages", () => {
    expect(AiLiveClientMessageSchema.parse({ type: "ai.turn.subscribe", payload: { conversationId: "Chat01" } })).toEqual({
      type: "ai.turn.subscribe",
      payload: { conversationId: "Chat01" },
    });
    expect(AiLiveClientMessageSchema.parse({ type: "ai.turn.unsubscribe", payload: { conversationId: "Chat01" } })).toEqual({
      type: "ai.turn.unsubscribe",
      payload: { conversationId: "Chat01" },
    });
    expect(
      AiLiveClientMessageSchema.safeParse({
        type: "ai.turn.subscribe",
        payload: { conversationId: "internal-uuid", extra: true },
      }).success,
    ).toBe(false);
  });

  test("accepts public turn events and rejects mismatched conversation envelopes", () => {
    const message = {
      type: "ai.turn.event",
      payload: {
        conversationId: "Chat01",
        event: {
          v: 1,
          type: "turn_finished",
          conversationId: "Chat01",
          turnId: "Turn01",
          attempt: 1,
          seq: 4,
          status: "completed",
          error: null,
        },
      },
    } satisfies AiLiveServerMessage;
    expect(parseAiLiveServerMessage(JSON.stringify(message))).toEqual(message);
    expect(
      parseAiLiveServerMessage(
        JSON.stringify({
          ...message,
          payload: { ...message.payload, event: { ...message.payload.event, conversationId: "Chat02" } },
        }),
      ),
    ).toBeNull();
  });

  test("requires a public conversation id in state snapshots", () => {
    expect(
      parseAiLiveServerMessage(
        JSON.stringify({
          type: "ai.turn.event",
          payload: {
            conversationId: "Chat01",
            event: { type: "state", conversation: { id: "internal-uuid" }, messages: [], activeTurn: null },
          },
        }),
      ),
    ).toBeNull();
  });

  test("rejects incomplete turn event variants", () => {
    expect(
      parseAiLiveServerMessage(
        JSON.stringify({
          type: "ai.turn.event",
          payload: {
            conversationId: "Chat01",
            event: {
              v: 1,
              type: "block_delta",
              conversationId: "Chat01",
              turnId: "Turn01",
              attempt: 1,
              seq: 2,
              blockId: "text-1",
              blockKind: "text",
            },
          },
        }),
      ),
    ).toBeNull();
  });

  test("keeps SSE and WebSocket event ordering and payloads equivalent", async () => {
    const events: AiStreamEvent[] = [
      {
        v: 1,
        type: "turn_started",
        conversationId: "Chat01",
        turnId: "Turn01",
        attempt: 1,
        seq: 1,
        modelProfileId: "default",
        providerModel: "provider/model",
      },
      {
        v: 1,
        type: "block_delta",
        conversationId: "Chat01",
        turnId: "Turn01",
        attempt: 1,
        seq: 2,
        blockId: "text-1",
        blockKind: "text",
        delta: "Hello",
      },
    ];
    const decoder = new TextDecoder();
    const sse = new Response(events.map((event) => decoder.decode(encodeSseEvent(event))).join(""));
    const sseEvents: AiStreamEvent[] = [];
    for await (const event of parseAiSse(sse, new AbortController().signal)) sseEvents.push(event);
    const wsEvents = events.map((event) => {
      const message = parseAiLiveServerMessage(JSON.stringify(aiTurnEventMessage("Chat01", event)));
      if (message?.type !== "ai.turn.event") throw new Error("Expected a turn event");
      return message.payload.event;
    });

    expect(wsEvents).toEqual(sseEvents);
  });
});
