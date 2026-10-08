import { expect, test } from "bun:test";
import { ImageMetadataError } from "@k2b/cloud/services/image-metadata";
import { upload } from "./item-attachments";

test("image uploads are parsed by magic before any database write", async () => {
  await expect(
    upload({
      itemId: crypto.randomUUID(),
      spaceId: crypto.randomUUID(),
      filename: "photo.png",
      mimeType: "image/png",
      content: new Uint8Array([255, 216, 255, 219, 0]),
      userId: null,
    }),
  ).rejects.toBeInstanceOf(ImageMetadataError);
});
