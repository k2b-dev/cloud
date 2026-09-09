import { expect, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const settle = () => Bun.sleep(25);

domTest("table and app creation retain input after failures and block dismissal while saving", async () => {
  for (const kind of ["table", "app"] as const) {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let respond: ((response: Response) => void) | undefined;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    let dispose = () => {};
    try {
      const { createTableAction } = await import("../sidebar/create-table");
      const { createCustomAppAction } = await import("../sidebar/create-custom-app");
      createRoot((cleanup) => {
        dispose = cleanup;
        void (kind === "table" ? createTableAction({ baseId: "BASE01" }) : createCustomAppAction({ baseId: "BASE01" }))();
      });
      let input = dom.document.querySelector<HTMLInputElement>("input[type=text]")!;
      input.value = "   ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const form = dom.document.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(requests).toBe(0);
      expect(dom.document.body.textContent).toContain("Enter a name.");
      input = dom.document.querySelector<HTMLInputElement>("input[type=text]")!;
      input.value = "Inventory";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      expect(requests).toBe(1);
      dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
      await settle();
      expect(dom.document.contains(form)).toBe(true);
      respond!(Response.json({ message: "Could not save this name" }, { status: 503 }));
      await settle();
      expect(input.value).toBe("Inventory");
      expect(dom.document.body.textContent).toContain("Could not save this name");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      expect(requests).toBe(2);
      respond!(Response.json({ message: "Still unavailable" }, { status: 503 }));
      await settle();
    } finally {
      dialogCore.close();
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  }
});

domTest("hold creation retains its reason and retries in the same dialog", async () => {
  const dom = createDomTestHarness();
  const { dialogCore, panelDialogOptions } = await import("@k2b/ui");
  const { CreatePreservationHoldDialog } = await import("./PreservationHoldsSection");
  let attempts = 0;
  const reasons: string[] = [];
  try {
    void dialogCore.open<void>(
      (close, context) =>
        createComponent(CreatePreservationHoldDialog, {
          baseId: "BASE01",
          close,
          setDismissHandler: context.setDismissHandler,
          save: async (input) => {
            attempts++;
            reasons.push(input.reason);
            throw new Error("Hold save unavailable");
          },
        }),
      panelDialogOptions,
    );
    const reason = dom.document.querySelector<HTMLTextAreaElement>("textarea")!;
    reason.value = "Annual review";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    const form = dom.document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(reason.value).toBe("Annual review");
    expect(dom.document.body.textContent).toContain("Hold save unavailable");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(attempts).toBe(2);
    expect(reasons).toEqual(["Annual review", "Annual review"]);
  } finally {
    dialogCore.close();
    dom.cleanup();
  }
});

domTest("blank and template Base creation preserve the submitted name after a failed request", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ message: "Base creation unavailable" }, { status: 503 }), {
    preconnect: originalFetch.preconnect,
  });
  const { dialogCore } = await import("@k2b/ui");
  const { default: BasesOverview } = await import("../overview/BasesOverview.island");
  let dispose = () => {};
  try {
    dispose = render(
      () =>
        createComponent(BasesOverview, {
          bases: [],
          total: 0,
          limit: 25,
          offset: 0,
          initialQuery: "",
          templates: [
            {
              id: "inventory",
              name: "Inventory",
              description: "Equipment",
              icon: "ti ti-package",
              highlights: ["Tables", "Forms", "Apps"],
            },
          ],
        }),
      dom.root,
    );
    for (const fromTemplate of [false, true]) {
      Array.from(dom.root.querySelectorAll("button"))
        .find((button) =>
          fromTemplate ? button.getAttribute("aria-label") === "Create Inventory base" : button.textContent?.includes("Blank base"),
        )!
        .click();
      const input = dom.document.querySelector<HTMLInputElement>('dialog input[type="text"]')!;
      input.value = "My inventory";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dom.document.querySelector("dialog form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      expect(dom.document.querySelector<HTMLInputElement>('dialog input[type="text"]')!.value).toBe("My inventory");
      expect(dom.document.querySelector("dialog")!.textContent).toContain("Base creation unavailable");
      dialogCore.close();
      await settle();
    }
  } finally {
    dialogCore.close();
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("admin settings display a load error with retry instead of an empty form", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return requests === 1
        ? Response.json({}, { status: 503 })
        : Response.json([
            { key: "grids.max_file_size_mb", kind: "number", value: 20, default: 10, label: "File size", description: "", isCustom: true },
          ]);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { SettingsBody } = await import("./AdminGridsSettings.island");
  let dispose = () => {};
  try {
    dispose = render(() => createComponent(SettingsBody, { close: () => {}, setDismissHandler: () => {} }), dom.root);
    await settle();
    expect(dom.root.textContent).toContain("Failed to load settings.");
    expect(dom.root.textContent).not.toContain("No Grids settings are registered.");
    const retry = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    retry.click();
    await settle();
    expect(requests).toBe(2);
    expect(dom.root.textContent).toContain("Maximum file size");
    expect(dom.root.textContent).not.toContain("Failed to load settings.");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("active holds search and page on the server and a failed release keeps the reason", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const reads: URL[] = [];
  let writes = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes++;
        return Response.json({ message: "Release unavailable" }, { status: 503 });
      }
      const url = new URL(String(input), "http://localhost");
      reads.push(url);
      return Response.json({
        items: [
          {
            id: "HOLD01",
            baseId: "BASE01",
            scope: { type: "base" },
            reason: "Annual review",
            status: "active",
            createdAt: "2026-09-09T12:00:00Z",
            createdByDisplayName: "Admin",
            releaseReason: null,
            releasedAt: null,
            releasedByDisplayName: null,
          },
        ],
        pagination: { page: Number(url.searchParams.get("page")), per_page: 25, total: 101, total_pages: 5 },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { PreservationHoldsSection } = await import("./PreservationHoldsSection");
  const { dialogCore } = await import("@k2b/ui");
  let dispose = () => {};
  try {
    dispose = render(() => createComponent(PreservationHoldsSection, { baseId: "BASE01", onSavingChange: () => {} }), dom.root);
    await settle();
    const button = (text: string) => Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === text)!;
    button("Next").click();
    await settle();
    expect(reads.at(-1)!.searchParams.get("page")).toBe("2");
    const search = dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Annual";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(reads.at(-1)!.searchParams.get("page")).toBe("1");
    expect(reads.at(-1)!.searchParams.get("q")).toBe("Annual");
    expect(dom.root.textContent).not.toContain("Use the CLI");
    button("Release").click();
    await settle();
    const reason = dom.document.querySelector<HTMLTextAreaElement>("textarea")!;
    reason.value = "Review is complete";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    const form = dom.document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(writes).toBe(1);
    expect(reason.value).toBe("Review is complete");
    expect(dom.document.body.textContent).toContain("Release unavailable");
  } finally {
    dialogCore.close();
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
