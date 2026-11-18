import { expect, test } from "bun:test";
import { assistantArchiveBlocker } from "./archive-blocker";

test("a chat names what keeps it from being archived: a running response or a decision it waits for (#108)", () => {
  // The open chat answers from its live turn, also when its listed state is older.
  expect(assistantArchiveBlocker({ runStatus: "idle" }, { status: "running" })).toBe("running");
  expect(assistantArchiveBlocker({ runStatus: "idle" }, { status: "waiting_for_action" })).toBe("waiting");
  // Every other chat answers from its last known run state.
  expect(assistantArchiveBlocker({ runStatus: "queued" }, null)).toBe("running");
  expect(assistantArchiveBlocker({ runStatus: "running" }, null)).toBe("running");
  expect(assistantArchiveBlocker({ runStatus: "needs_attention" }, null)).toBe("waiting");
  expect(assistantArchiveBlocker({ runStatus: "waiting_for_browser" }, null)).toBe("waiting");
  expect(assistantArchiveBlocker({ runStatus: "idle" }, null)).toBeNull();
  expect(assistantArchiveBlocker({ runStatus: "failed" }, null)).toBeNull();
});
