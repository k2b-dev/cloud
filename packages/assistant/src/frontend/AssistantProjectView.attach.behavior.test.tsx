import { expect, mock, spyOn, test } from "bun:test";
import type { ChooseFilesOptions } from "@k2b/cloud/browser/files";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

/** The shared chooser stands in for "This device" and every Cloud app; each call answers with `nextChoice`. */
const choices: ChooseFilesOptions[] = [];
let nextChoice: File[] = [];
// "Save to Files" is not under test here; its own tests cover it.
mock.module("@k2b/cloud/browser/files", () => ({
  SAVE_FILES_ICON: "ti ti-folder-down",
  SaveFilesButton: () => null,
  saveFiles: async () => [],
  saveFilesLabel: () => "Save to…",
  chooseFiles: async (options: ChooseFilesOptions) => {
    choices.push(options);
    return nextChoice;
  },
}));

const emptyPage = { items: [], page: 1, hasNext: false };
const snapshot = { projectId: "Proj01", knowledge: [], files: [], references: [], skills: emptyPage, apps: emptyPage };

/** The test DOM has no FileReader; the Project upload reads files as data URLs. */
class DataUrlReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}

/** A drop of files from outside the page, as an engine dispatches it. */
const dropEvent = (dom: DomTestHarness, files: File[]) => {
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, items: files.map((file) => ({ kind: "file", type: file.type })), dropEffect: "none" },
  });
  return event;
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

domTest("Add images and Add files open the shared chooser at once, and drops on the Project context upload too", async () => {
  const dom = createDomTestHarness();
  const fileReader = globalThis.FileReader;
  Object.assign(globalThis, { FileReader: DataUrlReader });
  const uploads: { path: string; body: unknown }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost/").pathname;
        if (init?.method === "POST" && typeof init.body === "string") {
          uploads.push({ path, body: JSON.parse(init.body) });
          return Response.json({});
        }
        return Response.json(snapshot);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { AssistantLiveProvider, createAssistantLiveHub } = await import("./assistant-live");
  const { default: AssistantProjectView } = await import("./AssistantProjectView");
  const dispose = render(
    () => (
      <AssistantLiveProvider value={createAssistantLiveHub()}>
        <AssistantProjectView
          project={{
            id: "Proj01",
            shortId: "Proj01",
            name: "Summer fair",
            description: "",
            icon: "ti ti-tent",
            instructions: "",
            defaultModelProfileId: null,
            permission: "write",
            revision: 1,
            createdAt: "2026-10-08T09:00:00.000Z",
            updatedAt: "2026-10-08T09:00:00.000Z",
          }}
          initialPage={{ items: [], page: 1, perPage: 20, total: 0, hasNext: false }}
          initialContext={snapshot}
          composer={<div />}
          onOpenConversation={async () => true}
        />
      </AssistantLiveProvider>
    ),
    dom.root,
  );
  try {
    // Cancelling the chooser uploads nothing and leaves no dialog behind.
    nextChoice = [];
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.click();
    await Bun.sleep(10);
    expect(choices).toEqual([{ multiple: true, accept: "image/*" }]);
    expect(uploads).toEqual([]);
    expect(dom.document.querySelector("dialog[open]")).toBeNull();

    // The + button chooses from this device or from a Cloud app at once, without a dialog in between.
    nextChoice = [new File(["png"], "stage.png", { type: "image/png" })];
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.click();
    await waitFor(() => uploads.length === 1, "the upload");
    expect(uploads[0]?.path).toBe("/api/ai/projects/Proj01/files");
    expect(uploads[0]?.body).toMatchObject({ path: "stage.png", mediaType: "image/png", content: "cG5n", encoding: "base64" });

    nextChoice = [new File(["%PDF"], "rules.pdf", { type: "application/pdf" })];
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Add files"]')!.click();
    await waitFor(() => uploads.length === 2, "the second upload");
    expect(choices.at(-1)).toEqual({ multiple: true, accept: undefined });
    expect(uploads[1]?.body).toMatchObject({ path: "rules.pdf", mediaType: "application/pdf" });

    // Files dropped on the Project context take the same upload path.
    const panel = dom.root.querySelector<HTMLElement>('aside[aria-label="Project context"]')!;
    panel.dispatchEvent(dropEvent(dom, [new File(["a,b"], "budget.csv", { type: "text/csv" })]));
    await waitFor(() => uploads.length === 3, "the dropped upload");
    expect(uploads[2]?.body).toMatchObject({ path: "budget.csv", mediaType: "text/csv" });
  } finally {
    dispose();
    fetchSpy.mockRestore();
    Object.assign(globalThis, { FileReader: fileReader });
    dom.cleanup();
  }
});
