import { describe, expect, test } from "bun:test";
import { buildMailConversationTimeline } from "./mail-conversation-timeline";

const message = (id: string, internalDate: string) => ({ id, internalDate });
const note = (id: string, createdAt: string) => ({ id, createdAt });

describe("mail conversation timeline", () => {
  test("reads oldest first with the newest message at the bottom and each note at its time", () => {
    const timeline = buildMailConversationTimeline(
      [message("newest", "2026-11-11T10:00:00.000Z"), message("oldest", "2026-11-09T10:00:00.000Z")],
      [note("between", "2026-11-10T16:20:00.000Z")],
    );
    expect(timeline.map((item) => item.id)).toEqual(["message:oldest", "note:between", "message:newest"]);
  });

  test("keeps a message before a note written at the same moment, and a stable order for equal times", () => {
    const at = "2026-11-10T10:00:00.000Z";
    const timeline = buildMailConversationTimeline([message("b", at), message("a", at)], [note("n", at)]);
    expect(timeline.map((item) => item.id)).toEqual(["message:a", "message:b", "note:n"]);
  });

  test("shows a note written before the first message first, and works without notes", () => {
    expect(
      buildMailConversationTimeline([message("m", "2026-11-10T10:00:00.000Z")], [note("early", "2026-11-01T10:00:00.000Z")]).map(
        (item) => item.kind,
      ),
    ).toEqual(["note", "message"]);
    expect(buildMailConversationTimeline([message("m", "2026-11-10T10:00:00.000Z")], []).map((item) => item.kind)).toEqual(["message"]);
  });
});
