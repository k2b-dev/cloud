import { expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { FileProviderSource } from "./file-providers";

const domTest = isServer ? test.skip : test;

const drive: FileProviderSource = {
  appId: "drive",
  name: "Drive",
  icon: "ti ti-folders",
  list: "folder.list",
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
