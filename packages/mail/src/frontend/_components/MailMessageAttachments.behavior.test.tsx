import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

/** Invented demo attachments. */
const files: Record<string, [string, string]> = {
  Att001: ["text/plain", "# Summer party 2026\n\nEverything the organising team needs.\n"],
  Att002: ["text/plain", "Packing list\n- Pavilion\n"],
  Att003: ["text/csv", "Stand,Team\nGrill,Team A\n"],
  Att004: ["application/json", '{ "incomplete":'],
};
const attachments = [
  { id: "Att001", filename: "Summer_party.md", contentType: "text/plain", sizeBytes: 519 },
  { id: "Att002", filename: "Packing_list.txt", contentType: "text/plain", sizeBytes: 24 },
  { id: "Att003", filename: "Stands.csv", contentType: "text/csv", sizeBytes: 26 },
  { id: "Att004", filename: "Stands.json", contentType: "application/json", sizeBytes: 15 },
];

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(40);
};

describe("Mail attachment preview", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("shows the document title, quiet file facts and one download, with the content on the dialog surface", async () => {
    const dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const file = files[/attachments\/(\w+)\?inline=true$/.exec(url)?.[1] ?? ""];
        return Promise.resolve(
          file ? new Response(file[1], { headers: { "content-type": file[0] } }) : new Response(null, { status: 404 }),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailMessageAttachments } = await import("./MailMessageAttachments");
    const { dialogCore } = await import("@k2b/ui");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () => createComponent(MailMessageAttachments, { mailboxId: "Box001", messageId: "Msg001", attachments }),
      dom.root,
    );
    const dialog = () => dom.document.querySelector<HTMLElement>(".k2b-dialog[open]")!;
    const preview = (index: number) => dom.root.querySelectorAll<HTMLButtonElement>(".mail-attachment-preview")[index]!;
    try {
      preview(0).click();
      await settle();
      expect(dialog().className).toContain("mail-attachment-dialog--reading");
      // The leading heading becomes the title and leaves the document; the file name moves into the facts line.
      expect(dialog().querySelector("h2")?.textContent).toBe("Summer party 2026");
      const facts = dialog().querySelector(".mail-attachment-dialog__facts");
      expect(facts?.querySelector(".mail-attachment-dialog__facts-name")?.getAttribute("title")).toBe("Summer_party.md");
      expect(facts?.textContent).toContain("519 B");
      expect(facts?.textContent).not.toContain("text/plain");
      expect(facts?.hasAttribute("data-pending")).toBeFalse();
      expect(dialog().querySelector(".k2b-content-markdown h1")).toBeNull();
      expect(dialog().querySelector(".k2b-content-file-view")?.getAttribute("data-variant")).toBe("plain");
      // Download lives in the header only, not again as an overlay on the content.
      expect(dialog().querySelectorAll("a[download]")).toHaveLength(1);
      expect(dialog().querySelector(".k2b-content-file-view__overlay a")).toBeNull();
      dialogCore.close();
      await settle();

      preview(1).click();
      await settle();
      expect(dialog().querySelector("h2")?.textContent).toBe("Packing_list.txt");
      expect(dialog().querySelector(".mail-attachment-dialog__facts")?.textContent).not.toContain("Packing_list.txt");
      // Plain text has no code box with its own copy header; copying sits in the dialog header.
      expect(dialog().querySelector(".k2b-content-code-display__header")).toBeNull();
      const copy = dialog().querySelector<HTMLButtonElement>(".k2b-panel-dialog__actions .k2b-copy-button");
      expect(copy?.getAttribute("aria-label")).toBe("Copy");
      expect(copy?.disabled).toBeFalse();
      dialogCore.close();
      await settle();

      // A table fills the wide frame; its raw view has no code box either, so Copy stays in the header.
      preview(2).click();
      await settle();
      expect(dialog().className).toContain("mail-attachment-dialog--stretch");
      expect(dialog().querySelector(".k2b-panel-dialog__actions .k2b-copy-button")).not.toBeNull();
      dialogCore.close();
      await settle();

      // JSON that does not parse falls back to text without a code box; the header still copies it.
      preview(3).click();
      await settle();
      expect(dialog().querySelector(".k2b-content-code-display__header")).toBeNull();
      expect(dialog().querySelector<HTMLButtonElement>(".k2b-panel-dialog__actions .k2b-copy-button")?.disabled).toBeFalse();
    } finally {
      dialogCore.close();
      dispose();
      dom.cleanup();
    }
  });

  test("offers each attachment and all of them to an app that stores files, reading them from their download route", async () => {
    const dom = createDomTestHarness();
    const requested: string[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(Response.json({ code: "APP_UNAVAILABLE", message: "Down" }, { status: 503 }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailMessageAttachments } = await import("./MailMessageAttachments");
    const { dialogCore } = await import("@k2b/ui");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () => createComponent(MailMessageAttachments, { mailboxId: "Box001", messageId: "Msg001", attachments }),
      dom.root,
    );
    try {
      const labels = [...dom.root.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
      expect(labels).toContain("Save all to…");
      expect(labels).toContain("Save Summer_party.md to…");
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Save all to…"]')!.click();
      await settle();
      const dialog = dom.document.querySelector<HTMLElement>(".k2b-dialog[open]")!;
      expect(dialog.querySelector("h2")?.textContent).toBe("Save 4 files");
      // Nothing is read before a folder is chosen; an outage of the app list is calm and offers a retry.
      expect(requested.some((url) => url.includes("/attachments/"))).toBeFalse();
      expect(dialog.textContent).toContain("Apps that store files could not be loaded.");
    } finally {
      dialogCore.close();
      // The save dialog keeps a history entry; let it leave before the page goes away.
      await settle();
      dispose();
      dom.cleanup();
    }
  });
});
