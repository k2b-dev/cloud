import { describe, expect, mock, spyOn, test } from "bun:test";
import type { LiveWebSocketOptions } from "@valentinkolb/cloud/browser/live";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { subscribeToSpacesDataInvalidation } from "../src/frontend/[id]/_components/workspace/workspace-events";
import type { SpaceLiveServerMessage } from "../src/live-events";

describe("Spaces live owner disposal", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  test.each(["resolve", "reject"] as const)("late %s cannot acknowledge or reload after unmount", async (settlement) => {
    const dom = createDomTestHarness();
    let callbacks!: LiveWebSocketOptions<SpaceLiveServerMessage>;
    const markApplied = mock(() => {});
    const connectionDispose = mock(() => {});
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    mock.module("@valentinkolb/cloud/browser/live", () => ({
      createLiveWebSocket: (options: LiveWebSocketOptions<SpaceLiveServerMessage>) => {
        callbacks = options;
        return { connect: () => {}, markApplied, dispose: connectionDispose };
      },
    }));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const invalidate = mock(() => pending);
    const stop = subscribeToSpacesDataInvalidation(["detail"], invalidate);
    const { default: SpaceLiveEvents } = await import("../src/frontend/[id]/_components/workspace/SpaceLiveEvents.island");
    const dispose = render(() => createComponent(SpaceLiveEvents, { spaceId: "Space1", initialCursor: null }), dom.root);
    try {
      callbacks.onMessage(
        { type: "spaces.live.ready", payload: { spaceId: "Space1", cursor: "1-0" } },
        {
          markApplied,
          send: () => true,
          terminate: () => {},
        },
      );
      await Promise.resolve();
      callbacks.onMessage(
        { type: "spaces.live.ready", payload: { spaceId: "Space1", cursor: "2-0" } },
        {
          markApplied,
          send: () => true,
          terminate: () => {},
        },
      );
      dispose();
      expect(connectionDispose).toHaveBeenCalledTimes(1);
      if (settlement === "resolve") resolve();
      else reject(new Error("Query owner disposed"));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      callbacks.onFatal?.({ code: "disposed", message: "Late connection failure" });
      expect(markApplied).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      stop();
      reload.mockRestore();
      dom.cleanup();
    }
  });
});
