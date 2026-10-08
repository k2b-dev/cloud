import { describe, expect, test } from "bun:test";
import serviceWorkerSource from "./service-worker.js" with { type: "text" };

type Listener = (event: Record<string, unknown>) => void;

const loadWorker = (windows: Array<Record<string, unknown>>, navigator: Record<string, unknown> = {}) => {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const visible = new Map<unknown, unknown>();
  const worker = {
    navigator,
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
        visible.set(options.tag, { title, options });
        return Promise.resolve();
      },
    },
  };
  new Function("self", serviceWorkerSource)(worker);
  return { listeners, opened, shown, visible };
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

  test("replaces a group's visible notification and renotifies for each event", async () => {
    const { listeners, shown, visible } = loadWorker([]);
    for (const title of ["First", "Second"]) {
      const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title, group: "inventory:stock:one" });
      listeners.get("push")!(push.event);
      await push.completion();
    }
    expect(shown).toEqual(
      ["First", "Second"].map((title) => ({
        title,
        options: {
          icon: "/branding/logo",
          tag: "inventory:stock:one",
          renotify: true,
          data: { targetHref: "/", group: "inventory:stock:one" },
        },
      })),
    );
    expect(visible.size).toBe(1);
    expect(visible.get("inventory:stock:one")).toEqual(shown[1]);
  });

  test.each([3, 0])("sets or clears the app badge for count %i within waitUntil", async (badge) => {
    const calls: unknown[] = [];
    let completeBadge: () => void = () => {};
    const badgeDone = new Promise<void>((resolve) => {
      completeBadge = resolve;
    });
    const { listeners, shown } = loadWorker([], {
      setAppBadge: (count: number) => {
        calls.push(count);
        return badgeDone;
      },
      clearAppBadge: () => {
        calls.push("clear");
        return badgeDone;
      },
    });
    const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", badge });
    listeners.get("push")!(push.event);
    expect(push.completion()).not.toBeNull();
    let finished = false;
    const completion = push.completion()!.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(calls).toEqual([badge === 0 ? "clear" : badge]);
    completeBadge();
    await completion;
    expect(shown).toHaveLength(1);
  });

  test.each(["missing", "rejects", "throws"])("shows the notification when the Badging API %s", async (failure) => {
    const { listeners, shown } = loadWorker(
      [],
      failure === "missing"
        ? {}
        : {
            setAppBadge: () => {
              if (failure === "throws") throw new Error("Unavailable");
              return Promise.reject(new Error("Unavailable"));
            },
            clearAppBadge: () => Promise.reject(new Error("Unavailable")),
          },
    );
    for (const badge of [4, 0]) {
      const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", badge });
      listeners.get("push")!(push.event);
      await push.completion();
    }
    expect(shown).toHaveLength(2);
  });

  test("accepts a maximum-length group after application namespacing", async () => {
    const group = "inventory:" + "g".repeat(128);
    const { listeners, shown } = loadWorker([]);
    const push = pushEvent({
      type: "cloud-notification",
      eventId: crypto.randomUUID(),
      title: "Ready",
      group,
      badge: Number.MAX_SAFE_INTEGER,
    });
    listeners.get("push")!(push.event);
    await push.completion();
    expect(shown[0]?.options.tag).toBe(group);
  });

  test.each([
    ...[null, 42, "", "group space", "group/one", " group", "group\n"].map((group) => ({ group })),
    ...[null, "2", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map((badge) => ({ badge })),
  ])("rejects invalid grouping or badge metadata: %j", (metadata) => {
    const { listeners, shown } = loadWorker([]);
    const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", ...metadata });
    listeners.get("push")!(push.event);
    expect(push.completion()).toBeNull();
    expect(shown).toEqual([]);
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
    const destination = {
      focus: async () => {
        actions.push("focus");
      },
    };
    const client = {
      url: "https://cloud.example/other",
      navigate: async (href: string) => {
        actions.push(`navigate:${href}`);
        return destination;
      },
      focus: async () => {
        throw new Error("Must focus the destination returned by navigation");
      },
    };
    const { listeners, opened } = loadWorker([client]);
    const click = notificationClickEvent("/app/assistant?conversation=two");
    listeners.get("notificationclick")!(click.event);
    await click.completion();
    expect(actions).toEqual(["navigate:/app/assistant?conversation=two", "focus"]);
    expect(opened).toEqual([]);
  });

  test.each(["navigation rejects", "navigation returns null", "focus rejects", "exact target closes"])(
    "opens the target if the existing tab cannot be used: %s",
    async (failure) => {
      const target = "/me/notifications";
      const focus = async () => {
        throw new TypeError("Client is no longer available");
      };
      const client = {
        url: `https://cloud.example${failure === "exact target closes" ? target : "/other"}`,
        navigate: async () => {
          if (failure === "navigation rejects") throw new TypeError("Client is not controlled by this worker");
          return failure === "navigation returns null" ? null : { focus };
        },
        focus,
      };
      const { listeners, opened } = loadWorker([client]);
      const click = notificationClickEvent(target);
      listeners.get("notificationclick")!(click.event);
      await click.completion();
      expect(click.closed()).toBe(true);
      expect(opened).toEqual([target]);
    },
  );

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
