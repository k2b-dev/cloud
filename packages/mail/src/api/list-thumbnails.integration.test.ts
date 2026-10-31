import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { projectMailboxPageData } from "../frontend/ssr-public-boundary";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { writeConversationAssignees } from "../service/collaboration";
import { listRowImageAttachments } from "../service/list-image-attachments";
import { validateMailboxLogoImage } from "../service/mailbox-logo-image";
import { createMailbox } from "../service/mailboxes";
import { storeReadableBlob } from "../service/message-blobs";
import { loadMailboxPageData, type MailboxListView, resolveWorkspaceRequest } from "../service/workspace";
import app from ".";

const suite = suiteFor("database", "nats", "valkey");
const anchor = new Date("2026-10-01T12:00:00.000Z");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: null,
});

/** A real, deterministic PNG; uncompressed IDAT keeps the normal images above the 4 KiB threshold. */
const png = (seed: number, width = 128, height = 64) => {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    content.copy(result, 4);
    result.writeUInt32BE(crc32(content), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) pixels[y * (width * 3 + 1) + x + 1] = (x * 17 + y * 13 + seed) % 256;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

type Resource = { id: string; short_id: string };
suite("Mail list attachment images and thumbnail access", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users = new Map<string, User>();
  const blobs = new Set<string>();
  let tokenSpy: { mockRestore: () => void } | undefined;
  let mailboxId = "";
  let mailboxShortId = "";
  let folderId = "";
  let sequence = 0;
  let conversation: Resource;
  let many: Resource;
  let empty: Resource;
  let older: Resource;
  let newer: Resource;
  let first: Resource;
  let second: Resource;
  let pdf: Resource;
  const manyImages: Resource[] = [];
  const context = (name = "owner") => contextFor(users.get(name)!);
  const call = (path: string, token = "owner") =>
    app.request(`/mailboxes/${mailboxShortId}${path}`, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": uniqueCallerAddress() },
    });
  const list = async (token = "owner", listMode = "conversations") => {
    const href = `/app/mail/${mailboxShortId}`;
    const response = await call(`/workspace-list?${new URLSearchParams({ href, listMode })}`, token);
    expect(response.status).toBe(200);
    const page: MailboxListView = await response.json();
    expect(page.listError).toBeNull();
    return page;
  };
  const createConversation = async () => {
    const [row] = await sql<Resource[]>`INSERT INTO mail.conversations
      (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Image fixture', 'Customer', ${anchor}) RETURNING id, short_id`;
    return row!;
  };
  const createMessage = async (target: Resource, date: Date) => {
    sequence++;
    const [row] = await sql<Resource[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, sent_at, size_bytes, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<images-${suffix}-${sequence}@example.test>`}, 'Image fixture', 'image fixture',
        ${date}, ${date}, 30000, ${sequence.toString(16).padStart(64, "0")}, 'complete', 'Image fixture body') RETURNING id, short_id`;
    await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${target.id}::uuid, ${row!.id}::uuid, ${sequence}, 'headers')`;
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${row!.id}::uuid, 1, ${sequence}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${folderId}::uuid, ${row!.id}::uuid, ARRAY[]::text[])`;
    await sql`INSERT INTO mail.message_search_chunks (message_id, mailbox_id, position, search_document)
      VALUES (${row!.id}::uuid, ${mailboxId}::uuid, 0, to_tsvector('simple', 'Image fixture'))`;
    return row!;
  };
  const addAttachment = async (
    message: Resource,
    path: string,
    bytes: Buffer,
    options: {
      type?: string;
      disposition?: string;
      cid?: string;
      nullChecksum?: boolean;
    } = {},
  ) => {
    const blob = await storeReadableBlob(Readable.from([bytes]), bytes.length);
    blobs.add(blob.id);
    const type = options.type ?? "image/png";
    const disposition = options.disposition ?? "attachment";
    const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts
      (message_id, part_path, content_type, disposition, content_id, filename, size_bytes, blob_id, hydration_status)
      VALUES (${message.id}::uuid, ${path}, ${type}, ${disposition}, ${options.cid ?? null}, 'fixture',
        ${bytes.length}, ${blob.id}::uuid, 'complete') RETURNING id`;
    const [row] = await sql<Resource[]>`INSERT INTO mail.attachments
      (short_id, message_id, part_id, filename, content_type, disposition, content_id, checksum, size_bytes, blob_id)
      VALUES (${newShortId()}, ${message.id}::uuid, ${part!.id}::uuid, 'fixture', ${type}, ${disposition}, ${options.cid ?? null},
        ${options.nullChecksum ? null : blob.contentHash}, ${bytes.length}, ${blob.id}::uuid) RETURNING id, short_id`;
    return row!;
  };

  beforeAll(async () => {
    for (const name of ["owner", "reader", "outsider"]) {
      const [row] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${`mail-images-${name}-${suffix}`}, 'local', 'user', ${name}, false) RETURNING id, uid`;
      users.set(name, {
        ...row!,
        roles: ["user"],
        provider: "local",
        profile: "user",
        givenname: name,
        sn: "Test",
        displayName: name,
        mail: `${row!.uid}@example.test`,
        avatarHash: null,
        ipa: null,
        accountExpires: null,
        lastLoginLocal: null,
        memberofGroup: [],
        memberofGroupIds: [],
        manages: [],
        managesGroupIds: [],
      });
    }
    tokenSpy = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token) => {
      const user = users.get(token);
      return user ? { kind: "user", payload: {}, user, scopes: ["read"] } : null;
    });
    mailboxId = unwrap(await createMailbox(context(), { name: `List images ${suffix}` })).id;
    const [mailbox] = await sql<Resource[]>`SELECT id, short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailbox!.short_id;
    unwrap(
      await grantMailboxAccess({
        context: context(),
        mailboxId,
        principal: { type: "user", userId: users.get("reader")!.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}', '{}', ${"c".repeat(64)}, 'active') RETURNING id`;
    const [folder] = await sql<{ id: string }[]>`INSERT INTO mail.folders
      (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, 'inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    folderId = folder!.id;
    conversation = await createConversation();
    older = await createMessage(conversation, new Date(anchor.getTime() - 60000));
    newer = await createMessage(conversation, anchor);
    await addAttachment(older, "1", png(1)); // Same checksum: prefer the newer message.
    // Insert 10 before 2: ordering must use the reader's numeric MIME order.
    second = await addAttachment(newer, "10", png(2), { type: " Image/PNG ; name=photo.png" });
    first = await addAttachment(newer, "2", png(1));
    await addAttachment(newer, "3", png(0, 1, 1));
    await addAttachment(newer, "4", png(3), { disposition: "inline", cid: "inline@example.test" });
    pdf = await addAttachment(newer, "5", Buffer.from("%PDF-1.7\n" + "document".repeat(600)), { type: "application/pdf" });
    many = await createConversation();
    const manyMessage = await createMessage(many, anchor);
    for (let i = 1; i <= 5; i++) manyImages.push(await addAttachment(manyMessage, String(i), png(i + 20), { nullChecksum: i >= 4 }));
    await sql.begin((tx) => writeConversationAssignees(tx, { mailboxId, conversationId: many.id, userIds: [users.get("reader")!.id] }));
    empty = await createConversation();
    await createMessage(empty, anchor);
  }, 30000);

  afterAll(async () => {
    tokenSpy?.mockRestore();
    const grants = mailboxId
      ? await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`
      : [];
    if (mailboxId) await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    for (const { access_id } of grants) await sql`DELETE FROM auth.access WHERE id = ${access_id}::uuid`;
    if (blobs.size)
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...blobs]}::jsonb))`;
    for (const user of users.values()) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  });

  test("lists exactly two qualifying images with newest deduplication and reader attachment order, using public IDs", async () => {
    const page = await list();
    expect(page.listItems.find((row) => row.id === conversation.short_id)).toMatchObject({
      imageAttachments: [
        { messageId: newer.short_id, attachmentId: first.short_id },
        { messageId: newer.short_id, attachmentId: second.short_id },
      ],
      imageAttachmentCount: 2,
    });
    expect(page.listItems.find((row) => row.id === empty.short_id)).toMatchObject({ imageAttachments: [], imageAttachmentCount: 0 });
    expect(page.listItems.find((row) => row.id === many.short_id)).toMatchObject({
      imageAttachments: manyImages.slice(0, 3).map((image) => ({ messageId: expect.any(String), attachmentId: image.short_id })),
      imageAttachmentCount: 5,
    });
    const resolved = await resolveWorkspaceRequest(new URL(`https://cloud.test/app/mail/${mailboxShortId}`), mailboxId);
    expect(resolved).not.toBeNull();
    const data = unwrap(await loadMailboxPageData({ context: context(), mailboxId, ...resolved! }));
    expect((await projectMailboxPageData(data)).listItems).toEqual(page.listItems);
  });

  test("message rows cover only that message", async () => {
    const images = unwrap(
      await listRowImageAttachments({ context: context(), mailboxId, rows: [{ id: older.id, selectionKind: "message" }] }),
    );
    expect(images.get(older.id)).toMatchObject({
      imageAttachmentCount: 1,
      imageAttachments: [{ messageId: older.id, attachmentId: expect.any(String) }],
    });
    const page = await list("owner", "messages");
    expect(page.listItems.find((row) => row.id === older.short_id)).toMatchObject({ imageAttachmentCount: 1 });
    expect(page.listItems.find((row) => row.id === newer.short_id)).toMatchObject({ imageAttachmentCount: 2 });
  });

  test("assigned-only readers get images only for assigned conversations, even on a direct batch lookup", async () => {
    const page = await list("reader");
    expect(page.listItems.map((row) => row.id)).toEqual([many.short_id]);
    expect(page.listItems[0]?.imageAttachmentCount).toBe(5);
    const images = unwrap(
      await listRowImageAttachments({
        context: context("reader"),
        mailboxId,
        rows: [
          { id: conversation.id, selectionKind: "conversation" },
          { id: newer.id, selectionKind: "message" },
        ],
      }),
    );
    expect(images.size).toBe(0);
  });

  test("image lookup failures preserve the list with empty images", async () => {
    const module = await import("../service/list-image-attachments");
    const lookup = spyOn(module, "listRowImageAttachments").mockRejectedValue(new Error("test failure"));
    try {
      const page = await list();
      expect(page.listItems.length).toBe(3);
      for (const row of page.listItems) expect(row).toMatchObject({ imageAttachments: [], imageAttachmentCount: 0 });
    } finally {
      lookup.mockRestore();
    }
  });

  test("thumbnail route rejects PDFs and callers who cannot open the message", async () => {
    const path = `/messages/${newer.short_id}/attachments/`;
    const document = await call(`${path}${pdf.short_id}/thumbnail`);
    expect(document.status).toBeGreaterThanOrEqual(400);
    expect(document.status).toBeLessThan(500);
    for (const token of ["reader", "outsider"]) {
      expect([403, 404]).toContain((await call(`${path}${first.short_id}/thumbnail`, token)).status);
    }
    expect((await call(`/messages/${older.short_id}/attachments/${first.short_id}/thumbnail`)).status).toBe(404);
  });

  (process.platform === "linux" ? test : test.skip)(
    "fits a real image within 96x96 and 48 KiB",
    async () => {
      const response = await call(`/messages/${newer.short_id}/attachments/${first.short_id}/thumbnail`);
      expect(response.status).toBe(200);
      expect(["image/jpeg", "image/png"]).toContain(response.headers.get("content-type") ?? "");
      expect(response.headers.get("cache-control")).toBe("private, max-age=604800, immutable");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBe("inline");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeLessThanOrEqual(48 * 1024);
      const image = unwrap(validateMailboxLogoImage(bytes));
      expect(image.width).toBe(96);
      expect(image.height).toBe(48);
      expect(response.headers.get("content-type")).toBe(image.contentType);
    },
    20000,
  );
});
