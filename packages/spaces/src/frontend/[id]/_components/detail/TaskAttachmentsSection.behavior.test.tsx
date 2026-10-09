import { expect, mock, spyOn, test } from "bun:test";
import type { ChooseFilesOptions } from "@k2b/cloud/browser/files";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { MAX_TASK_ATTACHMENT_SIZE_BYTES, type SpaceItemAttachment } from "../../../../contracts";

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

const attachment = (id: string, filename: string, mimeType: string): SpaceItemAttachment => ({
  id,
  filename,
  mimeType,
  sizeBytes: 4,
  kind: "file",
  createdAt: "2026-10-08T09:00:00.000Z",
});

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

domTest("Add image or video chooses through the shared chooser and uploads like a dropped file", async () => {
  const dom = createDomTestHarness();
  const uploads: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const file = init?.body instanceof FormData ? init.body.get("file") : null;
        if (!(file instanceof File)) return Response.json({ message: "Unexpected" }, { status: 500 });
        uploads.push(`${init?.method} ${new URL(String(input), "http://localhost/").pathname} ${file.name} ${file.type}`);
        return Response.json(attachment("Att002", file.name, file.type));
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  let changed = 0;
  const { default: TaskAttachmentsSection } = await import("./TaskAttachmentsSection");
  const dispose = render(
    () => (
      <TaskAttachmentsSection
        spaceId="Space1"
        itemId="Item01"
        attachments={[attachment("Att001", "tour.mp4", "video/mp4")]}
        canWrite
        onChanged={() => changed++}
      />
    ),
    dom.root,
  );
  try {
    const add = () =>
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add image or video"))!;

    // Cancelling the chooser uploads nothing.
    nextChoice = [];
    add().click();
    await Bun.sleep(10);
    expect(choices).toEqual([
      // Nineteen attachments are left, so files from a Cloud app may hold at most that many attachments' worth.
      { accept: "image/*,.svg,video/*,.mov,.m4v", multiple: true, maxBytes: 19 * MAX_TASK_ATTACHMENT_SIZE_BYTES },
    ]);
    expect(uploads).toEqual([]);

    // A video from a Cloud app arrives as a plain File and takes the upload path, untouched.
    nextChoice = [new File(["mov!"], "walkthrough.mov", { type: "video/quicktime" })];
    add().click();
    await waitFor(() => changed === 1, "the upload");
    expect(uploads).toEqual(["POST /api/spaces/Space1/items/Item01/attachments walkthrough.mov video/quicktime"]);
    expect(dom.root.querySelector('[aria-label="Play walkthrough.mov"]')).not.toBeNull();
  } finally {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  }
});
