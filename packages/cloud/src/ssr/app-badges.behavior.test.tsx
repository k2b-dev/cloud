import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { refreshAppBadges } from "../browser/app-badges";
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
let responses: Record<string, () => Response>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const requested = () => fetchSpy.mock.calls.map(([url]) => String(url));
const settle = () => Bun.sleep(10);
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
      async (input: string | URL | Request) => {
        const respond = responses[String(input)];
        if (!respond) throw new Error(`Unexpected request ${String(input)}`);
        return respond();
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});

afterEach(() => {
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
    visibility = "hidden";
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    refreshAppBadges();
    await settle();
    expect(requested()).toEqual([]);

    visibility = "visible";
    setSystemTime(start + 59_000);
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    expect(requested()).toEqual([]);

    setSystemTime(start + 60_000);
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    expect(requested().sort()).toEqual(["/api/chat/badge", "/api/notes/badge"]);
  } finally {
    dispose();
  }
});

test("a newer read cancels an older one, so a late answer never overwrites a newer count", async () => {
  const dispose = await mountRail();
  try {
    await settle();
    let release: (() => void) | undefined;
    responses["/api/chat/badge"] = () => Response.json({ count: 5 });
    fetchSpy.mockImplementationOnce(
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          init?.signal?.throwIfAborted();
          return responses[String(input)]!();
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    refreshAppBadges();
    responses["/api/chat/badge"] = () => Response.json({ count: 9 });
    refreshAppBadges();
    await settle();
    expect(badgeText(railLink("Chat"))).toBe("9");
    release?.();
    await settle();
    expect(badgeText(railLink("Chat"))).toBe("9");
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

test("the app grid shows the same count on the icon and tells screen readers", async () => {
  const disposeRail = await mountRail();
  const { AppLaunchpadPanel } = await import("./AppLaunchpadPanel");
  const grid = dom.window.document.createElement("div");
  dom.window.document.body.append(grid);
  const disposeGrid = render(
    () => createComponent(AppLaunchpadPanel, { apps, legalLinks: [], close: () => {} }),
    grid as unknown as HTMLElement,
  );
  try {
    await settle();
    const chat = grid.querySelector('a[href="/app/chat"]')!;
    expect(chat.querySelector(".app-icon > .cloud-app-badge")?.textContent).toBe("3");
    expect(chat.textContent).toBe("3Chat, 3 new");
    const mail = grid.querySelector('a[href="/app/mail"]')!;
    expect(mail.querySelector(".cloud-app-badge")).toBeNull();
    expect(mail.textContent).toBe("Mail");
  } finally {
    disposeGrid();
    disposeRail();
  }
});
