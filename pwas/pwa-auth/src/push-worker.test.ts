import { expect, test } from "bun:test";
import { installPushHandlers, OPEN_REQUEST_MESSAGE, type PushScope } from "./push-worker";

type Shown = { title: string; options: NotificationOptions };

function worker(options: { locale?: string; windows?: { url: string }[] } = {}) {
  const shown: Shown[] = [];
  const opened: string[] = [];
  const messages: unknown[] = [];
  const focused: string[] = [];
  const listeners: { push?: Parameters<PushScope["onPush"]>[0]; click?: Parameters<PushScope["onClick"]>[0] } = {};
  installPushHandlers({
    location: { origin: "https://login.example.test" },
    registration: {
      showNotification: async (title, notification) => {
        shown.push({ title, options: notification });
      },
    },
    clients: {
      matchAll: async () =>
        (options.windows ?? []).map((window) => ({
          url: window.url,
          focus: async () => focused.push(window.url),
          postMessage: (message: unknown) => messages.push(message),
        })),
      openWindow: async (url) => opened.push(url),
    },
    caches: {
      open: async () => ({ match: async () => (options.locale ? new Response(options.locale) : undefined) }),
    },
    languages: ["en-US"],
    onPush: (listener) => {
      listeners.push = listener;
    },
    onClick: (listener) => {
      listeners.click = listener;
    },
  });
  const push = async (text: string) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.push!({ data: { text: () => text }, waitUntil: (promise) => (done = promise) });
    await done;
  };
  const click = async (data: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    let closed = false;
    listeners.click!({ notification: { close: () => (closed = true), data }, waitUntil: (promise) => (done = promise) });
    await done;
    return closed;
  };
  return { shown, opened, messages, focused, push, click };
}

test("a sign-in push shows the Cloud address in the app's language and links to the request", async () => {
  const sw = worker({ locale: "de" });
  await sw.push(JSON.stringify({ v: 1, type: "login", cloud: "https://cloud.example.org", ref: "7d3c7a0e-2f4b-4f8a-9d61-0c1f2a3b4c5d" }));
  expect(sw.shown).toHaveLength(1);
  expect(sw.shown[0]!.title).toBe("Anmeldeanfrage bei cloud.example.org");
  expect(sw.shown[0]!.options).toMatchObject({
    body: "Anmeldung bestätigen",
    tag: "login:https://cloud.example.org",
    lang: "de",
    data: { url: "/?request=7d3c7a0e-2f4b-4f8a-9d61-0c1f2a3b4c5d" },
  });
});

test("every push shows a notification, even a malformed one, and test pushes are recognizable", async () => {
  const sw = worker();
  await sw.push("not json");
  await sw.push(JSON.stringify({ v: 1, type: "login", cloud: "javascript:alert(1)", ref: "x" }));
  await sw.push(JSON.stringify({ v: 1, type: "test" }));
  expect(sw.shown.map((item) => [item.title, item.options.body])).toEqual([
    ["Cloud Login", "Open Cloud Login to check waiting requests."],
    ["Cloud Login", "Open Cloud Login to check waiting requests."],
    ["Cloud Login", "Notifications work. You will hear about waiting requests here."],
  ]);
});

test("tapping a notification opens the app at the request, or focuses an open app", async () => {
  const closed = worker();
  expect(await closed.click({ url: "/?request=abc" })).toBe(true);
  expect(closed.opened).toEqual(["https://login.example.test/?request=abc"]);

  const running = worker({ windows: [{ url: "https://other.example.test/" }, { url: "https://login.example.test/" }] });
  await running.click({ url: "/?request=abc" });
  expect(running.opened).toEqual([]);
  expect(running.messages).toEqual([{ type: OPEN_REQUEST_MESSAGE, ref: "abc", kind: "login" }]);
  expect(running.focused).toEqual(["https://login.example.test/"]);

  const foreign = worker();
  await foreign.click({ url: "https://evil.example.test/phish" });
  expect(foreign.opened).toEqual(["https://login.example.test/"]);
});

test("Action wake-ups name only the Cloud host in English and German", async () => {
  for (const [locale, title, body] of [
    ["en", "Approval requested on cloud.example.org", "Open Cloud Login to review it."],
    ["de", "Freigabe angefragt auf cloud.example.org", "Öffne Cloud Login, um sie anzusehen."],
  ]) {
    const sw = worker({ locale });
    await sw.push(JSON.stringify({ v: 1, type: "action", cloud: "https://cloud.example.org", ref: "abc" }));
    expect(sw.shown[0]).toMatchObject({
      title,
      options: { body, tag: "action:https://cloud.example.org", data: { url: "/?action=abc&cloud=https%3A%2F%2Fcloud.example.org" } },
    });
  }
});

test("an Action notification opens its URL or forwards the Action kind to an open app", async () => {
  const closed = worker();
  await closed.click({ url: "/?action=abc" });
  expect(closed.opened).toEqual(["https://login.example.test/?action=abc"]);
  const running = worker({ windows: [{ url: "https://login.example.test/" }] });
  await running.click({ url: "/?action=abc" });
  await running.click({ url: "/?action=abc&cloud=https%3A%2F%2Fcloud.example.org" });
  // The Cloud lets the app load an Action its inbox summaries left out.
  expect(running.messages).toEqual([
    { type: OPEN_REQUEST_MESSAGE, ref: "abc", kind: "action" },
    { type: OPEN_REQUEST_MESSAGE, ref: "abc", kind: "action", cloud: "https://cloud.example.org" },
  ]);
  expect(running.focused).toEqual(["https://login.example.test/", "https://login.example.test/"]);
  await running.push(JSON.stringify({ v: 1, type: "action", cloud: "https://cloud.example.org/path", ref: "abc" }));
  await running.push(JSON.stringify({ v: 1, type: "action", cloud: "https://cloud.example.org", ref: "../bad" }));
  expect(running.shown.every((item) => item.options.body === "Open Cloud Login to check waiting requests.")).toBe(true);
});
