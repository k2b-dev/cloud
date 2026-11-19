import { describe, expect, test } from "bun:test";
import type { AiOpenQuestion, AiTurnBlock } from "@k2b/cloud/ai";
import { waitingQuestionsView } from "./waiting-questions";

const question = (id: string, conversationId: string, createdAt: string, anchor = `tool-${id}`): AiOpenQuestion => ({
  kind: "approval",
  id,
  conversationId,
  conversationTitle: conversationId === "here01" ? "October maintenance" : "Team Ops planning",
  anchor,
  short: `Question ${id}`,
  app: { name: "Mail", icon: "ti ti-mail" },
  createdAt,
});
const tool = (id: string, status: Extract<AiTurnBlock, { kind: "tool" }>["status"]): AiTurnBlock => ({
  id,
  kind: "tool",
  callId: id.replace(/^tool-/, ""),
  name: "mail.send",
  status,
});

const mail = question("mail", "here01", "2026-10-16T09:02:00.000Z");
const retro = question("retro", "here01", "2026-10-16T09:01:00.000Z");
const routine = question("routine", "other1", "2026-10-16T08:00:00.000Z");
const newest = question("newest", "other1", "2026-10-16T10:00:00.000Z");

describe("waitingQuestionsView", () => {
  test("lists this chat's questions first in the order they were asked, then the other chats'", () => {
    const view = waitingQuestionsView({
      questions: { items: [newest, mail, retro, routine], count: 4 },
      conversationId: "here01",
      local: [tool("tool-retro", "awaiting_approval"), tool("tool-mail", "awaiting_approval")],
    });
    expect(view.entries.map((entry) => entry.id)).toEqual(["retro", "mail", "routine", "newest"]);
    expect(view).toMatchObject({ total: 4, more: 0, onlyHere: null });
  });

  test("a question answered here leaves at once, before the server's read catches up", () => {
    const view = waitingQuestionsView({
      questions: { items: [mail, retro, routine], count: 3 },
      conversationId: "here01",
      local: [tool("tool-mail", "running"), tool("tool-retro", "awaiting_approval")],
    });
    expect(view.entries.map((entry) => entry.id)).toEqual(["retro", "routine"]);
    expect(view.total).toBe(2);
  });

  test("one question, here, shows the strip only while its answers are out of view", () => {
    expect(
      waitingQuestionsView({
        questions: { items: [mail], count: 1 },
        conversationId: "here01",
        local: [tool("tool-mail", "awaiting_approval")],
      }).onlyHere,
    ).toBe("tool-mail");
    // One elsewhere is never in view here; a second one here always shows both.
    expect(waitingQuestionsView({ questions: { items: [routine], count: 1 }, conversationId: "here01", local: [] }).onlyHere).toBeNull();
    expect(
      waitingQuestionsView({
        questions: { items: [mail, retro], count: 2 },
        conversationId: "here01",
        local: [tool("tool-mail", "awaiting_approval"), tool("tool-retro", "awaiting_approval")],
      }).onlyHere,
    ).toBeNull();
  });

  // v12 3m, P4 Rundgang f02: "the only entry of this chat" – entries of other chats do not keep it in the row.
  test("this chat's only entry leaves the row while in view, even when other chats wait", () => {
    const view = waitingQuestionsView({
      questions: { items: [mail, routine], count: 2 },
      conversationId: "here01",
      local: [tool("tool-mail", "awaiting_approval")],
    });
    expect(view).toMatchObject({ total: 2, onlyHere: "tool-mail", onlyHereAtEnd: true });
  });

  test("a version to switch on in this chat counts as its only entry once the chat is loaded", () => {
    const version: AiOpenQuestion = { ...mail, kind: "code_activate", anchor: "code-version-v2", short: "Version 2 einschalten" };
    const loaded = waitingQuestionsView({
      questions: { items: [version, routine, newest], count: 3 },
      conversationId: "here01",
      local: [],
    });
    // Its card may stand anywhere in the chat: it leaves the row only once the chat shows it.
    expect(loaded).toMatchObject({ total: 3, onlyHere: "code-version-v2", onlyHereAtEnd: false });
    // Not yet loaded, the row shows it until the card does.
    expect(
      waitingQuestionsView({ questions: { items: [version, routine], count: 2 }, conversationId: "here01", local: null }).onlyHere,
    ).toBeNull();
    // Elsewhere it is never left out.
    expect(waitingQuestionsView({ questions: { items: [version], count: 1 }, conversationId: "other1", local: [] }).onlyHere).toBeNull();
  });

  test("a question that just opened here keeps the strip's place before the read lists it", () => {
    const view = waitingQuestionsView({
      questions: { items: [], count: 0 },
      conversationId: "here01",
      local: [tool("tool-mail", "awaiting_approval")],
    });
    expect(view).toEqual({ attention: [], entries: [], more: 0, total: 1, onlyHere: "tool-mail", onlyHereAtEnd: true });
  });

  test("while the chat is not loaded, the server's read decides, and the row shows until the card does", () => {
    const view = waitingQuestionsView({ questions: { items: [mail], count: 1 }, conversationId: "here01", local: null });
    expect(view).toEqual({ attention: [], entries: [mail], more: 0, total: 1, onlyHere: null, onlyHereAtEnd: false });
  });

  test("a question this chat does not show, such as one without its card, keeps the row visible", () => {
    const view = waitingQuestionsView({ questions: { items: [mail], count: 1 }, conversationId: "here01", local: [] });
    expect(view).toEqual({ attention: [], entries: [mail], more: 0, total: 1, onlyHere: null, onlyHereAtEnd: false });
  });

  test("questions beyond the bounded read are counted as more", () => {
    const view = waitingQuestionsView({ questions: { items: [routine], count: 23 }, conversationId: null, local: null });
    expect(view).toMatchObject({ more: 22, total: 23, onlyHere: null });
  });

  test("a completed submission tool does not resolve a Code next step or an operational source", () => {
    const version: AiOpenQuestion = { ...mail, kind: "code_activate", short: "Version 5 einschalten" };
    const attention: AiOpenQuestion = {
      ...routine,
      kind: "code_attention",
      conversationId: "",
      anchor: "",
      href: "/app/assistant/code/c_fixture",
    };
    const view = waitingQuestionsView({
      questions: { items: [version, attention], count: 2 },
      conversationId: "here01",
      local: [tool(mail.anchor, "completed")],
    });
    expect(view.entries).toEqual([version, attention]);
    expect(view.total).toBe(2);
    expect(
      waitingQuestionsView({ questions: { items: [], count: 0 }, conversationId: "here01", local: [tool(mail.anchor, "completed")] }).total,
    ).toBe(0);
  });

  test("no question, no strip", () => {
    expect(waitingQuestionsView({ questions: { items: [], count: 0 }, conversationId: "here01", local: [] }).total).toBe(0);
  });
});

describe("what stopped in this chat", () => {
  const stopped = { key: "task:t1", kind: "routine" as const, short: "Routine needs attention", open: () => {} };
  const mail = question("mail", "here01", "2026-10-17T12:00:00.000Z");

  test("comes first, counts, and keeps the row visible beside the only card here", () => {
    const view = waitingQuestionsView({
      questions: { items: [mail], count: 1 },
      conversationId: "here01",
      local: [tool("tool-mail", "awaiting_approval")],
      attention: [stopped],
    });
    expect(view).toEqual({ attention: [stopped], entries: [mail], more: 0, total: 2, onlyHere: null, onlyHereAtEnd: false });
  });

  test("belongs to an open chat only", () => {
    const view = waitingQuestionsView({ questions: { items: [], count: 0 }, conversationId: null, local: null, attention: [stopped] });
    expect(view).toEqual({ attention: [], entries: [], more: 0, total: 0, onlyHere: null, onlyHereAtEnd: false });
  });
});
