import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { tinyJpeg, tinyPng, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import {
  AttachmentViewSchema,
  ChangesPageSchema,
  ChatLiveEventSchema,
  ConversationSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_UNSENT_ATTACHMENTS,
  MessagePageSchema,
  MessageViewSchema,
  SharedPageSchema,
  ThreadListSchema,
  ThreadSchema,
} from "../service/contracts";
import { cleanupAttachments, ORPHAN_CLEANUP_BATCH } from "../service/maintenance";
import { accessKey, resourceReaderDependencies } from "../service/resource-access";
import chatApi from ".";
import { messageFixtures, type Person } from "./messages.test-fixture";

setDefaultTimeout(30_000);
const suite = suiteFor("database", "nats", "valkey");
suite("Chat message attachments", () => {
  const f = messageFixtures();
  const server = new Hono<AuthContext>().route("/api/chat", chatApi);
  const upload = (
    person: Person,
    conversation: string,
    file = new File(["notes"], "notes.txt", { type: "text/plain" }),
    thread?: string,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (thread) form.append("thread", thread);
    return server.request(`https://cloud.example.test/api/chat/conversations/${conversation}/attachments`, {
      method: "POST",
      headers: { ...person.headers, "x-forwarded-for": uniqueCallerAddress() },
      body: form,
    });
  };
  const uploaded = async (person: Person, conversation: string, file?: File, thread?: string) => {
    const response = await upload(person, conversation, file, thread);
    expect(response.status).toBe(201);
    return AttachmentViewSchema.parse(await response.json());
  };
  const send = async (person: Person, conversation: string, extra = {}) => {
    const response = await f.request(person.headers, `/${conversation}/messages`, "POST", {
      clientId: crypto.randomUUID(),
      body: "",
      ...extra,
    });
    expect(response.status).toBe(201);
    return MessageViewSchema.parse(await response.json());
  };
  const download = (person: Person, conversation: string, attachment: string) =>
    f.request(person.headers, `/${conversation}/attachments/${attachment}`);
  const resetUpload = async (person: Person) => {
    const bucket = Math.floor(Date.now() / 60_000);
    await redis.send(
      "DEL",
      [-1, 0, 1].map((offset) => `cloud:ratelimit:chat.attachment.upload:user:${person.id}:${bucket + offset}`),
    );
  };
  const readerKeys: string[] = [];
  let reader: ReturnType<typeof spyOn> | undefined;
  afterEach(async () => {
    reader?.mockRestore();
    reader = undefined;
    if (readerKeys.length) await redis.send("DEL", readerKeys.splice(0));
  });

  test("upload requires write access, bounds request and file sizes, and accepts exactly one file", async () => {
    const owner = await f.person(),
      member = await f.person(),
      stranger = await f.person();
    const chat = await f.fixture(owner, [{ person: member, permission: "read" }]);
    expect((await upload(member, chat.shortId)).status).toBe(403);
    expect((await upload(stranger, chat.shortId)).status).toBe(404);
    expect((await upload(owner, chat.shortId, new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "big.bin"))).status).toBe(413);
    const early = await server.request(`https://cloud.example.test/api/chat/conversations/${chat.shortId}/attachments`, {
      method: "POST",
      headers: { ...owner.headers, "content-length": String(MAX_ATTACHMENT_BYTES + 65537), "x-forwarded-for": uniqueCallerAddress() },
      body: "x",
    });
    expect(early.status).toBe(413);
    expect(await early.json()).toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    const repeated = new FormData();
    repeated.append("file", new File(["one"], "one.txt"));
    repeated.append("file", new File(["two"], "two.txt"));
    expect(
      (
        await server.request(`https://cloud.example.test/api/chat/conversations/${chat.shortId}/attachments`, {
          method: "POST",
          headers: { ...owner.headers, "x-forwarded-for": uniqueCallerAddress() },
          body: repeated,
        })
      ).status,
    ).toBe(400);
    const empty = await uploaded(owner, chat.shortId, new File([], "empty.txt", { type: "text/plain" }));
    expect(empty.size).toBe(0);
    expect((await (await download(owner, chat.shortId, empty.id)).arrayBuffer()).byteLength).toBe(0);
    const boundary = await uploaded(owner, chat.shortId, new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "max.bin"));
    expect(boundary.size).toBe(MAX_ATTACHMENT_BYTES);
    const response = await download(owner, chat.shortId, boundary.id);
    expect((await response.arrayBuffer()).byteLength).toBe(MAX_ATTACHMENT_BYTES);
    expect(response.headers.get("content-length")).toBe(String(MAX_ATTACHMENT_BYTES));
  });

  test("upload checks thread ownership and archived state with the send rules", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner),
      elsewhere = await f.fixture(owner);
    const response = await f.request(owner.headers, `/${chat.shortId}/threads`, "POST", { name: "Files" });
    expect(response.status).toBe(201);
    const thread = ThreadSchema.parse(await response.json());
    await uploaded(owner, chat.shortId, undefined, thread.id);
    expect((await upload(owner, elsewhere.shortId, undefined, thread.id)).status).toBe(404);
    expect((await f.request(owner.headers, `/${chat.shortId}/threads/${thread.id}`, "PATCH", { archived: true })).status).toBe(200);
    const archived = await upload(owner, chat.shortId, undefined, thread.id);
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ code: "THREAD_ARCHIVED" });
  });

  test("images use filtered bytes, canonical MIME and dimensions; downloads use safe headers", async () => {
    const owner = await f.person(),
      other = await f.person();
    const chat = await f.fixture(owner, [{ person: other, permission: "write" }]);
    const jpeg = withCameraMetadata(await tinyJpeg());
    const attachment = await uploaded(owner, chat.shortId, new File([jpeg], 'Bild "ä".jpg', { type: "image/png" }));
    expect(attachment).toMatchObject({ name: 'Bild "ä".jpg', kind: "image", width: 2, height: 3, mimeType: "image/jpeg" });
    const [row] = await sql<{ content: Uint8Array; size_bytes: number; width: number; height: number }[]>`
      SELECT content, size_bytes, width, height FROM chat.attachments WHERE short_id = ${attachment.id}`;
    expect(row).toMatchObject({ size_bytes: attachment.size, width: 2, height: 3 });
    expect(attachment.size).toBeLessThan(jpeg.length);
    expect(Buffer.from(row!.content).includes(Buffer.from("Apple"))).toBeFalse();
    expect(Buffer.from(row!.content).includes(Buffer.from("GPS"))).toBeFalse();
    const content = await download(owner, chat.shortId, attachment.id);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array(row!.content));
    expect(content.headers.get("content-type")).toBe("image/jpeg");
    expect(content.headers.get("content-disposition")).toStartWith("inline;");
    expect(content.headers.get("content-disposition")).toContain("%C3%A4");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect((await download(other, chat.shortId, attachment.id)).status).toBe(404);
    const gif = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
    const comment = new TextEncoder().encode("comment");
    const taggedGif = new Uint8Array(gif.length + comment.length + 4);
    taggedGif.set(gif.subarray(0, 19));
    taggedGif.set([0x21, 0xfe, comment.length], 19);
    taggedGif.set(comment, 22);
    taggedGif[22 + comment.length] = 0;
    taggedGif.set(gif.subarray(19), 23 + comment.length);
    const gifView = await uploaded(owner, chat.shortId, new File([taggedGif], "animation.gif", { type: "image/gif" }));
    expect(gifView).toMatchObject({ kind: "image", width: 1, height: 1, size: gif.length });
    expect(new Uint8Array(await (await download(owner, chat.shortId, gifView.id)).arrayBuffer())).toEqual(gif);
    const malformed = await upload(owner, chat.shortId, new File(["not an image"], "bad.png", { type: "image/png" }));
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ code: "MALFORMED_IMAGE" });
    for (const type of ["text/html", "image/svg+xml", "application/xml"]) {
      const file = await uploaded(owner, chat.shortId, new File(["<html>text</html>"], "document", { type }));
      expect(file.kind).toBe("file");
      const content = await download(owner, chat.shortId, file.id);
      expect(content.headers.get("content-disposition")).toStartWith("attachment;");
      expect(content.headers.get("content-type")).toBe("application/octet-stream");
      await content.arrayBuffer();
    }
  });

  test("send binds only the subject's own unsent uploads from this chat, atomically and idempotently", async () => {
    const owner = await f.person(),
      other = await f.person(),
      stranger = await f.person();
    const chat = await f.fixture(owner, [{ person: other, permission: "write" }]),
      elsewhere = await f.fixture(owner);
    const first = await uploaded(owner, chat.shortId),
      second = await uploaded(owner, chat.shortId);
    const foreign = await uploaded(other, chat.shortId),
      wrongChat = await uploaded(owner, elsewhere.shortId);
    for (const ids of [[first.id, foreign.id], [wrongChat.id], ["Absent"]]) {
      const response = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
        clientId: crypto.randomUUID(),
        body: "",
        attachments: ids,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_ATTACHMENT" });
    }
    expect(MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages`)).json()).items).toEqual([]);
    const message = await send(owner, chat.shortId, { clientId: "once", attachments: [second.id, first.id] });
    expect(message.body).toBe("");
    expect(message.attachments).toEqual([first, second]);
    const retry = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "once",
      body: "changed",
      attachments: [foreign.id],
    });
    expect(retry.status).toBe(200);
    expect(MessageViewSchema.parse(await retry.json())).toEqual(message);
    const used = await f.request(owner.headers, `/${chat.shortId}/messages`, "POST", {
      clientId: "used",
      body: "",
      attachments: [first.id],
    });
    expect(used.status).toBe(400);
    expect(await used.json()).toMatchObject({ code: "INVALID_ATTACHMENT" });
    const page = MessagePageSchema.parse(await (await f.request(other.headers, `/${chat.shortId}/messages`)).json());
    expect(page.items[0]!.attachments).toEqual([first, second]);
    const changes = ChangesPageSchema.parse(await (await f.request(other.headers, `/${chat.shortId}/changes?afterRev=0`)).json());
    expect(changes.messages[0]!.attachments).toEqual([first, second]);
    const events = await sql<
      { payload: unknown }[]
    >`SELECT payload FROM events.outbox WHERE app_id = 'chat' AND ordering_key = ${`c:${chat.shortId}`} ORDER BY seq`;
    expect(events.map((row) => z.object({ d: ChatLiveEventSchema }).parse(row.payload).d)).toContainEqual({
      type: "message",
      message: expect.objectContaining({ id: message.id, attachments: [first, second] }),
    });
    const reply = await send(other, chat.shortId, { body: "Reply", replyTo: message.id });
    expect(reply.replyTo).toMatchObject({ attachments: [first, second], preview: "File: notes.txt" });
    expect((await download(other, chat.shortId, first.id)).status).toBe(200);
    expect((await download(stranger, chat.shortId, first.id)).status).toBe(404);
    expect((await download(owner, elsewhere.shortId, first.id)).status).toBe(404);
    await sql`DELETE FROM chat.messages WHERE short_id = ${message.id}`;
    expect(await sql`SELECT id FROM chat.attachments WHERE short_id = ANY(${toPgTextArray([first.id, second.id])}::text[])`).toHaveLength(
      0,
    );
    expect((await download(owner, chat.shortId, first.id)).status).toBe(404);
  });

  test("concurrent sends cannot reuse one upload and concurrent uploads respect the pending cap", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    const attachment = await uploaded(owner, chat.shortId);
    const sends = await Promise.all(
      ["first", "second"].map((clientId) =>
        f.request(owner.headers, `/${chat.shortId}/messages`, "POST", { clientId, body: "", attachments: [attachment.id] }),
      ),
    );
    expect(sends.map((response) => response.status).sort()).toEqual([201, 400]);
    for (let i = 0; i < MAX_UNSENT_ATTACHMENTS - 1; i++) await uploaded(owner, chat.shortId);
    await resetUpload(owner);
    const uploads = await Promise.all([upload(owner, chat.shortId), upload(owner, chat.shortId)]);
    expect(uploads.map((response) => response.status).sort()).toEqual([201, 409]);
    const [pending] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM chat.attachments
      WHERE conversation_id = ${chat.id}::uuid AND message_id IS NULL`;
    expect(pending!.count).toBe(MAX_UNSENT_ATTACHMENTS);
  });

  test("attachment-only list and thread previews use the request locale", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    const image = await uploaded(owner, chat.shortId, new File([tinyPng()], "photo.png", { type: "image/png" }));
    await send(owner, chat.shortId, { attachments: [image.id] });
    const german = { ...owner.headers, "accept-language": "de" };
    const chatView = ConversationSchema.parse(await (await f.request(german, `/${chat.shortId}`)).json());
    expect(chatView.lastMessage?.preview).toBe("Foto");
    const threads = ThreadListSchema.parse(await (await f.request(german, `/${chat.shortId}/threads`)).json());
    expect(threads.general.lastMessage?.preview).toBe("Foto");
  });

  test("pending cap returns 409 and the subject-wide upload limiter returns 429 with Retry-After", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (let i = 0; i < MAX_UNSENT_ATTACHMENTS; i++) await uploaded(owner, chat.shortId);
      const full = await upload(owner, chat.shortId);
      expect(full.status).toBe(409);
      expect(await full.json()).toMatchObject({ code: "ATTACHMENT_LIMIT" });
      const elsewhere = await f.fixture(owner);
      const limited = await upload(owner, elsewhere.shortId);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    } finally {
      await resetUpload(owner);
      clock.mockRestore();
    }
  });

  test("cleanup deletes at most one bounded batch older than 24 hours, preserves sent and newer uploads", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    const sent = await uploaded(owner, chat.shortId),
      recent = await uploaded(owner, chat.shortId);
    await send(owner, chat.shortId, { attachments: [sent.id] });
    await sql`UPDATE chat.attachments SET created_at = '1999-12-31T00:00:00Z' WHERE short_id = ${sent.id}`;
    await sql`UPDATE chat.attachments SET created_at = '2000-01-01T00:00:00Z' WHERE short_id = ${recent.id}`;
    for (let i = 0; i < ORPHAN_CLEANUP_BATCH + 1; i++)
      await sql`INSERT INTO chat.attachments
      (short_id, conversation_id, uploader_type, uploader_id, filename, mime_type, size_bytes, kind, content, created_at)
      VALUES (${testShortId()}, ${chat.id}::uuid, 'user', ${owner.id}::uuid, 'orphan', 'text/plain', 0, 'file', ${new Uint8Array()}, '1999-12-31T00:00:00Z')`;
    const now = new Date("2000-01-02T00:00:00Z");
    expect(await cleanupAttachments(sql, now)).toBe(ORPHAN_CLEANUP_BATCH);
    expect(await cleanupAttachments(sql, now)).toBe(1);
    expect(await cleanupAttachments(sql, now)).toBe(0);
    expect(
      (await sql<{ short_id: string }[]>`SELECT short_id FROM chat.attachments WHERE conversation_id = ${chat.id}::uuid ORDER BY short_id`)
        .map((row) => row.short_id)
        .sort(),
    ).toEqual([sent.id, recent.id].sort());
  });

  test("shared image/document pages retain upload positions after refs and links and hide unsent files", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner);
    const expected: string[] = [],
      imageIds: string[] = [],
      documentIds: string[] = [];
    for (let batch = 0; batch < 8; batch++) {
      const attachments = [];
      for (let i = 0; i < 10; i++) {
        const image = i % 2 === 0;
        const id = testShortId(),
          kind = image ? "image" : "file";
        const content = image ? tinyPng() : new TextEncoder().encode("x");
        const createdAt = new Date(Date.UTC(2026, 9, 24, 0, 0, batch * 10 + i));
        await sql`INSERT INTO chat.attachments
          (short_id, conversation_id, uploader_type, uploader_id, filename, mime_type, size_bytes, kind, width, height, content, created_at)
          VALUES (${id}, ${chat.id}::uuid, 'user', ${owner.id}::uuid, ${`${batch}-${i}`},
            ${image ? "image/png" : "text/plain"}, ${content.length}, ${kind}, ${image ? 3 : null}, ${image ? 2 : null}, ${content}, ${createdAt})`;
        attachments.push({ id, kind });
      }
      await send(owner, chat.shortId, {
        body: `https://example.test/${batch}`,
        refs: [{ type: "notebooks.note", id: "abcdef" }],
        attachments: attachments.map((a) => a.id),
      });
      expected.unshift(...attachments.map((a) => a.id));
      imageIds.unshift(...attachments.filter((a) => a.kind === "image").map((a) => a.id));
      documentIds.unshift(...attachments.filter((a) => a.kind === "file").map((a) => a.id));
    }
    await uploaded(owner, chat.shortId);
    for (const [kind, ids] of [
      ["all", expected],
      ["images", imageIds],
      ["documents", documentIds],
    ] as const) {
      let cursor: string | null = null;
      const seen: string[] = [];
      let pages = 0;
      do {
        const query: URLSearchParams = new URLSearchParams({ kind, ...(cursor ? { cursor } : {}) });
        const response = await f.request(owner.headers, `/${chat.shortId}/shared?${query}`);
        expect(response.status).toBe(200);
        const page = SharedPageSchema.parse(await response.json());
        seen.push(...page.items.flatMap((item) => (item.kind === "image" || item.kind === "document" ? [item.attachment.id] : [])));
        if (kind === "all" && pages === 0) expect(page.items.slice(0, 3).map((item) => item.kind)).toEqual(["element", "link", "image"]);
        cursor = page.nextCursor;
        pages++;
        expect(pages).toBeLessThan(10);
      } while (cursor);
      expect(seen).toEqual(ids);
    }
  });

  test("resource threads apply current reader access to uploads, downloads, history and shared files", async () => {
    const owner = await f.person(),
      chat = await f.fixture(owner),
      container = testShortId(),
      item = testShortId();
    await sql`UPDATE chat.conversations SET kind = 'system', resource_type = 'spaces.space', resource_id = ${container} WHERE id = ${chat.id}::uuid`;
    let readable = true;
    reader = spyOn(resourceReaderDependencies, "invoke").mockImplementation(async (_app, capability, input) => {
      const ref = { type: capability === "space.read" ? "spaces.space" : "spaces.item", id: String(input.id) };
      readerKeys.push(accessKey(`user:${owner.id}`, ref));
      if (capability === "item.read" && !readable) return null;
      return {
        data:
          capability === "space.read"
            ? { id: container, name: "Space", permission: "write" }
            : { id: item, title: "Task", kind: "task", spaceId: container },
        links: [{ rel: "open", href: "/app/spaces/test" }],
      };
    });
    const thread = ThreadSchema.parse(
      await (
        await f.request(owner.headers, `/${chat.shortId}/threads/for-resource`, "POST", { ref: { type: "spaces.item", id: item } })
      ).json(),
    );
    const file = await uploaded(owner, chat.shortId, undefined, thread.id);
    expect((await download(owner, chat.shortId, file.id)).status).toBe(200);
    await send(owner, chat.shortId, { thread: thread.id, attachments: [file.id] });
    expect((await download(owner, chat.shortId, file.id)).status).toBe(200);
    readable = false;
    await redis.del(accessKey(`user:${owner.id}`, { type: "spaces.item", id: item }));
    expect((await download(owner, chat.shortId, file.id)).status).toBe(404);
    expect((await upload(owner, chat.shortId, undefined, thread.id)).status).toBe(404);
    expect(SharedPageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/shared?kind=documents`)).json()).items).toEqual(
      [],
    );
    expect(MessagePageSchema.parse(await (await f.request(owner.headers, `/${chat.shortId}/messages`)).json()).items).toEqual([]);
  });
});
