import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { aiConversations } from "./store";
import * as stream from "./stream";
import { finishAiTurnAbort } from "./turn-abort";

const input = { conversationId: "11111111-1111-4111-8111-111111111111", turnId: "22222222-2222-4222-8222-222222222222" };
afterEach(() => mock.restore());

test("a live owner receives cancellation and keeps ownership of finalization", async () => {
  const publish = spyOn(stream, "publishAiTurnAbort").mockResolvedValue();
  const complete = spyOn(aiConversations, "completeTurn");
  await finishAiTurnAbort(input, { found: true, status: "running", ownerless: false });
  expect(publish).toHaveBeenCalledWith(input);
  expect(complete).not.toHaveBeenCalled();
});

test("an ownerless routine is finalized even when abort fanout fails, without a foreground wire event", async () => {
  spyOn(stream, "publishAiTurnAbort").mockRejectedValue(new Error("Fanout unavailable"));
  const complete = spyOn(aiConversations, "completeTurn").mockResolvedValue("completed");
  spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Save invoices",
    toolSource: { kind: "none" },
    background: { taskId: "task01", occurrenceId: "run001", context: [] },
  });
  const wire = spyOn(stream, "publishAiWireEvent").mockResolvedValue();
  await finishAiTurnAbort(input, { found: true, status: "queued", ownerless: true });
  expect(complete).toHaveBeenCalledWith({ ...input, status: "aborted", error: null });
  expect(wire).not.toHaveBeenCalled();
});

test("foreground abort preserves the captured attempt and next wire sequence", async () => {
  spyOn(stream, "publishAiTurnAbort").mockResolvedValue();
  spyOn(aiConversations, "completeTurn").mockResolvedValue("completed");
  spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({ kind: "chat", input: "Read invoices", toolSource: { kind: "none" } });
  const wire = spyOn(stream, "publishAiWireEvent").mockResolvedValue();
  await finishAiTurnAbort(
    input,
    { found: true, status: "running", ownerless: true },
    {
      turn: {
        id: input.turnId,
        shortId: "turn01",
        conversationId: input.conversationId,
        status: "running",
        attempt: 3,
        modelProfileId: "test",
        createdAt: "2026-04-07T09:00:00.000Z",
        completedAt: null,
        error: null,
      },
      liveSeq: 8,
      liveBlocks: [],
      actionWaitMs: 0,
      waitingSince: null,
    },
  );
  expect(wire).toHaveBeenCalledWith({ v: 1, ...input, attempt: 3, seq: 9, type: "turn_finished", status: "aborted", error: null });
});
