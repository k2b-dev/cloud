import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { SearchItem } from "../api/search/schemas";

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
  test("keeps matching navigation below priority-zero resources and opens its exact route", async () => {
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
      expect(buttons[0]!.textContent).toContain("Zebra QR note");
      expect(buttons[1]!.textContent).toContain("QR generator");
      expect(buttons[1]!.textContent).toContain("Create a code for a link.");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(dom.root.querySelector(".cloud-resource-search__preview p")?.textContent).toBe("Create a code for a link.");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(selected.at(-1)?.href).toBe("/tools/qr");
      buttons[1]!.click();
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
  test("context actions precede results in an empty scoped search and follow content when typing", async () => {
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
      await waitFor(() => dom.root.querySelector('[role="option"]')?.textContent?.includes("Task notes") ?? false, "content first");
      expect(dom.root.querySelectorAll('[role="option"]')[1]?.textContent).toContain("Complete task");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
