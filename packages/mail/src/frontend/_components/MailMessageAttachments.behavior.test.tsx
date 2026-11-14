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

  test("opens every attachment in the Lightbox with the document title, quiet facts, Copy text and one download", async () => {
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
    const { render } = await import("solid-js/web");
    const dispose = render(
      () => createComponent(MailMessageAttachments, { mailboxId: "Box001", messageId: "Msg001", attachments }),
      dom.root,
    );
    const lightbox = () => dom.document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox")!;
    const actions = () => [...lightbox().querySelectorAll(".k2b-lightbox__action")].map((button) => button.textContent);
    const step = async () => {
      lightbox().querySelector<HTMLButtonElement>('button[aria-label="Next file"]')!.click();
      await settle();
    };
    // Every attachment is a tile; a click on one opens the Lightbox.
    const preview = (index: number) => dom.root.querySelectorAll<HTMLButtonElement>(".mail-attachment-tile__open")[index]!;
    try {
      expect(dom.root.querySelector("[data-mail-message-attachments]")?.getAttribute("aria-label")).toBe("4 attachments");
      expect(dom.root.querySelectorAll(".mail-attachment-tile__open")).toHaveLength(4);
      expect(dom.root.querySelector("[data-mail-download-all]")?.textContent).toContain("Download all 4");
      preview(0).click();
      await settle();
      // The leading heading becomes the name and leaves the document; the file name moves into the facts.
      expect(lightbox().getAttribute("aria-label")).toBe("Summer party 2026");
      const facts = lightbox().querySelector(".k2b-lightbox__name span")?.textContent;
      expect(facts).toContain("Summer_party.md");
      expect(facts).toContain("519 B");
      expect(facts).not.toContain("text/plain");
      expect(lightbox().querySelector(".k2b-content-markdown h1")).toBeNull();
      expect(lightbox().querySelector(".k2b-content-file-view")?.getAttribute("data-variant")).toBe("plain");
      // Download lives in the action pill only, not again as an overlay on the content; Markdown needs no Copy text.
      const download = lightbox().querySelectorAll<HTMLAnchorElement>("a[download]");
      expect(download).toHaveLength(1);
      expect(download[0]?.getAttribute("href")).toBe("/api/mail/mailboxes/Box001/messages/Msg001/attachments/Att001");
      expect(lightbox().querySelector(".k2b-content-file-view__overlay a")).toBeNull();
      expect(actions()).toEqual(["Save to…"]);
      // All four attachments are in the strip; the next one is the plain text.
      expect(lightbox().querySelectorAll(".k2b-thumbnail-strip__thumb")).toHaveLength(4);
      await step();
      expect(lightbox().getAttribute("aria-label")).toBe("Packing_list.txt");
      expect(lightbox().querySelector(".k2b-lightbox__name span")?.textContent ?? "").not.toContain("Packing_list.txt");
      // Plain text has no code box with its own copy header; Copy text sits in the action pill and copies the text.
      expect(lightbox().querySelector(".k2b-content-code-display__header")).toBeNull();
      expect(actions()).toEqual(["Copy text", "Save to…"]);
      const copied: string[] = [];
      Object.defineProperty(dom.window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
      });
      lightbox().querySelector<HTMLButtonElement>('.k2b-lightbox__action[aria-label="Copy text"]')!.click();
      expect(copied).toEqual(["Packing list\n- Pavilion\n"]);

      // A table's raw view has no code box either, so Copy text stays in the pill.
      await step();
      expect(lightbox().getAttribute("aria-label")).toBe("Stands.csv");
      expect(actions()).toEqual(["Copy text", "Save to…"]);

      // JSON that does not parse falls back to text without a code box; the pill still copies it.
      await step();
      expect(lightbox().querySelector(".k2b-content-code-display__header")).toBeNull();
      expect(actions()).toEqual(["Copy text", "Save to…"]);
      lightbox().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
      await settle();
      expect(dom.document.querySelector("dialog.k2b-lightbox")).toBeNull();
    } finally {
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
      // Each tile's "…" saves that one attachment.
      expect(labels).toContain("Actions for Summer_party.md");
      const tileMenu = dom.root.querySelector('[data-mail-attachment="Att001"]')!;
      expect([...tileMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Download", "Save to…"]);
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Save all to…"]')!.click();
      let dialog = dom.document.querySelector<HTMLElement>(".k2b-dialog[open]");
      for (let attempt = 0; attempt < 100 && !dialog; attempt += 1) {
        await settle();
        dialog = dom.document.querySelector<HTMLElement>(".k2b-dialog[open]");
      }
      if (!dialog) throw new Error("The attachment save dialog did not open");
      expect(dialog.querySelector("h2")?.textContent).toBe("Save 4 files");
      // Nothing is read before a folder is chosen; an outage of the app list is calm and offers a retry.
      expect(requested.some((url) => url.includes("/attachments/"))).toBeFalse();
      expect(dialog.textContent).toContain("Apps not loaded");
      expect(dialog.textContent).toContain("Try again");
    } finally {
      dialogCore.close();
      // The save dialog keeps a history entry; let it leave before the page goes away.
      await settle();
      dispose();
      dom.cleanup();
    }
  });
});
