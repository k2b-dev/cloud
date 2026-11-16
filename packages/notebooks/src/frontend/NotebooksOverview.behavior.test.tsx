import { expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const entry = (id: string, title: string) => ({
  id,
  notebook: { id: "Book01", name: "Product", icon: "ti ti-bulb" },
  note: { id: `Note${id}`, title },
  noteVersionId: null,
  actor: { kind: "system" as const, id: null, displayName: "System", avatarHash: null },
  action: "note.edited",
  metadata: {},
  occurrenceCount: 1,
  createdAt: "2026-08-20T10:00:00.000Z",
  lastOccurredAt: "2026-08-20T10:00:00.000Z",
});

test.skipIf(isServer)("a failed older page keeps the rows and says so where Load more was; Try again loads it", async () => {
  const dom = createDomTestHarness();
  setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  const originalFetch = globalThis.fetch;
  const pages: string[] = [];
  let failNext = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.pathname.endsWith("/overview/activity")) throw new Error(`Unexpected request: ${url.pathname}`);
      pages.push(url.searchParams.get("cursor") ?? "");
      if (failNext) {
        failNext = false;
        return Response.json({ message: "Older activity is unavailable" }, { status: 503 });
      }
      return Response.json({ data: [entry("02", "Older note")], nextCursor: null });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: NotebooksOverview } = await import("./NotebooksOverview.island");
  const dispose = render(
    () =>
      createComponent(NotebooksOverview, {
        notebooks: [],
        templates: [],
        recentNotes: [],
        initialActivity: { items: [entry("01", "Newer note")], nextCursor: "next" },
        initialActivityError: null,
        initialPinnedNotebookIds: [],
        dateConfig: { locale: "en", timeZone: "UTC" },
        now: "2026-08-20T12:00:00.000Z",
      }),
    dom.root,
  );
  try {
    const edge = () => dom.root.querySelector<HTMLElement>(".k2b-load-more")!;
    // The edge waits for the reader instead of loading by itself.
    await Bun.sleep(30);
    expect(pages).toEqual([]);
    edge().querySelector("button")!.click();
    await Bun.sleep(30);
    expect(pages).toEqual(["next"]);
    expect(edge().dataset.state).toBe("error");
    expect(edge().textContent).toContain("Older activity is unavailable");
    expect(dom.root.querySelector(".notebooks-overview-activity-alert")).toBeNull();
    expect(dom.root.querySelector(".k2b-activity")?.textContent).toContain("Newer note");

    edge().querySelector("button")!.click();
    await Bun.sleep(30);
    expect(pages).toEqual(["next", "next"]);
    expect(dom.root.querySelector(".k2b-activity")?.textContent).toContain("Older note");
    expect(edge().dataset.state).toBe("done");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    setSystemTime();
    dom.cleanup();
  }
});
