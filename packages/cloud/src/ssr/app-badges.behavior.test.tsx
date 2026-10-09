import { afterEach, beforeEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { refreshAppBadges } from "../browser/app-badges";
import { APP_BADGE_INTERVAL_MS } from "./app-badges";
import type { RailApp } from "./rail-navigation";

const apps: RailApp[] = [
  {
    id: "chat",
    label: "Chat",
    href: "/app/chat",
    match: "/app/chat",
    iconClass: "ti ti-message",
    defaultVisible: true,
    badge: "/api/chat/badge",
  },
  { id: "mail", label: "Mail", href: "/app/mail", match: "/app/mail", iconClass: "ti ti-mail", defaultVisible: true },
  {
    id: "notes",
    label: "Notes",
    href: "/app/notes",
    match: "/app/notes",
    iconClass: "ti ti-notes",
    defaultVisible: true,
    badge: "/api/notes/badge",
  },
];
const settings = { revision: 0, visibility: {}, shortcuts: [] };

let dom: DomTestHarness;
let visibility: DocumentVisibilityState;
let responses: Record<string, (signal?: AbortSignal) => Response | Promise<Response>>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const requested = () => fetchSpy.mock.calls.map(([url]) => String(url));
const settle = () => Bun.sleep(10);
// Bun.sleep never resolves under fake timers; a fetch answered from memory settles within a few microtasks.
const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
/** An app that never answers until the request is aborted. */
const hang = (signal?: AbortSignal) =>
  new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
const hide = (hidden: boolean) => {
  visibility = hidden ? "hidden" : "visible";
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
};
const railLink = (label: string) => dom.root.querySelector<HTMLAnchorElement>(`a[href="/app/${label.toLowerCase()}"]`)!;
const badgeText = (link: Element) => link.querySelector(".cloud-app-badge")?.textContent ?? null;

beforeEach(() => {
  dom = createDomTestHarness();
  visibility = "visible";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  responses = {
    "/api/chat/badge": () => Response.json({ count: 3 }),
    "/api/notes/badge": () => new Response("unavailable", { status: 503 }),
  };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const respond = responses[String(input)];
        if (!respond) throw new Error(`Unexpected request ${String(input)}`);
        return respond(init?.signal ?? undefined);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});

afterEach(() => {
  jest.useRealTimers();
  fetchSpy.mockRestore();
  setSystemTime();
  dom.cleanup();
});

const mountRail = async () => {
  const { default: RailApps } = await import("./RailApps.island");
  return render(() => createComponent(RailApps, { apps, settings, currentPath: "/app/mail" }), dom.root);
};

test("the rail reads each declared badge once after hydration and shows only positive counts", async () => {
  const dispose = await mountRail();
  try {
    expect(badgeText(railLink("Chat"))).toBeNull();
    await settle();
    expect(requested().sort()).toEqual(["/api/chat/badge", "/api/notes/badge"]);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
    expect(badgeText(railLink("Chat"))).toBe("3");
    expect(railLink("Chat").getAttribute("aria-label")).toBe("Chat, 3 new");
    expect(railLink("Chat").querySelector(".cloud-app-badge")?.getAttribute("aria-hidden")).toBe("true");
    // A failing app and an app without a badge render exactly as before.
    expect(badgeText(railLink("Notes"))).toBeNull();
    expect(railLink("Notes").getAttribute("aria-label")).toBe("Notes");
    expect(railLink("Mail").getAttribute("aria-label")).toBe("Mail");
    expect(railLink("Mail").children).toHaveLength(2);
  } finally {
    dispose();
  }
});

test("large counts show 99+ and a malformed body or zero clears the badge", async () => {
  const dispose = await mountRail();
  try {
    responses["/api/chat/badge"] = () => Response.json({ count: 1234 });
    refreshAppBadges();
    await settle();
    expect(badgeText(railLink("Chat"))).toBe("99+");
    expect(railLink("Chat").getAttribute("aria-label")).toBe("Chat, more than 99 new");
    for (const body of [{ count: 0 }, { count: -1 }, { count: 2.5 }, { count: "4" }, {}, null, [3]]) {
      responses["/api/chat/badge"] = () => Response.json({ count: 7 });
      refreshAppBadges();
      await settle();
      expect(badgeText(railLink("Chat"))).toBe("7");
      responses["/api/chat/badge"] = () => Response.json(body);
      refreshAppBadges();
      await settle();
      expect(badgeText(railLink("Chat"))).toBeNull();
    }
  } finally {
    dispose();
  }
});

test("a hidden tab sends nothing and reads again only when it is visible and the interval has passed", async () => {
  const start = Date.now();
  setSystemTime(start);
  const dispose = await mountRail();
  try {
    await settle();
    fetchSpy.mockClear();
    hide(true);
    refreshAppBadges();
    await settle();
    expect(requested()).toEqual([]);

    setSystemTime(start + 59_000);
    hide(false);
    await settle();
    expect(requested()).toEqual([]);

    setSystemTime(start + 60_000);
    hide(true);
    hide(false);
    await settle();
    expect(requested().sort()).toEqual(["/api/chat/badge", "/api/notes/badge"]);
  } finally {
    dispose();
  }
});

test("a refresh in a hidden tab keeps the scheduled read for when the tab is visible again", async () => {
  jest.useFakeTimers();
  const dispose = await mountRail();
  try {
    await flush();
    fetchSpy.mockClear();
    jest.advanceTimersByTime(10_000);
    hide(true);
    refreshAppBadges();
    jest.advanceTimersByTime(10_000);
    hide(false);
    await flush();
    expect(requested()).toEqual([]);

    jest.advanceTimersByTime(APP_BADGE_INTERVAL_MS - 20_000);
    await flush();
    expect(requested().sort()).toEqual(["/api/chat/badge", "/api/notes/badge"]);
  } finally {
    dispose();
  }
});

test("refreshes while a read runs share one more read after it, so a late answer never overwrites a newer count", async () => {
  const dispose = await mountRail();
  const chatReads = () => requested().filter((url) => url === "/api/chat/badge");
  try {
    await settle();
    fetchSpy.mockClear();
    let release: (() => void) | undefined;
    responses["/api/chat/badge"] = () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json({ count: 5 }));
      });
    refreshAppBadges();
    responses["/api/chat/badge"] = () => Response.json({ count: 9 });
    refreshAppBadges();
    refreshAppBadges();
    await settle();
    expect(chatReads()).toHaveLength(1);
    expect(badgeText(railLink("Chat"))).toBe("3");

    release?.();
    await settle();
    expect(chatReads()).toHaveLength(2);
    expect(badgeText(railLink("Chat"))).toBe("9");
  } finally {
    dispose();
  }
});

test("a slow app delays only its own badge, and its read gives up after the interval", async () => {
  jest.useFakeTimers();
  responses["/api/chat/badge"] = hang;
  responses["/api/notes/badge"] = () => Response.json({ count: 2 });
  const dispose = await mountRail();
  try {
    await flush();
    expect(badgeText(railLink("Notes"))).toBe("2");

    responses["/api/chat/badge"] = () => Response.json({ count: 4 });
    jest.advanceTimersByTime(APP_BADGE_INTERVAL_MS);
    await flush();
    // The scheduled read waits for the stuck one, which the deadline ends.
    expect(requested().filter((url) => url === "/api/chat/badge")).toHaveLength(2);
    expect(badgeText(railLink("Chat"))).toBe("4");
  } finally {
    dispose();
  }
});

test("after the rail unmounts, nothing reads badges any more", async () => {
  const dispose = await mountRail();
  await settle();
  dispose();
  fetchSpy.mockClear();
  refreshAppBadges();
  await settle();
  expect(requested()).toEqual([]);
});

test("the app grid shows the same count on the icon and on a pinned app, and tells screen readers", async () => {
  const disposeRail = await mountRail();
  const railData = dom.window.document.createElement("script");
  railData.id = "cloud-rail-data";
  railData.type = "application/json";
  railData.textContent = JSON.stringify({
    apps,
    settings: { ...settings, shortcuts: [{ id: "pinned-chat", kind: "app", appId: "chat" }] },
  });
  dom.window.document.body.append(railData);
  const { AppLaunchpadPanel } = await import("./AppLaunchpadPanel");
  const grid = dom.window.document.createElement("div");
  dom.window.document.body.append(grid);
  const disposeGrid = render(
    () => createComponent(AppLaunchpadPanel, { apps, legalLinks: [], close: () => {} }),
    grid as unknown as HTMLElement,
  );
  try {
    await settle();
    const chat = grid.querySelector('.launchpad-apps-grid a[href="/app/chat"]')!;
    expect(chat.querySelector(".app-icon > .cloud-app-badge")?.textContent).toBe("3");
    expect(chat.textContent).toBe("3Chat, 3 new");
    const pinned = grid.querySelector('section a[href="/app/chat"]')!;
    expect(pinned.querySelector(".cloud-app-badge")?.textContent).toBe("3");
    expect(pinned.textContent).toBe("3Chat, 3 new");
    const mail = grid.querySelector('.launchpad-apps-grid a[href="/app/mail"]')!;
    expect(mail.querySelector(".cloud-app-badge")).toBeNull();
    expect(mail.textContent).toBe("Mail");
  } finally {
    disposeGrid();
    disposeRail();
  }
});
