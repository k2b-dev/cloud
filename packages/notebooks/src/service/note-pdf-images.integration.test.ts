import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { request } from "node:http";
import { requestPublicHttps, resolvePublicNetworkAddresses } from "@k2b/cloud/services";
import * as pdfModule from "@k2b/cloud/services/pdf";
import { type GotenbergConfig, preparePdfImage } from "@k2b/cloud/services/pdf";
import { sql } from "bun";
import sharp from "sharp";
import { startGotenbergTrap } from "../../../../scripts/fixtures/gotenberg-trap";
import { pdfImages, pdfText } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import * as attachments from "./attachments";
import { buildNotePdfHtml, renderNotePdf } from "./note-pdf";
import { notePdfImageBoxes, prepareNotePdfImages } from "./note-pdf-images";

suiteFor("database", "gotenberg")("attached images in real note PDFs", () => {
  let notebook: { id: string; short_id: string };
  let foreign: { id: string; short_id: string };
  let config: GotenbergConfig;
  const ids: string[] = [];
  let jpeg: Uint8Array;
  let png: Uint8Array;
  let webp: Uint8Array;
  const insert = async (data: Uint8Array, type: string, name: string, notebookId = notebook.id, size = data.byteLength) => {
    const id = testShortId();
    await sql`INSERT INTO notebooks.attachments (short_id, notebook_id, filename, mime_type, size_bytes, kind, content, created_at)
      VALUES (${id}, ${notebookId}::uuid, ${name}, ${type}, ${size}, 'image', ${data}, '2026-10-01T00:00:00Z')`;
    return id;
  };
  const render = (markdown: string, options: Partial<Parameters<typeof renderNotePdf>[1]> = {}) =>
    renderNotePdf(
      {
        markdown,
        notebookId: notebook.id,
        notebookShortId: notebook.short_id,
        publicOrigin: "https://cloud.example.test",
        noteId: notebook.id,
        locale: "en",
        userId: null,
        serviceAccountId: null,
        boundNotebookId: null,
        bypassAccess: true,
        title: "Image fixtures",
      },
      { config, maxAttachmentBytes: 1024 * 1024, ...options },
    );

  beforeAll(async () => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30000, maxHtmlBytes: 4 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
    const notebooks = await sql<{ id: string; short_id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name, created_at)
      VALUES (${testShortId()}, 'PDF image fixtures', '2026-10-01T00:00:00Z'), (${testShortId()}, 'Private image fixtures', '2026-10-01T00:00:00Z') RETURNING id, short_id`;
    notebook = notebooks[0]!;
    foreign = notebooks[1]!;
    // Deterministic photo-like gradients; alpha varies in every row, rather than an opaque PNG with an alpha channel.
    const width = 480,
      height = 320;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = 4 * (y * width + x);
        pixels[offset] = (x * 7 + y * 13) % 256;
        pixels[offset + 1] = (x + y * 3) % 256;
        pixels[offset + 2] = (x * 3 + y) % 256;
        pixels[offset + 3] = 40 + ((x + y) % 216);
      }
    jpeg = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .flatten({ background: "white" })
      .jpeg()
      .toBuffer();
    png = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    webp = await sharp(jpeg).webp().toBuffer();
    ids.push(
      await insert(jpeg, "image/jpeg", "gradient.jpg"),
      await insert(png, "image/png", "alpha.png"),
      await insert(webp, "image/webp", "gradient.webp"),
    );
  });
  afterAll(async () => {
    if (notebook) await sql`DELETE FROM notebooks.notebooks WHERE id IN (${notebook.id}::uuid, ${foreign.id}::uuid)`;
  });

  test("JPEG, alpha PNG and WebP are uploaded once each, with every Book size placement", async () => {
    const markdown = [
      `![jpeg](attach://${ids[0]} =100x60)`,
      `![alpha](attach://${ids[1]} =100x60)`,
      ...["", " =100x", " =x60", " =100x60"].map((size) => `![webp](attach://${ids[2]}${size})`),
    ].join(" ");
    let metadataLoads = 0;
    const upload = spyOn(pdfModule, "renderHtmlToPdfWithConfig");
    try {
      const result = await render(markdown, {
        imageDependencies: {
          list: async (params) => {
            metadataLoads++;
            return attachments.listByShortIds(params);
          },
        },
      });
      // Chromium may write one uploaded asset as several XObjects, so PDF object count is not asserted.
      // The upload count is the contract; the PDF must contain only the expected dimensions and encodings.
      expect(metadataLoads).toBe(1);
      expect(result.omissions).toEqual([]);
      expect(upload).toHaveBeenCalledTimes(1);
      const input = upload.mock.calls[0]![0];
      expect(input.assets?.map(({ name }) => name)).toEqual(["img-1.jpg", "img-2.png", "img-3.jpg"]);
      expect(input.html.match(/src="img-3\.jpg"/g)).toHaveLength(4);
      const images = await pdfImages(result.pdf);
      const expectedImages = [
        { type: "image", width: 313, height: 209, enc: "jpeg" },
        { type: "image", width: 313, height: 209, enc: "image" },
        { type: "smask", width: 313, height: 209, enc: "image" },
        { type: "image", width: 480, height: 320, enc: "jpeg" },
      ];
      for (const expected of expectedImages) expect(images).toContainEqual(expect.objectContaining(expected));
      for (const { type, width, height, enc } of images) expect(expectedImages).toContainEqual({ type, width, height, enc });
    } finally {
      upload.mockRestore();
    }
  }, 60000);

  test("an escaped attachment address that Book shows also prints", async () => {
    const result = await render(`![escaped](attach\\://${ids[0]})`);
    expect(result.omissions).toEqual([]);
    expect((await pdfImages(result.pdf)).filter(({ type }) => type === "image")).toHaveLength(1);
  }, 60000);

  test("foreign and missing IDs print the same not_found reason without a private filename", async () => {
    const foreignId = await insert(jpeg, "image/jpeg", "secret-name.jpg", foreign.id);
    const result = await render(`![foreign](attach://${foreignId}) ![missing](attach://ZZZZZZ)`);
    expect(result.omissions).toEqual([
      { code: "not_found", kind: "image", label: "foreign" },
      { code: "not_found", kind: "image", label: "missing" },
    ]);
    expect(await pdfImages(result.pdf)).toEqual([]);
    const text = await pdfText(result.pdf);
    expect(text).toContain("Image not included: foreign – file not found");
    expect(text).toContain("Image not included: missing – file not found");
    expect(text).not.toContain("secret-name");
  }, 60000);

  test("SVG stays download-only and size metadata prevents reading large content", async () => {
    const svg = await insert(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'),
      "image/svg+xml",
      "drawing.svg",
    );
    let loads = 0;
    const result = await render(`![drawing](attach://${svg}) ![large](attach://${ids[0]})`, {
      maxAttachmentBytes: 1,
      imageDependencies: {
        content: async () => {
          loads++;
          throw new Error("must not read");
        },
      },
    });
    expect(loads).toBe(0);
    expect(result.omissions.map(({ code }) => code)).toEqual(["unsupported_format", "too_large"]);
    expect(await pdfImages(result.pdf)).toEqual([]);
  }, 60000);

  test("a real byte budget keeps the image prefix and marks the rest in order", async () => {
    const repeated = [ids[0]!, await insert(jpeg, "image/jpeg", "second.jpg"), await insert(jpeg, "image/jpeg", "third.jpg")];
    const markdown = repeated.map((id, n) => `![photo ${n}](attach://${id} =100x60)`).join(" ");
    const built = buildNotePdfHtml({
      markdown,
      notebookShortId: notebook.short_id,
      publicOrigin: "https://cloud.example.test",
      locale: "en",
    });
    const reference = await prepareNotePdfImages({
      ...built,
      notebookId: notebook.id,
      maxHtmlBytes: config.maxHtmlBytes,
      maxAttachmentBytes: 1024 * 1024,
      deadline: Date.now() + 30000,
      signal: new AbortController().signal,
      locale: "en",
    });
    const variants = await preparePdfImage({
      data: jpeg,
      boxes: notePdfImageBoxes([built.images[0]!], "document"),
      maxBytes: config.maxHtmlBytes,
    });
    if (!variants.ok || !variants.variants[2]) throw new Error("Fixture must fit at 150 dpi");
    const budget = reference.htmlUpperBound + Math.floor(variants.variants[2].data.size * 1.5);
    const result = await render(markdown, { config: { ...config, maxHtmlBytes: budget } });
    expect(result.omissions).toEqual([
      { code: "over_budget", kind: "image", label: "photo 1" },
      { code: "over_budget", kind: "image", label: "photo 2" },
    ]);
    expect((await pdfImages(result.pdf)).filter(({ type }) => type === "image")).toHaveLength(1);
    expect(await pdfText(result.pdf)).toContain("no room left in the PDF");
    await expect(render(markdown, { config: { ...config, maxHtmlBytes: 10 } })).rejects.toMatchObject({ code: "html_too_large" });
  }, 60000);

  test("Gotenberg requests no application or external image URL", async () => {
    const trap = await startGotenbergTrap(config.url);
    try {
      const result = await render(
        `![photo](attach://${ids[0]} =100x60) ![x](${trap.origin}/img.png) ![y](/api/notebooks/x/attachments/y/content)`,
      );
      expect(await trap.takeRequests()).toEqual([]);
      expect((await pdfImages(result.pdf)).filter(({ type }) => type === "image")).toHaveLength(1);
      expect(result.omissions.map(({ code }) => code)).toEqual(["blocked", "blocked"]);
    } finally {
      await trap.stop();
    }
  }, 60000);

  test("external JPEGs are fetched once and uploaded; Gotenberg requests no image addresses", async () => {
    const trap = await startGotenbergTrap(config.url);
    const upload = spyOn(pdfModule, "renderHtmlToPdfWithConfig");
    let server: ReturnType<typeof Bun.serve> | undefined;
    let requests = 0;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          requests++;
          return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } });
        },
      });
      const url = `https://images.example.test:${server.port}/photo.jpg`;
      const result = await render(`![photo](${url}) ![again](${url}) ![private](${trap.origin}/x.png)`, {
        imageDependencies: {
          request: (input) =>
            requestPublicHttps(input, {
              resolve: async (host) =>
                host === "images.example.test" ? [{ address: "127.0.0.1", family: 4 }] : resolvePublicNetworkAddresses(host),
              // Local HTTP fixture exercises pinned byte transport; production always uses node:https.
              request: (options, callback) => request({ ...options, protocol: "http:" }, callback),
            }),
        },
      });
      expect(requests).toBe(1);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload.mock.calls[0]![0].assets?.map(({ name }) => name)).toEqual(["img-1.jpg"]);
      const images = await pdfImages(result.pdf);
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect(image).toMatchObject({ type: "image", width: 480, height: 320, enc: "jpeg" });
      expect(result.omissions).toEqual([{ code: "blocked", kind: "image", label: `private (${trap.origin}/x.png)` }]);
      expect(await trap.takeRequests()).toEqual([]);
    } finally {
      upload.mockRestore();
      await server?.stop(true);
      await trap.stop();
    }
  }, 60000);

  test("client abort waits for the active real worker and starts no further worker", async () => {
    const controller = new AbortController();
    let calls = 0;
    const childSpawn = spyOn(Bun, "spawn");
    const started = performance.now();
    try {
      const promise = render(ids.map((id) => `![photo](attach://${id})`).join(" "), {
        signal: controller.signal,
        imageDependencies: {
          prepare: (input, options) => {
            calls++;
            const pending = preparePdfImage(input, options);
            // acquire() resumes first and spawns the worker, then cancellation must reap it.
            queueMicrotask(() => controller.abort());
            return pending;
          },
        },
      });
      await expect(promise).rejects.toBeDefined();
      expect(calls).toBe(1);
      expect(performance.now() - started).toBeLessThan(5000);
      const children = childSpawn.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(typeof child.exitCode === "number" || child.signalCode !== null).toBe(true);
    } finally {
      childSpawn.mockRestore();
    }
  }, 10000);
});
