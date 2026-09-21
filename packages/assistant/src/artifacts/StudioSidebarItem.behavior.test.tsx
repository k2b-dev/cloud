import { expect, test } from "bun:test";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test("Studio loads on open, paginates, retries failures and launches scoped search without creation", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { StudioSidebarItem } = await import("./StudioSidebarItem");
  const { artifactClient } = await import("./client");
  const { registerGlobalSearchHost } = await import("@k2b/cloud/browser/testing");
  const original = artifactClient.list;
  const requests: number[] = [],
    searches: unknown[] = [];
  let failure = false;
  artifactClient.list = async (page = 1) => {
    requests.push(page);
    if (failure) throw new Error("offline");
    return {
      items: [
        {
          id: `App00${page}`,
          kind: "app",
          title: `App ${page}`,
          description: "",
          icon: "ti ti-calculator",
          permission: "read",
          revision: 1,
          publishedRevision: 1,
          publishedVersion: 1,
          updatedAt: "",
          forkedFromId: null,
          forkedFromRevision: null,
        },
      ],
      page,
      hasNext: page === 1,
    };
  };
  const release = registerGlobalSearchHost((options) => searches.push(options));
  const dispose = render(() => <StudioSidebarItem active activeAppId="App001" />, dom.root);
  try {
    const panel = dom.root.querySelector<HTMLElement>('[role="dialog"]')!;
    const toggle = (state: string) => {
      const event = new Event("toggle");
      Object.defineProperty(event, "newState", { value: state });
      panel.dispatchEvent(event);
    };
    panel.showPopover = () => toggle("open");
    panel.hidePopover = () => toggle("closed");
    expect(panel.querySelector('[data-viewport-size="compact"]')).not.toBeNull();
    expect(requests).toEqual([]);
    dom.root.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-item-main")!.click();
    await Bun.sleep(0);
    expect(requests).toEqual([1]);
    expect(panel.querySelector('a[href="/app/assistant/apps/App001/run"]')?.getAttribute("aria-current")).toBe("page");
    const button = (label: string) =>
      Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.trim() === label)!;
    button("Next").click();
    await Bun.sleep(0);
    expect(requests).toEqual([1, 2]);
    expect(panel.querySelector('a[href="/app/assistant/apps/App002/run"]')).not.toBeNull();
    expect(button("Next").disabled).toBe(true);
    failure = true;
    button("Back").click();
    await Bun.sleep(0);
    expect(panel.textContent).toContain("Could not load this content");
    expect(panel.querySelector('[data-viewport-size="compact"]')).not.toBeNull();
    failure = false;
    button("Try again").click();
    await Bun.sleep(0);
    expect(panel.textContent).toContain("App 1");
    expect(panel.querySelector(".ti-plus")).toBeNull();
    panel.querySelector<HTMLButtonElement>('[aria-label="Search apps"]')!.click();
    expect(searches).toEqual([{ query: "", scope: { appId: "assistant", tag: "studio-app", label: "Studio", icon: "ti ti-app-window" } }]);
  } finally {
    dispose();
    release();
    artifactClient.list = original;
    dom.cleanup();
  }
});

test("mobile Studio keeps one compact viewport through loading and empty results", async () => {
  const dom = createDomTestHarness();
  const { openStudioDialog } = await import("./StudioSidebarItem");
  const { artifactClient } = await import("./client");
  const original = artifactClient.list;
  let resolve!: (value: Awaited<ReturnType<typeof artifactClient.list>>) => void;
  artifactClient.list = () =>
    new Promise((done) => {
      resolve = done;
    });
  const lifetime = new AbortController();
  const dialog = openStudioDialog({ signal: lifetime.signal });
  try {
    await Bun.sleep(0);
    const viewport = dom.document.querySelector('[data-viewport-size="compact"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.querySelector("[data-viewport-size]")).toBeNull();
    resolve({ items: [], page: 1, hasNext: false });
    await Bun.sleep(0);
    expect(dom.document.querySelector('[data-viewport-size="compact"]')).toBe(viewport);
  } finally {
    lifetime.abort();
    await dialog;
    artifactClient.list = original;
    dom.cleanup();
  }
});
