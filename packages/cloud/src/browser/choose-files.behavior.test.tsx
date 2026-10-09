import { expect, test } from "bun:test";
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
    await settle();
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
