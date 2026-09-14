import { describe, expect, test } from "bun:test";
import serviceWorkerSource from "./service-worker.js" with { type: "text" };

type Listener = (event: Record<string, unknown>) => void;

const loadWorker = (windows: Array<Record<string, unknown>>) => {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const worker = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (href: string) => {
        opened.push(href);
        return Promise.resolve(null);
      },
    },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
  };
  new Function("self", serviceWorkerSource)(worker);
  return { listeners, opened, shown };
};

const pushEvent = (payload: unknown) => {
  let completion: Promise<unknown> | null = null;
  return {
    event: {
      data: { json: () => payload },
      waitUntil: (promise: Promise<unknown>) => {
        completion = promise;
      },
    },
    completion: () => completion,
  };
};

const notificationClickEvent = (targetHref: string) => {
  let completion: Promise<unknown> | null = null;
  let closed = false;
  return {
    event: {
      notification: {
        data: { targetHref },
        close: () => {
          closed = true;
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        completion = promise;
      },
    },
    completion: () => completion,
    closed: () => closed,
  };
};

describe("browser notification service worker", () => {
  test.each([
    { name: "a focused target tab", tabs: [{ focused: true, visibilityState: "visible" }] },
    { name: "a visible unfocused tab", tabs: [{ focused: false, visibilityState: "visible" }] },
    { name: "a hidden tab", tabs: [{ focused: false, visibilityState: "hidden" }] },
    { name: "no tabs", tabs: [] },
    {
      name: "multiple tabs",
      tabs: [{ focused: true, visibilityState: "visible" }, { visibilityState: "visible" }, { visibilityState: "hidden" }],
    },
  ])("shows one native notification with $name without forwarding to tabs", async ({ tabs }) => {
    const messages: unknown[] = [];
    const targetHref = "/app/assistant?conversation=one";
    const { listeners, shown } = loadWorker(
      tabs.map((tab) => ({
        ...tab,
        url: `https://cloud.example${targetHref}`,
        postMessage: (value: unknown) => messages.push(value),
      })),
    );
    const eventId = crypto.randomUUID();
    const push = pushEvent({ type: "cloud-notification", eventId, title: "Ready", targetHref });

    listeners.get("push")!(push.event);
    expect(push.completion()).not.toBeNull();
    await push.completion();

    expect(messages).toEqual([]);
    expect(shown).toEqual([
      {
        title: "Ready",
        options: { icon: "/branding/logo", tag: eventId, data: { targetHref } },
      },
    ]);
  });

  test("uses the Cloud root when a notification has no target", async () => {
    const { listeners, shown } = loadWorker([]);
    const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready" });
    listeners.get("push")!(push.event);
    await push.completion();
    expect(shown[0]?.options.data).toEqual({ targetHref: "/" });
  });

  test("focuses an already open exact target when its notification is clicked", async () => {
    let focusCount = 0;
    const targetClient = {
      url: "https://cloud.example/app/assistant?conversation=one",
      focus: () => {
        focusCount += 1;
        return Promise.resolve(targetClient);
      },
    };
    const { listeners, opened } = loadWorker([targetClient]);
    const click = notificationClickEvent("/app/assistant?conversation=one");

    listeners.get("notificationclick")!(click.event);
    await click.completion();

    expect(click.closed()).toBe(true);
    expect(focusCount).toBe(1);
    expect(opened).toEqual([]);
  });

  test("opens the exact target when no Cloud window exists", async () => {
    const { listeners, opened } = loadWorker([]);
    const click = notificationClickEvent("/app/assistant?conversation=two");

    listeners.get("notificationclick")!(click.event);
    await click.completion();

    expect(click.closed()).toBe(true);
    expect(opened).toEqual(["/app/assistant?conversation=two"]);
  });

  test("navigates and focuses an existing window when its target differs", async () => {
    const actions: string[] = [];
    const client = {
      url: "https://cloud.example/other",
      navigate: async (href: string) => {
        actions.push(`navigate:${href}`);
      },
      focus: async () => {
        actions.push("focus");
      },
    };
    const { listeners, opened } = loadWorker([client]);
    const click = notificationClickEvent("/app/assistant?conversation=two");
    listeners.get("notificationclick")!(click.event);
    await click.completion();
    expect(actions).toEqual(["navigate:/app/assistant?conversation=two", "focus"]);
    expect(opened).toEqual([]);
  });

  test("opens the safe root for malformed stored click targets", async () => {
    const { listeners, opened } = loadWorker([]);
    const click = notificationClickEvent("https://other.example/private");
    listeners.get("notificationclick")!(click.event);
    await click.completion();
    expect(opened).toEqual(["/"]);
  });

  test("ignores malformed payloads and unsafe targets", () => {
    const { listeners, shown } = loadWorker([]);
    const payload = { type: "cloud-notification", eventId: crypto.randomUUID(), title: "Unsafe" };
    for (const value of [
      null,
      {},
      { ...payload, type: "other" },
      { ...payload, title: null },
      { ...payload, eventId: null },
      ...["//example.test", "/\\evil.example", "https://example.test", "/path\n"].map((targetHref) => ({ ...payload, targetHref })),
    ]) {
      const push = pushEvent(value);
      listeners.get("push")!(push.event);
      expect(push.completion()).toBeNull();
    }
    expect(shown).toEqual([]);
  });
});
