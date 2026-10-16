import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import type { ChooseFilesOptions } from "./FileChooser";
import type { FileProviderContext } from "../contracts/file-provider";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { FileProviderSource } from "./file-providers";

const domTest = isServer ? test.skip : test;

const drive: FileProviderSource = {
  appId: "drive",
  name: "Drive",
  icon: "ti ti-folders",
  list: "folder.list",
  context: false,
  read: "file.read",
  maxBytes: 1_000,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The device's dialog as `showFileDialog` opens it: a file input appended to the body. Cancelling it removes it. */
const cancelDeviceDialog = (document: Document) => {
  const input = document.body.querySelector<HTMLInputElement>(':scope > input[type="file"]');
  input?.dispatchEvent(new Event("cancel"));
  return input !== null;
};

domTest("aborting while the FileChooser chunk loads resolves immediately and never opens a late dialog", async () => {
  const dom = createDomTestHarness();
  const { dialogCore } = await import("@k2b/ui");
  const reload = await import("./reload");
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  const pending = Promise.withResolvers<void>();
  const loaded = Promise.withResolvers<void>();
  const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
    await pending.promise;
    const module = await loader();
    loaded.resolve();
    return module;
  });
  const open = spyOn(dialogCore, "open");
  const controller = new AbortController();
  const remove = spyOn(controller.signal, "removeEventListener");
  try {
    const result = createFileChoosing(createProviderList(async () => [drive]))({ signal: controller.signal });
    expect(load).toHaveBeenCalledTimes(1);
    controller.abort();
    // The result must settle while the import is still blocked, within one event-loop turn.
    expect(await Promise.race([result, settle().then(() => "still pending")])).toEqual([]);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(open).not.toHaveBeenCalled();
    pending.resolve();
    await loaded.promise;
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
  } finally {
    controller.abort();
    pending.resolve();
    load.mockRestore();
    open.mockRestore();
    remove.mockRestore();
    dom.cleanup();
  }
});

domTest("a failed on-demand chooser load resolves no files without opening a dialog", async () => {
  const dom = createDomTestHarness();
  const { dialogCore } = await import("@k2b/ui");
  const reload = await import("./reload");
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  const load = spyOn(reload, "importOnDemand").mockResolvedValue(undefined);
  const open = spyOn(dialogCore, "open");
  try {
    const chooseFiles = createFileChoosing(createProviderList(async () => [drive]));
    expect(await chooseFiles()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
  } finally {
    load.mockRestore();
    open.mockRestore();
    dom.cleanup();
  }
});

domTest("a catalog refusal sends Attach to the device's dialog and asks again, so a renewed session finds its apps", async () => {
  const dom = createDomTestHarness();
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  const { FileProviderError } = await import("./file-providers");
  const answers = [() => Promise.reject(new FileProviderError("UNAUTHORIZED", "Sign in", 401)), () => Promise.resolve([drive])];
  let loads = 0;
  const providers = createProviderList(() => answers[loads++]!());
  const chooseFiles = createFileChoosing(providers);
  try {
    providers.prefetch();
    await settle();
    expect(loads).toBe(1);

    // Refused: no chooser that could only show an error, the device's dialog opens at once.
    const refusedChoice = chooseFiles();
    expect(dom.document.querySelector("dialog[open]")).toBeNull();
    expect(cancelDeviceDialog(dom.document)).toBe(true);
    expect(await refusedChoice).toEqual([]);
    // The refusal was not kept: that Attach asked the catalog again, and this time it answers.
    expect(loads).toBe(2);
    await settle();

    const controller = new AbortController();
    const choice = chooseFiles({ signal: controller.signal });
    for (let attempt = 0; attempt < 100 && !dom.document.querySelector("dialog[open] .cloud-file-chooser"); attempt++) await Bun.sleep(10);
    expect(dom.document.querySelector("dialog[open] .cloud-file-chooser")?.textContent).toContain("Drive");
    controller.abort();
    expect(await choice).toEqual([]);
    expect(loads).toBe(2);
  } finally {
    dom.cleanup();
  }
});

domTest("a catalog without file providers is asked once per page", async () => {
  const dom = createDomTestHarness();
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  let loads = 0;
  const providers = createProviderList(async () => {
    loads++;
    return [];
  });
  const chooseFiles = createFileChoosing(providers);
  try {
    providers.prefetch();
    await settle();
    for (let attempt = 0; attempt < 2; attempt++) {
      const choice = chooseFiles();
      expect(cancelDeviceDialog(dom.document)).toBe(true);
      expect(await choice).toEqual([]);
    }
    expect(loads).toBe(1);
  } finally {
    dom.cleanup();
  }
});

domTest("a discovery chunk failure is silent during prefetch and retryable in the chooser", async () => {
  const dom = createDomTestHarness();
  const { toast } = await import("@k2b/ui");
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const controller = new AbortController();
  let loads = 0;
  const providers = createProviderList(async () => {
    if (++loads < 3) throw new TypeError("Failed to fetch dynamically imported module");
    return [drive];
  });
  try {
    providers.prefetch();
    await settle();
    expect(providers.known()).toBeUndefined();
    expect(providers.requested()).toBe(false);
    expect(error).not.toHaveBeenCalled();
    const choice = createFileChoosing(providers)({ signal: controller.signal });
    for (let attempt = 0; attempt < 100 && !dom.document.querySelector("dialog[open] .cloud-file-chooser"); attempt++) await Bun.sleep(10);
    const dialog = dom.document.querySelector("dialog[open] .cloud-file-chooser");
    expect(dialog?.textContent).toContain("Apps with files could not be loaded.");
    const retry = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === "Try again");
    expect(retry).toBeDefined();
    retry?.click();
    await settle();
    expect(dialog?.textContent).toContain("Drive");
    expect(loads).toBe(3);
    expect(error).not.toHaveBeenCalled();
    controller.abort();
    expect(await choice).toEqual([]);
  } finally {
    controller.abort();
    error.mockRestore();
    dom.cleanup();
  }
});

const waitForChooser = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await settle();
  expect(condition()).toBe(true);
};

const invoices: FileProviderSource = { ...drive, appId: "invoices", name: "Invoices", context: true };
const customer = { type: "customers.customer", id: "c1" };

/** Real chooser and capability transport; invoices decides which files match. */
const contextualChooser = async (options: ChooseFilesOptions, locale = "en") => {
  const dom = createDomTestHarness();
  const [{ FileChooser }, { LocaleProvider }] = await Promise.all([import("./FileChooser"), import("@k2b/ui")]);
  const calls: { app: string; input: { parent?: string; query?: string; cursor?: string; context?: FileProviderContext } }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const app = String(url).includes("/invoices/") ? "invoices" : "drive";
    const { input } = JSON.parse(String(init?.body));
    calls.push({ app, input });
    const matching =
      app === "invoices" &&
      input.context?.refs.some((ref: { type: string; id: string }) => ref.type === customer.type && ref.id === customer.id);
    const items =
      !matching || input.parent || input.query
        ? []
        : [
            { kind: "folder", id: "archive", name: "Archive" },
            { kind: "file", id: "invoice", name: "Invoice c1.pdf", size: 1 },
          ];
    return Response.json({ data: { writable: false, items, next: null } });
  };
  const dispose = render(
    () => (
      <LocaleProvider locale={locale}>
        <FileChooser
          options={options}
          providers={() => ({ state: "ready", providers: [invoices, drive] })}
          retryProviders={() => {}}
          caller={() => ({ locale, fetch })}
          close={() => {}}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const row = (name: string) =>
    [...dom.document.querySelectorAll<HTMLElement>('[role="gridcell"]')].find((cell) => cell.textContent?.includes(name));
  const button = (name: string) =>
    [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name);
  return {
    dom,
    calls,
    row,
    button,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

domTest("matching invoices list files and successful lazy context is reused across folders and providers", async () => {
  let resolutions = 0;
  const view = await contextualChooser({
    context: async () => {
      resolutions++;
      return { refs: [customer] };
    },
  });
  try {
    view.row("Drive")!.click();
    await waitForChooser(() => view.calls.length === 1);
    expect(resolutions).toBe(0);
    expect(view.calls[0]!.input).not.toHaveProperty("context");
    view.button("Sources")!.click();
    view.row("Invoices")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    view.row("Archive")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.dom.root.textContent).not.toContain("No matching files");
    view.button("Sources")!.click();
    view.row("Invoices")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    expect(resolutions).toBe(1);
    expect(
      view.calls
        .filter((call) => call.app === "invoices")
        .every((call) => JSON.stringify(call.input.context) === JSON.stringify({ refs: [customer] })),
    ).toBe(true);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("contextual empty roots use the custom, default, and German titles and return to sources", async () => {
  for (const [locale, title, action, custom] of [
    ["en", "No matching files for these recipients", "Choose another source", true],
    ["en", "No matching files", "Choose another source", false],
    ["de", "Keine passenden Dateien", "Andere Quelle wählen", false],
  ] as const) {
    const view = await contextualChooser(
      { context: { refs: [{ ...customer, id: "other" }] }, ...(custom ? { noMatchingFiles: title } : {}) },
      locale,
    );
    try {
      view.row("Invoices")!.click();
      await waitForChooser(() => Boolean(view.button(action)));
      expect(view.dom.root.textContent).toContain(title);
      view.button(action)!.click();
      expect(view.row("Drive")).toBeDefined();
      expect(view.row("Invoices")).toBeDefined();
    } finally {
      await settle();
      view.cleanup();
    }
  }
});

domTest("failed lazy context shows Try again and retries resolution before listing", async () => {
  let resolutions = 0;
  const view = await contextualChooser({
    context: async () => {
      if (++resolutions === 1) throw new Error("Lookup failed");
      return { refs: [customer] };
    },
  });
  try {
    view.row("Invoices")!.click();
    await waitForChooser(() => Boolean(view.button("Try again")));
    expect(view.dom.root.textContent).toContain("This folder could not be loaded");
    expect(view.calls).toHaveLength(0);
    view.button("Try again")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    expect(resolutions).toBe(2);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("normalizes context refs once, dropping duplicates and invalid refs and capping at twenty", async () => {
  const refs = [
    customer,
    customer,
    { type: "invalid", id: "" },
    ...Array.from({ length: 30 }, (_, index) => ({ ...customer, id: `c${index + 2}` })),
  ];
  const view = await contextualChooser({ context: { refs } });
  try {
    view.row("Invoices")!.click();
    await waitForChooser(() => view.calls.length === 1);
    expect(view.calls[0]!.input.context?.refs).toEqual([customer, ...refs.slice(3, 22)]);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("without caller context an empty supporting provider keeps the ordinary empty state", async () => {
  const view = await contextualChooser({});
  try {
    view.row("Invoices")!.click();
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.calls[0]!.input).not.toHaveProperty("context");
    expect(view.button("Choose another source")).toBeUndefined();
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("a name filter keeps its own empty state after receiving caller context", async () => {
  const view = await contextualChooser({ context: { refs: [customer] }, noMatchingFiles: "Recipient matches" });
  try {
    view.row("Invoices")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    const filter = view.dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "missing";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    for (let attempt = 0; attempt < 100 && !view.button("Clear filter"); attempt++) await Bun.sleep(5);
    expect(view.dom.root.textContent).toContain("Nothing matches “missing”");
    expect(view.dom.root.textContent).not.toContain("Recipient matches");
    expect(view.calls.at(-1)!.input.context).toEqual({ refs: [customer] });
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("navigation and closing abort lazy context silently without listing a stale folder", async () => {
  let pendingSignal: AbortSignal | undefined;
  const view = await contextualChooser({
    context: (signal) => {
      pendingSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  try {
    view.row("Invoices")!.click();
    expect(pendingSignal?.aborted).toBe(false);
    view.button("Sources")!.click();
    expect(pendingSignal?.aborted).toBe(true);
    view.row("Drive")!.click();
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.calls.map((call) => call.app)).toEqual(["drive"]);
    expect(view.button("Try again")).toBeUndefined();
    view.button("Sources")!.click();
    view.row("Invoices")!.click();
  } finally {
    await settle();
    view.cleanup();
  }
  expect(pendingSignal?.aborted).toBe(true);
});
