import { describe, expect, test } from "bun:test";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { attachmentsByMessage, mergeMailAttachments } from "./mail-detail-attachments";

type Message = Pick<MailWorkspaceMessage, "id" | "from" | "attachments">;
const file = (id: string, filename: string, checksum: string | null, contentType = "application/pdf") => ({
  id,
  filename,
  contentType,
  sizeBytes: 1024,
  contentId: null,
  checksum,
});
const message = (id: string, name: string, attachments: Message["attachments"]): Message => ({
  id,
  from: [{ name, address: `${id.toLowerCase()}@example.test` }],
  attachments,
});

describe("conversation attachments in the details panel", () => {
  test("merge only equal content, keep equal names with other content apart with their sender, files before images", () => {
    const messages = [
      message("Msg1", "Lena Hoffmann", [file("A1", "Costing.xlsx", "k1"), file("A2", "Page.jpg", "p1", "image/jpeg")]),
      message("Msg2", "Northern Light", [file("A3", "Brochure.pdf", "b3"), file("A4", "Costing.xlsx", "k2")]),
      message("Msg3", "Mira Okafor", [file("A5", "Brochure.pdf", "b3"), file("A6", "Notes.txt", null), file("A7", "Notes.txt", null)]),
    ];
    const merged = mergeMailAttachments(messages);
    expect(merged.occurrences).toBe(7);
    expect(merged.merged).toBe(1);
    expect(merged.files.map((entry) => [entry.attachment.id, entry.messageIds, entry.from])).toEqual([
      ["A1", ["Msg1"], "Lena Hoffmann"],
      ["A3", ["Msg2", "Msg3"], null],
      ["A4", ["Msg2"], "Northern Light"],
      // Without a checksum nothing is merged, even with the same name in one message.
      ["A6", ["Msg3"], "Mira Okafor"],
      ["A7", ["Msg3"], "Mira Okafor"],
      ["A2", ["Msg1"], null],
    ]);
  });

  test("by message lists every message with all of its own attachments", () => {
    const messages = [
      message("Msg1", "Lena", [file("A1", "a.pdf", "x")]),
      message("Msg2", "Mira", []),
      message("Msg3", "Kai", [file("A2", "a.pdf", "x")]),
    ];
    expect(attachmentsByMessage(messages).map(({ message, files }) => [message.id, files.map((entry) => entry.attachment.id)])).toEqual([
      ["Msg1", ["A1"]],
      ["Msg3", ["A2"]],
    ]);
  });
});
