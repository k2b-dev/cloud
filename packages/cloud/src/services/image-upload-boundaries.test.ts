import { expect, test } from "bun:test";
import { stripImageDataUrlMetadata, stripImageMetadata } from "@k2b/cloud/services/image-metadata";
import { Hono } from "hono";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { isAiImage } from "../ai/file-media-type";
import { prepareAiModelProfileImages } from "../ai/settings";
import { respond } from "../server/api/respond";
import { setAvatar } from "./accounts/avatar";
import { settingsService } from "./settings/app";
import { registerSettings } from "./settings/defaults";
import { writeKey } from "./settings/store";

const malformed = new Uint8Array([255, 216, 255, 219, 0]);
const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;

test("the public typed error becomes HTTP 422 through Hono", async () => {
  const app = new Hono().post("/", async (c) => {
    stripImageMetadata(new Uint8Array(await c.req.arrayBuffer()));
    return c.text("stored");
  });
  const response = await app.request("/", { method: "POST", body: malformed });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ message: "Malformed JPEG image.", code: "MALFORMED_IMAGE" });
});

test("data URLs are stripped without changing their declared image type; external URLs stay unchanged", async () => {
  const jpeg = await tinyJpeg();
  expect(stripImageDataUrlMetadata(dataUrl(withCameraMetadata(jpeg, 1)))).toBe(dataUrl(jpeg));
  expect(stripImageDataUrlMetadata("https://example.test/photo.jpg")).toBe("https://example.test/photo.jpg");
  expect(() => stripImageDataUrlMetadata("data:image/jpeg;base64,/9j/2wA=")).toThrow();
  expect(() => stripImageDataUrlMetadata("data:image/jpeg;base64,%%%!")).toThrow();
});

test("avatar and image setting writes reject malformed containers before any storage or encryption", async () => {
  await expect(setAvatar({ id: crypto.randomUUID(), dataUrl: dataUrl(malformed) })).rejects.toMatchObject({ status: 422 });
  const key = `test.image_privacy_${crypto.randomUUID()}`;
  registerSettings([{ key, kind: "image", default: "", label: "Image", description: "Unit test only", group: "test" }]);
  await expect(writeKey(key, dataUrl(malformed))).rejects.toMatchObject({ status: 422 });
  // App settings routes (Grids admin settings, gateway-ops) pass the result to respond().
  const app = new Hono().put("/", async (c) => respond(c, await settingsService.entry.update({ key, value: dataUrl(malformed) })));
  const response = await app.request("/", { method: "PUT" });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ message: "Malformed JPEG image.", code: "MALFORMED_IMAGE" });
});

test("new model profile logos are sanitized without rewriting other profile fields", async () => {
  const jpeg = await tinyJpeg();
  const profile = { id: "example", image: dataUrl(withCameraMetadata(jpeg, 1)), model: "example-model", provider: "openai" };
  expect(prepareAiModelProfileImages(JSON.stringify([profile]))).toBe(JSON.stringify([{ ...profile, image: dataUrl(jpeg) }]));
  expect(() => prepareAiModelProfileImages(JSON.stringify([{ ...profile, image: dataUrl(malformed) }]))).toThrow();
});

test("AI image classification accepts the declared media type or the path extension", () => {
  expect(isAiImage("/IMG_0001.JPG", "application/octet-stream")).toBe(true);
  expect(isAiImage("/scan.bin", "image/jpeg")).toBe(true);
  expect(isAiImage("/scan.bin", "application/octet-stream")).toBe(false);
});
