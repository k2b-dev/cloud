import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { FileProviderContext } from "../contracts/file-provider";
import type { ChooseFilesOptions } from "./FileChooser";
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
  const answers = [
    () => Promise.reject(new FileProviderError("UNAUTHORIZED", "Sign in", 401)),
    () => Promise.resolve([drive]),
    () => Promise.resolve([drive]),
  ];
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
    // The open dialog read the catalog once more behind the kept list.
    expect(loads).toBe(3);
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
    expect(dialog?.textContent).toContain("Apps not loaded");
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
    view.button("Drive")!.click();
    await waitForChooser(() => view.calls.length === 1);
    expect(resolutions).toBe(0);
    expect(view.calls[0]!.input).not.toHaveProperty("context");
    view.button("Invoices")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    view.row("Archive")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.dom.root.textContent).not.toContain("No matching files");
    view.button("Drive")!.click();
    await waitForChooser(() => view.calls.length === 4);
    view.button("Invoices")!.click();
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

domTest("contextual empty roots use the custom, default, and German titles, with the other sources beside them", async () => {
  for (const [locale, title, custom] of [
    ["en", "No matching files for these recipients", true],
    ["en", "No matching files", false],
    ["de", "Keine passenden Dateien", false],
  ] as const) {
    const view = await contextualChooser(
      { context: { refs: [{ ...customer, id: "other" }] }, ...(custom ? { noMatchingFiles: title } : {}) },
      locale,
    );
    try {
      view.button("Invoices")!.click();
      await waitForChooser(() => Boolean(view.dom.root.textContent?.includes(title)));
      expect(view.button("Drive")).toBeDefined();
      expect(view.button("Invoices")?.getAttribute("aria-current")).toBe("true");
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
    view.button("Invoices")!.click();
    await waitForChooser(() => Boolean(view.button("Try again")));
    expect(view.dom.root.textContent).toContain("This folder could not be loaded");
    expect(view.dom.root.textContent).toContain("Lookup failed");
    expect(resolutions).toBe(1);
    expect(view.calls).toHaveLength(0);
    view.button("Try again")!.click();
    await waitForChooser(() => Boolean(view.row("Invoice c1.pdf")));
    expect(resolutions).toBe(2);
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]!.input.context).toEqual({ refs: [customer] });
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
    view.button("Invoices")!.click();
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
    view.button("Invoices")!.click();
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.calls[0]!.input).not.toHaveProperty("context");
    expect(view.dom.root.textContent).not.toContain("No matching files");
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("a name filter keeps its own empty state after receiving caller context", async () => {
  const view = await contextualChooser({ context: { refs: [customer] }, noMatchingFiles: "Recipient matches" });
  try {
    view.button("Invoices")!.click();
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
    view.button("Invoices")!.click();
    expect(pendingSignal?.aborted).toBe(false);
    view.button("Drive")!.click();
    expect(pendingSignal?.aborted).toBe(true);
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("This folder is empty")));
    expect(view.calls.map((call) => call.app)).toEqual(["drive"]);
    expect(view.button("Try again")).toBeUndefined();
    view.button("Invoices")!.click();
  } finally {
    await settle();
    view.cleanup();
  }
  expect(pendingSignal?.aborted).toBe(true);
});

const vault: FileProviderSource = { ...drive, appId: "vault", name: "Vault" };
type Entry = { kind: "file"; id: string; name: string; size: number } | { kind: "folder"; id: string; name: string };
const entry = (id: string, size: number): Entry => ({ kind: "file", id, name: `${id}.txt`, size });

/** The real chooser over a fake transport: `answer` decides each call by its path and input. */
const chooser = async (
  options: ChooseFilesOptions,
  answer: (path: string, input: { parent?: string; id?: string } | undefined) => Response | Promise<Response>,
  providers: FileProviderSource[] = [drive],
) => {
  const dom = createDomTestHarness();
  const [{ FileChooser }, { LocaleProvider }] = await Promise.all([import("./FileChooser"), import("@k2b/ui")]);
  const closed: File[][] = [];
  const requests: { path: string; signal?: AbortSignal | null }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    requests.push({ path, signal: init?.signal });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return answer(path, body?.input);
  };
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <FileChooser
          options={options}
          providers={() => ({ state: "ready", providers })}
          retryProviders={() => {}}
          caller={() => ({ locale: "en", fetch })}
          close={(files) => closed.push(files)}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const button = (name: string) =>
    [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name);
  const row = (name: string) =>
    [...dom.document.querySelectorAll<HTMLElement>('[role="gridcell"]')].find((cell) => cell.textContent?.includes(name));
  const add = () => [...dom.document.querySelectorAll<HTMLButtonElement>(".cloud-file-chooser__add")][0]!;
  const status = () => dom.document.querySelector<HTMLElement>(".cloud-file-chooser__status")!;
  return {
    dom,
    closed,
    requests,
    button,
    row,
    add,
    status,
    dispose,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};
const folderPage = (items: Entry[]) => Response.json({ data: { writable: false, items, next: null } });

domTest("maxFiles and maxTotalBytes keep Add disabled with the reason, and a file above them shows its own", async () => {
  const items = [entry("a", 400), entry("b", 400), entry("c", 300), entry("d", 950)];
  const view = await chooser({ multiple: true, maxFiles: 2, maxTotalBytes: 900 }, () => folderPage(items));
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    expect(view.status().textContent).toContain("at most 2 files");
    expect(view.add().disabled).toBe(true);
    // A single file above the total can never fit, so it is disabled with the limit.
    expect(view.row("d.txt")!.getAttribute("aria-disabled")).toBe("true");
    expect(view.row("d.txt")!.textContent).toContain("Too large, up to");
    view.row("a.txt")!.click();
    view.row("b.txt")!.click();
    expect(view.status().textContent).toBe("2 files selected");
    expect(view.add().disabled).toBe(false);
    expect(view.add().textContent).toBe("Add (2)");
    view.row("c.txt")!.click();
    expect(view.status().textContent).toBe("At most 2 files");
    expect(view.status().dataset.error).toBe("true");
    expect(view.add().disabled).toBe(true);
    view.row("a.txt")!.click();
    view.row("b.txt")!.click();
    expect(view.status().textContent).toBe("1 file selected");
    view.row("a.txt")!.click();
    view.row("b.txt")!.click();
    view.row("a.txt")!.click();
    // b and c: 700 bytes of 900.
    expect(view.status().textContent).toBe("2 files selected");
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("maxTotalBytes alone: files that fit one by one cannot be added together above it", async () => {
  const items = [entry("a", 400), entry("b", 400), entry("c", 300)];
  const view = await chooser({ multiple: true, maxTotalBytes: 900 }, () => folderPage(items));
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    for (const name of ["a.txt", "b.txt", "c.txt"]) view.row(name)!.click();
    expect(view.status().textContent).toContain("Too large together, up to");
    expect(view.add().disabled).toBe(true);
    view.row("c.txt")!.click();
    expect(view.add().disabled).toBe(false);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("without limits only the provider's limit per file applies", async () => {
  const items = [entry("a", 900), entry("b", 900), entry("c", 1_200)];
  const view = await chooser({ multiple: true }, () => folderPage(items));
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    expect(view.status().textContent).toBe("Select one or more files");
    expect(view.row("c.txt")!.getAttribute("aria-disabled")).toBe("true");
    view.row("a.txt")!.click();
    view.row("b.txt")!.click();
    expect(view.add().disabled).toBe(false);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("closing aborts every read and drops answers that arrive afterwards", async () => {
  const read = Promise.withResolvers<Response>();
  const view = await chooser({ multiple: true }, (path) => {
    if (path.endsWith("/folder.list")) return folderPage([entry("a", 5), entry("b", 5)]);
    if (path.endsWith("/file.read")) return read.promise;
    return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
  });
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    view.row("a.txt")!.click();
    view.row("b.txt")!.click();
    view.add().click();
    await waitForChooser(() => view.requests.filter((request) => request.path.endsWith("/file.read")).length === 2);
    const reads = view.requests.filter((request) => request.path.endsWith("/file.read"));
    expect(reads.every((request) => request.signal?.aborted === false)).toBe(true);
    view.dispose();
    expect(reads.every((request) => request.signal?.aborted === true)).toBe(true);
    // A late answer finds the dialog gone and changes nothing.
    read.resolve(
      Response.json({
        data: {},
        stream: { id: "s", direction: "read", mediaType: "text/plain", size: 5, expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    await settle();
    await settle();
    expect(view.closed).toEqual([]);
    expect(view.requests.some((request) => request.path.endsWith("/streams/read"))).toBe(false);
  } finally {
    view.dom.cleanup();
  }
});

domTest("a provider whose root answers 403 or 404 leaves the sources with a short hint; a deeper 403 offers Up", async () => {
  const view = await chooser(
    {},
    (path, input) => {
      if (path.includes("/vault/")) return Response.json({ code: "FORBIDDEN", message: "No" }, { status: 403 });
      if (path.includes("/gone/")) return Response.json({ code: "NOT_FOUND", message: "Gone" }, { status: 404 });
      if (input?.parent === "private") return Response.json({ code: "FORBIDDEN", message: "No" }, { status: 403 });
      return folderPage([{ kind: "folder", id: "private", name: "Private" }]);
    },
    [drive, vault, { ...drive, appId: "gone", name: "Gone" }],
  );
  try {
    view.button("Vault")!.click();
    await waitForChooser(() => view.button("Vault") === undefined);
    expect(view.status().textContent).toBe("Vault is no longer available");
    expect(view.button("This device")?.getAttribute("aria-current")).toBe("true");
    expect(view.dom.root.querySelector(".k2b-dropzone")).not.toBeNull();
    view.button("Gone")!.click();
    await waitForChooser(() => view.status().textContent === "Gone is no longer available");
    expect(view.button("Gone")).toBeUndefined();
    view.button("Drive")!.click();
    expect(view.status().textContent).not.toContain("no longer available");
    await waitForChooser(() => Boolean(view.row("Private")));
    view.row("Private")!.click();
    await waitForChooser(() => Boolean(view.dom.root.textContent?.includes("You no longer have access to this folder")));
    expect(view.button("Drive")).toBeDefined();
    expect(view.button("Up")).toBeDefined();
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("one budget for the whole transfer: reads that announce more than listed stop at maxTotalBytes", async () => {
  const view = await chooser({ multiple: true, maxTotalBytes: 150 }, (path, input) => {
    if (path.endsWith("/folder.list")) return folderPage([entry("a", 1), entry("b", 1), entry("c", 1)]);
    if (path.endsWith("/file.read"))
      return Response.json({
        data: {},
        stream: { id: input?.id ?? "", direction: "read", mediaType: "text/plain", size: 100, expiresAt: "2099-01-01T00:00:00.000Z" },
      });
    return new Response(new Uint8Array(100));
  });
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    for (const name of ["a.txt", "b.txt", "c.txt"]) view.row(name)!.click();
    view.add().click();
    await waitForChooser(() => view.status().textContent === "1 of 3 ready, 2 failed");
    expect(view.requests.filter((request) => request.path.endsWith("/streams/read"))).toHaveLength(1);
    expect(view.closed).toEqual([]);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("a provider that repeats an ID shows one entry, so one choice stays one file", async () => {
  const view = await chooser({}, () => folderPage([entry("a", 1), { ...entry("a", 1), name: "copy.txt" }, entry("b", 1)]));
  try {
    view.button("Drive")!.click();
    await waitForChooser(() => Boolean(view.row("a.txt")));
    expect(view.row("copy.txt")).toBeUndefined();
    expect(view.dom.document.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
  } finally {
    await settle();
    view.cleanup();
  }
});

domTest("files from this device meet the same limits: the chooser says why and stays open, the direct dialog toasts", async () => {
  const pick = (input: HTMLInputElement, files: File[]) => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const two = [new File(["aaaa"], "a.txt"), new File(["bbbb"], "b.txt")];
  const view = await chooser({ multiple: true, maxFiles: 1 }, () => folderPage([]));
  try {
    pick(view.dom.root.querySelector<HTMLInputElement>('input[type="file"][hidden]')!, two);
    expect(view.closed).toEqual([]);
    expect(view.status().textContent).toBe("At most 1 file");
    expect(view.status().dataset.error).toBe("true");
    pick(view.dom.root.querySelector<HTMLInputElement>('input[type="file"][hidden]')!, two.slice(0, 1));
    expect(view.closed).toHaveLength(1);
  } finally {
    await settle();
    view.cleanup();
  }

  const dom = createDomTestHarness();
  const { toast } = await import("@k2b/ui");
  const { createFileChoosing } = await import("./choose-files");
  const { createProviderList } = await import("./provider-list");
  const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  try {
    const providers = createProviderList(async () => []);
    providers.prefetch();
    await settle();
    const choice = createFileChoosing(providers)({ multiple: true, maxTotalBytes: 6 });
    pick(dom.document.body.querySelector<HTMLInputElement>(':scope > input[type="file"]')!, two);
    expect(await choice).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toStartWith("Too large together, up to");
  } finally {
    error.mockRestore();
    dom.cleanup();
  }
});
