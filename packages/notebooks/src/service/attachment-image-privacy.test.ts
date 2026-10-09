import { expect, test } from "bun:test";
import { ImageMetadataError } from "@k2b/cloud/services/image-metadata";
import { detectKind, upload } from "./attachments";

test("image classification by filename reaches stripping even for octet-stream uploads", async () => {
  expect(detectKind("photo.jpg", "application/octet-stream")).toBe("image");
  await expect(
    upload({
      notebookId: crypto.randomUUID(),
      filename: "photo.jpg",
      mimeType: "application/octet-stream",
      content: new Uint8Array([255, 216, 255, 219, 0]),
      userId: null,
    }),
  ).rejects.toBeInstanceOf(ImageMetadataError);
});
