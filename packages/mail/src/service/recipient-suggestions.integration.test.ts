import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createRecipientMailboxFixture, recipientSuggestionNow as now, recipientContext } from "../../test/fixtures/recipient-suggestions";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { listRecipientSuggestions } from "./recipient-suggestions";

const suite = suiteFor("database", "nats", "valkey");
suite("mailbox recipient suggestions", () => {
  let fixture: Awaited<ReturnType<typeof createRecipientMailboxFixture>>;
  let other: typeof fixture;
  let assigned: typeof fixture;
  let accountId = "";
  let serviceContext: MailRequestContext;
  let uid = 0;
  let inbox = "";
  let junk = "";
  let drafts = "";
  let overridden = "";
  const seed = async (
    addresses: Array<{ email: string; role?: string; name?: string }>,
    days = 0,
    folderId = inbox,
    deleted = false,
    mailboxId = fixture.mailboxId,
  ) => {
    const number = ++uid;
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<suggest-${number}@example.test>`}, 'Test', 'test',
        ${new Date(now.getTime() - days * 86400000)}, 128, ${number.toString(16).padStart(64, "0")}, 'complete') RETURNING id`;
    if (!message) throw new Error("Could not create message");
    for (const [position, address] of addresses.entries()) {
      await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message.id}::uuid, ${address.role ?? "from"}, ${position}, ${address.name ?? null}, ${address.email}, ${address.email.toLowerCase()})`;
    }
    const [ref] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${folderId}::uuid, ${message.id}::uuid, 1, ${number}) RETURNING id`;
    if (!ref) throw new Error("Could not create placement reference");
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, deleted_at)
      VALUES (${ref.id}::uuid, ${folderId}::uuid, ${message.id}::uuid, ${deleted ? now : null})`;
    return message.id;
  };
  const list = async (query = "example.test", limit = 20, context = fixture.context) => {
    const result = await listRecipientSuggestions({ context, mailboxId: fixture.mailboxId, query, limit, now });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.items;
  };

  beforeAll(async () => {
    await migrate();
    fixture = await createRecipientMailboxFixture();
    other = await createRecipientMailboxFixture();
    assigned = await createRecipientMailboxFixture();
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${fixture.mailboxId}::uuid, '{}', '{}', ${"a".repeat(64)}, 'active') RETURNING id`;
    if (!resource) throw new Error("Could not create resource");
    for (const [name, role] of [
      ["Inbox", "inbox"],
      ["Junk", "junk"],
      ["Drafts", "drafts"],
      ["Override", "other"],
    ]) {
      const [folder] = await sql<
        { id: string }[]
      >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${resource.id}::uuid, ${name}, ${name}, ${role}, 'current') RETURNING id`;
      if (!folder) throw new Error("Could not create folder");
      if (role === "inbox") inbox = folder.id;
      else if (role === "junk") junk = folder.id;
      else if (role === "drafts") drafts = folder.id;
      else overridden = folder.id;
    }
    await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, folder_id, role) VALUES (${fixture.mailboxId}::uuid, ${overridden}::uuid, 'junk')`;
    await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, reply_to)
      VALUES (${newShortId()}, ${fixture.mailboxId}::uuid, 'Own', ' OWN@example.test ', ' REPLY@example.test ')`;
    await seed(
      [
        { email: "own@example.test" },
        { email: "written@example.test", role: "to", name: "Written Recipient" },
        { email: "copied@example.test", role: "cc" },
      ],
      30,
    );
    await seed([{ email: "written@example.test", role: "bcc" }], 31);
    for (let i = 0; i < 6; i++) await seed([{ email: "rank-frequent@example.test" }], i);
    await seed([{ email: "rank-recent@example.test", name: "Ada Lovelace" }], 0);
    await seed([{ email: "rank-recent@example.test", name: " " }], -1);
    await seed([{ email: "rank-recent@example.test", name: "Old Name" }], 20);
    await seed([{ email: "rank-old@example.test" }], 90);
    await seed([{ email: "reply@example.test" }]);
    await seed([{ email: "junk-only@example.test" }], 0, junk);
    await seed([{ email: "own@example.test" }, { email: "draft-only@example.test", role: "to" }], 0, drafts);
    await seed([{ email: "override-only@example.test" }], 0, overridden);
    await seed([{ email: "deleted-only@example.test" }], 0, inbox, true);
    const mixedMessage = await seed([{ email: "mixed-junk@example.test" }]);
    const [mixedRef] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${junk}::uuid, ${mixedMessage}::uuid, 1, ${++uid}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${mixedRef!.id}::uuid, ${junk}::uuid, ${mixedMessage}::uuid)`;
    const mixedDraft = await seed([{ email: "mixed-draft@example.test" }]);
    const [draftRef] = await sql<{ id: string }[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${drafts}::uuid, ${mixedDraft}::uuid, 1, ${++uid}) RETURNING id`;
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${draftRef!.id}::uuid, ${drafts}::uuid, ${mixedDraft}::uuid)`;
    const [otherResource] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${other.mailboxId}::uuid, '{}', '{}', ${"b".repeat(64)}, 'active') RETURNING id`;
    const [otherFolder] = await sql<
      { id: string }[]
    >`INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${otherResource!.id}::uuid, 'other-inbox', 'Inbox', 'inbox', 'current') RETURNING id`;
    await seed([{ email: "other-only@example.test" }], 0, otherFolder!.id, false, other.mailboxId);
    await seed([{ email: "literal_tag@example.test" }]);
    await seed([{ email: "literalxxxtag@example.test" }]);
    await seed([{ email: "not an email" }]);
    for (let i = 0; i < 3; i++) await seed([{ email: "team@localhost" }]);
    await seed([{ email: "team@example.test", name: "N".repeat(250) }], 2);
    await seed([
      { email: "distinct-one@example.test", role: "from" },
      { email: "distinct-one@example.test", role: "reply_to" },
      { email: "distinct-one@example.test", role: "to" },
    ]);
    await seed([{ email: "distinct-two@example.test" }]);
    await seed([{ email: "distinct-two@example.test" }]);
    for (let i = 0; i < 25; i++) await seed([{ email: `limit${i}@example.test` }]);
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (user_id, permission) VALUES (${assigned.user.id}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_assigned_access (mailbox_id, access_id) VALUES (${fixture.mailboxId}::uuid, ${grant!.id}::uuid)`;
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES ('Recipient Agent', 'agent') RETURNING id`;
    accountId = account!.id;
    const [agentGrant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (service_account_id, permission) VALUES (${accountId}::uuid, 'read') RETURNING id`;
    await sql`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${fixture.mailboxId}::uuid, ${agentGrant!.id}::uuid)`;
    serviceContext = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: accountId,
          name: "Recipient Agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: now.toISOString(),
        },
        delegatedUser: null,
        scopes: ["mail:read"],
        credentialId: null,
        credentialExpiresAt: null,
      },
      accessSubject: { type: "service_account", serviceAccountId: accountId },
    };
  });
  afterAll(async () => {
    await fixture?.cleanup();
    await other?.cleanup();
    await assigned?.cleanup();
    if (accountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
  });
  test("ranks written recipients first, then distinct-message recency and frequency; keeps the latest non-empty name", async () => {
    const items = await list();
    expect(items.slice(0, 2).map((item) => item.address)).toEqual(["written@example.test", "copied@example.test"]);
    // Both recipients of one outgoing message outrank the much more frequent sender.
    expect(items[2]?.address).toBe("rank-frequent@example.test");
    expect((await list("rank-")).map((item) => item.address)).toEqual([
      "rank-frequent@example.test",
      "rank-recent@example.test",
      "rank-old@example.test",
    ]);
    expect((await list("recent"))[0]).toMatchObject({
      displayName: "Ada Lovelace",
      lastSeenAt: "2026-10-20T12:00:00.000Z",
      writtenTo: false,
    });
    expect((await list("old@"))[0]?.writtenTo).toBe(false);
  });
  test("matches a display-name word prefix and address substring without treating LIKE syntax as wildcards", async () => {
    expect((await list("LOV")).map((item) => item.address)).toEqual(["rank-recent@example.test"]);
    expect((await list("CENT@")).map((item) => item.address)).toEqual(["rank-recent@example.test"]);
    // `_` and `%` are literal: "l_t" must not also match "literalxxxtag", and "%t" matches nothing.
    expect((await list("l_t")).map((item) => item.address)).toEqual(["literal_tag@example.test"]);
    expect(await list("%t")).toEqual([]);
    expect(await list("\\\\")).toEqual([]);
  });
  test("excludes own identities, other mailboxes, Junk, effective Drafts and deleted placements", async () => {
    for (const query of [
      "own@",
      "reply@",
      "other-only",
      "junk-only",
      "mixed-junk",
      "override-only",
      "draft-only",
      "mixed-draft",
      "deleted-only",
      "not an",
    ])
      expect(await list(query)).toEqual([]);
  });
  test("a Drafts override excludes its folder instead of the provider Drafts folder", async () => {
    await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, folder_id, role)
      VALUES (${fixture.mailboxId}::uuid, ${inbox}::uuid, 'drafts')`;
    try {
      expect(await list("written@")).toEqual([]);
      expect(await list("copied@")).toEqual([]);
      expect((await list("draft-only")).map((item) => item.address)).toEqual(["draft-only@example.test"]);
    } finally {
      await sql`DELETE FROM mail.folder_role_overrides WHERE mailbox_id = ${fixture.mailboxId}::uuid AND role = 'drafts'`;
    }
  });
  test("a provider Drafts folder mapped to another role does not exclude its messages", async () => {
    await sql`INSERT INTO mail.folder_role_overrides (mailbox_id, folder_id, role)
      VALUES (${fixture.mailboxId}::uuid, ${drafts}::uuid, 'archive')`;
    try {
      expect((await list("draft-only")).map((item) => item.address)).toEqual(["draft-only@example.test"]);
    } finally {
      await sql`DELETE FROM mail.folder_role_overrides WHERE mailbox_id = ${fixture.mailboxId}::uuid AND role = 'archive'`;
    }
  });
  test("invalid imported addresses never take a result slot; names fit the recipient name limit", async () => {
    const [item, ...rest] = await list("team@", 1);
    expect(rest).toEqual([]);
    expect(item?.address).toBe("team@example.test");
    expect(item?.displayName).toBe("N".repeat(200));
  });
  test("scores each message only once even when an address occurs in several roles", async () => {
    expect((await list("distinct-")).map((item) => item.address)).toEqual(["distinct-two@example.test", "distinct-one@example.test"]);
  });
  test("honours and defensively clamps the requested limit", async () => {
    expect(await list("limit", 3)).toHaveLength(3);
    expect(await list("limit", 50)).toHaveLength(20);
    expect(await list("limit", -1)).toHaveLength(1);
  });
  test("denies assigned-only callers before returning any data", async () => {
    const result = await listRecipientSuggestions({
      context: recipientContext(assigned.user),
      mailboxId: fixture.mailboxId,
      query: "ad",
      limit: 8,
      now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 403, message: "Access denied" });
  });
  test("bounds work to the newest messages before filtering candidates", async () => {
    const result = await listRecipientSuggestions({
      context: fixture.context,
      mailboxId: fixture.mailboxId,
      query: "example.test",
      limit: 20,
      window: 1,
      now,
    });
    expect(result.ok && result.data.items.map((item) => item.address)).toEqual(["rank-recent@example.test"]);
  });
  test("gives a service account with a mailbox grant the same items as its user", async () => {
    expect(await list("example.test", 20, serviceContext)).toEqual(await list());
  });
});
