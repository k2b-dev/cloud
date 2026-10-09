import { expect, mock, spyOn, test } from "bun:test";
import type { ChooseFilesOptions } from "@k2b/cloud/browser/files";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { EDITOR_INSERT_ATTACHMENT_EVENT } from "../detail/events";

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

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

domTest("the attach dialog's dropzone chooses through the shared chooser and uploads what was chosen", async () => {
  const dom = createDomTestHarness();
  const uploads: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost/").pathname;
        const file = init?.body instanceof FormData ? init.body.get("file") : null;
        if (!(file instanceof File)) return Response.json([]);
        uploads.push(`${init?.method} ${path} ${file.name}`);
        return Response.json({
          id: `Att${uploads.length}`,
          kind: "file",
          filename: file.name,
          notebookId: "Book01",
          mimeType: file.type,
          sizeBytes: file.size,
          createdBy: null,
          createdAt: "2026-10-08T09:00:00.000Z",
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const inserted: string[] = [];
  const onInsert = (event: Event) => inserted.push((event as CustomEvent<{ filename: string }>).detail.filename);
  window.addEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsert);
  const { openAttachmentPicker } = await import("./AttachmentPicker");
  try {
    const closed = openAttachmentPicker("Book01", "en");
    await waitFor(() => Boolean(dom.document.querySelector(".k2b-dropzone")), "the attach dialog");
    const zone = () => dom.document.querySelector<HTMLButtonElement>(".k2b-dropzone")!;

    // Cancelling the chooser keeps the dialog open and uploads nothing.
    nextChoice = [];
    zone().click();
    await Bun.sleep(10);
    expect(choices).toEqual([{ multiple: true }]);
    expect(uploads).toEqual([]);

    // Files from this device or from a Cloud app upload in order, insert at the cursor, and close the dialog.
    nextChoice = [new File(["%PDF"], "minutes.pdf", { type: "application/pdf" }), new File(["a,b"], "budget.csv", { type: "text/csv" })];
    zone().click();
    await closed;
    expect(uploads).toEqual(["POST /api/notebooks/Book01/attachments minutes.pdf", "POST /api/notebooks/Book01/attachments budget.csv"]);
    expect(inserted).toEqual(["minutes.pdf", "budget.csv"]);
  } finally {
    window.removeEventListener(EDITOR_INSERT_ATTACHMENT_EVENT, onInsert);
    fetchSpy.mockRestore();
    dom.cleanup();
  }
});
