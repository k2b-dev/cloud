import { expect, test } from "bun:test";
import { type Message, memoryStore, nessi, type Provider, type ProviderRequest } from "@k2b/nessi";
import { AI_OPEN_TOOL_CALL_RESULT, answerOpenToolCalls } from "./open-tool-calls";

/** Records each streamed request. */
const recording = (requests: ProviderRequest[]): Provider => ({
  name: "fixture",
  family: "openai-compatible",
  model: "fixture",
  capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
  async complete() {
    throw new Error("Unexpected completion");
  },
  async *stream(request) {
    requests.push(request);
    yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
  },
});

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const calls = (...ids: string[]): Message => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool_call" as const, id, name: "send_mail", args: { to: "jana@example.test" } })),
});
const result = (callId: string): Message => ({ role: "tool_result", callId, name: "send_mail", result: "sent", isError: false });

const send = async (messages: Message[]) => {
  const requests: ProviderRequest[] = [];
  for await (const _event of answerOpenToolCalls(recording(requests)).stream({ messages })) {
  }
  return requests[0]!.messages;
};

test("a call an earlier turn left without a result is answered as not returned, right after the message that made it", async () => {
  const sent = await send([user("Send both"), calls("done", "open"), result("done"), user("Continue where you left off.")]);
  expect(sent).toEqual([
    user("Send both"),
    calls("done", "open"),
    { role: "tool_result", callId: "open", name: "send_mail", result: AI_OPEN_TOOL_CALL_RESULT, isError: true },
    result("done"),
    user("Continue where you left off."),
  ]);
});

test("a result counts only for the model message before it, since providers may reuse call IDs", async () => {
  const sent = await send([user("First"), calls("call_0"), user("Second"), calls("call_0"), result("call_0"), user("Third")]);
  const notReturned: Message = {
    role: "tool_result",
    callId: "call_0",
    name: "send_mail",
    result: AI_OPEN_TOOL_CALL_RESULT,
    isError: true,
  };
  // The first call_0 is open, although a later call_0 has a result.
  expect(sent).toEqual([user("First"), calls("call_0"), notReturned, user("Second"), calls("call_0"), result("call_0"), user("Third")]);
});

test("a result stored after a scheduled message moves up to its call instead of being answered as not returned", async () => {
  const digest: Message = { role: "assistant", content: [{ type: "text", text: "Your daily digest is ready." }] };
  const sent = await send([user("Send both"), calls("a", "b"), result("a"), digest, result("b"), user("Thanks")]);
  expect(sent).toEqual([user("Send both"), calls("a", "b"), result("b"), result("a"), digest, user("Thanks")]);
  expect(sent.filter((message) => message.role === "tool_result" && message.callId === "b")).toHaveLength(1);
});

/** What the provider receives when nessi runs the next turn over `history`, which nessi itself repairs first. */
const sendThroughNessi = async (history: Message[], input: string) => {
  const requests: ProviderRequest[] = [];
  const store = memoryStore();
  for (const message of history) await store.append(message);
  for await (const _event of nessi({ systemPrompt: "Test", store, provider: answerOpenToolCalls(recording(requests)), input })) {
  }
  return requests[0]!.messages;
};

test("through nessi, which answers an open call itself, the call still reads as not returned", async () => {
  const sent = await sendThroughNessi([user("Send both"), calls("done", "open"), result("done")], "Continue where you left off.");
  expect(sent).toEqual([
    user("Send both"),
    calls("done", "open"),
    { role: "tool_result", callId: "open", name: "send_mail", result: AI_OPEN_TOOL_CALL_RESULT, isError: true },
    result("done"),
    user("Continue where you left off."),
  ]);
});

test("through nessi, a result stored after a scheduled message still moves up to its call, once", async () => {
  const digest: Message = { role: "assistant", content: [{ type: "text", text: "Your daily digest is ready." }] };
  const sent = await sendThroughNessi([user("Send both"), calls("a", "b"), result("a"), digest, result("b")], "Thanks");
  expect(sent).toEqual([user("Send both"), calls("a", "b"), result("b"), result("a"), digest, user("Thanks")]);
});

test("a history without open calls reaches the provider unchanged", async () => {
  const messages = [user("Send"), calls("done"), result("done"), user("Thanks")];
  expect(await send(messages)).toBe(messages);
});
