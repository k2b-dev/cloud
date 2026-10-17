import { expect, test } from "bun:test";
import { delegateEvents, isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { SearchItem, SearchStreamLine } from "../api/search/schemas";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const selected: SearchItem = {
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  ref: { type: "notebooks.note", id: "quarter-three" },
  readable: true,
  title: "Q3 planning",
  preview: "The third quarter",
  href: "/notebooks/quarter-three",
};
const stream = () => {
  const lines: SearchStreamLine[] = [
    { type: "start", query: "q3", apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }], providers: ["notebooks"] },
    { type: "provider", provider: "notebooks", status: "ok", results: [selected], ms: 0 },
    { type: "done", status: "complete", count: 1 },
  ];
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
};

if (isServer) {
  test.skip("runs with browser export conditions", () => {});
} else {
  test("opens a scoped picker with its query, streams matches, confirms a choice and cancels", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return stream();
      },
      { preconnect: originalFetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openCloudResourcePicker } = await import("./resource-picker");
    delegateEvents(["input", "click", "keydown"]);
    const options = {
      scope: { appId: "notebooks", tag: "note", label: "Notizen · Notebooks", icon: "ti ti-notebook" },
      query: "q3",
      initialAppId: "mail",
      requireReader: true,
    };
    try {
      const result = openCloudResourcePicker(options);
      await waitFor(() => Boolean(dom.document.querySelector("section button")), "streamed picker result");
      const url = new URL(requests[0]!, "http://localhost");
      expect(url.pathname).toBe("/api/search");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ app: "notebooks", scope_tag: "note", q: "q3", require_reader: "true" });
      expect(dom.document.querySelector<HTMLInputElement>("input[role=combobox]")?.value).toBe("q3");
      const chip = dom.document.querySelector<HTMLButtonElement>('button[title="Notizen · Notebooks"]');
      expect(chip?.textContent).toContain("Notizen · Notebooks");
      expect(chip?.querySelector("i.ti-notebook")).not.toBeNull();
      dom.document.querySelector<HTMLButtonElement>("section button")!.click();
      const add = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Add")!;
      expect(add.disabled).toBe(false);
      add.click();
      expect(await result).toEqual(selected);

      const escaped = openCloudResourcePicker(options);
      dom.document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      // Happy DOM does not turn Escape into the native dialog's cancel event.
      dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
      expect(await escaped).toBeUndefined();
      const closed = openCloudResourcePicker(options);
      dom.document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click();
      expect(await closed).toBeUndefined();
    } finally {
      dialogCore.close();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  for (const initialAppId of [undefined, "notebooks"]) {
    test(`prefills a query without an explicit scope (${initialAppId ?? "all apps"})`, async () => {
      const dom = createDomTestHarness();
      const originalFetch = globalThis.fetch;
      const requests: string[] = [];
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return stream();
        },
        { preconnect: originalFetch.preconnect },
      );
      const { dialogCore } = await import("@k2b/ui");
      const { openCloudResourcePicker } = await import("./resource-picker");
      try {
        const result = openCloudResourcePicker({ query: "q3", initialAppId });
        await waitFor(() => Boolean(dom.document.querySelector("section button")), "query results");
        const params = new URL(requests[0]!, "http://localhost").searchParams;
        expect(params.get("q")).toBe("q3");
        expect(params.get("app")).toBe(initialAppId ?? null);
        expect(dom.document.querySelector<HTMLInputElement>("input")?.value).toBe("q3");
        if (initialAppId) expect(dom.document.querySelector('button[title="Notebooks"]')).not.toBeNull();
        dom.document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click();
        expect(await result).toBeUndefined();
      } finally {
        dialogCore.close();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }

  test("a prefilled query longer than the search accepts is cut to its 500 characters", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return stream();
      },
      { preconnect: originalFetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openCloudResourcePicker } = await import("./resource-picker");
    try {
      const result = openCloudResourcePicker({ scope: { appId: "notebooks", label: "Notes" }, query: "q".repeat(600) });
      await waitFor(() => requests.length > 0, "the first search");
      expect(new URL(requests[0]!, "http://localhost").searchParams.get("q")).toHaveLength(500);
      expect(dom.document.querySelector<HTMLInputElement>('input[role="combobox"]')!.value).toHaveLength(500);
      dom.document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click();
      expect(await result).toBeUndefined();
    } finally {
      dialogCore.close();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("an app scope starts searching with no query", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return stream();
      },
      { preconnect: originalFetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const { openCloudResourcePicker } = await import("./resource-picker");
    try {
      const result = openCloudResourcePicker({ scope: { appId: "notebooks", label: "Notes" } });
      await waitFor(() => Boolean(dom.document.querySelector("section button")), "app results without query");
      expect(new URL(requests[0]!, "http://localhost").searchParams.get("app")).toBe("notebooks");
      dom.document.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click();
      expect(await result).toBeUndefined();
    } finally {
      dialogCore.close();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
