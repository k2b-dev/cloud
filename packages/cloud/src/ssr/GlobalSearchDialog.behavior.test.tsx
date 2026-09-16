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

const commandCatalogResponse = () => Response.json({ protocolVersion: 2, apps: [], page: { hasMore: false } });

const catalogResponse = () =>
  Response.json({
    query: "",
    count: 0,
    apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }],
    items: [],
  });

test("context commands replace their catalog entry and expose only the active shortcut", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const command = {
    localId: "note.compose",
    title: "New note",
    description: "Choose a notebook",
    keywords: [],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    path: "/app/notebooks",
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      String(input).includes("/capabilities/v1/catalog")
        ? Response.json({
            protocolVersion: 2,
            apps: [
              {
                appId: "notebooks",
                appName: "Notebooks",
                appDescription: "",
                appIcon: "ti ti-notebook",
                manifest: {
                  protocolVersion: 2,
                  appId: "notebooks",
                  manifestHash: "0".repeat(64),
                  types: [],
                  queries: [],
                  actions: [],
                  commands: [command, { ...command, localId: "other", title: "Another action" }],
                },
              },
            ],
            page: { hasMore: false },
          })
        : catalogResponse(),
    { preconnect: originalFetch.preconnect },
  );
  const { registerContextAwareCommand } = await import("../browser/command-bridge");
  const remove = registerContextAwareCommand({
    id: "notebooks.note.compose",
    title: "New note",
    description: "Daily Journal",
    shortcut: "ctrl+alt+n",
    action: () => {},
  });
  const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(() => <GlobalSearchDialog close={() => {}} />, dom.root);
  try {
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.value = ">";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => dom.root.textContent?.includes("Another action") ?? false, "catalog commands");
    const notes = () => Array.from(dom.root.querySelectorAll('[role="option"]')).filter((row) => row.textContent?.includes("New note"));
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.textContent).toContain("Daily Journal");
    expect(notes()[0]?.querySelector("kbd")?.textContent).toContain("N");
    remove();
    await waitFor(() => notes()[0]?.textContent?.includes("Choose a notebook") ?? false, "global command after context cleanup");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.querySelector("kbd")).toBeNull();
  } finally {
    dispose();
    remove();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
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
      if (String(_input).includes("/capabilities/v1/catalog")) return Promise.resolve(commandCatalogResponse());
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
      const controls = Array.from(quickTags.querySelectorAll<HTMLButtonElement>("button"));
      expect(controls.map((button) => button.textContent)).toEqual(["All filters", "Actions"]);
      expect(controls.every((button) => button.dataset.variant === "ghost" && !button.disabled)).toBe(true);
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
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("/capabilities/v1/catalog") ? commandCatalogResponse() : searchResponse("Alpha")),
    { preconnect: originalFetch.preconnect },
  );
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
    await waitFor(() => closed === 1, "normal navigation to close search");
    expect(closed).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("navigation failure preserves the search; retry waits for the handler and ignores duplicate clicks", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      String(input).includes("/capabilities/v1/catalog") ? commandCatalogResponse() : searchResponse("Alpha"),
    { preconnect: originalFetch.preconnect },
  );
  const { registerSearchNavigation } = await import("../browser/search-bridge");
  const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
  let calls = 0;
  let finish!: (value: boolean) => void;
  const stop = registerSearchNavigation(async () => {
    if (++calls === 1) throw new Error("Unsaved content could not be stored");
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  let closed = 0;
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(() => <GlobalSearchDialog close={() => closed++} />, dom.root);
  try {
    const input = dom.root.querySelector<HTMLInputElement>("input")!;
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => Boolean(dom.root.querySelector('[role="option"][aria-disabled="false"]')), "result");
    const row = dom.root.querySelector<HTMLButtonElement>('[role="option"]')!;
    row.click();
    await waitFor(() => Boolean(dom.root.querySelector('[role="alert"]')), "navigation error");
    expect(closed).toBe(0);
    expect(input.value).toBe("alpha");
    row.click();
    row.click();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(closed).toBe(0);
    finish(true);
    await waitFor(() => closed === 1, "navigation completes");
  } finally {
    stop();
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("Command new-tab launch reserves a tab before resolution and preserves the palette", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const resolution = deferred<Response>();
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      if (String(input).includes("/capabilities/v1/commands/")) return resolution.promise;
      return Promise.resolve(String(input).includes("/capabilities/v1/catalog") ? commandCatalogResponse() : catalogResponse());
    },
    { preconnect: originalFetch.preconnect },
  );
  const opened: unknown[][] = [];
  const destinations: string[] = [];
  const target = { opener: {}, location: { replace: (href: string) => destinations.push(href) }, close: () => {} };
  dom.window.open = (...args) => {
    opened.push(args);
    return target as unknown as ReturnType<typeof dom.window.open>;
  };
  const { registerContextAwareCommand } = await import("../browser/command-bridge");
  const remove = registerContextAwareCommand({
    id: "compose.current",
    title: "Compose for current item",
    description: "Open the form.",
    action: { command: "demo.compose", input: {} },
  });
  const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
  let closed = 0;
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(() => <GlobalSearchDialog close={() => closed++} />, dom.root);
  try {
    await waitFor(() => Boolean(dom.root.querySelector('[role="option"]')), "context action");
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    expect(opened).toEqual([["about:blank", "_blank"]]);
    expect(target.opener).toBeNull();
    expect(destinations).toEqual([]);
    resolution.resolve(Response.json({ href: "https://configured.example/app/demo?command=demo.compose" }));
    await waitFor(() => destinations.length === 1, "resolved Command link");
    expect(destinations).toEqual(["https://configured.example/app/demo?command=demo.compose"]);
    expect(closed).toBe(0);
  } finally {
    dispose();
    remove();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("search actions replace scope and command text in place, keep focus and never open a tab", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const originalOpen = window.open;
  let opened = 0;
  window.open = () => {
    opened++;
    return null;
  };
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return String(input).includes("/capabilities/v1/catalog") ? commandCatalogResponse() : catalogResponse();
    },
    { preconnect: originalFetch.preconnect },
  );
  const { createSignal } = await import("solid-js");
  const { registerGlobalSearchHost } = await import("../browser/search-bridge");
  const { registerContextAwareCommand } = await import("../browser/commands");
  const { default: GlobalSearchDialog } = await import("./GlobalSearchDialog");
  const [request, setRequest] = createSignal<import("../browser/search-bridge").GlobalSearchOptions>({});
  const stopHost = registerGlobalSearchHost((options) => setRequest({ ...options }));
  const stopCommand = registerContextAwareCommand({
    id: "assistant.search",
    title: "Search chats",
    description: "Find chat content",
    action: { search: { scope: { ref: { type: "assistant.chat", id: "Chat01" }, label: "Planning" } } },
  });
  let closes = 0;
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(
    () => (
      <GlobalSearchDialog
        request={request()}
        close={() => {
          closes++;
        }}
      />
    ),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.focus();
    input.value = ">Search chats";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => Boolean(dom.root.querySelector('[role="option"]')), "search action");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await Bun.sleep(10);
    expect(opened).toBe(0);
    expect(input.value).toBe(">Search chats");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => input.value === "", "in-place scope switch");
    expect(closes).toBe(0);
    expect(dom.root.querySelector('input[role="combobox"]')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(dom.root.querySelector(".cloud-resource-search__tag")?.textContent).toContain("Planning");
    await waitFor(() => requests.some((url) => url.includes("scope_id=Chat01")), "scoped request");
    dom.root.querySelector<HTMLButtonElement>(".cloud-resource-search__tag")!.click();
    await waitFor(() => !dom.root.querySelector(".cloud-resource-search__tag"), "scope removed");
    expect(closes).toBe(0);
  } finally {
    dispose();
    stopCommand();
    stopHost();
    window.open = originalOpen;
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
