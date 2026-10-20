import { expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import { invalidateSpacesData } from "./[id]/_components/workspace/workspace-events";

const snapshot = (view: OverviewView): OverviewWork => ({
  view,
  counts: { mine: 1, today: 1, upcoming: 1 },
  items: [
    {
      shortId: "Item01",
      spaceShortId: "Space1",
      spaceName: "Example",
      spaceColor: null,
      title: `${view} task`,
      priority: null,
      startsAt: null,
      endsAt: null,
      deadline: null,
      deadlineAllDay: false,
    },
  ],
});

test.skipIf(isServer)("view invalidation refreshes overview work, counts and activity without clearing visible data", async () => {
  const dom = createDomTestHarness();
  setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; resolve: (response: Response) => void }> = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.pathname.endsWith("/overview/work") && !url.pathname.endsWith("/overview/activity")) {
        throw new Error(`Unexpected request: ${url.pathname}`);
      }
      return new Promise<Response>((resolve) => requests.push({ url, resolve }));
    },
    { preconnect: originalFetch.preconnect },
  );
  const initialWork = snapshot("mine");
  const initialEntry = {
    id: "1",
    space: { id: "Space1", name: "Example", color: "#3b82f6" },
    item: { id: "Item01", title: "mine task" },
    actor: { kind: "system" as const, id: null, displayName: "System", avatarHash: null },
    action: "task.created",
    metadata: {},
    occurrenceCount: 1,
    createdAt: "2026-08-20T10:00:00.000Z",
    lastOccurredAt: "2026-08-20T10:00:00.000Z",
  };
  const updatedWork: OverviewWork = {
    ...initialWork,
    counts: { mine: 2, today: 2, upcoming: 2 },
    items: [...initialWork.items, ...initialWork.items.map((item) => ({ ...item, shortId: "Item02", title: "Created task" }))],
  };
  const { default: SpacesOverview } = await import("./SpacesOverview.island");
  const dispose = render(
    () =>
      createComponent(SpacesOverview, {
        spaces: [],
        initialView: "mine",
        initialWork,
        initialPinnedSpaceIds: [],
        initialActivity: { items: [initialEntry], nextCursor: null },
        initialActivityError: null,
        dateConfig: { locale: "en", timeZone: "UTC" },
      }),
    dom.root,
  );
  try {
    await Bun.sleep(30);
    expect(requests).toHaveLength(0);
    await invalidateSpacesData(["detail"]);
    expect(requests).toHaveLength(0);

    let covered = false;
    const refresh = invalidateSpacesData(["view"]).then(() => {
      covered = true;
    });
    await Bun.sleep(30);
    expect(requests.map(({ url }) => url.pathname).sort()).toEqual(["/api/spaces/overview/activity", "/api/spaces/overview/work"]);
    expect(covered).toBe(false);
    expect(dom.root.querySelector(".spaces-overview-work-list")?.textContent).toContain("mine task");
    expect(dom.root.querySelector(".spaces-overview-activity-list")?.textContent).toContain("Created “mine task” in Example");
    expect(dom.root.textContent).not.toContain("Loading work");
    expect(dom.root.textContent).not.toContain("No activity yet");

    const workRequest = requests.find(({ url }) => url.pathname.endsWith("/overview/work"));
    expect(workRequest?.url.searchParams.get("view")).toBe("mine");
    workRequest?.resolve(Response.json(updatedWork));
    await Bun.sleep(30);
    expect(covered).toBe(false);
    expect(dom.root.querySelector(".spaces-overview-work-list")?.textContent).toContain("Created task");
    expect(Array.from(dom.root.querySelectorAll(".k2b-view-tabs__tab"), (tab) => tab.textContent?.trim())).toEqual([
      "For me2",
      "Today2",
      "Upcoming2",
    ]);
    requests
      .find(({ url }) => url.pathname.endsWith("/overview/activity"))
      ?.resolve(
        Response.json({
          data: [{ ...initialEntry, id: "2", item: { id: "Item02", title: "Created task" } }, initialEntry],
          nextCursor: null,
        }),
      );
    await refresh;
    expect(covered).toBe(true);
    expect(dom.root.querySelector(".spaces-overview-activity-list")?.textContent).toContain("Created “Created task” in Example");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    setSystemTime();
    dom.cleanup();
  }
});

test.skipIf(isServer)("overview keeps SSR work and ignores superseded tab requests, including history navigation", async () => {
  const dom = createDomTestHarness();
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
  dom.window.history.replaceState(null, "", "/app/spaces");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ view: OverviewView; signal?: AbortSignal | null; resolve: (response: Response) => void }> = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.pathname.endsWith("/overview/work")) throw new Error(`Unexpected request: ${url.pathname}`);
      const view = url.searchParams.get("view");
      if (view !== "mine" && view !== "today" && view !== "upcoming") throw new Error("Unexpected view");
      return new Promise<Response>((resolve) => requests.push({ view, signal: init?.signal, resolve }));
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: SpacesOverview } = await import("./SpacesOverview.island");
  const dispose = render(
    () =>
      createComponent(SpacesOverview, {
        spaces: [],
        initialView: "mine",
        initialWork: snapshot("mine"),
        initialPinnedSpaceIds: [],
        initialActivity: { items: [], nextCursor: null },
        initialActivityError: null,
        dateConfig: { locale: "en", timeZone: "UTC" },
      }),
    dom.root,
  );
  const settle = () => Bun.sleep(30);
  const labels: Record<string, string> = { today: "Today", upcoming: "Upcoming" };
  const select = (view: string) => {
    const option = Array.from(dom.root.querySelectorAll<HTMLAnchorElement>(".k2b-view-tabs__tab")).find((link) =>
      link.textContent?.startsWith(labels[view]!),
    );
    expect(option).toBeDefined();
    option!.click();
  };
  try {
    await settle();
    expect(requests).toHaveLength(0);
    expect(dom.root.textContent).toContain("mine task");
    select("today");
    await settle();
    expect(dom.window.location.search).toBe("?view=today");
    expect(dom.root.textContent).not.toContain("mine task");
    expect(dom.root.textContent).toContain("Loading work");
    select("upcoming");
    await settle();
    expect(requests[0]!.signal?.aborted).toBe(true);
    requests[1]!.resolve(Response.json(snapshot("upcoming")));
    await settle();
    requests[0]!.resolve(Response.json(snapshot("today")));
    await settle();
    expect(dom.root.textContent).toContain("upcoming task");
    expect(dom.root.textContent).not.toContain("today task");
    dom.window.history.replaceState(null, "", "/app/spaces?view=today");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
    expect(requests[2]!.view).toBe("today");
    requests[2]!.resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
    await settle();
    expect(dom.root.textContent).toContain("Could not load work");
    expect(dom.root.textContent).not.toContain("upcoming task");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    dom.cleanup();
  }
});
