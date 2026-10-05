import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { SearchItem, SearchStreamLine } from "../api/search/schemas";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const item = (id: string): SearchItem => ({
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  readable: true,
  ref: { type: "notebooks.note", id },
  title: id,
  href: `/app/notebooks/${id}`,
  preview: `${id} preview`,
});

describe("CloudResourceSearch selection", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("applies picker filters and returns the selected resource", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return Response.json({
        query: "",
        count: 2,
        apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }],
        items: [item("existing"), item("selectable")],
      });
    }) as typeof fetch;

    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    let selected: SearchItem | undefined;
    const dispose = render(
      () => (
        <CloudResourceSearch
          onClose={() => {}}
          selectionMode
          initialAppId="notebooks"
          requireReader
          excludeRefs={[{ type: "notebooks.note", id: "existing" }]}
          onSelect={(item) => {
            selected = item;
          }}
        />
      ),
      dom.root,
    );

    try {
      await waitFor(() => dom.root.textContent?.includes("selectable preview") ?? false, "the filtered result");
      expect(requests[0]).toBe("/api/search?provider_limit=10&app=notebooks&require_reader=true");
      expect(dom.root.textContent).not.toContain("existing preview");

      dom.root.querySelector<HTMLButtonElement>("section button")!.click();
      expect(selected).toBeUndefined();
      const confirm = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add")!;
      expect(confirm.disabled).toBe(false);
      confirm.click();
      expect(selected?.ref).toEqual({ type: "notebooks.note", id: "selectable" });
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
  test("shows matching pages at once above streamed resources and opens its exact route", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          query: "qr",
          count: 1,
          apps: [],
          items: [item("Zebra QR note")],
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const selected: SearchItem[] = [];
    const dispose = render(
      () => (
        <CloudResourceSearch
          onClose={() => {}}
          navigationItems={[
            {
              appId: "tools",
              appName: "Tools",
              appIcon: "ti ti-tools",
              readable: false,
              ref: { type: "cloud.navigation", id: "tools:/tools/qr" },
              title: "QR generator",
              preview: "Create a code for a link.",
              href: "/tools/qr",
              keywords: ["qr code"],
              priority: 0,
            },
          ]}
          onSelect={(result) => {
            selected.push(result);
          }}
        />
      ),
      dom.root,
    );
    try {
      const input = dom.root.querySelector<HTMLInputElement>("input[role=combobox]")!;
      input.value = "qr";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => dom.root.querySelectorAll("section button").length === 2, "resource and navigation results");
      const buttons = dom.root.querySelectorAll<HTMLButtonElement>("section button");
      expect(buttons[0]!.textContent).toContain("QR generator");
      expect(buttons[0]!.textContent).toContain("Create a code for a link.");
      expect(buttons[1]!.textContent).toContain("Zebra QR note");
      expect(dom.root.querySelector(".cloud-resource-search__preview p")?.textContent).toBe("Create a code for a link.");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(selected.at(-1)?.href).toBe("/tools/qr");
      buttons[0]!.click();
      expect(selected).toHaveLength(2);
      expect(selected.at(-1)?.href).toBe("/tools/qr");
      input.value = "unmatched";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => !dom.root.textContent?.includes("QR generator"), "navigation filtering");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});

const catalog = [
  {
    id: "notebooks",
    name: "Notebooks",
    icon: "ti ti-notebook",
    tags: [{ tag: "note", title: "Notes", description: "Search notes", aliases: ["markdown"] }],
  },
];

if (!isServer) {
  test("discovers picker tags inline, matches aliases, and never requests an unfinished tag", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        requests.push(String(url));
        return Response.json({ query: "", count: 0, items: [], apps: catalog });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: Search } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown", "mouseover"]);
    let closed = false;
    const dispose = render(
      () => (
        <Search
          selectionMode
          onSelect={() => {}}
          onClose={() => {
            closed = true;
          }}
        />
      ),
      dom.root,
    );
    try {
      await waitFor(() => dom.root.textContent?.includes("#note") ?? false, "picker catalog");
      expect(dom.root.querySelector("select")).toBeNull();
      const input = dom.root.querySelector<HTMLInputElement>("input")!;
      input.value = "#mar";
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(dom.root.querySelector('[role="listbox"]')?.textContent).toContain("Notes");
      expect(dom.root.textContent).not.toContain("Unknown filter");
      await Bun.sleep(240);
      expect(requests).toHaveLength(1);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await waitFor(() => requests.some((url) => url.includes("tag=note")), "committed canonical tag");
      expect(input.value).toBe("");
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Remove #note"]')!.click();
      input.value = "#missing";
      input.setSelectionRange(8, 8);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      input.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(input.value).toBe("");
      expect(closed).toBe(false);
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click();
      expect(closed).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("blocks stale selection during debounce, supersedes requests, and keeps the chosen preview stable", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; signal?: AbortSignal | null; resolve: (value: Response) => void }> = [];
    globalThis.fetch = Object.assign(
      (url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          requests.push({ url: String(url), signal: init?.signal, resolve });
        }),
      { preconnect: originalFetch.preconnect },
    );
    const { default: Search } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown", "mouseover"]);
    const selected: SearchItem[] = [];
    const dispose = render(
      () => <Search selectionMode initialAppId="notebooks" onSelect={(item) => selected.push(item)} onClose={() => {}} />,
      dom.root,
    );
    const respond = (index: number, titles: string[]) =>
      requests[index]!.resolve(Response.json({ query: "", apps: catalog, items: titles.map(item), count: titles.length }));
    const result = (index: number) => dom.root.querySelector<HTMLButtonElement>(`[data-result-index="${index}"]`)!;
    const add = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add")!;
    try {
      await waitFor(() => requests.length === 1, "first request");
      respond(0, ["Alpha", "Beta"]);
      await waitFor(() => !!result(1), "results");
      result(0).click();
      result(1).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      expect(dom.root.querySelector("h2")?.textContent).toBe("Alpha");
      expect(add().disabled).toBe(false);
      const input = dom.root.querySelector<HTMLInputElement>("input")!;
      input.value = "gamma";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(add().disabled).toBe(true);
      result(0).click();
      expect(selected).toEqual([]);
      await waitFor(() => requests.length === 2, "gamma request");
      input.value = "delta";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => requests.length === 3, "delta request");
      expect(requests[1]!.signal?.aborted).toBe(true);
      respond(2, ["Delta"]);
      await waitFor(() => result(0)?.textContent?.includes("Delta") ?? false, "latest results");
      respond(1, ["Gamma"]);
      await Bun.sleep(10);
      expect(dom.root.textContent).not.toContain("Gamma");
      result(0).click();
      add().click();
      expect(selected.map((item) => item.title)).toEqual(["Delta"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
  test("retries a failed request without making stale results selectable", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        return requests === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ query: "", apps: catalog, items: [item("Recovered")], count: 1 });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(() => <CloudResourceSearch initialAppId="notebooks" onClose={() => {}} onSelect={() => {}} />, dom.root);
    try {
      await waitFor(() => dom.root.textContent?.includes("currently unavailable") ?? false, "error feedback");
      expect(dom.root.querySelector('[role="option"]')).toBeNull();
      const retry = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Try again",
      )!;
      retry.click();
      await waitFor(() => dom.root.textContent?.includes("Recovered") ?? false, "recovered results");
      expect(requests).toBe(2);
      expect(dom.root.textContent).not.toContain("currently unavailable");
      expect(dom.root.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("false");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}

test("resource context stays visible, preserves ID casing, and can be removed without losing the query", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(new URL(String(input), "http://localhost"));
    return Response.json({ query: "", count: 1, apps: [], items: [item("result")] });
  }) as typeof fetch;
  const { default: Search } = await import("./CloudResourceSearch");
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(
    () => (
      <Search
        request={{ scope: { ref: { type: "notebooks.notebook", id: "AaBb12" }, label: "Daily Journal", icon: "ti ti-notebook" } }}
        onClose={() => {}}
        onSelect={() => {}}
      />
    ),
    dom.root,
  );
  try {
    await waitFor(() => requests.length === 1, "scoped request");
    expect(requests[0]?.searchParams.get("scope_id")).toBe("AaBb12");
    expect(requests[0]?.searchParams.get("scope_type")).toBe("notebooks.notebook");
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.value = "journal";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => requests.length === 2, "scoped text search");
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Search beyond Daily Journal"]')!.click();
    expect(input.value).toBe("journal");
    await waitFor(() => requests.length === 3, "unscoped search");
    expect(requests[2]?.searchParams.get("q")).toBe("journal");
    expect(requests[2]?.searchParams.has("scope_id")).toBe(false);
    expect(requests[2]?.searchParams.has("app")).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("a repeated open replaces context in place and does not show previous-scope results", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const { createSignal } = await import("solid-js");
  const { default: Search } = await import("./CloudResourceSearch");
  const [request, setRequest] = createSignal<import("./search-bridge").GlobalSearchOptions>({
    scope: { appId: "notebooks", label: "Notebooks" },
  });
  globalThis.fetch = (async (input) => {
    const app = new URL(String(input), "http://localhost").searchParams.get("app");
    return Response.json({ query: "", count: 1, apps: [], items: [{ ...item(app ?? "global"), appId: app }] });
  }) as typeof fetch;
  const dispose = render(() => <Search request={request()} onClose={() => {}} onSelect={() => {}} />, dom.root);
  try {
    await waitFor(() => dom.root.textContent?.includes("notebooks preview") ?? false, "initial results");
    const originalInput = dom.root.querySelector("input");
    setRequest({ scope: { appId: "spaces", label: "Spaces" } });
    await Promise.resolve();
    expect(dom.root.textContent).not.toContain("notebooks preview");
    await waitFor(() => dom.root.textContent?.includes("spaces preview") ?? false, "new context results");
    expect(dom.root.querySelector("input")).toBe(originalInput);
    expect(dom.root.querySelector('[aria-label="Search beyond Spaces"]')).not.toBeNull();
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test("public navigation search browses and filters Tools without calling authenticated resource APIs", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return new Response(null, { status: 401 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
  const selected: SearchItem[] = [];
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(
    () => (
      <CloudResourceSearch
        request={{ scope: { appId: "tools", label: "Tools" } }}
        searchResources={false}
        navigationItems={[
          {
            ...item("QR Code"),
            appId: "tools",
            appName: "Tools",
            ref: { type: "cloud.navigation", id: "tools:qr" },
            href: "/tools/qr",
            readable: false,
          },
        ]}
        onSelect={(value) => selected.push(value)}
        onClose={() => {}}
      />
    ),
    dom.root,
  );
  try {
    await waitFor(() => !!dom.root.querySelector('[role="option"]'), "public tools");
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.value = "qr";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => !!dom.root.querySelector('[role="option"][aria-disabled="false"]'), "public match");
    dom.root.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    expect(selected[0]?.href).toBe("/tools/qr");
    expect(requests).toBe(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

if (!isServer)
  test("context actions are visible but never implicitly selected; > discovers global actions", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ query: "", count: 0, apps: [], items: [] }), { preconnect: () => {} });
    const { createSignal } = await import("solid-js");
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const [contextVisible, setContextVisible] = createSignal(true);
    const calls: string[] = [];
    const context = { id: "done", title: "Complete Summer party", description: "The current task", context: true, action: () => {} };
    const globalCommand = {
      id: "spaces.task.compose",
      title: "New task",
      description: "Create in Spaces",
      action: { command: "spaces.task.compose", input: {} },
    };
    const dispose = render(
      () => (
        <CloudResourceSearch
          onClose={() => {}}
          onSelect={() => {}}
          commands={[...(contextVisible() ? [context] : []), globalCommand]}
          onCommand={(command) => calls.push(command.id)}
        />
      ),
      dom.root,
    );
    try {
      await waitFor(() => dom.root.textContent?.includes("Complete Summer party") ?? false, "context action");
      const input = dom.root.querySelector<HTMLInputElement>("input")!;
      expect(dom.root.textContent).not.toContain("New task");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toEqual([]);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toEqual(["done"]);
      setContextVisible(false);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toEqual(["done"]);
      input.value = ">";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => dom.root.textContent?.includes("New task") ?? false, "command catalog");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toEqual(["done"]);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(calls).toEqual(["done", "spaces.task.compose"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("resource pickers never expose Commands even if a caller passes them", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ query: "", count: 0, apps: [], items: [] }), { preconnect: () => {} });
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    const dispose = render(
      () => (
        <CloudResourceSearch
          selectionMode
          onClose={() => {}}
          onSelect={() => {}}
          commands={[{ id: "done", title: "Complete Summer party", description: "Current", context: true, action: () => {} }]}
          onCommand={() => {
            throw new Error("Picker must not run Commands");
          }}
        />
      ),
      dom.root,
    );
    try {
      await Bun.sleep(10);
      expect(dom.root.textContent).not.toContain("Complete Summer party");
      expect(dom.root.querySelector('[aria-selected="true"]')).toBeNull();
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("context actions stay above results, and typing selects the first result instead of an action", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ query: "", count: 1, apps: [], items: [item("Task notes")] }), {
      preconnect: originalFetch.preconnect,
    });
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input"]);
    const dispose = render(
      () => (
        <CloudResourceSearch
          onClose={() => {}}
          onSelect={() => {}}
          initialAppId="notebooks"
          commands={[{ id: "done", title: "Complete task", description: "Current item", context: true, action: () => {} }]}
          onCommand={() => {}}
        />
      ),
      dom.root,
    );
    try {
      await waitFor(() => dom.root.querySelectorAll('[role="option"]').length === 2, "scoped contents");
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("Complete task");
      expect(dom.root.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      input.value = "task";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(
        () => dom.root.querySelector('[role="option"][aria-selected="true"]')?.textContent?.includes("Task notes") ?? false,
        "first result selected",
      );
      expect(dom.root.querySelector('[role="option"]')?.textContent).toContain("Complete task");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("late Commands preserve the keyboard-selected resource; explicit Command filters support Enter", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => Response.json({ query: "", count: 3, apps: [], items: [item("First"), item("Second"), item("Third")] }),
      { preconnect: originalFetch.preconnect },
    );
    const { createSignal } = await import("solid-js");
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    const command = {
      id: "spaces.task.compose",
      title: "New task",
      description: "Create in Spaces",
      action: { command: "spaces.task.compose", input: {} },
    };
    const [commands, setCommands] = createSignal<(typeof command)[]>([]);
    const selected: string[] = [];
    delegateEvents(["input", "keydown"]);
    const dispose = render(
      () => (
        <CloudResourceSearch
          initialAppId="notebooks"
          commands={commands()}
          onCommand={(command) => selected.push(command.id)}
          onSelect={(item) => selected.push(item.ref.id)}
          onClose={() => {}}
        />
      ),
      dom.root,
    );
    try {
      await waitFor(() => dom.root.querySelectorAll('[role="option"]').length === 3, "resources");
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      const key = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      key("ArrowDown");
      key("ArrowDown");
      setCommands([command]);
      key("Enter");
      expect(selected).toEqual(["Third"]);
      input.value = "> new task";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => dom.root.querySelectorAll('[role="option"]').length === 1, "filtered command");
      key("Enter");
      expect(selected).toEqual(["Third", "spaces.task.compose"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("context reordering follows the selected identity and removing it does not select another action", async () => {
    const dom = createDomTestHarness();
    const { createSignal } = await import("solid-js");
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    const first = { id: "first", title: "First", description: "Current", context: true, action: () => {} };
    const second = { ...first, id: "second", title: "Second" };
    const [commands, setCommands] = createSignal([first, second]);
    const selected: string[] = [];
    delegateEvents(["keydown"]);
    const dispose = render(
      () => (
        <CloudResourceSearch
          searchResources={false}
          commands={commands()}
          onCommand={(command) => selected.push(command.id)}
          onSelect={() => {}}
          onClose={() => {}}
        />
      ),
      dom.root,
    );
    try {
      await waitFor(() => dom.root.querySelectorAll('[role="option"]').length === 2, "context commands");
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      const key = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      key("ArrowDown");
      setCommands([second, first]);
      key("Enter");
      expect(selected).toEqual(["first"]);
      setCommands([second]);
      key("Enter");
      expect(selected).toEqual(["first"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

test("provider contexts use one chip, replace in place, and clear their hidden filter with the chip", async () => {
  if (isServer) return;
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const { createSignal } = await import("solid-js");
  const { default: Search } = await import("./CloudResourceSearch");
  const [request, setRequest] = createSignal<import("./search-bridge").GlobalSearchOptions>({
    scope: { appId: "assistant", tag: "assistant-project", label: "Projects" },
    query: "",
  });
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(url);
      const name = url.searchParams.get("scope_tag") === "studio-app" ? "Studio result" : "Project result";
      return Response.json({ query: "", count: 1, apps: [], items: [item(name)] });
    },
    { preconnect: originalFetch.preconnect },
  );
  delegateEvents(["input", "click", "keydown"]);
  const dispose = render(() => <Search request={request()} onClose={() => {}} onSelect={() => {}} />, dom.root);
  try {
    await waitFor(() => dom.root.textContent?.includes("Project result") ?? false, "project results");
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input.value).toBe("");
    expect(dom.root.querySelectorAll(".cloud-resource-search__tag")).toHaveLength(1);
    expect(dom.root.textContent).not.toContain("#assistant-project");
    expect(requests[0]?.searchParams.get("scope_tag")).toBe("assistant-project");
    expect(requests[0]?.searchParams.has("tag")).toBe(false);
    setRequest({ scope: { appId: "assistant", tag: "studio-app", label: "Studio" }, query: "" });
    await Promise.resolve();
    expect(dom.root.textContent).not.toContain("Project result");
    expect(dom.root.querySelector("input")).toBe(input);
    await waitFor(() => dom.root.textContent?.includes("Studio result") ?? false, "studio results");
    expect(dom.root.querySelectorAll(".cloud-resource-search__tag")).toHaveLength(1);
    input.value = "planner";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => requests.at(-1)?.searchParams.get("q") === "planner", "search text");
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Search beyond Studio"]')!.click();
    expect(input.value).toBe("planner");
    expect(dom.root.querySelectorAll(".cloud-resource-search__tag")).toHaveLength(0);
    await waitFor(() => !requests.at(-1)?.searchParams.has("app"), "global search");
    expect(requests.at(-1)?.searchParams.has("scope_tag")).toBe(false);
    expect(requests.at(-1)?.searchParams.get("q")).toBe("planner");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

/** A search response the test writes line by line, as Core streams it. */
const lineStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } }),
    write: (line: SearchStreamLine) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
    close: () => controller.close(),
  };
};
const streamApps = [
  { id: "files", name: "Files", icon: "ti ti-folder" },
  { id: "mail", name: "Mail", icon: "ti ti-mail" },
  { id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" },
];
const found = (appId: string, title: string): SearchItem => ({
  ...item(title),
  appId,
  appName: streamApps.find((app) => app.id === appId)!.name,
  ref: { type: `${appId}.item`, id: title },
  href: `/app/${appId}/${title}`,
});
const providerLine = (provider: string, results: SearchItem[], status = results.length ? "ok" : "empty"): SearchStreamLine => ({
  type: "provider",
  provider,
  status: status as "ok",
  results,
  ms: 5,
});
const politeAnnouncements = () => document.querySelector('[data-k2b-live] [data-politeness="polite"]')?.textContent ?? "";

describe("streamed search results", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async (props: Partial<import("./CloudResourceSearch").CloudResourceSearchProps> = {}) => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: URL; signal?: AbortSignal | null; stream: ReturnType<typeof lineStream> }> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("accept")).toBe("application/x-ndjson");
        const stream = lineStream();
        requests.push({ url: new URL(String(input), "http://localhost"), signal: init?.signal, stream });
        return stream.response;
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: CloudResourceSearch } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const selected: SearchItem[] = [];
    const dispose = render(
      () => <CloudResourceSearch onClose={() => {}} onSelect={(value) => selected.push(value)} {...props} />,
      dom.root,
    );
    const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const type = async (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => requests.at(-1)?.url.searchParams.get("q") === text, `search for ${text}`);
      return requests.at(-1)!.stream;
    };
    const rows = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const status = () => dom.root.querySelector(".cloud-resource-search__status")?.textContent ?? "";
    return {
      dom,
      requests,
      selected,
      input,
      type,
      rows,
      status,
      cleanup: () => {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      },
    };
  };

  test("shows a fast app at once, appends a slow one below, and keeps the keyboard selection", async () => {
    const view = await setup();
    try {
      const stream = await view.type("plan");
      stream.write({ type: "start", query: "plan", apps: streamApps, providers: ["files", "mail", "notebooks"] });
      await waitFor(() => view.status().includes("Files, Mail, and Notebooks are still searching…"), "all apps searching");
      expect(view.dom.root.textContent).not.toContain("No matches");

      stream.write(providerLine("files", [found("files", "Plan.pdf"), found("files", "Plan v2.pdf")]));
      await waitFor(() => view.rows().length === 2, "the fast app");
      expect(view.status()).toContain("Mail and Notebooks are still searching…");
      // Arrived rows can be opened while the others still search.
      expect(view.rows()[0]!.getAttribute("aria-disabled")).toBe("false");
      const [first, second] = view.rows();
      view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(second!.getAttribute("aria-selected")).toBe("true");

      stream.write(providerLine("notebooks", []));
      stream.write(providerLine("mail", [found("mail", "Plan for Monday")]));
      await waitFor(() => view.rows().length === 3, "the slow app");
      // The rows already shown are the same elements in the same place; the new section only follows them.
      expect(view.rows().slice(0, 2)).toEqual([first!, second!]);
      expect(view.rows()[2]!.textContent).toContain("Plan for Monday");
      expect(Array.from(view.dom.root.querySelectorAll(".cloud-resource-search__group")).map((group) => group.textContent)).toEqual([
        "Files",
        "Mail",
      ]);
      expect(second!.getAttribute("aria-selected")).toBe("true");
      expect(politeAnnouncements()).not.toContain("Search complete");

      stream.write({ type: "done", status: "complete", count: 3 });
      stream.close();
      await waitFor(() => view.status() === "", "the status line to leave");
      await waitFor(() => politeAnnouncements().includes("Search complete, 3 results"), "the announcement");
      view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(view.selected.map((value) => value.title)).toEqual(["Plan v2.pdf"]);
    } finally {
      view.cleanup();
    }
  });

  test("says “No matches” only after every app has answered", async () => {
    const view = await setup();
    try {
      const stream = await view.type("zebra");
      stream.write({ type: "start", query: "zebra", apps: streamApps, providers: ["files", "mail"] });
      stream.write(providerLine("files", []));
      await waitFor(() => view.status().includes("Mail is still searching…"), "the remaining app");
      await Bun.sleep(20);
      expect(view.dom.root.textContent).not.toContain("No matches");
      stream.write(providerLine("mail", []));
      stream.write({ type: "done", status: "complete", count: 0 });
      stream.close();
      await waitFor(() => view.dom.root.textContent?.includes("No matches. Try another search term.") ?? false, "no matches");
      expect(view.status()).toBe("");
      await waitFor(() => politeAnnouncements().includes("Search complete, 0 results"), "the announcement");
    } finally {
      view.cleanup();
    }
  });

  test("names an app that timed out and retries only that app", async () => {
    const view = await setup();
    try {
      const stream = await view.type("plan");
      stream.write({ type: "start", query: "plan", apps: streamApps, providers: ["files", "mail"] });
      stream.write(providerLine("files", [found("files", "Plan.pdf")]));
      stream.write(providerLine("mail", [], "timeout"));
      stream.write({ type: "done", status: "partial", count: 1 });
      stream.close();
      await waitFor(() => view.status().includes("Mail did not respond in time"), "the timeout row");
      expect(view.dom.root.textContent).not.toContain("No matches");
      const first = view.rows()[0];
      const searches = view.requests.length;

      Array.from(view.dom.root.querySelectorAll<HTMLButtonElement>(".cloud-resource-search__status button"))
        .find((button) => button.textContent === "Try again")!
        .click();
      await waitFor(() => view.requests.length === searches + 1, "the retry");
      const retry = view.requests.at(-1)!;
      expect(retry.url.searchParams.get("app")).toBe("mail");
      expect(retry.url.searchParams.get("q")).toBe("plan");
      await waitFor(() => view.status().includes("Mail is still searching…"), "the retried app");
      expect(view.status()).not.toContain("did not respond");

      retry.stream.write({ type: "start", query: "plan", apps: streamApps, providers: ["mail"] });
      retry.stream.write(providerLine("mail", [found("mail", "Plan for Monday")]));
      retry.stream.write({ type: "done", status: "complete", count: 1 });
      retry.stream.close();
      await waitFor(() => view.rows().length === 2, "the retried results");
      expect(view.rows()[0]).toBe(first!);
      expect(view.rows()[1]!.textContent).toContain("Plan for Monday");
      expect(view.status()).toBe("");
    } finally {
      view.cleanup();
    }
  });

  test("gives a search narrowed to one app one clear state", async () => {
    const view = await setup({ initialAppId: "mail" });
    try {
      const stream = await view.type("invoice");
      expect(view.requests.at(-1)!.url.searchParams.get("app")).toBe("mail");
      stream.write({ type: "start", query: "invoice", apps: streamApps, providers: ["mail"] });
      await waitFor(() => view.status().includes("Mail is still searching…"), "the narrowed app");
      stream.write(providerLine("mail", []));
      stream.write({ type: "done", status: "complete", count: 0 });
      stream.close();
      await waitFor(() => view.dom.root.textContent?.includes("Mail: no matches for “invoice”") ?? false, "the narrowed empty state");
      expect(view.dom.root.textContent).not.toContain("No matches. Try another search term.");
    } finally {
      view.cleanup();
    }
  });

  test("cancels the running search when the input changes", async () => {
    const view = await setup();
    try {
      const first = await view.type("pla");
      first.write({ type: "start", query: "pla", apps: streamApps, providers: ["files", "mail"] });
      first.write(providerLine("files", [found("files", "Plan.pdf")]));
      await waitFor(() => view.rows().length === 1, "the first results");
      const second = await view.type("plan");
      expect(view.requests.at(-2)!.signal?.aborted).toBeTrue();
      // The previous rows stay visible, but belong to the old input and cannot be chosen.
      expect(view.rows()[0]!.getAttribute("aria-disabled")).toBe("true");
      second.write({ type: "start", query: "plan", apps: streamApps, providers: ["files", "mail"] });
      second.write(providerLine("mail", [found("mail", "Plan for Monday")]));
      await waitFor(() => view.rows()[0]?.textContent?.includes("Plan for Monday") ?? false, "the new results");
      expect(view.rows()).toHaveLength(1);
      expect(view.rows()[0]!.getAttribute("aria-disabled")).toBe("false");
    } finally {
      view.cleanup();
    }
  });
});
