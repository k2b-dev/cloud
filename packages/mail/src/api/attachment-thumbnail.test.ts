import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { Hono } from "hono";
import * as messages from "../service/messages";
import * as publicResources from "../service/public-resources";
import { aggregateResourcePaths, attachmentThumbnailResponse } from "./index";
import { type MailApiContext, projectResourcePaths } from "./public-resource-boundary";

const attachment: messages.AttachmentDownload = {
  blobId: "11111111-1111-4111-8111-111111111111",
  total: 4096,
  chunkSize: 65536,
  chunkCount: 1,
  contentHash: "a".repeat(64),
  contentType: "image/png",
  filename: "private-original.png",
};
const pngPrefix = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const request = (result: Result<messages.AttachmentDownload> = ok(attachment), access = async (_blobId: string) => {}) =>
  new Hono<MailApiContext>().get("/", (c) => attachmentThumbnailResponse(c, result, access)).request("/");
const source = () => {
  spyOn(messages, "readAttachmentPrefix").mockResolvedValue(pngPrefix);
  return spyOn(messages, "createAttachmentStream").mockImplementation(
    () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(attachment.total));
          c.close();
        },
      }),
  );
};
afterEach(() => mock.restore());

describe("Mail image thumbnails", () => {
  test("preserves access failures and rejects non-images before reading the source", async () => {
    const read = spyOn(messages, "readAttachmentPrefix");
    expect((await request(fail(err.forbidden("Access denied")))).status).toBe(403);
    for (const data of [
      { ...attachment, contentType: "application/pdf" },
      { ...attachment, total: 26 * 1024 * 1024 },
    ])
      expect((await request(ok(data))).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  test("rejects a mismatched signature before reading or decoding the full blob", async () => {
    spyOn(messages, "readAttachmentPrefix").mockResolvedValue(new Uint8Array([0, 1, 2]));
    const read = spyOn(messages, "createAttachmentStream");
    expect((await request()).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  test("returns only the fitted variant with private immutable caching", async () => {
    const stream = source();
    const data = new Blob([pngPrefix], { type: "image/png" });
    const prepare = spyOn(services, "preparePdfImage").mockResolvedValue({
      ok: true,
      variants: [{ data, type: "image/png", width: 96, height: 48 }],
    });
    const check = mock(async (_blobId: string) => {});
    const response = await request(ok(attachment), check);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe(`"thumbnail-v1-${attachment.contentHash}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngPrefix);
    expect(prepare).toHaveBeenCalledWith(
      { data: new Uint8Array(4096), boxes: [{ width: 96, height: 96 }], maxBytes: 49152 },
      { signal: expect.any(AbortSignal), timeoutMs: 15000 },
    );
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ start: 0, endExclusive: 4096, assertCurrentAccess: expect.any(Function) });
    expect(check).toHaveBeenCalledWith(attachment.blobId);
  });

  test("worker errors, null variants and runtime failures produce bounded errors without source bytes", async () => {
    source();
    const prepare = spyOn(services, "preparePdfImage");
    for (const code of ["unreadable", "unsupported_format", "too_large", "timed_out"] as const) {
      prepare.mockResolvedValue({ ok: false, code });
      expect((await request()).status).toBe(400);
    }
    prepare.mockResolvedValue({ ok: true, variants: [null] });
    expect((await request()).status).toBe(400);
    prepare.mockRejectedValue(new Error("sensitive worker detail"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive");
  });

  test("does not return a prepared thumbnail when access was revoked", async () => {
    source();
    spyOn(services, "preparePdfImage").mockResolvedValue({
      ok: true,
      variants: [
        {
          data: new Blob([pngPrefix]),
          type: "image/png",
          width: 1,
          height: 1,
        },
      ],
    });
    const response = await request(ok(attachment), async () => {
      throw new Error("revoked");
    });
    expect(response.status).toBe(500);
  });

  test("answers 304 for the image the browser holds, after the access check and without reading or a worker", async () => {
    const read = spyOn(messages, "readAttachmentPrefix");
    const prepare = spyOn(services, "preparePdfImage");
    const app = new Hono<MailApiContext>().get("/", (c) => attachmentThumbnailResponse(c, ok(attachment), async () => {}));
    const response = await app.request("/", { headers: { "If-None-Match": `W/"x", "thumbnail-v1-${attachment.contentHash}"` } });
    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(read).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    // A revoked access never reaches the comparison.
    const denied = await new Hono<MailApiContext>()
      .get("/", (c) => attachmentThumbnailResponse(c, fail(err.forbidden("Access denied")), async () => {}))
      .request("/", { headers: { "If-None-Match": `"thumbnail-v1-${attachment.contentHash}"` } });
    expect(denied.status).toBe(403);
  });

  test("a disconnect during a stalled source read frees the slot for the next thumbnail", async () => {
    const read = spyOn(messages, "readAttachmentPrefix").mockImplementation(() => new Promise(() => {}));
    const app = new Hono<MailApiContext>().get("/", (c) => attachmentThumbnailResponse(c, ok(attachment), async () => {}));
    const stalled = [new AbortController(), new AbortController()];
    const responses = stalled.map((controller) => app.request("/", { signal: controller.signal }));
    while (read.mock.calls.length < 2) await Bun.sleep(1);
    for (const controller of stalled) controller.abort();
    expect((await Promise.all(responses)).map((response) => response.status)).toEqual([500, 500]);
    // Both slots are free again: the next thumbnail reaches its source read at once.
    read.mockResolvedValue(new Uint8Array([0, 1, 2]));
    expect((await app.request("/")).status).toBe(400);
  });

  test("prepares two thumbnails at once, queues 64 more, and answers busy beyond that", async () => {
    source();
    const releases: (() => void)[] = [];
    const prepare = spyOn(services, "preparePdfImage").mockImplementation(
      () =>
        new Promise((resolve) =>
          releases.push(() => resolve({ ok: true, variants: [{ data: new Blob([pngPrefix]), type: "image/png", width: 1, height: 1 }] })),
        ),
    );
    const pending = Array.from({ length: 66 }, () => request());
    await Bun.sleep(0);
    const busy = await request();
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(prepare).toHaveBeenCalledTimes(2);
    // Each finished thumbnail lets one waiting request in.
    while (prepare.mock.calls.length < 66 || releases.length) {
      releases.shift()?.();
      await Bun.sleep(1);
    }
    const statuses = await Promise.all(pending.map(async (response) => (await response).status));
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(66);
  });

  test("projects nested list image message and attachment IDs at the API boundary", async () => {
    const messageId = "22222222-2222-4222-8222-222222222222";
    const attachmentId = "33333333-3333-4333-8333-333333333333";
    const projection = spyOn(publicResources, "publicIds").mockImplementation(
      async (table, ids) => new Map(ids.map((id) => [id!, table === "messages" ? "Msg001" : "Att001"])),
    );
    const data = {
      listItems: [{ id: messageId, selectionKind: "message", imageAttachments: [{ messageId, attachmentId }], imageAttachmentCount: 1 }],
    };
    const result = await projectResourcePaths(ok(data), aggregateResourcePaths(data));
    expect(result).toEqual(
      ok({
        listItems: [
          {
            id: "Msg001",
            selectionKind: "message",
            imageAttachments: [{ messageId: "Msg001", attachmentId: "Att001" }],
            imageAttachmentCount: 1,
          },
        ],
      }),
    );
    expect(projection).toHaveBeenCalledWith("attachments", [attachmentId]);
  });
});
