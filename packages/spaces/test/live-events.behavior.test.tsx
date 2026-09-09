import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { subscribeToSpacesDataInvalidation } from "../src/frontend/[id]/_components/workspace/workspace-events";

type Controls = { markApplied: (cursor: string | null) => void; terminate: () => void };
type LiveOptions = {
  onMessage: (message: never, controls: Controls) => void;
  subscribe: (cursor: string | null) => unknown;
};

let options!: LiveOptions;
const transport = { connected: 0, disposed: 0, applied: [] as Array<string | null> };
if (!isServer) {
  mock.module("@k2b/cloud/browser/live", () => ({
    createLiveWebSocket: (next: LiveOptions) => {
      options = next;
      return {
        connect: () => (transport.connected += 1),
        dispose: () => (transport.disposed += 1),
        markApplied: (cursor: string | null) => transport.applied.push(cursor),
      };
    },
  }));
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe("Spaces live events", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("covers every ready domain before acknowledgement, ignores foreign events, and disposes the transport", async () => {
    transport.connected = 0;
    transport.disposed = 0;
    transport.applied.length = 0;
    const dom = createDomTestHarness();
    const covered: string[] = [];
    const stops = [
      subscribeToSpacesDataInvalidation(["view"], async () => void covered.push("view")),
      subscribeToSpacesDataInvalidation(["detail"], async () => void covered.push("detail")),
      subscribeToSpacesDataInvalidation(["wormholes"], async () => void covered.push("wormholes")),
    ];
    const { default: SpaceLiveEvents } = await import("../src/frontend/[id]/_components/workspace/SpaceLiveEvents.island");
    const dispose = render(() => createComponent(SpaceLiveEvents, { spaceId: "space-1", initialCursor: "1-0" }), dom.root);
    expect(transport.connected).toBe(1);
    expect(options.subscribe("1-0")).toEqual({ type: "spaces.live.subscribe", payload: { spaceId: "space-1", fromCursor: "1-0" } });

    options.onMessage({ type: "spaces.live.ready", payload: { spaceId: "space-1", cursor: "2-0" } } as never, {
      markApplied: () => undefined,
      terminate: () => undefined,
    });
    await flush();
    expect(covered.sort()).toEqual(["detail", "view", "wormholes"]);
    expect(transport.applied).toEqual(["2-0"]);

    options.onMessage(
      {
        type: "spaces.live.event",
        payload: { spaceId: "space-2", cursor: "3-0", event: { type: "item.updated", spaceId: "space-2", itemId: "item-1", at: "" } },
      } as never,
      { markApplied: () => undefined, terminate: () => undefined },
    );
    await flush();
    expect(transport.applied).toEqual(["2-0"]);

    dispose();
    expect(transport.disposed).toBe(1);
    stops.forEach((stop) => stop());
    dom.cleanup();
  });

  test("carries the changed item into detail invalidations", async () => {
    transport.applied.length = 0;
    const dom = createDomTestHarness();
    const detailItems: Array<string | null> = [];
    const stop = subscribeToSpacesDataInvalidation(["detail"], async (invalidation) => void detailItems.push(invalidation.itemId));
    const { default: SpaceLiveEvents } = await import("../src/frontend/[id]/_components/workspace/SpaceLiveEvents.island");
    const dispose = render(() => createComponent(SpaceLiveEvents, { spaceId: "space-1", initialCursor: "1-0" }), dom.root);

    options.onMessage(
      {
        type: "spaces.live.event",
        payload: { spaceId: "space-1", cursor: "4-0", event: { type: "item.updated", spaceId: "space-1", itemId: "Item01", at: "" } },
      } as never,
      { markApplied: () => undefined, terminate: () => undefined },
    );
    await flush();
    expect(detailItems).toEqual(["Item01"]);
    expect(transport.applied).toEqual(["4-0"]);

    dispose();
    stop();
    dom.cleanup();
  });
});
