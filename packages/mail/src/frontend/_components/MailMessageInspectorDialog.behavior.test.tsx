import { describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MessageInspector } from "../../contracts";

const imap = {
  folderId: "Fold01",
  folderName: "Inbox",
  remotePath: "INBOX",
  uid: "42",
  uidValidity: "10",
  modseq: null,
  flags: [],
  keywords: [],
};
const jmap = { folderId: "Fold02", folderName: "Archive", remotePath: "Archive", remoteId: "email_alpha", flags: [], keywords: [] };
const inspector: MessageInspector = {
  id: "Mesg01",
  messageId: "<fixture@example.test>",
  inReplyTo: null,
  referenceIds: [],
  subject: "Locator fixture",
  internalDate: "2026-11-19T12:00:00.000Z",
  sentAt: null,
  sizeBytes: 0,
  hydrationStatus: "envelope",
  hydrationErrorCode: null,
  contentHash: "a".repeat(64),
  sourceHash: null,
  contentType: null,
  source: { available: false, exact: false, byteLength: null, contentHash: null },
  headers: [],
  rawHeaders: "",
  headersComplete: false,
  placements: [],
  parts: [],
  attachments: [],
  mailingList: null,
  spam: { flag: null, status: null, score: null },
  warnings: [],
};

describe("message inspector protocol addresses", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  for (const mixed of [false, true]) {
    test(`C9: renders ${mixed ? "opaque JMAP IDs alongside IMAP" : "the unchanged IMAP columns"}`, async () => {
      const dom = createDomTestHarness();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => Response.json({ ...inspector, placements: mixed ? [imap, jmap] : [imap] }), {
        preconnect: originalFetch.preconnect,
      });
      const { dialogCore } = await import("@k2b/ui");
      const { openMailMessageInspector } = await import("./MailMessageInspectorDialog");
      const result = openMailMessageInspector({ mailboxId: "Mbox01", messages: [], initialMessageId: inspector.id });
      try {
        // Allow the mocked query and dialog mount to settle before inspecting the table.
        await Bun.sleep(60);
        const table = dom.document.querySelector("table");
        expect(table, "C9: placement table loaded").not.toBeNull();
        const rows = Array.from(table?.querySelectorAll("tbody tr") ?? []).map((row) =>
          Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent),
        );
        expect(rows[0]?.slice(0, 3), "C9: IMAP address").toEqual(["Inbox", "42", "10"]);
        expect(table?.querySelectorAll("th")[1]?.textContent).toBe(mixed ? "Message ID" : "UID");
        if (mixed) expect(rows[1]?.slice(0, 3), "C9: JMAP address").toEqual(["Archive", "email_alpha", "Not applicable"]);
        expect(table?.textContent, "C9: no synthetic null UID").not.toContain("null");
      } finally {
        dialogCore.close();
        await result;
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }
});
