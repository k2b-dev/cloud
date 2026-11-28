import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, FileProviderListData, User } from "@k2b/cloud/contracts";
import { FileProviderListInputSchema } from "@k2b/cloud/contracts";
import { backgroundWork } from "@k2b/cloud/services";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { unwrap } from "@k2b/stdlib";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { MAX_DRAFT_ATTACHMENT_BYTES } from "../contracts";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess, type MailboxAccess } from "./access";
import { attachmentFileBackfillSteps, backfillAttachmentFiles, indexMessageAttachments } from "./attachment-file-index";
import { attachmentFileQueries, listAttachmentFiles } from "./attachment-files";
import type { MailRequestContext } from "./auth";
import type { ConnectorEnvelope } from "./connectors";
import { setMailboxPreference } from "./mailbox-preferences";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import { hydrateMessageFromSource } from "./message-hydration";
import { materializeOutboundMessage } from "./outbound-message-projection";
import { outboundDraftSnapshotSchema } from "./outbound-mime";
import { assessMessages } from "./security";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats");

type Address = { name: string; address: string };
type Plan = { "Relation Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; Plans?: Plan[] };
const planNodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
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
  const serviceAccountIds: string[] = [];
  let owner: User;
  let reader: User;
  let assigned: User;
  let stranger: User;
  let mailbox = { id: "", shortId: "", resourceId: "", folderId: "" };
  let other = { id: "", shortId: "", resourceId: "", folderId: "" };
  let nextUid = 100;
  const envelopes = new Map<string, { envelope: ConnectorEnvelope; contentId: string; source: Buffer }>();

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
    params: { from: Address | null; date: string; parts: Part[]; html?: string },
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
        ...(params.html
          ? [
              `Content-Type: multipart/alternative; boundary="alt-${key}"`,
              "",
              `--alt-${key}`,
              "Content-Type: text/plain; charset=utf-8",
              "",
              `Body of ${key}`,
              `--alt-${key}`,
              "Content-Type: text/html; charset=utf-8",
              "",
              params.html,
              `--alt-${key}--`,
            ]
          : ["Content-Type: text/plain; charset=utf-8", "", `Body of ${key}`]),
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
    envelopes.set(key, { envelope, contentId: messageId, source });
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
  // The first message's four shown files share one date; their order between them is the attachment ID's.
  const firstFiles = ["icon.svg", "photo.jpg", "report.pdf", "scan.pdf"];
  const aliceFiles = [...firstFiles, "a3.txt", "a2.txt", "a1.txt"];
  const inDateOrder = (names: string[]) => [...names.slice(0, 4).sort(), ...names.slice(4)];
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
        // As Apple Mail sends a PDF: inline with a Content-ID that the body never references.
        { filename: "scan.pdf", type: "application/pdf", bytes: 6000, disposition: "inline", contentId: `scan-${suffix}@example.test` },
        // Small, but not a format the list previews, so not taken for a logo.
        { filename: "icon.svg", type: "image/svg+xml", bytes: 300, disposition: "attachment", contentId: `icon-${suffix}@example.test` },
        // An image the body shows, sent without an inline disposition: the reader shows it in place, so it stays out.
        { filename: "chart.png", type: "image/png", bytes: 6000, disposition: "attachment", contentId: `chart-${suffix}@example.test` },
      ],
      html: `<p>Body of first</p><img src="cid:logo-${suffix}@example.test" alt="Logo"><img src="cid:chart-${suffix}%40example.test" alt="Chart"><a href="cid:icon-${suffix}@example.test">Icon</a><a href="https://files.example.org/share">Files</a>`,
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
    if (serviceAccountIds.length > 0)
      await sql`DELETE FROM auth.service_accounts WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${serviceAccountIds}::jsonb))`;
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

  test("a sender's folder lists their attachments newest first, without body images or small preview-format logos", async () => {
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
    // Both left-out parts are stored and indexed; the source leaves them out when it reads.
    expect(stored.map((row) => row.filename)).toEqual(expect.arrayContaining(["dot.gif", "logo.png"]));
    const indexed = await sql<{ filename: string; disposition: string; content_id: string | null; body_references: boolean }[]>`
      SELECT filename, disposition, content_id, body_references FROM mail.attachment_files
      WHERE message_id = ${envelopes.get("first")!.contentId}::uuid ORDER BY filename
    `;
    expect(indexed.map((row) => [row.filename, row.disposition, row.body_references])).toEqual([
      ["chart.png", "attachment", true],
      ["dot.gif", "attachment", false],
      ["icon.svg", "attachment", false],
      ["logo.png", "inline", true],
      ["photo.jpg", "inline", false],
      ["report.pdf", "attachment", false],
      ["scan.pdf", "inline", false],
    ]);
    expect(indexed.find((row) => row.filename === "scan.pdf")?.content_id).toBe(`<scan-${suffix}@example.test>`);
    expect(await items(reader, { parent: aliceMarch, query: "A2" })).toEqual(["a2.txt"]);
  });

  test("pages hold at most the limit and continue by cursor until next is null", async () => {
    const pages = await all(reader, aliceMarch, 2);
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 2, 1]);
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
    expect((await items(assigned, { parent: aliceMarch })).sort()).toEqual(firstFiles);
    expect(await items(assigned, { parent: bobMarch })).toEqual([]);
    expect(await items(assigned, { parent: `${mailbox.shortId}/2025/12/-` })).toEqual([]);
  });

  test("service accounts see the source like their other Mail reads: bound to one mailbox and capped by scopes", async () => {
    const serviceContext = async (kind: "agent" | "resource_bound", scopes: string[]): Promise<MailRequestContext> => {
      const name = `Files ${kind} ${scopes.join(" ") || "unscoped"} ${suffix}`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, ${kind}, ${kind === "resource_bound" ? "mail" : null}, ${kind === "resource_bound" ? "mailbox" : null},
          ${kind === "resource_bound" ? mailbox.id : null}::uuid) RETURNING id
      `;
      if (!row) throw new Error("Service account fixture missing");
      serviceAccountIds.push(row.id);
      const context: MailRequestContext = {
        actor: {
          kind: "service_account",
          serviceAccount: {
            id: row.id,
            name,
            kind,
            status: "active",
            delegatedUserId: null,
            appId: kind === "resource_bound" ? "mail" : null,
            resourceType: kind === "resource_bound" ? "mailbox" : null,
            resourceId: kind === "resource_bound" ? mailbox.id : null,
            createdBy: null,
            createdAt: "2026-11-27T10:00:00.000Z",
          },
          delegatedUser: null,
          scopes,
        },
        accessSubject: { type: "service_account", serviceAccountId: row.id },
        requestId: `mail-files-service-${row.id}`,
      };
      for (const target of [mailbox.id, other.id])
        unwrap(
          await grantMailboxAccess({ context: contextFor(owner), mailboxId: target, principal: context.accessSubject, permission: "read" }),
        );
      return context;
    };
    const serviceList = (context: MailRequestContext, parent?: string) =>
      listAttachmentFiles(context, { limit: 50, ...(parent ? { parent } : {}) }, "en");
    // Granted on both mailboxes, but bound to one: only that one, in the root and below it.
    const bound = await serviceContext("resource_bound", ["mail:read"]);
    expect(unwrap(await serviceList(bound)).items.map((entry) => entry.name)).toEqual([address]);
    expect(inDateOrder(unwrap(await serviceList(bound, aliceMarch)).items.map((entry) => entry.name))).toEqual(aliceFiles);
    expect(await serviceList(bound, other.shortId)).toMatchObject({ ok: false, error: { status: 404 } });
    // A credential without a Mail scope reads nothing, whatever its grants.
    const unscoped = await serviceContext("agent", []);
    expect(unwrap(await serviceList(unscoped)).items).toEqual([]);
    expect(await serviceList(unscoped, mailbox.shortId)).toMatchObject({ ok: false, error: { status: 404 } });
    const scoped = await serviceContext("agent", ["mail:read"]);
    expect(
      unwrap(await serviceList(scoped))
        .items.map((entry) => entry.name)
        .sort(),
    ).toEqual([address, `Other files ${suffix}`].sort());
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
        // An assigned-only reader's folders take the same statements.
        expect(await meter.during(() => list(assigned, { parent, limit: 100 }))).toHaveLength(6);
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
    // The backfill reads the stored body in SQL; it must decide like ingest did, also for an `href="cid:"` link.
    const snapshot = () =>
      sql<{ attachment_id: string; month: string; sender_email: string; body_references: boolean; link_domains: string[] }[]>`
      SELECT attachment_id, month::text, sender_email, body_references, link_domains FROM mail.attachment_files
      WHERE mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid) ORDER BY attachment_id
    `;
    // The sanitizer drops a `cid:` href, so the stored body gets one here: the SQL rule must not count it.
    await sql`UPDATE mail.message_contents SET sanitized_html = sanitized_html || ${`<a href="cid:icon-${suffix}@example.test">Icon</a>`}
      WHERE id = ${envelopes.get("first")!.contentId}::uuid`;
    const before = await snapshot();
    // Every stored attachment of both mailboxes has its row, including the parts the source does not show.
    const [stored] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mail.attachments a JOIN mail.message_contents mc ON mc.id = a.message_id
      WHERE mc.mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid)
    `;
    expect(before).toHaveLength(stored!.count);
    await sql`DELETE FROM mail.attachment_files WHERE mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid)`;
    await sql`DELETE FROM mail.attachment_files_backfill`;
    const first = await backfillAttachmentFiles();
    expect(first?.completed).toBe(true);
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

  test("the backfill stops in maintenance „Ruhe“ before its next batch and keeps its cursor", async () => {
    await sql`DELETE FROM mail.attachment_files_backfill`;
    const paused = spyOn(backgroundWork, "paused").mockReturnValue(true);
    try {
      expect(await backfillAttachmentFiles()).toBeNull();
      expect(await sql`SELECT 1 FROM mail.attachment_files_backfill`).toHaveLength(0);
    } finally {
      paused.mockRestore();
    }
    expect((await backfillAttachmentFiles())?.completed).toBe(true);
  });

  test("a sender whose address outgrows a readable ID gets a bounded one that still opens their files", async () => {
    const long: Address = { name: "", address: `${"ü".repeat(300)}@example.test` };
    await receive(other, "long-sender", {
      from: long,
      date: "2026-03-15T09:00:00.000Z",
      parts: [{ filename: "long.txt", type: "text/plain", bytes: 100, disposition: "attachment" }],
    });
    const senders = unwrap(await list(owner, { parent: `${other.shortId}/2026/03` })).items;
    // The name is cut to the contract's 255 characters; the ID is the address's hash.
    const folder = senders.find((entry) => entry.id.includes("/h:"));
    expect(folder?.id).toMatch(new RegExp(`^${other.shortId}/2026/03/h:[0-9a-f]{64}$`));
    expect(folder?.name).toHaveLength(255);
    expect(long.address.startsWith(folder!.name.slice(0, 200))).toBe(true);
    expect(await items(owner, { parent: folder!.id })).toEqual(["long.txt"]);
    expect(senders.every((entry) => entry.id.length <= 2048)).toBe(true);
  });

  test("files the read capability would refuse as too large are not listed", async () => {
    const contract = envelopes.get("bob")!.contentId;
    await sql`UPDATE mail.attachment_files SET size_bytes = ${MAX_DRAFT_ATTACHMENT_BYTES + 1} WHERE message_id = ${contract}::uuid`;
    try {
      expect(await items(reader, { parent: bobMarch })).toEqual([]);
      expect(await items(reader, { parent: march })).toEqual(["Alice Example (alice@example.test)"]);
    } finally {
      await sql`UPDATE mail.attachment_files SET size_bytes = 300 WHERE message_id = ${contract}::uuid`;
    }
    expect(await items(reader, { parent: bobMarch })).toEqual(["contract.txt"]);
  });

  test("hydrating a message again replaces its rows and never doubles them", async () => {
    const { contentId, source } = envelopes.get("bob")!;
    const rows = () => sql<{ attachment_id: string; filename: string }[]>`
      SELECT attachment_id, filename FROM mail.attachment_files WHERE message_id = ${contentId}::uuid
    `;
    const before = await rows();
    await sql`UPDATE mail.message_contents SET hydration_status = 'envelope' WHERE id = ${contentId}::uuid`;
    expect(await hydrateMessageFromSource({ messageId: contentId, source: Readable.from([source]) })).toMatchObject({ status: "hydrated" });
    const after = await rows();
    expect(after.map((row) => row.filename)).toEqual(before.map((row) => row.filename));
    expect(after.map((row) => row.attachment_id)).not.toEqual(before.map((row) => row.attachment_id));
    expect(await items(reader, { parent: bobMarch })).toEqual(["contract.txt"]);
  });

  test("a sent message indexes its files in its projection, and the logo its body shows stays out", async () => {
    const logoId = `logo.${crypto.randomUUID()}@example.test`;
    const file = Buffer.alloc(5000, 7);
    const fileBlob = await storeReadableBlob(Readable.from([file]), file.length);
    const snapshot = outboundDraftSnapshotSchema.parse({
      format: "markdown",
      revision: 1,
      from: { name: "Team", address },
      replyTo: null,
      envelopeFrom: null,
      to: [{ name: "Bob", address: bob.address }],
      cc: [],
      bcc: [],
      subject: `Sent files ${suffix}`,
      body: "See attached",
      renderedHtml: `<p>See attached</p><img src="cid:${logoId}" alt="Team">`,
      inlineLogo: { versionId: crypto.randomUUID(), sha256: "a".repeat(64), contentType: "image/png", byteLength: 5000, contentId: logoId },
      attachments: [
        {
          id: crypto.randomUUID(),
          blobId: fileBlob.id,
          filename: "offer.pdf",
          contentType: "application/pdf",
          byteLength: file.length,
          contentHash: fileBlob.contentHash,
        },
      ],
    });
    const projection = await sql.begin((tx) =>
      materializeOutboundMessage({
        db: tx,
        mailboxId: mailbox.id,
        outboxId: crypto.randomUUID(),
        stableMessageId: `<sent-${suffix}@example.test>`,
        conversationId: null,
        snapshot,
        inlineLogoContent: Buffer.alloc(5000, 9),
        internalDate: new Date("2026-02-14T09:00:00.000Z"),
        byteLength: 10_000,
      }),
    );
    const rows = await sql<{ filename: string; disposition: string; body_references: boolean; sender_email: string }[]>`
      SELECT filename, disposition, body_references, sender_email FROM mail.attachment_files
      WHERE message_id = ${projection.messageId}::uuid ORDER BY filename
    `;
    expect(rows).toEqual([
      { filename: "logo.png", disposition: "inline", body_references: true, sender_email: address },
      { filename: "offer.pdf", disposition: "attachment", body_references: false, sender_email: address },
    ]);
    // Once the sent copy lies in a folder, the source shows its file under the mailbox's own address, without the logo.
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${mailbox.folderId}::uuid, ${projection.messageId}::uuid, 1, 9001) RETURNING id
    `;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${mailbox.folderId}::uuid, ${projection.messageId}::uuid, ARRAY[]::text[])`;
    expect(await items(reader, { parent: `${mailbox.shortId}/2026/02/e:${encodeURIComponent(address)}` })).toEqual(["offer.pdf"]);
  });

  test("attachments of a message a deny rule matches are not listed, except mail Cloud sent itself", async () => {
    const first = envelopes.get("first")!.contentId;
    const [links] = await sql<{ link_domains: string[] }[]>`
      SELECT link_domains FROM mail.attachment_files WHERE message_id = ${first}::uuid LIMIT 1
    `;
    expect(links?.link_domains).toEqual(["files.example.org"]);
    // The sent copy from the projection test also lies in Sent, which marks it as mail Cloud sent.
    const [sent] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${mailbox.resourceId}::uuid, ${`sent-${suffix}`}, 'Sent', 'sent', 'current') RETURNING id
    `;
    const [sentCopy] = await sql<{ message_id: string }[]>`
      SELECT message_id FROM mail.attachment_files WHERE filename = 'offer.pdf' AND mailbox_id = ${mailbox.id}::uuid
    `;
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${sent!.id}::uuid, ${sentCopy!.message_id}::uuid, 1, 9003) RETURNING id
    `;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${sent!.id}::uuid, ${sentCopy!.message_id}::uuid, ARRAY[]::text[])`;
    const withRule = async (target: "sender_address" | "sender_domain" | "link_domain", value: string, check: () => Promise<void>) => {
      const [rule] = await sql<{ id: string }[]>`
        INSERT INTO mail.security_policies (disposition, target, value) VALUES ('deny', ${target}, ${value}) RETURNING id
      `;
      try {
        await check();
      } finally {
        await sql`DELETE FROM mail.security_policies WHERE id = ${rule!.id}::uuid`;
      }
    };
    await withRule("sender_address", bob.address, async () => {
      expect(await items(reader, { parent: march })).toEqual(["Alice Example (alice@example.test)"]);
      expect(await items(reader, { parent: bobMarch })).toEqual([]);
    });
    await withRule("link_domain", "example.org", async () => {
      const files = await items(reader, { parent: aliceMarch });
      expect(files).not.toContain("report.pdf");
      expect(files).toContain("a1.txt");
    });
    await withRule("sender_domain", "example.test", async () => {
      // Every sender of March is at example.test; of their mail only the copy Cloud sent stays.
      expect(await items(reader, { parent: march })).toEqual([]);
      expect(await items(reader, { parent: `${mailbox.shortId}/2026/02/e:${encodeURIComponent(address)}` })).toEqual(["offer.pdf"]);
      // Mail without a sender has no domain to match.
      expect(await items(reader, { parent: mailbox.shortId })).toEqual(["2026", "2025"]);
    });
    // A disabled rule matches nothing.
    await sql`INSERT INTO mail.security_policies (disposition, target, value, enabled) VALUES ('deny', 'sender_address', ${bob.address}, false)`;
    try {
      expect(await items(reader, { parent: bobMarch })).toEqual(["contract.txt"]);
    } finally {
      await sql`DELETE FROM mail.security_policies WHERE value = ${bob.address}`;
    }
  });

  test("the backfill never waits on a delete or a date move, loses nothing to a rollback and reads the moved date", async () => {
    const rolledBack = envelopes.get("alice-1")!.contentId;
    const moved = envelopes.get("alice-2")!.contentId;
    const deleted = envelopes.get("alice-3")!.contentId;
    const attachmentsOf = async (messageId: string) =>
      (await sql<{ id: string }[]>`SELECT id FROM mail.attachments WHERE message_id = ${messageId}::uuid`).map((row) => row.id);
    const [rolledBackIds, movedIds, deletedIds] = [
      await attachmentsOf(rolledBack),
      await attachmentsOf(moved),
      await attachmentsOf(deleted),
    ];
    const held = [...rolledBackIds, ...movedIds, ...deletedIds].sort();
    await sql`DELETE FROM mail.attachment_files WHERE mailbox_id IN (${mailbox.id}::uuid, ${other.id}::uuid)`;
    await sql`DELETE FROM mail.attachment_files_backfill`;
    // Three writers hold their locks: a hydration that will roll back, a purge that commits, and a sync's date move.
    const writers = [await sql.reserve(), await sql.reserve(), await sql.reserve()] as const;
    const [hydration, purge, sync] = writers;
    try {
      await hydration`BEGIN`;
      await hydration`DELETE FROM mail.message_parts WHERE message_id = ${rolledBack}::uuid`;
      await purge`BEGIN`;
      await purge`DELETE FROM mail.message_parts WHERE message_id = ${deleted}::uuid`;
      await sync`BEGIN`;
      await sync`UPDATE mail.message_contents SET internal_date = '2026-05-02T09:00:00Z' WHERE id = ${moved}::uuid`;
      const startedAt = performance.now();
      const blocked = await backfillAttachmentFiles(AbortSignal.timeout(20_000));
      // Shorter than the batch's 10 s lock timeout: it skipped, never waited.
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(blocked?.completed).toBe(false);
      const [marker] = await sql<{ after_id: string }[]>`SELECT after_id::text FROM mail.attachment_files_backfill`;
      expect(marker!.after_id < held[0]!).toBe(true);
      const early = await sql<{ attachment_id: string }[]>`
        SELECT attachment_id FROM mail.attachment_files
        WHERE attachment_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${held}::jsonb))
      `;
      expect(early).toEqual([]);
      await hydration`ROLLBACK`;
      await purge`COMMIT`;
      await sync`COMMIT`;
    } finally {
      for (const writer of writers) {
        await writer`ROLLBACK`.catch(() => undefined);
        writer.release();
      }
    }
    let progress = await backfillAttachmentFiles();
    for (let run = 1; run < 5 && !progress?.completed; run += 1) progress = await backfillAttachmentFiles();
    expect(progress?.completed).toBe(true);
    const indexed = await sql<{ attachment_id: string; month: string }[]>`
      SELECT attachment_id, month::text FROM mail.attachment_files
      WHERE attachment_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${held}::jsonb))
    `;
    const months = new Map(indexed.map((row) => [row.attachment_id, row.month]));
    for (const id of rolledBackIds) expect(months.get(id)).toBe("2026-03-01");
    for (const id of movedIds) expect(months.get(id)).toBe("2026-05-01");
    for (const id of deletedIds) expect(months.has(id)).toBe(false);
    expect(await attachmentsOf(deleted)).toEqual([]);
    expect(await items(reader, { parent: aliceMarch })).toContain("a1.txt");
    expect(await items(reader, { parent: `${mailbox.shortId}/2026/05` })).toEqual(["Alice Example (alice@example.test)"]);
  });

  /** Resolves once a statement on another connection waits for a row lock; fails after the test's own budget. */
  const lockWaitStarted = async (statement: string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await sql<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${statement}%`}
      `;
      if ((row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error(`No statement waits for a lock: ${statement}`);
      await Bun.sleep(25);
    }
  };
  const monthsOf = async (messageId: string) =>
    (await sql<{ month: string }[]>`SELECT month::text FROM mail.attachment_files WHERE message_id = ${messageId}::uuid`).map(
      (row) => row.month,
    );

  test("a date move that waits on a backfill batch between its lock and its insert moves the rows the batch adds", async () => {
    const message = envelopes.get("alice-1")!.contentId;
    await sql`DELETE FROM mail.attachment_files WHERE message_id = ${message}::uuid`;
    const batch = await sql.reserve();
    let moved: Promise<unknown> | undefined;
    try {
      await batch`BEGIN`;
      const [locked] = await attachmentFileBackfillSteps.lock(batch, "00000000-0000-0000-0000-000000000000");
      const ids = locked!.locked.split(",");
      // The sync's date move comes between the batch's lock and its insert, and waits for the batch.
      moved = sql`UPDATE mail.message_contents SET internal_date = '2026-06-03T09:00:00Z' WHERE id = ${message}::uuid AND true`.then(
        (rows) => rows,
      );
      await lockWaitStarted("AND true");
      await attachmentFileBackfillSteps.index(batch, ids);
      await batch`COMMIT`;
      await moved;
    } finally {
      await batch`ROLLBACK`.catch(() => undefined);
      batch.release();
      await moved?.catch(() => undefined);
    }
    // The trigger ran after the batch committed, with a snapshot that holds the batch's rows.
    expect(await monthsOf(message)).toEqual(["2026-06-01"]);
    await sql`UPDATE mail.message_contents SET internal_date = '2026-03-01T09:00:00Z' WHERE id = ${message}::uuid`;
    expect(await monthsOf(message)).toEqual(["2026-03-01"]);
  });

  test("a date move that waits on a hydration inserting rows moves them once the hydration commits", async () => {
    const message = envelopes.get("bob")!.contentId;
    await sql`DELETE FROM mail.attachment_files WHERE message_id = ${message}::uuid`;
    const hydration = await sql.reserve();
    let moved: Promise<unknown> | undefined;
    try {
      await hydration`BEGIN`;
      // As hydration does: the message row first, then its attachments' index rows.
      await hydration`SELECT id FROM mail.message_contents WHERE id = ${message}::uuid FOR UPDATE`;
      await indexMessageAttachments(hydration, message, { contentIds: [], linkDomains: [] });
      moved = sql`UPDATE mail.message_contents SET internal_date = '2026-07-04T09:00:00Z' WHERE id = ${message}::uuid AND 1 = 1`.then(
        (rows) => rows,
      );
      await lockWaitStarted("AND 1 = 1");
      await hydration`COMMIT`;
      await moved;
    } finally {
      await hydration`ROLLBACK`.catch(() => undefined);
      hydration.release();
      await moved?.catch(() => undefined);
    }
    expect(await monthsOf(message)).toEqual(["2026-07-01"]);
    await sql`UPDATE mail.message_contents SET internal_date = '2026-03-20T09:00:00Z' WHERE id = ${message}::uuid`;
    expect(await monthsOf(message)).toEqual(["2026-03-01"]);
  });

  test("the source lists a message's files exactly when the reader opens its links, after ingest and after the backfill", async () => {
    const drift = await createMailboxWithFolder(`Drift ${suffix}`, false);
    const [sentFolder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${drift.resourceId}::uuid, ${`drift-sent-${suffix}`}, 'Sent', 'sent', 'current') RETURNING id
    `;
    const sent = { ...drift, folderId: sentFolder!.id };
    const link = (href: string) => `<p>See</p><a href="${href}">link</a>`;
    const cases: { key: string; from: string; html?: string; target?: typeof drift }[] = [
      { key: "d1", from: "blocked@drift.test" },
      { key: "d2", from: "x@sub.blocked.test" },
      { key: "d3", from: "y@bücher.example" },
      { key: "d4", from: "z@drift.test", html: link("https://müller.example/x") },
      { key: "d5", from: "z@drift.test", html: link("https://%65vil.test/") },
      { key: "d6", from: "z@drift.test", html: link(String.raw`https:\\two.evil.test\x`) },
      { key: "d7", from: "z@drift.test", html: link("https:three.evil.test") },
      { key: "d8", from: "z@drift.test", html: link(" https://four.evil.test/") },
      { key: "d9", from: "z@drift.test", html: link("https://a@b@five.evil.test/") },
      { key: "d10", from: "off@drift.test" },
      { key: "d11", from: "blocked@drift.test", target: sent },
      { key: "d12", from: "ok@drift.test", html: link("https://fine.example/") },
    ];
    const messages = new Map<string, string>();
    for (const [index, item] of cases.entries()) {
      const received = await receive(item.target ?? drift, `drift-${item.key}`, {
        from: { name: "", address: item.from },
        date: `2026-05-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
        parts: [{ filename: `${item.key}.txt`, type: "text/plain", bytes: 100, disposition: "attachment" }],
        ...(item.html ? { html: item.html } : {}),
      });
      messages.set(item.key, received.messageId);
    }
    // Half the messages keep their ingest rows, the other half get theirs from the backfill.
    const backfilled = cases.filter((_, index) => index % 2 === 1).map((item) => messages.get(item.key)!);
    await sql`DELETE FROM mail.attachment_files
      WHERE message_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${backfilled}::jsonb))`;
    await sql`DELETE FROM mail.attachment_files_backfill`;
    let progress = await backfillAttachmentFiles();
    for (let run = 1; run < 3 && !progress?.completed; run += 1) progress = await backfillAttachmentFiles();
    expect(progress?.completed).toBe(true);
    const rules = await sql<{ id: string }[]>`
      INSERT INTO mail.security_policies (disposition, target, value, enabled) VALUES
        ('deny', 'sender_address', 'blocked@drift.test', true),
        ('deny', 'sender_domain', 'blocked.test', true),
        ('deny', 'sender_domain', 'xn--bcher-kva.example', true),
        ('deny', 'link_domain', 'xn--mller-kva.example', true),
        ('deny', 'link_domain', 'evil.test', true),
        ('deny', 'sender_address', 'off@drift.test', false)
      RETURNING id
    `;
    try {
      const assessed = unwrap(await assessMessages(drift.id, [...messages.values()]));
      const outcomes: Record<string, { disabled: boolean; listed: boolean }> = {};
      for (const item of cases) {
        const messageId = messages.get(item.key)!;
        const [row] = await sql<{ sender_email: string }[]>`
          SELECT sender_email FROM mail.attachment_files WHERE message_id = ${messageId}::uuid
        `;
        const parent = `${drift.shortId}/2026/05/${row!.sender_email ? `e:${encodeURIComponent(row!.sender_email)}` : "-"}`;
        const listed = (await items(owner, { parent })).includes(`${item.key}.txt`);
        outcomes[item.key] = { disabled: assessed.get(messageId)!.linksDisabled, listed };
      }
      for (const [key, outcome] of Object.entries(outcomes))
        expect({ key, listed: outcome.listed }).toEqual({ key, listed: !outcome.disabled });
      // The rules reach what they name: sender, subdomain, international sender, links however written; never a disabled rule or a sent copy.
      for (const key of ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9"])
        expect({ key, disabled: outcomes[key]!.disabled }).toEqual({ key, disabled: true });
      for (const key of ["d10", "d11", "d12"]) expect({ key, disabled: outcomes[key]!.disabled }).toEqual({ key, disabled: false });
    } finally {
      await sql`DELETE FROM mail.security_policies WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${rules.map((rule) => rule.id)}::jsonb))`;
    }
  });

  test("an assigned-only reader's folders read their own attachments, not the mailbox's other rows", async () => {
    const blob = await storeReadableBlob(Readable.from([Buffer.from("x")]), 1);
    const [bulk] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailbox.id}::uuid, 'Bulk', 'bulk', '2026-03-12T09:00:00Z', 1,
        encode(sha256(convert_to(${`bulk-${suffix}`}, 'UTF8')), 'hex'), 'complete')
      RETURNING id
    `;
    await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${bulk!.id}::uuid, 'from', 0, 'Alice Example', 'alice@example.test', 'alice@example.test')`;
    // 3,000 attachments in the reader's own month and sender, in a conversation the reader is not assigned to.
    await sql`
      WITH parts AS (
        INSERT INTO mail.message_parts (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
        SELECT ${bulk!.id}::uuid, 'bulk-' || g, 'text/plain', 'attachment', 'bulk-' || g || '.txt', 1, ${blob.id}::uuid, 'complete'
        FROM generate_series(1, 3000) g
        RETURNING id, part_path, filename
      )
      INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      SELECT 'B' || lpad(substr(part_path, 6), 5, '0'), ${bulk!.id}::uuid, id, filename, 'text/plain', 'attachment', 1, ${blob.id}::uuid
      FROM parts
    `;
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${mailbox.folderId}::uuid, ${bulk!.id}::uuid, 1, 9002) RETURNING id
    `;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags)
      VALUES (${ref!.id}::uuid, ${mailbox.folderId}::uuid, ${bulk!.id}::uuid, ARRAY[]::text[])`;
    await indexMessageAttachments(sql, bulk!.id, { contentIds: [], linkDomains: [] });
    await sql`ANALYZE mail.attachment_files`;
    await sql`ANALYZE mail.conversation_assignees`;
    await sql`ANALYZE mail.conversation_messages`;
    // Rules exist while the plans are read, so their lookup is part of what the plans pay.
    const planRules = await sql<{ id: string }[]>`
      INSERT INTO mail.security_policies (disposition, target, value) VALUES
        ('deny', 'sender_domain', 'plan.invalid'), ('deny', 'link_domain', 'plan.invalid'), ('deny', 'sender_address', 'plan@plan.invalid')
      RETURNING id
    `;
    const access: MailboxAccess = { scope: "assigned", permission: "read", userId: assigned.id };
    const sender = { email: alice.address };
    const queries = {
      years: attachmentFileQueries.months(mailbox.id, access, { from: "-infinity", before: "infinity", step: "year", limit: 100 }),
      months: attachmentFileQueries.months(mailbox.id, access, { from: "2026-01-01", before: "2027-01-01", step: "month", limit: 100 }),
      senders: attachmentFileQueries.senders(mailbox.id, access, { year: 2026, month: 3, after: null, query: null, limit: 100 }),
      files: attachmentFileQueries.files(mailbox.id, access, { year: 2026, month: 3, sender, query: null, cursor: null, limit: 100 }),
    };
    for (const [name, query] of Object.entries(queries)) {
      const [explained] = await sql<{ "QUERY PLAN": unknown }[]>`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`;
      const raw = explained!["QUERY PLAN"];
      const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: Plan }[];
      const read = planNodes(plan[0]!.Plan)
        .filter((node) => node["Relation Name"] === "attachment_files")
        .reduce((sum, node) => sum + (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1), 0);
      // The reader's own attachments (six indexed parts of one message), never the 3,000 others of the month.
      expect({ name, read: read <= 20 }).toEqual({ name, read: true });
    }
    expect((await items(assigned, { parent: aliceMarch })).sort()).toEqual(firstFiles);
    expect(await items(reader, { parent: aliceMarch, limit: 3 })).toHaveLength(3);
    await sql`DELETE FROM mail.security_policies WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${planRules.map((rule) => rule.id)}::jsonb))`;
  });
});
