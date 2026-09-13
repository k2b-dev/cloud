import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { OverviewView, OverviewWork } from "../overview-contracts";

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
    },
  ],
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
  const select = (view: string) => {
    const link = dom.root.querySelector<HTMLAnchorElement>(`a[href="/app/spaces?view=${view}"]`);
    expect(link).not.toBeNull();
    link!.click();
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
