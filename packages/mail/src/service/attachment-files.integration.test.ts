import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, FileProviderListData, User } from "@k2b/cloud/contracts";
import { FileProviderListInputSchema } from "@k2b/cloud/contracts";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { unwrap } from "@k2b/stdlib";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import { backfillAttachmentFiles } from "./attachment-file-index";
import { listAttachmentFiles } from "./attachment-files";
import type { MailRequestContext } from "./auth";
import type { ConnectorEnvelope } from "./connectors";
import { setMailboxPreference } from "./mailbox-preferences";
import { createMailbox } from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats");

type Address = { name: string; address: string };
type Part = { filename: string; type: string; bytes: number; disposition: "attachment" | "inline"; contentId?: string };

const base64 = (bytes: number, fill: number) =>
  (
    Buffer.alloc(bytes, fill)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");

suite("Mail attachments as a file-provider source", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const address = `team-${suffix}@example.test`;
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  const requestIds: string[] = [];
  let owner: User;
  let reader: User;
  let assigned: User;
  let stranger: User;
  let mailbox = { id: "", shortId: "", resourceId: "", folderId: "" };
  let other = { id: "", shortId: "", resourceId: "", folderId: "" };
  let nextUid = 100;
  const envelopes = new Map<string, { envelope: ConnectorEnvelope; contentId: string }>();

  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-files-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id
    `;
    if (!row) throw new Error("User fixture was not created");
    userIds.push(row.id);
    return {
      id: row.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName: role,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
  };
  const contextFor = (user: User): MailRequestContext => {
    const requestId = `mail-files-${user.uid}`;
    requestIds.push(requestId);
    return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, requestId };
  };
  const capabilityContext = (user: User, locale = "en"): CapabilityExecutionContext => ({
    ...contextFor(user),
    requestId: `mail-files-${user.uid}`,
    user,
    locale,
    origin: "assistant",
    signal: AbortSignal.timeout(30_000),
  });

  const createMailboxWithFolder = async (name: string, withAddress: boolean) => {
    const created = unwrap(await createMailbox(contextFor(owner), { name }));
    mailboxIds.push(created.id);
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${created.id}::uuid`;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${created.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}, 'active') RETURNING id
    `;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`inbox-${created.id}`}, 'Inbox', 'inbox', 'current') RETURNING id
    `;
    if (withAddress)
      await sql`
        INSERT INTO mail.provider_connections (
          owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
          smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, status
        ) VALUES (
          ${created.id}::uuid, 'Files fixture', ${address}, ${address}, 'imap.example.test', 993, 'implicit',
          'smtp.example.test', 465, 'implicit', 'password', 'fixture-secret', 'active'
        )
      `;
    return { id: created.id, shortId: row!.short_id, resourceId: resource!.id, folderId: folder!.id };
  };

  /** One message through the real ingest path: its envelope, then hydration from a MIME source. */
  const receive = async (
    target: typeof mailbox,
    key: string,
    params: { from: Address | null; date: string; parts: Part[] },
  ): Promise<{ messageId: string; conversationId: string }> => {
    nextUid += 1;
    const messageIdHeader = `<${key}-${suffix}@example.test>`;
    const date = new Date(params.date);
    const envelope: ConnectorEnvelope = {
      remoteRef: { kind: "imap", folderStableKey: `inbox-${target.id}`, uidValidity: "1", uid: String(nextUid), modseq: String(nextUid) },
      providerMessageId: null,
      providerThreadId: null,
      messageId: messageIdHeader,
      inReplyTo: null,
      references: [],
      subject: `Files ${key} ${suffix}`,
      sentAt: date,
      internalDate: date,
      sizeBytes: 4096,
      flags: [],
      labels: [],
      addresses: { from: params.from ? [params.from] : [], replyTo: [], to: [{ name: "Team", address }], cc: [], bcc: [] },
      mimeStructure: {},
    };
    const messageId = await ingestEnvelope({
      db: sql,
      mailboxId: target.id,
      remoteResourceId: target.resourceId,
      folderId: target.folderId,
      message: envelope,
      captureWorkflowTriggers: false,
    });
    envelopes.set(key, { envelope, contentId: messageId });
    const boundary = `b-${key}`;
    const source = Buffer.from(
      [
        `Message-ID: ${messageIdHeader}`,
        `Date: ${date.toUTCString()}`,
        ...(params.from ? [`From: ${params.from.name ? `${params.from.name} ` : ""}<${params.from.address}>`] : []),
        `To: Team <${address}>`,
        `Subject: Files ${key} ${suffix}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Body of ${key}`,
        ...params.parts.flatMap((part, index) => [
          `--${boundary}`,
          `Content-Type: ${part.type}; name="${part.filename}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: ${part.disposition}; filename="${part.filename}"`,
          ...(part.contentId ? [`Content-ID: <${part.contentId}>`] : []),
          "",
          base64(part.bytes, index + 1),
        ]),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    expect(await hydrateMessageFromSource({ messageId, source: Readable.from([source]) })).toMatchObject({ status: "hydrated" });
    const [link] = await sql<{ conversation_id: string }[]>`
      SELECT conversation_id::text FROM mail.conversation_messages WHERE message_id = ${messageId}::uuid
    `;
    return { messageId, conversationId: link!.conversation_id };
  };

  const list = async (user: User, input: { parent?: string; query?: string; cursor?: string; limit?: number }, locale = "en") =>
    listAttachmentFiles(contextFor(user), { limit: 50, ...input }, locale);
  const items = async (user: User, input: { parent?: string; query?: string; limit?: number }, locale = "en") =>
    unwrap(await list(user, input, locale)).items.map((entry) => entry.name);
  const all = async (user: User, parent: string, limit: number) => {
    const pages: FileProviderListData[] = [];
    let cursor: string | undefined;
    do {
      const next = unwrap(await list(user, { parent, limit, ...(cursor ? { cursor } : {}) }));
      pages.push(next);
      cursor = next.next ?? undefined;
    } while (cursor && pages.length < 20);
    return pages;
  };
  // report.pdf and photo.jpg share one message and date; their order between them is the attachment ID's.
  const aliceFiles = ["photo.jpg", "report.pdf", "a3.txt", "a2.txt", "a1.txt"];
  const inDateOrder = (names: string[]) => [...names.slice(0, 2).sort(), ...names.slice(2)];
  const alice: Address = { name: "Alice Example", address: "alice@example.test" };
  const bob: Address = { name: "", address: "bob@example.test" };
  let march = "";
  let aliceMarch = "";
  let bobMarch = "";

  beforeAll(async () => {
    owner = await createUser("owner");
    reader = await createUser("reader");
    assigned = await createUser("assigned");
    stranger = await createUser("stranger");
    mailbox = await createMailboxWithFolder(`Files ${suffix}`, true);
    other = await createMailboxWithFolder(`Other files ${suffix}`, false);
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId: mailbox.id,
        principal: { type: "user", userId: reader.id },
        permission: "read",
      }),
    );
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId: mailbox.id,
        principal: { type: "user", userId: assigned.id },
        permission: "read",
        scope: "assigned",
      }),
    );
    const first = await receive(mailbox, "first", {
      from: alice,
      date: "2026-03-10T09:00:00.000Z",
      parts: [
        { filename: "report.pdf", type: "application/pdf", bytes: 6000, disposition: "attachment" },
        { filename: "logo.png", type: "image/png", bytes: 6000, disposition: "inline", contentId: `logo-${suffix}@example.test` },
        { filename: "dot.gif", type: "image/gif", bytes: 40, disposition: "attachment" },
        { filename: "photo.jpg", type: "image/jpeg", bytes: 6000, disposition: "inline" },
      ],
    });
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${first.conversationId}::uuid, ${assigned.id}::uuid)`;
    await receive(mailbox, "bob", {
      from: bob,
      date: "2026-03-20T09:00:00.000Z",
      parts: [{ filename: "contract.txt", type: "text/plain", bytes: 300, disposition: "attachment" }],
    });
    await receive(mailbox, "nobody", {
      from: null,
      date: "2025-12-31T23:30:00.000Z",
      parts: [{ filename: "notes.txt", type: "text/plain", bytes: 200, disposition: "attachment" }],
    });
    for (const day of [1, 2, 3])
      await receive(mailbox, `alice-${day}`, {
        from: alice,
        date: `2026-03-0${day}T09:00:00.000Z`,
        parts: [{ filename: `a${day}.txt`, type: "text/plain", bytes: 100, disposition: "attachment" }],
      });
    await receive(other, "other", {
      from: alice,
      date: "2026-03-10T09:00:00.000Z",
      parts: [{ filename: "elsewhere.pdf", type: "application/pdf", bytes: 500, disposition: "attachment" }],
    });
    march = `${mailbox.shortId}/2026/03`;
    aliceMarch = `${march}/e:${encodeURIComponent(alice.address)}`;
    bobMarch = `${march}/e:${encodeURIComponent(bob.address)}`;
  });

  afterAll(async () => {
    for (const id of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid RETURNING access_id`;
      const assignedAccess = await sql<{ access_id: string }[]>`
        DELETE FROM mail.mailbox_assigned_access WHERE mailbox_id = ${id}::uuid RETURNING access_id
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: id });
      const accessIds = [...access, ...assignedAccess].map((row) => row.access_id);
      if (accessIds.length > 0)
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (requestIds.length > 0)
      await sql`DELETE FROM audit.events WHERE request_id IN (SELECT jsonb_array_elements_text(${requestIds}::jsonb))`;
    if (userIds.length > 0)
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  test("the root lists the mailboxes a reader may see by address, never another one, and leaves out hidden ones", async () => {
    expect(await items(owner, {})).toEqual(expect.arrayContaining([address, `Other files ${suffix}`]));
    expect(await items(reader, {})).toEqual([address]);
    expect(await items(assigned, {})).toEqual([address]);
    expect(await items(stranger, {})).toEqual([]);
    expect(await items(owner, { query: "other files" })).toEqual([`Other files ${suffix}`]);
    unwrap(await setMailboxPreference(contextFor(owner), other.id, { hidden: true }));
    try {
      expect(await items(owner, {})).toEqual([address]);
    } finally {
      unwrap(await setMailboxPreference(contextFor(owner), other.id, { hidden: false }));
    }
    const root = unwrap(await list(reader, {}));
    expect(root).toEqual({ writable: false, items: [{ kind: "folder", id: mailbox.shortId, name: address }], next: null });
  });

  test("a mailbox folder holds years, months and senders with localized names, newest first", async () => {
    expect(await items(reader, { parent: mailbox.shortId })).toEqual(["2026", "2025"]);
    expect(await items(reader, { parent: `${mailbox.shortId}/2026` })).toEqual(["March"]);
    expect(await items(reader, { parent: `${mailbox.shortId}/2026` }, "de")).toEqual(["März"]);
    expect(await items(reader, { parent: march })).toEqual(["Alice Example (alice@example.test)", "bob@example.test"]);
    expect(await items(reader, { parent: `${mailbox.shortId}/2025/12` }, "de")).toEqual(["Unbekannter Absender"]);
    expect(await items(reader, { parent: `${mailbox.shortId}/2025/12` })).toEqual(["Unknown sender"]);
    expect(await items(reader, { parent: `${mailbox.shortId}/2025/12/-` })).toEqual(["notes.txt"]);
    expect(await items(reader, { parent: march, query: "BOB" })).toEqual(["bob@example.test"]);
  });

  test("a sender's folder lists their attachments newest first, without inline images or signature logos", async () => {
    const page = unwrap(await list(reader, { parent: aliceMarch }));
    expect(inDateOrder(page.items.map((entry) => entry.name))).toEqual(aliceFiles);
    expect(page.items.find((entry) => entry.name === "report.pdf")).toMatchObject({
      kind: "file",
      size: 6000,
      mediaType: "application/pdf",
      updatedAt: "2026-03-10T09:00:00.000Z",
    });
    const stored = await sql<{ filename: string }[]>`
      SELECT a.filename FROM mail.attachments a JOIN mail.message_contents mc ON mc.id = a.message_id
      WHERE mc.mailbox_id = ${mailbox.id}::uuid ORDER BY a.filename
    `;
    // Both left-out parts are stored attachments; only the file source leaves them out.
    expect(stored.map((row) => row.filename)).toEqual(expect.arrayContaining(["dot.gif", "logo.png"]));
    expect(await items(reader, { parent: aliceMarch, query: "A2" })).toEqual(["a2.txt"]);
  });

  test("pages hold at most the limit and continue by cursor until next is null", async () => {
    const pages = await all(reader, aliceMarch, 2);
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.at(-1)?.next).toBeNull();
    // The pages hold the unpaged listing in its order, each file once.
    const unpaged = unwrap(await list(reader, { parent: aliceMarch })).items.map((entry) => entry.id);
    expect(pages.flatMap((page) => page.items.map((entry) => entry.id))).toEqual(unpaged);
    expect(inDateOrder(pages.flatMap((page) => page.items.map((entry) => entry.name)))).toEqual(aliceFiles);
    const senders = await all(reader, march, 1);
    expect(senders.flatMap((page) => page.items.map((entry) => entry.name))).toEqual([
      "Alice Example (alice@example.test)",
      "bob@example.test",
    ]);
    const years = await all(reader, mailbox.shortId, 1);
    expect(years.flatMap((page) => page.items.map((entry) => entry.name))).toEqual(["2026", "2025"]);
    expect(await list(reader, { parent: aliceMarch, cursor: "not a cursor" })).toMatchObject({ ok: false, error: { status: 400 } });
  });

  test("an assigned-only reader sees only the attachments of their conversations", async () => {
    expect(await items(assigned, { parent: mailbox.shortId })).toEqual(["2026"]);
    expect(await items(assigned, { parent: march })).toEqual(["Alice Example (alice@example.test)"]);
    expect(inDateOrder(await items(assigned, { parent: aliceMarch }))).toEqual(["photo.jpg", "report.pdf"]);
    expect(await items(assigned, { parent: bobMarch })).toEqual([]);
    expect(await items(assigned, { parent: `${mailbox.shortId}/2025/12/-` })).toEqual([]);
  });

  test("a reader of one mailbox never reaches another one, and malformed folders are not found", async () => {
    for (const parent of [other.shortId, `${other.shortId}/2026/03`]) {
      expect(await list(reader, { parent })).toMatchObject({ ok: false, error: { status: 404 } });
    }
    expect(await list(stranger, { parent: mailbox.shortId })).toMatchObject({ ok: false, error: { status: 404 } });
    for (const parent of [
      `${mailbox.shortId}/26`,
      `${mailbox.shortId}/0000`,
      `${mailbox.shortId}/2026/13`,
      `${mailbox.shortId}/2026/03/x`,
      "../etc",
    ]) {
      expect(await list(reader, { parent })).toMatchObject({ ok: false, error: { status: 404 } });
    }
  });

  test("the capability pages the source and its files open through attachment.content.read with the same access", async () => {
    const run = (user: User, input: Record<string, unknown>) =>
      mailCapabilities.queries["attachment.files.list"].run(FileProviderListInputSchema.parse(input), capabilityContext(user));
    const listed = await run(reader, { parent: aliceMarch, limit: 1 });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.data.data.items).toHaveLength(1);
    expect(listed.data.page?.hasMore).toBe(true);
    const file = unwrap(await list(reader, { parent: aliceMarch })).items.find((entry) => entry.name === "report.pdf")!;
    const read = mailCapabilities.queries["attachment.content.read"];
    const opened = await read.run({ id: file.id }, capabilityContext(reader));
    if (!opened.ok) throw new Error(opened.error.message);
    const stream = opened.data.stream;
    expect(stream).toMatchObject({ direction: "read", name: "report.pdf", mediaType: "application/pdf", size: 6000 });
    const response = await read.stream.read(stream, capabilityContext(reader));
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.alloc(6000, 1))).toBe(true);
    const contract = unwrap(await list(reader, { parent: bobMarch })).items[0]!;
    expect(await read.run({ id: contract.id }, capabilityContext(assigned))).toMatchObject({ ok: false, error: { status: 404 } });
  });

  test("every folder is a fixed, small number of statements, independent of the page size", async () => {
    const meter = await meterSql();
    try {
      const root = await meter.during(() => list(reader, {}));
      expect(root).toHaveLength(2);
      for (const parent of [mailbox.shortId, `${mailbox.shortId}/2026`, march, aliceMarch]) {
        const small = await meter.during(() => list(reader, { parent, limit: 1 }));
        const large = await meter.during(() => list(reader, { parent, limit: 100 }));
        // Resolve the mailbox, four grant reads (actor, mailbox, mailbox-wide and assigned grants), one folder query.
        expect(small).toHaveLength(6);
        expect(large).toHaveLength(6);
      }
    } finally {
      await meter.close();
    }
  });

  test("a message that left every folder takes its attachments out of the source", async () => {
    const bobMessage = envelopes.get("bob")!.contentId;
    await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE message_id = ${bobMessage}::uuid`;
    try {
      expect(await items(reader, { parent: march })).toEqual(["Alice Example (alice@example.test)"]);
    } finally {
      await sql`UPDATE mail.message_placements SET deleted_at = NULL WHERE message_id = ${bobMessage}::uuid`;
    }
  });

  test("a message whose date moves on its next sync moves its attachments with it", async () => {
    const entry = envelopes.get("bob")!;
    const moved = new Date("2026-04-02T09:00:00.000Z");
    await ingestEnvelope({
      db: sql,
      mailboxId: mailbox.id,
      remoteResourceId: mailbox.resourceId,
      folderId: mailbox.folderId,
      message: { ...entry.envelope, internalDate: moved },
      captureWorkflowTriggers: false,
    });
    try {
      expect(await items(reader, { parent: `${mailbox.shortId}/2026` })).toEqual(["April", "March"]);
      expect(await items(reader, { parent: `${mailbox.shortId}/2026/04` })).toEqual(["bob@example.test"]);
    } finally {
      await ingestEnvelope({
        db: sql,
        mailboxId: mailbox.id,
        remoteResourceId: mailbox.resourceId,
        folderId: mailbox.folderId,
        message: entry.envelope,
        captureWorkflowTriggers: false,
      });
    }
    expect(await items(reader, { parent: `${mailbox.shortId}/2026` })).toEqual(["March"]);
  });

  test("the backfill indexes earlier attachments once, resumes from its cursor and changes nothing on a repeat", async () => {
    const snapshot = () => sql<{ attachment_id: string; month: string; sender_email: string }[]>`
      SELECT attachment_id, month::text, sender_email FROM mail.attachment_files
      WHERE mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid) ORDER BY attachment_id
    `;
    const before = await snapshot();
    expect(before).toHaveLength(8);
    await sql`DELETE FROM mail.attachment_files WHERE mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid)`;
    await sql`DELETE FROM mail.attachment_files_backfill`;
    const first = await backfillAttachmentFiles();
    expect(first.completed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(inDateOrder(await items(reader, { parent: aliceMarch }))).toEqual(aliceFiles);
    // A finished backfill is one read; a reset one runs again over indexed rows without adding any.
    expect(await backfillAttachmentFiles()).toEqual(first);
    await sql`DELETE FROM mail.attachment_files_backfill`;
    const again = await backfillAttachmentFiles();
    expect(again).toMatchObject({ completed: true, indexed: 0 });
    expect(await snapshot()).toEqual(before);
    // A cursor midway resumes after it and indexes only what follows.
    const ids = before.map((row) => row.attachment_id);
    const middle = ids[4]!;
    await sql`DELETE FROM mail.attachment_files WHERE attachment_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))`;
    await sql`UPDATE mail.attachment_files_backfill SET after_id = ${middle}::uuid, indexed = 0, completed_at = NULL`;
    await backfillAttachmentFiles();
    const resumed = await snapshot();
    expect(resumed.map((row) => row.attachment_id)).toEqual(ids.filter((id) => id > middle));
  });
});
