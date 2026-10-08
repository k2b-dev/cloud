import { expect, mock, spyOn, test } from "bun:test";
import type { ChooseFilesOptions } from "@k2b/cloud/browser/files";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

/** The shared chooser stands in for "This device" and every Cloud app; each call answers with `nextChoice`. */
const choices: ChooseFilesOptions[] = [];
let nextChoice: File[] = [];
mock.module("@k2b/cloud/browser/files", () => ({
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

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

domTest("Add images chooses through the shared chooser and uploads what was chosen as Project files", async () => {
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
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Add images"]')!.click();
    await waitFor(() => Boolean(dom.document.querySelector(".k2b-dropzone")), "the add dialog");

    // The dialog's dropzone still takes drops; a click chooses from this device or from a Cloud app.
    nextChoice = [new File(["png"], "stage.png", { type: "image/png" })];
    dom.document.querySelector<HTMLButtonElement>(".k2b-dropzone")!.click();
    await waitFor(() => uploads.length === 1, "the upload");
    expect(choices).toEqual([{ multiple: true, accept: "image/*" }]);
    expect(uploads[0]?.path).toBe("/api/ai/projects/Proj01/files");
    expect(uploads[0]?.body).toMatchObject({ path: "stage.png", mediaType: "image/png", content: "cG5n", encoding: "base64" });
  } finally {
    dispose();
    fetchSpy.mockRestore();
    Object.assign(globalThis, { FileReader: fileReader });
    dom.cleanup();
  }
});
