import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const searchResponse = (title: string) =>
  Response.json({
    query: title.toLowerCase(),
    count: 1,
    apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }],
    items: [
      {
        appId: "notebooks",
        appName: "Notebooks",
        appIcon: "ti ti-notebook",
        readable: true,
        ref: { type: "notebooks.note", id: title.toLowerCase() },
        title,
        href: `/app/notebooks/${title.toLowerCase()}`,
        preview: `${title} preview`,
      },
    ],
  });

const catalogResponse = () =>
  Response.json({
    query: "",
    count: 0,
    apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }],
    items: [],
  });

describe("GlobalSearchDialog query lifecycle", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("keeps last-good results during refresh and renders one loading indicator", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ signal: init?.signal as AbortSignal, response });
      return response.promise;
    }) as typeof fetch;

    const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(() => <GlobalSearchDialog close={() => {}} />, dom.root);

    try {
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      await waitFor(() => requests.length === 1, "the app catalog request");
      const quickTags = dom.root.querySelector(".cloud-resource-search__quick")!;
      expect(quickTags.querySelectorAll(".cloud-resource-search__tag-skeleton")).toHaveLength(3);
      requests[0]!.response.resolve(catalogResponse());
      await waitFor(() => !quickTags.querySelector(".cloud-resource-search__tag-skeleton"), "catalog placeholders to clear");
      expect(dom.root.querySelector(".cloud-resource-search__quick")).toBe(quickTags);

      input.value = "alpha";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
      await waitFor(() => requests.length === 2, "the first debounced search");
      requests[1]!.response.resolve(searchResponse("Alpha"));
      await waitFor(() => dom.root.textContent?.includes("Alpha preview") ?? false, "the first result");

      input.value = "beta";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
      await waitFor(() => requests.length === 3, "the refreshed search");

      expect(dom.root.textContent).toContain("Alpha preview");
      const spinners = dom.root.querySelectorAll(".ti-loader-2.animate-spin");
      expect(spinners).toHaveLength(1);
      expect(spinners[0]?.closest("label")?.firstElementChild).toBe(spinners[0]);
      expect(dom.root.querySelector(".cloud-resource-search__input .ti-search")).toBeNull();

      requests[2]!.response.resolve(searchResponse("Beta"));
      await waitFor(() => dom.root.textContent?.includes("Beta preview") ?? false, "the refreshed result");
      expect(dom.root.textContent).not.toContain("Alpha preview");
      expect(dom.root.querySelector(".cloud-resource-search__input .ti-search")).not.toBeNull();
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});

test("Mod+Enter and modified click open a new tab without losing the current search", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => Promise.resolve(searchResponse("Alpha")), { preconnect: originalFetch.preconnect });
  const opened: unknown[][] = [];
  dom.window.open = (...args) => {
    opened.push(args);
    return null;
  };
  let closed = 0;
  const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(() => <GlobalSearchDialog close={() => closed++} />, dom.root);
  try {
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => !!dom.root.querySelector('[role="option"]') && !dom.root.querySelector('[role="status"]'), "fresh results");
    for (const modifier of ["metaKey", "ctrlKey"]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }));
    }
    const row = dom.root.querySelector<HTMLButtonElement>('[role="option"]')!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    row.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    expect(opened).toEqual(Array.from({ length: 4 }, () => ["/app/notebooks/alpha", "_blank", "noopener,noreferrer"]));
    expect(closed).toBe(0);
    expect(input.value).toBe("alpha");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(closed).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
