import { expect, test } from "bun:test";
import { ImageMetadataError, stripImageMetadata } from "@k2b/cloud/services/image-metadata";
import { imageBytes, imageText, pngChunk, tinyJpeg, tinyPng, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { messagePreview } from "../system-messages";
import { attachmentHeaders, prepareAttachmentContent } from "./attachment-content";
import { AttachmentViewSchema, MAX_MESSAGE_ATTACHMENTS, SendMessageSchema, UploadAttachmentSchema } from "./contracts";

const ids = Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, (_, i) => `abcde${i}`);
test("attachment-only messages accept up to ten unique short IDs; empty or invalid sends fail", () => {
  expect(SendMessageSchema.parse({ clientId: "photo", body: "", attachments: ids }).attachments).toEqual(ids);
  for (const extra of [
    { attachments: [] },
    { attachments: [ids[0], ids[0]] },
    { attachments: [...ids, "abcdef"] },
    { attachments: ["bad"] },
    { attachments: [crypto.randomUUID()] },
    { attachments: ids, body: " \n" },
    { attachments: ids, body: "\u0000" },
  ])
    expect(SendMessageSchema.safeParse({ clientId: "invalid", body: "", ...extra }).success).toBeFalse();
});
test("multipart accepts exactly one file and an optional bounded thread", () => {
  const file = new File(["text"], "note.txt");
  expect(UploadAttachmentSchema.parse({ file, thread: "abcdef" })).toEqual({ file, thread: "abcdef" });
  for (const input of [{ file: [file, file] }, { file: "text" }, { file, thread: "general" }, { file, extra: "x" }])
    expect(UploadAttachmentSchema.safeParse(input).success).toBeFalse();
});
test("JPEG dimensions and metadata filtering use actual bytes, including progressive images", async () => {
  for (const progressive of [false, true]) {
    const original = withCameraMetadata(await tinyJpeg(progressive));
    const result = await prepareAttachmentContent(original, "application/octet-stream");
    expect(result).toMatchObject({ kind: "image", mimeType: "image/jpeg", width: 2, height: 3 });
    expect(result.content).toEqual(stripImageMetadata(original));
    expect(Buffer.from(result.content).includes(Buffer.from("Apple"))).toBeFalse();
    expect(Buffer.from(result.content).includes(Buffer.from("GPS"))).toBeFalse();
  }
});
test("PNG, WebP and GIF dimensions come from the runtime image metadata reader", async () => {
  const png = tinyPng();
  const tagged = imageBytes(png.subarray(0, 33), pngChunk("tEXt", imageText("Comment\0private")), png.subarray(33));
  const clean = await prepareAttachmentContent(tagged, "image/png");
  expect(clean).toMatchObject({ width: 3, height: 2, mimeType: "image/png" });
  expect(clean.content).toEqual(png);
  const webp = new Uint8Array(await new Bun.Image(tinyPng()).webp().bytes());
  expect(await prepareAttachmentContent(webp, "image/webp")).toMatchObject({ width: 3, height: 2 });
  const gif = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  expect(await prepareAttachmentContent(gif, "image/gif")).toMatchObject({ width: 1, height: 1, kind: "image" });
});
test("unreadable images fail; documents retain their bytes and have no dimensions", async () => {
  for (const bytes of [imageText("not a PNG"), tinyPng().subarray(0, 20), imageText("GIF89a")])
    await expect(prepareAttachmentContent(bytes, "image/png")).rejects.toBeInstanceOf(ImageMetadataError);
  const bytes = imageText("<svg><text>text</text></svg>");
  expect(await prepareAttachmentContent(bytes, "image/svg+xml")).toEqual({
    content: bytes,
    mimeType: "image/svg+xml",
    kind: "file",
    width: null,
    height: null,
  });
});
test("only allowlisted raster formats render inline and filenames survive HTTP encoding", () => {
  const headers = attachmentHeaders({ name: 'Plan "ä".png', mimeType: "image/png", kind: "image" });
  expect(headers["Content-Type"]).toBe("image/png");
  expect(headers["Content-Disposition"]).toBe("inline; filename=\"Plan ___.png\"; filename*=UTF-8''Plan%20%22%C3%A4%22.png");
  expect(headers["Cache-Control"]).toBe("private, no-store");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  expect(headers["Content-Security-Policy"]).toContain("sandbox");
  for (const mimeType of ["text/html", "image/svg+xml", "application/xml", "text/xml", "application/pdf"])
    for (const kind of ["file", "image"] as const) {
      const headers = attachmentHeaders({ name: "document", mimeType, kind });
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).toStartWith("attachment;");
    }
});
test("attachment previews use the viewer locale and text still takes precedence", () => {
  const image = { kind: "image" as const, name: "photo.jpg" },
    file = { kind: "file" as const, name: "plan.pdf" };
  expect(messagePreview("", [image], "en")).toBe("Photo");
  expect(messagePreview("", [image], "de")).toBe("Foto");
  expect(messagePreview("", [file], "en")).toBe("File: plan.pdf");
  expect(messagePreview("", [file], "de")).toBe("Datei: plan.pdf");
  expect(messagePreview(" Caption\n", [image], "de")).toBe("Caption");
  expect(
    AttachmentViewSchema.safeParse({
      id: "abcdef",
      name: "x",
      mimeType: "text/plain",
      size: 10485761,
      kind: "file",
      href: "/x",
    }).success,
  ).toBeFalse();
});
