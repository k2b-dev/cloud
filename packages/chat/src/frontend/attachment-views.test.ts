import { expect, test } from "bun:test";
import { chatMessages } from "../messages";
import type { AttachmentView } from "../service/contracts";
import { attachmentDetail, rowAttachments } from "./attachment-views";

const file = (change: Partial<AttachmentView>): AttachmentView => ({
  id: "File01",
  name: "Raumplan-v3.pdf",
  mimeType: "application/pdf",
  size: 1_250_000,
  kind: "file",
  href: "/api/chat/conversations/abcdef/attachments/File01",
  ...change,
});

test("a file's second line says its kind and size in the reader's language", () => {
  const en = chatMessages.resolve(["en"]).t;
  const de = chatMessages.resolve(["de"]).t;
  expect(attachmentDetail(file({}), en, "en")).toBe("PDF · 1.25 MB");
  expect(attachmentDetail(file({ name: "wartung.log", mimeType: "text/plain", size: 14_000 }), de, "de")).toBe("Text · 14 KB");
  expect(attachmentDetail(file({ name: "Angebot.docx", mimeType: "application/octet-stream" }), de, "de")).toStartWith("DOCX · ");
  expect(attachmentDetail(file({ name: "noext", mimeType: "application/octet-stream" }), de, "de")).toStartWith("Datei · ");
});

test("images with a stored size open in place; everything else is a file that downloads", () => {
  const opened: string[] = [];
  const rows = rowAttachments(
    [file({ id: "Img001", name: "lager.jpg", mimeType: "image/jpeg", kind: "image", width: 800, height: 600 }), file({})],
    chatMessages.resolve(["en"]).t,
    "en",
    (attachment) => opened.push(attachment.id),
  );
  expect(rows[0]).toMatchObject({ kind: "image", alt: "lager.jpg", width: 800, height: 600 });
  expect(rows[1]).toMatchObject({ kind: "file", name: "Raumplan-v3.pdf", href: "/api/chat/conversations/abcdef/attachments/File01" });
  if (rows[0]?.kind === "image") rows[0].onOpen?.();
  expect(opened).toEqual(["Img001"]);
});
