import { expect, mock, test } from "bun:test";
import type { AiStoredMessage } from "@k2b/cloud/ai";
import { createRoot, createSignal } from "solid-js";
import { createAssistantNextMessage } from "./next-message";

type Row = Pick<AiStoredMessage, "id" | "kind" | "message" | "suggestedNextMessage">;
const user: Row = { id: "m1", kind: "message", message: { role: "user", content: [{ type: "text", text: "Was hat Jana gefragt?" }] } };
const answer = (suggestion?: Row["suggestedNextMessage"]): Row => ({
  id: "m2",
  kind: "message",
  message: { role: "assistant", content: [{ type: "text", text: "Soll ich ihr antworten?" }] },
  ...(suggestion ? { suggestedNextMessage: suggestion } : {}),
});

const setup = (rows: Row[], dismiss: (conversationId: string, messageId: string) => Promise<unknown> = mock(async () => undefined)) =>
  createRoot((dispose) => {
    const [messages, setMessages] = createSignal<Row[]>(rows);
    const [blocked, setBlocked] = createSignal(false);
    const [conversationId, setConversationId] = createSignal<string | null>("c1");
    const failures: (() => void)[] = [];
    const next = createAssistantNextMessage({
      conversationId,
      messages,
      blocked,
      dismiss,
      onDismissFailed: (retry) => failures.push(retry),
    });
    return { next, setMessages, setBlocked, setConversationId, dismiss, failures, dispose };
  });

test("the latest answer's suggestion stands while nothing else waits", () => {
  const view = setup([user, answer({ text: "Ja, antworte Jana", dismissedAt: null })]);
  expect(view.next()?.text).toBe("Ja, antworte Jana");
  // A running answer, a waiting question or approval, or queued messages take its place.
  view.setBlocked(true);
  expect(view.next()).toBeUndefined();
  view.setBlocked(false);
  // A Project composer has no chat of its own.
  view.setConversationId(null);
  expect(view.next()).toBeUndefined();
  view.dispose();
});

test("no suggestion when the latest message is not an answer with one, or it was dismissed on the server", () => {
  expect(setup([user]).next()).toBeUndefined();
  expect(setup([answer()]).next()).toBeUndefined();
  expect(setup([answer({ text: "Ja", dismissedAt: null }), user]).next()).toBeUndefined();
  expect(setup([{ ...answer({ text: "Ja", dismissedAt: null }), kind: "summary" }]).next()).toBeUndefined();
  expect(setup([answer({ text: "Ja", dismissedAt: "2026-11-14T20:00:00Z" })]).next()).toBeUndefined();
});

test("Escape hides it at once and records the dismissal; a failed record says so and can try again", async () => {
  let fail = true;
  const dismiss = mock(async (_conversationId: string, _messageId: string): Promise<unknown> => {
    if (fail) throw new Error("offline");
    return undefined;
  });
  const view = setup([user, answer({ text: "Ja, antworte Jana", dismissedAt: null })], dismiss);
  view.next()!.onDismiss();
  expect(view.next()).toBeUndefined();
  expect(dismiss.mock.calls).toEqual([["c1", "m2"]]);
  await Promise.resolve();
  await Promise.resolve();
  // The person already set it aside, so it stays hidden; the failure is reported with a way to try again.
  expect(view.next()).toBeUndefined();
  expect(view.failures).toHaveLength(1);
  fail = false;
  view.failures[0]!();
  expect(dismiss.mock.calls).toEqual([
    ["c1", "m2"],
    ["c1", "m2"],
  ]);
  await Promise.resolve();
  await Promise.resolve();
  expect(view.failures).toHaveLength(1);
  // The next answer brings its own suggestion.
  view.setMessages([user, answer({ text: "Ja", dismissedAt: null }), { ...answer({ text: "Schick es ab", dismissedAt: null }), id: "m3" }]);
  expect(view.next()?.text).toBe("Schick es ab");
  view.dispose();
});
