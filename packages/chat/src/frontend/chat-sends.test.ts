import { expect, test } from "bun:test";
import { MessageViewSchema } from "../service/contracts";
import { createChatSends, createChatSendsApi } from "./chat-sends";

const message = MessageViewSchema.parse({
  id: "message001",
  conversationId: "abcdef",
  seq: 1,
  rev: 1,
  kind: "text",
  author: { type: "user", id: "11111111-1111-4111-8111-111111111111", name: "Lea" },
  body: "Hello",
  system: null,
  systemText: null,
  createdAt: "2026-10-12T12:00:00.000Z",
});
const deferred = <T>() => {
  let resolve = (_value: T) => {},
    reject = (_error: Error) => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("send is pending immediately; a failed send retries with the same identity and body", async () => {
  const first = deferred<typeof message>(),
    second = deferred<typeof message>();
  const calls: unknown[] = [];
  const controller = createChatSends({
    post: async (id, input) => {
      calls.push([id, input]);
      return calls.length === 1 ? first.promise : second.promise;
    },
    newClientId: () => "client-1",
    now: () => new Date(message.createdAt),
  });
  const states: string[] = [];
  controller.subscribe(() => states.push(controller.sends("abcdef")[0]?.status ?? "forgotten"));
  const entry = controller.send("abcdef", "Hello");
  expect(entry).toMatchObject({ clientId: "client-1", status: "pending", message: null, createdAt: message.createdAt });
  expect(controller.sends("abcdef")).toEqual([entry]);
  controller.retry(entry.clientId);
  expect(calls).toHaveLength(1);
  first.reject(new Error("offline"));
  await Bun.sleep(0);
  expect(entry.status).toBe("failed");
  controller.retry(entry.clientId);
  expect(entry.status).toBe("pending");
  expect(calls).toEqual([
    ["abcdef", { clientId: "client-1", body: "Hello" }],
    ["abcdef", { clientId: "client-1", body: "Hello" }],
  ]);
  second.resolve(message);
  await Bun.sleep(0);
  expect(entry).toMatchObject({ status: "sent", message });
  controller.retry(entry.clientId);
  expect(calls).toHaveLength(2);
  controller.forget(entry.clientId);
  expect(controller.sends("abcdef")).toEqual([]);
  expect(states).toEqual(["pending", "failed", "pending", "sent", "forgotten"]);
  controller.dispose();
});

for (const outcome of ["success", "failure"] as const)
  test(`results after dispose do not change a pending send (${outcome})`, async () => {
    const pending = deferred<typeof message>();
    const controller = createChatSends({ post: () => pending.promise });
    let notified = 0;
    controller.subscribe(() => notified++);
    const entry = controller.send("abcdef", "Hello");
    controller.dispose();
    if (outcome === "success") pending.resolve(message);
    else pending.reject(new Error("offline"));
    await Bun.sleep(0);
    expect(entry.status).toBe("pending");
    expect(entry.message).toBeNull();
    expect(notified).toBe(1);
  });

test("sends keep creation order per conversation and ignore forgotten pending results", async () => {
  const pending = deferred<typeof message>();
  let id = 0;
  const controller = createChatSends({ post: () => pending.promise, newClientId: () => String(++id) });
  const first = controller.send("abcdef", "First");
  controller.send("ghijkl", "Other");
  const second = controller.send("abcdef", "Second");
  expect(controller.sends("abcdef")).toEqual([first, second]);
  controller.forget(first.clientId);
  pending.resolve(message);
  await Bun.sleep(0);
  expect(first.status).toBe("pending");
  expect(controller.sends("abcdef")).toEqual([second]);
  controller.dispose();
});

test("send API accepts 200 and 201, validates messages, and rejects every failed response", async () => {
  const original = globalThis.fetch;
  let status = 200;
  const requests: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push([String(url), init?.method, JSON.parse(String(init?.body))]);
      return Response.json(status < 300 ? message : { message: "Failed" }, { status });
    },
    { preconnect: original.preconnect },
  );
  try {
    const api = createChatSendsApi();
    const input = { clientId: "same-id", body: "Hello" };
    expect(await api("abcdef", input)).toEqual(message);
    status = 201;
    expect(await api("abcdef", input)).toEqual(message);
    for (status of [400, 403, 404, 429, 500]) await expect(api("abcdef", input)).rejects.toThrow(String(status));
    expect(requests[0]).toEqual(["/api/chat/conversations/abcdef/messages", "POST", input]);
  } finally {
    globalThis.fetch = original;
  }
});
