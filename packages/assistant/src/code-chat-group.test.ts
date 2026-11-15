import { expect, test } from "bun:test";
import type { CapabilityInvocation } from "@k2b/cloud/capabilities";
import type { z } from "zod";
import { type CodeChatList, codeChatGroup, loadCodeChatGroup } from "./code-chat-group";
import type { CodeQueryInvoke } from "./code-summary";
import { codeVersionCardAnchor } from "./frontend/code-version-anchor";

const item = (state: CodeChatList["items"][number]["state"], attention = false) => ({
  codeId: `c_${state.padEnd(8, "x")}`,
  title: `Code ${state}`,
  state,
  attention,
  anchor: `tool-${state}`,
});

test("every state of a chat's Code has its word from 3d and a colour, and a click jumps to its card", () => {
  const states = ["on", "paused", "ready", "waiting", "expired", "changes", "revising", "rejected"] as const;
  const group = codeChatGroup({ count: states.length, items: states.map((state) => item(state, state === "ready")) }, "de")!;
  expect(group).toMatchObject({ key: "automations", label: "Automationen", count: 8, allHref: "/app/assistant?code=1" });
  expect(group.rows.map((row) => [row.word, row.tone ?? null])).toEqual([
    ["Eingeschaltet", "ok"],
    ["Pausiert", "warn"],
    ["Bereit, noch aus", "ai"],
    ["Wartet auf Admin", "warn"],
    ["Freigabe abgelaufen", "warn"],
    ["Änderungen angefordert", "warn"],
    ["Gustav überarbeitet", "ai"],
    ["Abgelehnt", null],
  ]);
  expect(group.rows[2]).toMatchObject({
    attention: true,
    anchor: "tool-ready",
    action: { href: "/app/assistant/code/c_readyxxx", label: "Code-Seite von „Code ready“ öffnen" },
  });
  expect(group.rows.filter((row) => row.attention)).toHaveLength(1);
});

/** Core's answer, parsed through the caller's own schema like the real transport; undefined means Core refused. */
const fakeCore = (answer: unknown) => {
  const calls: unknown[] = [];
  const invoke: CodeQueryInvoke = async <T extends z.ZodType>(invocation: CapabilityInvocation, schema: T) => {
    calls.push(invocation);
    if (answer === undefined) return { ok: false as const, error: { code: "FORBIDDEN", message: "refused", status: 403 } };
    return { ok: true as const, data: { data: schema.parse(answer) } };
  };
  return { invoke, calls };
};

test("a chat without readable Code has no group, also when Core refuses or cannot answer", async () => {
  const chat = "00000000-0000-4000-8000-000000000001";
  expect(codeChatGroup({ count: 0, items: [] }, "de")).toBeNull();
  // Core answers only the chat's owner, and only with Code they may read: a reader without the right gets nothing.
  const empty = fakeCore({ count: 0, items: [] });
  expect(await loadCodeChatGroup(empty.invoke, chat, "de")).toBeNull();
  expect(empty.calls).toEqual([{ appId: "core", capabilityId: "code.chat.list", kind: "query", input: { conversationId: chat } }]);
  expect(await loadCodeChatGroup(fakeCore(undefined).invoke, chat, "de")).toBeNull();
  const offline: CodeQueryInvoke = async () => {
    throw new Error("offline");
  };
  expect(await loadCodeChatGroup(offline, chat, "de")).toBeNull();
  const one = fakeCore({ count: 1, items: [item("waiting")] });
  expect((await loadCodeChatGroup(one.invoke, chat, "en"))?.rows.map((row) => row.word)).toEqual(["Waiting for admin"]);
});

test("the anchor Core returns is the one the version card carries in the chat", () => {
  // core.code.chat.list answers `code-version-<versionId>` (chat-list.integration.test.ts); a row click lands on this card.
  expect(codeVersionCardAnchor("281fc42a-2d41-4822-a28b-e9e026f68ec1")).toBe("code-version-281fc42a-2d41-4822-a28b-e9e026f68ec1");
});
