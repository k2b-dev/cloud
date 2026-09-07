import { describe, expect, test } from "bun:test";
import { parseSpaceLiveServerMessage, SPACE_LIVE_WS_TYPE, SpaceLiveClientMessageSchema, toPublicSpaceEvent } from "./live-events";

const SPACE_ID = "Space1";
const ITEM_ID = "Item01";

describe("Spaces live event protocol", () => {
  test("accepts legacy subscription cursors for resync but rejects them in server events", () => {
    expect(
      SpaceLiveClientMessageSchema.safeParse({
        type: SPACE_LIVE_WS_TYPE.subscribe,
        payload: { spaceId: SPACE_ID, fromCursor: "123-4" },
      }).success,
    ).toBe(true);
    expect(
      parseSpaceLiveServerMessage(
        JSON.stringify({
          type: SPACE_LIVE_WS_TYPE.ready,
          payload: { spaceId: SPACE_ID, cursor: "123-4" },
        }),
      ),
    ).toBeNull();
  });

  test("validates subscriptions with optional replay cursors", () => {
    expect(
      SpaceLiveClientMessageSchema.safeParse({
        type: SPACE_LIVE_WS_TYPE.subscribe,
        payload: { spaceId: SPACE_ID, fromCursor: "s6t.test.3" },
      }).success,
    ).toBeTrue();
    expect(
      SpaceLiveClientMessageSchema.safeParse({
        type: SPACE_LIVE_WS_TYPE.subscribe,
        payload: { spaceId: SPACE_ID, fromCursor: "invalid" },
      }).success,
    ).toBeFalse();
    expect(
      SpaceLiveClientMessageSchema.safeParse({
        type: SPACE_LIVE_WS_TYPE.subscribe,
        payload: { spaceId: "865c713f-4f1c-43a1-a5e7-35e8e70eaec5", fromCursor: null },
      }).success,
    ).toBeFalse();
  });

  test("parses typed events and rejects malformed payloads", () => {
    const message = parseSpaceLiveServerMessage(
      JSON.stringify({
        type: SPACE_LIVE_WS_TYPE.event,
        payload: {
          spaceId: SPACE_ID,
          cursor: "s6t.test.1",
          event: {
            type: "item.updated",
            spaceId: SPACE_ID,
            itemId: ITEM_ID,
            at: "2026-07-16T20:00:00.000Z",
          },
        },
      }),
    );

    expect(message?.type).toBe(SPACE_LIVE_WS_TYPE.event);
    if (message?.type === SPACE_LIVE_WS_TYPE.event)
      expect(message.payload.event).toEqual({ type: "item.updated", spaceId: SPACE_ID, itemId: ITEM_ID, at: "2026-07-16T20:00:00.000Z" });
    expect(parseSpaceLiveServerMessage("not-json")).toBeNull();
    expect(parseSpaceLiveServerMessage(JSON.stringify({ type: SPACE_LIVE_WS_TYPE.event, payload: {} }))).toBeNull();
  });

  test("carries Space metadata and access invalidation events", () => {
    for (const type of ["space.updated", "space.deleted", "access.changed"] as const) {
      expect(
        parseSpaceLiveServerMessage(
          JSON.stringify({
            type: SPACE_LIVE_WS_TYPE.event,
            payload: { spaceId: SPACE_ID, cursor: "s6t.test.1", event: { type, spaceId: SPACE_ID, at: "2026-07-21T10:00:00.000Z" } },
          }),
        ),
      ).not.toBeNull();
    }
  });

  test("projects internal events without exposing resource UUIDs", () => {
    expect(
      toPublicSpaceEvent(
        {
          type: "item.updated",
          spaceId: "865c713f-4f1c-43a1-a5e7-35e8e70eaec5",
          itemId: "965c713f-4f1c-43a1-a5e7-35e8e70eaec5",
          at: "2026-07-16T20:00:00.000Z",
        },
        { spaceId: SPACE_ID, itemId: ITEM_ID },
      ),
    ).toEqual({ type: "item.updated", spaceId: SPACE_ID, itemId: ITEM_ID, at: "2026-07-16T20:00:00.000Z" });
  });
});
