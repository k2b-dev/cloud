import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type ConnectorVerification, unavailableProviderLimitSnapshot } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { rediscoverProviderBinding } from "./bindings";
import { sha256Json } from "./canonical";
import { imapSmtpConnector } from "./connectors";
import { applyMailingListDisposition, listSubscriptions, requestUnsubscribe } from "./list-subscriptions";
import { createMailbox } from "./mailboxes";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";
import { createProviderConnection } from "./provider-connections";

const FOLDER_RIGHTS = ["read", "write_flags", "insert", "move", "delete_messages"];

const remoteFolder = (path: string, uidValidity: string, role: "inbox" | "sent" | "archive") => ({
  stableKey: `${path}:${uidValidity}`,
  path,
  name: path,
  delimiter: "/",
  parentPath: null,
  role,
  subscribed: true,
  selectable: true,
  uidValidity,
  uidNext: "1",
  highestModseq: "1",
  rights: FOLDER_RIGHTS,
  rightsSource: "acl" as const,
});

const fixtureFolders = () => [
  remoteFolder("INBOX", "10", "inbox"),
  remoteFolder("Sent", "20", "sent"),
  remoteFolder("Archive", "30", "archive"),
];

const fixtureVerification = (): ConnectorVerification => ({
  authenticatedPrincipal: "lists@example.test",
  serverIdentity: { serverInfo: { name: "fixture" } },
  capabilities: {
    idle: true,
    condstore: true,
    qresync: true,
    move: true,
    uidplus: true,
    namespace: true,
    listExtended: true,
    specialUse: true,
    acl: true,
    notify: false,
    quota: false,
    gmailExtensions: false,
  },
  limits: unavailableProviderLimitSnapshot(),
  accounts: [
    { id: "lists@example.test", name: "Lists fixture", locator: {}, namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }] },
  ],
});

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: "Mail",
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-list-subscription-${user.uid}`,
});

suite("mailing-list subscriptions", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let mailboxId = "";
  let inboxFolderId = "";
  let sentFolderId = "";
  let ownerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let outsiderContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const createUser = async (label: string) => {
      const uid = `mail-list-${label}-${suffix}`;
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${uid}, false)
        RETURNING id
      `;
      if (!user) throw new Error("Failed to create mailing-list test user");
      userIds.push(user.id);
      return { id: user.id, uid };
    };
    ownerContext = contextFor(await createUser("owner"));
    const reader = await createUser("reader");
    readerContext = contextFor(reader);
    outsiderContext = contextFor(await createUser("outsider"));
    const mailbox = await createMailbox(ownerContext, { name: `Lists ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const access = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!access.ok) throw new Error(access.error.message);

    for (const [index, listId] of ["Updates <updates.example.test>", "Alerts <alerts.example.test>"].entries()) {
      const protocolFacts = {
        ...EMPTY_MESSAGE_PROTOCOL_FACTS,
        list: {
          ...EMPTY_MESSAGE_PROTOCOL_FACTS.list,
          id: listId,
          unsubscribe: [`https://lists.example.test/${index}/unsubscribe`],
          unsubscribePost: "List-Unsubscribe=One-Click",
          post: [`mailto:${index}@example.test`],
          help: [`https://lists.example.test/${index}/help`],
          archive: [`https://lists.example.test/${index}/archive`],
        },
      };
      await sql`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, internal_date, size_bytes, content_hash,
          hydration_status, protocol_facts
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<list-${index}-${suffix}@example.test>`},
          ${`List fixture ${index}`},
          ${new Date(Date.now() - index * 60_000)},
          128,
          ${`${index}`.repeat(64)},
          'complete',
          ${protocolFacts}::jsonb
        )
      `;
    }

    const verify = spyOn(imapSmtpConnector, "verify").mockResolvedValue(fixtureVerification());
    const discover = spyOn(imapSmtpConnector, "discoverFolders").mockResolvedValue(fixtureFolders());
    try {
      const connection = await createProviderConnection({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Lists fixture ${suffix}`,
          email: "lists@example.test",
          username: "lists@example.test",
          imap: { host: "imap.example.test", port: 993, tlsMode: "implicit" },
          smtp: { host: "smtp.example.test", port: 587, tlsMode: "starttls" },
          secret: { kind: "password", password: "fixture-secret" },
        },
      });
      if (!connection.ok) throw new Error(connection.error.message);
      const evidence = {
        version: 1,
        serverKey: sha256Json({ host: "imap.example.test", port: 993, tlsMode: "implicit", serverInfo: { name: "fixture" } }),
        accountId: "lists@example.test",
        namespaces: [{ kind: "personal", prefix: "", delimiter: "/" }],
        folders: fixtureFolders().map((folder) => ({
          relativePath: folder.path,
          parentRelativePath: null,
          name: folder.name,
          role: folder.role,
          remotePath: folder.path,
          delimiter: folder.delimiter,
          selectable: folder.selectable,
          subscribed: folder.subscribed,
          uidValidity: folder.uidValidity,
          uidNext: folder.uidNext,
          highestModseq: folder.highestModseq,
          rights: folder.rights,
          rightsSource: folder.rightsSource,
        })),
      };
      const scope = sha256Json(evidence);
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${mailboxId}::uuid, ${{ accountId: "lists@example.test" }}::jsonb, '{}'::jsonb, ${scope}, 'active')
        RETURNING id
      `;
      const [binding] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_bindings (
          remote_resource_id, connection_id, state, authenticated_principal, remote_locator,
          capabilities, rights, verification_evidence, verified_scope_fingerprint, verified_secret_revision, last_verified_at
        ) VALUES (
          ${resource!.id}::uuid, ${connection.data.connection.id}::uuid, 'active', 'lists@example.test',
          ${{ accountId: "lists@example.test" }}::jsonb, ${fixtureVerification().capabilities}::jsonb, '{}'::jsonb,
          ${evidence}::jsonb, ${scope}, 1, now()
        ) RETURNING id
      `;
      await rediscoverProviderBinding({ bindingId: binding!.id });
    } finally {
      discover.mockRestore();
      verify.mockRestore();
    }
    const folders = await sql<{ id: string; role: string }[]>`
      SELECT folder.id, folder.role
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE resource.mailbox_id = ${mailboxId}::uuid
    `;
    inboxFolderId = folders.find((folder) => folder.role === "inbox")?.id ?? "";
    sentFolderId = folders.find((folder) => folder.role === "sent")?.id ?? "";
    if (!inboxFolderId || !sentFolderId) throw new Error("Failed to discover the mailing-list fixture folders");

    // The list message the user received sits in the inbox; the user's own post to the list sits in Sent.
    const placements: Array<{ messageId: string; folderId: string; uid: number }> = [];
    for (const [index, folderId] of [inboxFolderId, sentFolderId].entries()) {
      const [message] = await sql<{ id: string }[]>`
        SELECT id FROM mail.message_contents
        WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${`<list-${index}-${suffix}@example.test>`}
      `;
      placements.push({ messageId: message!.id, folderId, uid: 500 + index });
    }
    for (const placement of placements) {
      const [uidValidity] = await sql<{ uid_validity: string }[]>`
        SELECT ref.uid_validity FROM mail.binding_folder_refs ref WHERE ref.folder_id = ${placement.folderId}::uuid
      `;
      const [remoteRef] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${placement.folderId}::uuid, ${placement.messageId}::uuid, ${uidValidity!.uid_validity}, ${placement.uid})
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
        VALUES (${remoteRef!.id}::uuid, ${placement.folderId}::uuid, ${placement.messageId}::uuid)
      `;
    }
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((item) => item.access_id)}::jsonb))
        `;
      }
    }
    if (userIds.length > 0) {
      await sql`
        DELETE FROM auth.users
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))
      `;
    }
  });

  test("paginates by cursor and fails closed outside the mailbox", async () => {
    const first = await listSubscriptions({ context: ownerContext, mailboxId, limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items).toHaveLength(1);
    expect(first.data.nextCursor).not.toBeNull();

    const second = await listSubscriptions({
      context: ownerContext,
      mailboxId,
      cursor: first.data.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.items).toHaveLength(1);

    const focused = await listSubscriptions({
      context: ownerContext,
      mailboxId,
      focusedListKey: "alerts.example.test",
      limit: 1,
    });
    expect(focused.ok).toBe(true);
    if (focused.ok) {
      expect(focused.data.items.map((item) => item.listKey)).toEqual(["alerts.example.test", "updates.example.test"]);
      expect(focused.data.nextCursor).not.toBeNull();
    }

    const denied = await listSubscriptions({ context: outsiderContext, mailboxId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
  });

  test("executes a verified one-click endpoint only once", async () => {
    let requestCount = 0;
    const current = await listSubscriptions({ context: ownerContext, mailboxId });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const subscription = current.data.items.find((item) => item.listKey === "updates.example.test");
    expect(subscription?.unsubscribe?.kind).toBe("one_click");
    if (!subscription?.unsubscribe) return;

    const request = () => {
      requestCount += 1;
      return Promise.resolve({ statusCode: 204, location: null });
    };
    const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
    const input = {
      listKey: subscription.listKey,
      href: subscription.unsubscribe.href,
    };
    const first = await requestUnsubscribe({ context: ownerContext, mailboxId, input }, { request, lookup });
    const second = await requestUnsubscribe({ context: ownerContext, mailboxId, input }, { request, lookup });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(requestCount).toBe(1);
    if (first.ok && second.ok) expect(second.data.requestedAt).toBe(first.data.requestedAt);
  });

  test("lets readers inspect lists but not change subscriptions or messages", async () => {
    const visible = await listSubscriptions({ context: readerContext, mailboxId });
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    const subscription = visible.data.items[0];
    expect(subscription).toBeDefined();
    if (!subscription?.unsubscribe) return;

    const unsubscribe = await requestUnsubscribe({
      context: readerContext,
      mailboxId,
      input: { listKey: subscription.listKey, href: subscription.unsubscribe.href },
    });
    expect(unsubscribe.ok).toBe(false);
    if (!unsubscribe.ok) expect(unsubscribe.error.status).toBe(403);

    const disposition = await applyMailingListDisposition({
      context: readerContext,
      mailboxId,
      input: {
        listKey: subscription.listKey,
        disposition: "archive",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(disposition.ok).toBe(false);
    if (!disposition.ok) expect(disposition.error.status).toBe(403);
  });

  test("never disposes the user's own list posts out of Sent", async () => {
    const received = await applyMailingListDisposition({
      context: ownerContext,
      mailboxId,
      input: { listKey: "updates.example.test", disposition: "archive", idempotencyKey: `inbox-disposition-${suffix}` },
    });
    expect(received.ok).toBe(true);
    if (received.ok) expect(received.data).toEqual({ commandCount: 1, truncated: false });

    const ownPost = await applyMailingListDisposition({
      context: ownerContext,
      mailboxId,
      input: { listKey: "alerts.example.test", disposition: "archive", idempotencyKey: `sent-disposition-${suffix}` },
    });
    expect(ownPost.ok).toBe(true);
    if (ownPost.ok) expect(ownPost.data).toEqual({ commandCount: 0, truncated: false });
  });

  test("requires write access before selecting disposition targets", async () => {
    const denied = await applyMailingListDisposition({
      context: outsiderContext,
      mailboxId,
      input: {
        listKey: "updates.example.test",
        disposition: "archive",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.status).toBe(403);
  });
});
