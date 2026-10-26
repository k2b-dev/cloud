import { expect, test } from "bun:test";
import { REQUEST_IDLE_TIMEOUT_MAX_SECONDS } from "@k2b/cloud/server/request-timeout.ts";
import { MessageViewSchema } from "../service/contracts";
import { createChatSends, createChatSendsApi } from "./chat-sends";

const message = MessageViewSchema.parse({
  reactions: [],
  refs: [],
  thread: null,
  replyTo: null,
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
const fakePost = () => {
  const calls: {
    conversationId: string;
    input: { clientId: string; body: string };
    request: ReturnType<typeof deferred<typeof message>>;
  }[] = [];
  return {
    calls,
    post: (conversationId: string, input: { clientId: string; body: string }) => {
      const request = deferred<typeof message>();
      calls.push({ conversationId, input, request });
      return request.promise;
    },
  };
};

test("unsent tracks pending and failed sends across conversations until sent or forgotten", async () => {
  const fake = fakePost();
  let clientId = 0;
  const controller = createChatSends({
    post: fake.post,
    newClientId: () => `client-${++clientId}`,
    now: () => new Date(message.createdAt),
  });
  expect(controller.unsent()).toBe(false);
  controller.send("abcdef", "Hello");
  expect(controller.unsent()).toBe(true);
  const second = controller.send("ghijkl", "Other chat");
  fake.calls[0]!.request.resolve(message);
  await Bun.sleep(0);
  expect(controller.unsent()).toBe(true);
  fake.calls[1]!.request.reject(new Error("offline"));
  await Bun.sleep(0);
  expect(second.status).toBe("failed");
  expect(controller.unsent()).toBe(true);
  controller.retry(second.clientId);
  fake.calls[2]!.request.resolve({ ...message, conversationId: "ghijkl", body: second.body });
  await Bun.sleep(0);
  expect(controller.unsent()).toBe(false);
  const failed = controller.send("abcdef", "Try again");
  fake.calls[3]!.request.reject(new Error("offline"));
  await Bun.sleep(0);
  expect(controller.unsent()).toBe(true);
  controller.forget(failed.clientId);
  expect(controller.unsent()).toBe(false);
  controller.dispose();
});

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
  controller.forget(entry.clientId);
  controller.forget("missing");
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

test("sends post one at a time in creation order despite delayed responses", async () => {
  const fake = fakePost();
  const controller = createChatSends({ post: fake.post });
  const entries = ["A", "B", "C"].map((body) => controller.send("abcdef", body));
  expect(controller.sends("abcdef")).toEqual(entries);
  expect(fake.calls.map((call) => call.input.body)).toEqual(["A"]);
  for (let index = 0; index < entries.length; index++) {
    fake.calls[index]!.request.resolve({ ...message, seq: index + 1, body: entries[index]!.body });
    await Bun.sleep(0);
    expect(entries[index]!.status).toBe("sent");
    expect(fake.calls.map((call) => call.input.body)).toEqual(["A", "B", "C"].slice(0, index + 2));
  }
  expect(entries.map((entry) => entry.status)).toEqual(["sent", "sent", "sent"]);
  controller.dispose();
});

test("a failed head holds later sends until retry keeps its identity and place", async () => {
  const fake = fakePost();
  const controller = createChatSends({ post: fake.post });
  const first = controller.send("abcdef", "A");
  const second = controller.send("abcdef", "B");
  fake.calls[0]!.request.reject(new Error("offline"));
  await Bun.sleep(0);
  const third = controller.send("abcdef", "C");
  expect([first.status, second.status, third.status]).toEqual(["failed", "pending", "pending"]);
  expect(fake.calls).toHaveLength(1);
  controller.retry(first.clientId);
  expect(first.status).toBe("pending");
  expect(controller.sends("abcdef")).toEqual([first, second, third]);
  expect(fake.calls.map((call) => call.input)).toEqual([
    { clientId: first.clientId, body: "A" },
    { clientId: first.clientId, body: "A" },
  ]);
  for (const [index, entry] of [first, second, third].entries()) {
    fake.calls[index + 1]!.request.resolve({ ...message, seq: index + 1, body: entry.body });
    await Bun.sleep(0);
    expect(entry.status).toBe("sent");
    expect(fake.calls.map((call) => call.input.body)).toEqual(["A", "A", "B", "C"].slice(0, index + 3));
  }
  controller.dispose();
});

test("forgetting a failed head releases the next pending send", async () => {
  const fake = fakePost();
  const controller = createChatSends({ post: fake.post });
  const first = controller.send("abcdef", "A");
  const second = controller.send("abcdef", "B");
  fake.calls[0]!.request.reject(new Error("offline"));
  await Bun.sleep(0);
  expect(first.status).toBe("failed");
  expect(second.status).toBe("pending");
  expect(fake.calls).toHaveLength(1);
  controller.forget(first.clientId);
  expect(controller.sends("abcdef")).toEqual([second]);
  expect(fake.calls.map((call) => call.input.body)).toEqual(["A", "B"]);
  fake.calls[1]!.request.resolve({ ...message, body: "B" });
  await Bun.sleep(0);
  expect(second.status).toBe("sent");
  controller.dispose();
});

for (const outcome of ["success", "failure"] as const)
  test(`forgetting an in-flight send waits for settlement and ignores its result (${outcome})`, async () => {
    const fake = fakePost();
    const controller = createChatSends({ post: fake.post });
    let notified = 0;
    controller.subscribe(() => notified++);
    const first = controller.send("abcdef", "A");
    const second = controller.send("abcdef", "B");
    controller.forget(first.clientId);
    expect(fake.calls).toHaveLength(1);
    expect(controller.sends("abcdef")).toEqual([second]);
    expect(notified).toBe(3);
    if (outcome === "success") fake.calls[0]!.request.resolve(message);
    else fake.calls[0]!.request.reject(new Error("offline"));
    await Bun.sleep(0);
    expect(first).toMatchObject({ status: "pending", message: null });
    expect(controller.sends("abcdef")).toEqual([second]);
    expect(notified).toBe(3);
    expect(fake.calls.map((call) => call.input.body)).toEqual(["A", "B"]);
    fake.calls[1]!.request.resolve({ ...message, body: "B" });
    await Bun.sleep(0);
    expect(second.status).toBe("sent");
    controller.dispose();
  });

test("conversations post in parallel and a failure only holds its own conversation", async () => {
  const fake = fakePost();
  const controller = createChatSends({ post: fake.post });
  const first = controller.send("abcdef", "A");
  const other = controller.send("ghijkl", "Other");
  const second = controller.send("abcdef", "B");
  const later = controller.send("ghijkl", "Later");
  expect(fake.calls.map((call) => call.conversationId)).toEqual(["abcdef", "ghijkl"]);
  fake.calls[0]!.request.reject(new Error("offline"));
  await Bun.sleep(0);
  fake.calls[1]!.request.resolve({ ...message, conversationId: "ghijkl", body: "Other" });
  await Bun.sleep(0);
  expect([first.status, second.status, other.status, later.status]).toEqual(["failed", "pending", "sent", "pending"]);
  expect(fake.calls.map((call) => [call.conversationId, call.input.body])).toEqual([
    ["abcdef", "A"],
    ["ghijkl", "Other"],
    ["ghijkl", "Later"],
  ]);
  fake.calls[2]!.request.resolve({ ...message, conversationId: "ghijkl", seq: 2, body: "Later" });
  await Bun.sleep(0);
  expect(later.status).toBe("sent");
  controller.dispose();
});

for (const outcome of ["success", "failure"] as const)
  test(`dispose prevents queued sends and notifications after settlement (${outcome})`, async () => {
    const fake = fakePost();
    const controller = createChatSends({ post: fake.post });
    let notified = 0;
    controller.subscribe(() => notified++);
    const first = controller.send("abcdef", "A");
    const second = controller.send("abcdef", "B");
    expect(fake.calls).toHaveLength(1);
    controller.dispose();
    controller.send("abcdef", "C");
    controller.retry(first.clientId);
    controller.forget(first.clientId);
    if (outcome === "success") fake.calls[0]!.request.resolve(message);
    else fake.calls[0]!.request.reject(new Error("offline"));
    await Bun.sleep(0);
    expect(fake.calls).toHaveLength(1);
    expect(controller.sends("abcdef")).toEqual([first, second]);
    expect([first.status, second.status]).toEqual(["pending", "pending"]);
    expect(first.message).toBeNull();
    expect(notified).toBe(2);
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

test("send API passes the gateway deadline signal and rejects when it aborts", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  const budgets: number[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  AbortSignal.timeout = (milliseconds) => {
    budgets.push(milliseconds);
    return controller.signal;
  };
  globalThis.fetch = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const pending = createChatSendsApi()("abcdef", { clientId: "same-id", body: "Hello" });
    expect(budgets).toEqual([REQUEST_IDLE_TIMEOUT_MAX_SECONDS * 1000]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
    await expect(pending).rejects.toThrow("Request timed out");
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
