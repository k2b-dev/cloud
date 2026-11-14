import { expect, test } from "bun:test";
import { chatMessages } from "../messages";
import type { AttachmentView } from "../service/contracts";
import { attachmentDetail, lightboxItem, rowAttachments } from "./attachment-views";

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

test("images with a stored size show in the row; every attachment opens in the Lightbox", () => {
  const opened: string[] = [];
  const rows = rowAttachments(
    [file({ id: "Img001", name: "lager.jpg", mimeType: "image/jpeg", kind: "image", width: 800, height: 600 }), file({})],
    chatMessages.resolve(["en"]).t,
    "en",
    (attachment) => opened.push(attachment.id),
  );
  expect(rows[0]).toMatchObject({ kind: "image", alt: "lager.jpg", width: 800, height: 600 });
  expect(rows[1]).toMatchObject({ kind: "file", name: "Raumplan-v3.pdf", href: "/api/chat/conversations/abcdef/attachments/File01" });
  rows[0]?.onOpen?.();
  rows[1]?.onOpen?.();
  expect(opened).toEqual(["Img001", "File01"]);
});

test("the Lightbox reads shown images, PDFs and video from the address, loads text, and offers Download for the rest", () => {
  const t = chatMessages.resolve(["en"]).t;
  const item = (change: Partial<AttachmentView>) => lightboxItem(file(change), t, "en", []);
  const image = item({ name: "lager.jpg", mimeType: "image/jpeg", kind: "image", width: 800, height: 600 });
  expect(image).toMatchObject({ src: file({}).href, thumbnail: file({}).href, downloadUrl: file({}).href });
  expect(image.load).toBeUndefined();
  expect(item({})).toMatchObject({ name: "Raumplan-v3.pdf", meta: "PDF · 1.25 MB", src: file({}).href });
  expect(item({ name: "clip.mp4", mimeType: "video/mp4" }).src).toBe(file({}).href);
  const log = item({ name: "wartung.log", mimeType: "text/plain", size: 14_000 });
  expect(log.src).toBeUndefined();
  expect(log.load).toBeFunction();
  // An image the server only offers as a download, such as an SVG, and a Word file show their facts and Download.
  for (const other of [
    item({ name: "plan.svg", mimeType: "image/svg+xml", kind: "file" }),
    item({ name: "Angebot.docx", mimeType: "application/octet-stream" }),
  ]) {
    expect(other.src).toBeUndefined();
    expect(other.load).toBeUndefined();
    expect(other.downloadUrl).toBe(file({}).href);
  }
});
