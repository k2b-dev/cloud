import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { buildAiMessageTimeline } from "../timeline";
import type { AiStoredMessage } from "../types";
import type { AiWakeup, AiWakeupEvent } from "../wakeup-contracts";
import { collectAiWakeupLines } from "./wakeup-plan";

const AT = "2026-11-16T15:00:00.000Z";
const stored = (
  id: string,
  seq: number,
  message: Message,
  loopId: string | null,
  meta: AiStoredMessage["meta"] = null,
): AiStoredMessage => ({
  id,
  shortId: id,
  conversationId: "conversation-1",
  seq,
  kind: "message",
  message,
  loopId,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta,
  createdAt: AT,
});
const alarm = (patch: Partial<AiWakeup> = {}): AiWakeup => ({
  id: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
  at: AT,
  cron: null,
  timezone: "Europe/Berlin",
  endsAt: null,
  note: "Antwort von Lena Vogt prüfen",
  noteSource: { kind: "person", userId: "6f9619ff-8b86-4d11-b42d-00c04fc96400" },
  snoozes: 0,
  status: "active",
  missedReason: null,
  revision: 0,
  rhythm: "Einmalig",
  ...patch,
});
const fact = (id: string, seq: number, kind: AiWakeupEvent["kind"], wakeup = alarm()) =>
  stored(id, seq, { role: "assistant", content: [{ type: "text", text: "Wecker gestellt" }] }, null, {
    wakeupEvent: { id: `event-${id}`, kind, at: AT, wakeup },
  });
const user = (id: string, seq: number, loopId: string) => stored(id, seq, { role: "user", content: [{ type: "text", text: id }] }, loopId);
const call = (id: string, seq: number, loopId: string, name: string, args: Record<string, unknown>) =>
  stored(id, seq, { role: "assistant", content: [{ type: "tool_call", id: `call-${id}`, name, args }] }, loopId);
const result = (id: string, seq: number, loopId: string, name: string, value: unknown, isError = false) =>
  stored(id, seq, { role: "tool_result", callId: `call-${id.replace("-result", "")}`, name, result: value, isError }, loopId);
const answer = (id: string, seq: number, loopId: string) =>
  stored(id, seq, { role: "assistant", content: [{ type: "text", text: "Erledigt." }] }, loopId);

describe("alarm facts in the timeline", () => {
  test("a fact Gustav's tool wrote mid-turn stands after the turn's answer and never splits the turn", () => {
    const timeline = buildAiMessageTimeline([
      user("ask", 1, "turn-1"),
      call("set", 2, "turn-1", "wakeup_create", { at: AT, timezone: "Europe/Berlin", note: "Antwort prüfen" }),
      fact("created", 3, "created"),
      result("set-result", 4, "turn-1", "wakeup_create", alarm()),
      answer("done", 5, "turn-1"),
    ]);
    expect(timeline.map((item) => item.type)).toEqual(["user", "assistant", "wakeup"]);
    const line = timeline[2];
    expect(line?.type === "wakeup" && [line.loopId, line.after]).toEqual(["turn-1", "turn-1"]);
  });

  test("a fact after a finished turn stays where it is and belongs to no turn", () => {
    const timeline = buildAiMessageTimeline([user("ask", 1, "turn-1"), answer("done", 2, "turn-1"), fact("deleted", 3, "deleted")]);
    const line = timeline.at(-1);
    expect(line?.type === "wakeup" && [line.loopId, line.after]).toEqual([null, "turn-1"]);
  });
});

describe("alarm facts while a turn runs", () => {
  test("the person's own change during a turn moves to its end but stays the person's, so it strikes the line in place", () => {
    const timeline = buildAiMessageTimeline([
      fact("created", 1, "created"),
      user("ask", 2, "turn-2"),
      call("read", 3, "turn-2", "mail_search", { q: "Lena" }),
      fact("deleted", 4, "deleted"),
      result("read-result", 5, "turn-2", "mail_search", []),
      answer("done", 6, "turn-2"),
    ]);
    expect(timeline.map((item) => item.type)).toEqual(["wakeup", "user", "assistant", "wakeup"]);
    const lines = collectAiWakeupLines(timeline);
    expect([...lines.keys()]).toEqual(["created"]);
    expect(lines.get("created")?.plan?.deleted).toBe(true);
  });
});

describe("alarm lines", () => {
  test("only the newest line of an alarm is current, and it knows the alarm before it", () => {
    const later = alarm({ at: "2026-11-16T16:00:00.000Z", revision: 1 });
    const lines = collectAiWakeupLines(
      buildAiMessageTimeline([
        fact("created", 1, "created"),
        user("move", 2, "turn-2"),
        answer("moved", 3, "turn-2"),
        fact("updated", 4, "updated", later),
      ]),
    );
    expect(lines.get("created")?.plan?.latest).toBe(false);
    expect(lines.get("updated")?.plan).toMatchObject({ latest: true, previous: { at: AT } });
  });

  test("the person's deletion strikes the line through in place, and Undo right after it restores that line", () => {
    const deleted = collectAiWakeupLines(buildAiMessageTimeline([fact("created", 1, "created"), fact("deleted", 2, "deleted")]));
    expect([...deleted.keys()]).toEqual(["created"]);
    expect(deleted.get("created")?.plan?.deleted).toBe(true);

    const again = alarm({ id: "6f9619ff-8b86-4d11-b42d-00c04fc96401" });
    const undone = collectAiWakeupLines(
      buildAiMessageTimeline([fact("created", 1, "created"), fact("deleted", 2, "deleted"), fact("again", 3, "created", again)]),
    );
    expect([...undone.keys()]).toEqual(["created"]);
    expect(undone.get("created")?.plan).toMatchObject({ deleted: false, latest: true, event: { wakeup: { id: again.id } } });
  });

  test("Gustav's deletion in a turn keeps its own struck line at the end of that turn", () => {
    const lines = collectAiWakeupLines(
      buildAiMessageTimeline([
        fact("created", 1, "created"),
        user("ask", 2, "turn-2"),
        call("remove", 3, "turn-2", "wakeup_delete", { id: alarm().id, revision: 0 }),
        fact("deleted", 4, "deleted"),
        result("remove-result", 5, "turn-2", "wakeup_delete", alarm({ status: "deleted" })),
        answer("done", 6, "turn-2"),
      ]),
    );
    expect(lines.get("deleted")?.plan).toMatchObject({ latest: true, event: { kind: "deleted" } });
    expect(lines.get("created")?.plan?.latest).toBe(false);
  });

  test("a failure after an alarm Gustav did set still gets its line", () => {
    const failedAfter = collectAiWakeupLines(
      buildAiMessageTimeline([
        user("ask", 1, "turn-1"),
        call("first", 2, "turn-1", "wakeup_create", { at: AT, timezone: "Europe/Berlin", note: "Erstes" }),
        fact("created", 3, "created", alarm({ note: "Erstes" })),
        result("first-result", 4, "turn-1", "wakeup_create", alarm({ note: "Erstes" })),
        call("second", 5, "turn-1", "wakeup_create", { at: AT, timezone: "Europe/Berlin", note: "Zweites" }),
        result("second-result", 6, "turn-1", "wakeup_create", { error: "limit" }, true),
        answer("done", 7, "turn-1"),
      ]),
    );
    expect([...failedAfter.values()].find((line) => line.failed)?.failed?.input.note).toBe("Zweites");
  });

  test("an alarm Gustav could not set gets one line with its time and note, until an alarm with that note exists", () => {
    const tried = { at: AT, timezone: "Europe/Berlin", note: "Antwort prüfen" };
    const failed = [
      user("ask", 1, "turn-1"),
      call("set", 2, "turn-1", "wakeup_create", tried),
      result("set-result", 3, "turn-1", "wakeup_create", { error: "unavailable" }, true),
      answer("done", 4, "turn-1"),
    ];
    const lines = collectAiWakeupLines(buildAiMessageTimeline(failed));
    const key = [...lines.keys()].find((id) => id.endsWith(":wakeup-failed"));
    expect(key && lines.get(key)).toEqual({ failed: { input: { ...tried, cron: null, endsAt: null }, retried: false } });

    const retried = collectAiWakeupLines(buildAiMessageTimeline([...failed, fact("created", 5, "created", alarm({ note: tried.note }))]));
    expect([...retried.values()].find((line) => line.failed)?.failed?.retried).toBe(true);
  });
});
