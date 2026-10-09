import { describe, expect, test } from "bun:test";
import serviceWorkerSource from "./service-worker.js" with { type: "text" };

type Listener = (event: Record<string, unknown>) => void;

const createCaches = () => {
  const entries = new Map<string, Response>();
  return {
    open: async (_name: string) => ({
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        entries.set(key, response.clone());
      },
    }),
  };
};

const loadWorker = (
  windows: Array<Record<string, unknown>>,
  navigator: Record<string, unknown> = {},
  caches: ReturnType<typeof createCaches> = createCaches(),
) => {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const visible = new Map<unknown, { title: string; options: Record<string, unknown> }>();
  const worker = {
    navigator,
    caches,
    location: { origin: "https://cloud.example" },
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
      getNotifications: async ({ tag }: { tag: string }) => {
        const notification = visible.get(tag);
        return notification ? [{ title: notification.title, ...notification.options }] : [];
      },
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        visible.set(options.tag, { title, options });
        return Promise.resolve();
      },
    },
  };
  new Function("self", serviceWorkerSource)(worker);
  return { listeners, opened, shown, visible, worker };
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

  test("shows the preview as the native notification body without using the presentation body", async () => {
    const { listeners, shown } = loadWorker([]);
    const push = pushEvent({
      type: "cloud-notification",
      eventId: crypto.randomUUID(),
      title: "Ready",
      preview: "Short preview",
      body: "Sensitive presentation body",
    });
    listeners.get("push")!(push.event);
    await push.completion();
    expect(shown[0]?.options.body).toBe("Short preview");
  });

  test.each([null, 1, {}, []].map((preview) => ({ preview })))("rejects a non-string preview: %j", ({ preview }) => {
    const { listeners, shown } = loadWorker([]);
    const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", preview });
    listeners.get("push")!(push.event);
    expect(push.completion()).toBeNull();
    expect(shown).toEqual([]);
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
          data: { targetHref: "/" },
        },
      })),
    );
    expect(visible.size).toBe(1);
    expect(visible.get("inventory:stock:one")).toEqual(shown[1]);
  });

  test("keeps a newer grouped notification and badge when an older push arrives late", async () => {
    const badges: number[] = [];
    const { listeners, shown, visible } = loadWorker([], { setAppBadge: (count: number) => badges.push(count) });
    for (const [title, createdAt, badge] of [
      ["Second", 2000, 5],
      ["First", 1000, 3],
    ]) {
      const push = pushEvent({
        type: "cloud-notification",
        eventId: crypto.randomUUID(),
        title,
        createdAt,
        badge,
        preview: `${title} preview`,
        group: "chat:one",
      });
      listeners.get("push")!(push.event);
      await push.completion();
    }
    expect(visible.get("chat:one")).toEqual({
      title: "Second",
      options: { icon: "/branding/logo", tag: "chat:one", body: "Second preview", data: { targetHref: "/", createdAt: 2000 } },
    });
    expect(shown[0]?.options.renotify).toBe(true);
    expect(shown[1]?.options).not.toHaveProperty("renotify");
    expect(badges).toEqual([5]);
  });

  test("renotifies and applies badges in order, including equal timestamps", async () => {
    const badges: number[] = [];
    const { listeners, shown } = loadWorker([], { setAppBadge: (count: number) => badges.push(count) });
    for (const [createdAt, badge] of [
      [1000, 3],
      [2000, 5],
      [2000, 6],
    ]) {
      const push = pushEvent({
        type: "cloud-notification",
        eventId: crypto.randomUUID(),
        title: "Ready",
        createdAt,
        badge,
        group: "chat:one",
      });
      listeners.get("push")!(push.event);
      await push.completion();
    }
    expect(shown.map(({ options }) => options.renotify)).toEqual([true, true, true]);
    expect(badges).toEqual([3, 5, 6]);
  });

  test("keeps the newer notification when same-group pushes overlap", async () => {
    const { listeners, shown, visible } = loadWorker([]);
    const pushes = [
      [2000, "Second"],
      [1000, "First"],
    ].map(([createdAt, title]) =>
      pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title, createdAt, group: "chat:one" }),
    );
    for (const push of pushes) listeners.get("push")!(push.event);
    await Promise.all(pushes.map((push) => push.completion()));
    expect(visible.get("chat:one")?.title).toBe("Second");
    expect(shown[1]?.options).not.toHaveProperty("renotify");
  });

  test("serializes badge updates while concurrent notifications still display", async () => {
    const badges: number[] = [];
    let completeBadge: () => void = () => {};
    const badgeDone = new Promise<void>((resolve) => {
      completeBadge = resolve;
    });
    let badgeStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      badgeStarted = resolve;
    });
    const caches = createCaches();
    const cache = await caches.open("cloud-notification-state");
    const match = cache.match;
    cache.match = async (key) => {
      const previous = await match(key);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return previous;
    };
    caches.open = async () => cache;
    const { listeners, shown } = loadWorker(
      [],
      {
        setAppBadge: (count: number) => {
          badges.push(count);
          badgeStarted();
          return badgeDone;
        },
      },
      caches,
    );
    const first = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Second", createdAt: 2000, badge: 5 });
    listeners.get("push")!(first.event);
    const second = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "First", createdAt: 1000, badge: 3 });
    listeners.get("push")!(second.event);
    await started;
    // Allow the second display to finish while the first badge call is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown.map(({ title }) => title)).toEqual(["Second", "First"]);
    expect(badges).toEqual([5]);
    completeBadge();
    await Promise.all([first.completion(), second.completion()]);
    expect(badges).toEqual([5]);
  });

  test("keeps badge recency across groups", async () => {
    const badges: number[] = [];
    const { listeners, shown } = loadWorker([], { setAppBadge: (count: number) => badges.push(count) });
    for (const [group, createdAt, badge] of [
      ["chat:x", 2000, 5],
      ["chat:y", 1000, 3],
    ]) {
      const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", group, createdAt, badge });
      listeners.get("push")!(push.event);
      await push.completion();
    }
    expect(shown.map(({ options }) => options.renotify)).toEqual([true, true]);
    expect(badges).toEqual([5]);
  });

  test("keeps badge recency after the worker restarts", async () => {
    const caches = createCaches();
    const badges: number[] = [];
    for (const [createdAt, badge] of [
      [2000, 5],
      [1000, 3],
    ]) {
      const { listeners, shown } = loadWorker([], { setAppBadge: (count: number) => badges.push(count) }, caches);
      const push = pushEvent({ type: "cloud-notification", eventId: crypto.randomUUID(), title: "Ready", createdAt, badge });
      listeners.get("push")!(push.event);
      await push.completion();
      expect(shown).toHaveLength(1);
    }
    expect(badges).toEqual([5]);
  });

  test.each(["notifications missing", "notifications throw", "caches missing", "caches throw", "cache read throws", "cache write throws"])(
    "still displays and badges when %s",
    async (failure) => {
      const badges: number[] = [];
      const { listeners, shown, worker } = loadWorker([], { setAppBadge: (count: number) => badges.push(count) });
      if (failure === "notifications missing") Reflect.deleteProperty(worker.registration, "getNotifications");
      if (failure === "notifications throw")
        worker.registration.getNotifications = async () => {
          throw new Error("Unavailable");
        };
      if (failure === "caches missing") Reflect.deleteProperty(worker, "caches");
      if (failure === "caches throw")
        worker.caches.open = async () => {
          throw new Error("Unavailable");
        };
      if (failure === "cache read throws" || failure === "cache write throws") {
        const cache = await worker.caches.open("cloud-notification-state");
        if (failure === "cache read throws")
          cache.match = async () => {
            throw new Error("Unavailable");
          };
        else
          cache.put = async () => {
            throw new Error("Unavailable");
          };
        worker.caches.open = async () => cache;
      }
      const push = pushEvent({
        type: "cloud-notification",
        eventId: crypto.randomUUID(),
        title: "Ready",
        group: "chat:one",
        createdAt: 1000,
        badge: 3,
      });
      listeners.get("push")!(push.event);
      await push.completion();
      expect(shown).toHaveLength(1);
      expect(badges).toEqual([3]);
    },
  );

  test.each([3, 0])("sets or clears the app badge for count %i within waitUntil", async (badge) => {
    const calls: unknown[] = [];
    let badgeStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      badgeStarted = resolve;
    });
    let completeBadge: () => void = () => {};
    const badgeDone = new Promise<void>((resolve) => {
      completeBadge = resolve;
    });
    const { listeners, shown } = loadWorker([], {
      setAppBadge: (count: number) => {
        calls.push(count);
        badgeStarted();
        return badgeDone;
      },
      clearAppBadge: () => {
        calls.push("clear");
        badgeStarted();
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
    await started;
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
    ...[null, "1", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map((createdAt) => ({ createdAt })),
  ])("rejects invalid grouping, badge, or timestamp metadata: %j", (metadata) => {
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
