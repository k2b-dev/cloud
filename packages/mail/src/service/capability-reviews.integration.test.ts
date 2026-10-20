import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { assertCapabilityReview } from "@k2b/cloud/capabilities/testing";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { draftReviewAudience, grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { loadSendReviewContent } from "./capability-review-readers";
import { getDraft } from "./drafts";
import { createLocalTag } from "./local-tags";
import { createMailbox } from "./mailboxes";
import { publicIds } from "./public-resources";

const suite = suiteFor("database", "nats", "valkey");
const at = "2026-10-20T06:00:00.000Z";
const recipient = { name: "Lea Berg", address: "lea@outside.test" };

suite("Mail per-call reviews with real grants and draft state", () => {
  let owner: MailRequestContext;
  let ownerId = "";
  let memberId = "";
  let assignedId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let identityId = "";
  let identityShortId = "";
  let otherIdentityShortId = "";
  let draftId = "";
  let draftShortId = "";
  let blobId = "";
  let groupId = "";
  const users: string[] = [];
  const conversations: Array<{ id: string; shortId: string }> = [];
  const grantIds: string[] = [];

  const context = (locale = "de"): CapabilityExecutionContext => ({
    ...owner,
    user: owner.actor.kind === "user" ? owner.actor.user : null,
    requestId: "mail-action-review-fixture",
    origin: "assistant",
    locale,
    signal: new AbortController().signal,
  });
  const createUser = async (name: string) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin)
      VALUES (${`mail-review-${newShortId()}`}, 'local', 'user', ${name}, ${`${name}@internal.test`}, false) RETURNING id`;
    if (!row) throw new Error("Missing review fixture user");
    users.push(row.id);
    return row.id;
  };
  const grant = async (userId: string, scope?: "assigned") => {
    const entry = unwrap(
      await grantMailboxAccess({ context: owner, mailboxId, principal: { type: "user", userId }, permission: "write", scope }),
    );
    grantIds.push(entry.id);
    return entry.id;
  };

  beforeAll(migrate, 30_000);

  beforeEach(async () => {
    users.length = 0;
    conversations.length = 0;
    grantIds.length = 0;
    mailboxId = "";
    groupId = "";
    blobId = "";
    ownerId = await createUser("Owner");
    memberId = await createUser("Member");
    assignedId = await createUser("Assigned");
    const user = await accounts.users.get({ id: ownerId });
    if (!user) throw new Error("Missing owner");
    owner = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: ownerId }, requestId: "mail-review-fixture" };
    const [group] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`mail-review-${newShortId()}`}, 'local', 'Only owner') RETURNING id`;
    groupId = group!.id;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${ownerId}::uuid, ${groupId}::uuid)`;
    const mailbox = unwrap(await createMailbox(owner, { name: "Team Ops", description: "Review integration fixture" }));
    mailboxId = mailbox.id;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = mailboxRow!.short_id;
    await sql`UPDATE mail.mailboxes SET compose_safety = ${{ internalDomains: ["internal.test"], largeRecipientThreshold: 20 }}::jsonb WHERE id = ${mailboxId}::uuid`;
    const [identity] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, status, vcard, default_cc, default_bcc)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Chosen', 'Team Ops', 'team@internal.test', 'verified', 'BEGIN:VCARD\nEND:VCARD', '[{"address":"default-cc@internal.test"}]'::jsonb, '[{"address":"default-bcc@internal.test"}]'::jsonb)
      RETURNING id, short_id`;
    identityId = identity!.id;
    identityShortId = identity!.short_id;
    const [other] = await sql<
      { short_id: string }[]
    >`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Other', 'Other', 'other@internal.test', 'verified') RETURNING short_id`;
    otherIdentityShortId = other!.short_id;
    const [signature] = await sql<{ id: string }[]>`INSERT INTO mail.compose_templates
      (short_id, mailbox_id, kind, scope, name, normalized_name, shortcut, body_template, created_by_actor_kind, created_by_actor_id)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'signature', 'mailbox', 'Team', 'team', 'team', 'Regards {{ sender.display_name }}\n{{ mailbox.logo }}', 'user', ${ownerId}::uuid) RETURNING id`;
    const logoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
    const [logo] = await sql<{ id: string }[]>`INSERT INTO mail.mailbox_logo_versions
      (mailbox_id, content, content_type, pixel_width, pixel_height, display_width, alt_text, sha256, created_by_actor_kind, created_by_actor_id)
      VALUES (${mailboxId}::uuid, ${logoBytes}, 'image/png', 1, 1, 1, 'Team logo', ${new Bun.CryptoHasher("sha256").update(logoBytes).digest("hex")}, 'user', ${ownerId}::uuid) RETURNING id`;
    await sql`UPDATE mail.mailboxes SET logo_version_id = ${logo!.id}::uuid WHERE id = ${mailboxId}::uuid`;
    const [draft] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, sender_identity_id, signature_template_id, author_kind, author_id, last_editor_kind, last_editor_id, to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, revision, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${identityId}::uuid, ${signature!.id}::uuid, 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid,
        ${[recipient]}::jsonb, ${[{ name: "Mira", address: "mira@internal.test" }]}::jsonb, ${[{ name: "Tom", address: "tom@internal.test" }]}::jsonb, 'Maintenance', 'Hello Lea', 7, ${at}, ${at}) RETURNING id, short_id`;
    draftId = draft!.id;
    draftShortId = draft!.short_id;
    const hash = new Bun.CryptoHasher("sha256").update(newShortId()).digest("hex");
    const [blob] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_size, chunk_count, complete, completed_at)
      VALUES (${hash}, 1, 1048576, 1, true, ${at}) RETURNING id`;
    blobId = blob!.id;
    for (const [position, filename] of ["plan.pdf", "calendar.ics"].entries())
      await sql`INSERT INTO mail.draft_attachments
      (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position, created_at)
      VALUES (${newShortId()}, ${draftId}::uuid, ${blobId}::uuid, ${filename}, 'application/octet-stream', 1, ${hash}, ${position}, ${at})`;
    for (const subject of ["Conversation A", "Conversation B"]) {
      const [conversation] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.conversations
        (short_id, mailbox_id, subject, participant_summary, latest_message_at) VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'lea@outside.test', ${at}) RETURNING id, short_id`;
      const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${newShortId()}@example.test>`}, ${subject}, ${at}, 1, ${new Bun.CryptoHasher("sha256").update(subject + mailboxId).digest("hex")}, 'complete') RETURNING id`;
      await sql`INSERT INTO mail.conversation_messages (conversation_id, message_id, position) VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 0)`;
      conversations.push({ id: conversation!.id, shortId: conversation!.short_id });
    }
  }, 30_000);

  afterEach(async () => {
    if (mailboxId) {
      const links = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid UNION SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid`;
      grantIds.push(...links.map((l) => l.access_id));
      await sql`DELETE FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${grantIds}::jsonb))`;
    if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    if (blobId) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${blobId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${users}::jsonb))`;
  }, 30_000);

  const draftReviews = async () => {
    const ctx = context();
    const base = { mailboxId: mailboxShortId, draftId: draftShortId, expectedRevision: 7 };
    return [
      unwrap(
        await mailCapabilities.actions["draft.create"].review(
          mailCapabilities.actions["draft.create"].input.parse({
            mailboxId: mailboxShortId,
            senderIdentityId: identityShortId,
            subject: "Maintenance",
          }),
          ctx,
        ),
      ),
      unwrap(await mailCapabilities.actions["draft.patch"].review({ ...base, patch: { subject: "Updated" } }, ctx)),
      unwrap(
        await mailCapabilities.actions["draft.update"].review(
          mailCapabilities.actions["draft.update"].input.parse({
            ...base,
            draft: { senderIdentityId: identityShortId, subject: "Updated", body: "Hello" },
          }),
          ctx,
        ),
      ),
      unwrap(
        await mailCapabilities.actions["draft.attachment.add"].review(
          { ...base, attachment: { filename: "note.txt", contentType: "text/plain", base64: "eA==" } },
          ctx,
        ),
      ),
    ];
  };
  for (const scope of [undefined, "assigned"] as const)
    test(`all four draft reviews distinguish solo from ${scope ?? "mailbox"} readers`, async () => {
      for (const review of await draftReviews()) expect(review.reach).toBe("draft");
      await grant(memberId, scope);
      for (const review of await draftReviews()) {
        expect(review.reach).toBeUndefined();
        expect(review.consequences?.[0]?.text).toContain("sehen den Entwurf sofort");
        assertCapabilityReview(review);
      }
    }, 30_000);

  test("group and service principals never narrow draft reach", async () => {
    expect((await draftReviewAudience(mailboxId, { type: "service_account", serviceAccountId: assignedId })).shared).toBeTrue();
    const entry = unwrap(
      await grantMailboxAccess({ context: owner, mailboxId, principal: { type: "group", groupId }, permission: "read" }),
    );
    grantIds.push(entry.id);
    for (const review of await draftReviews()) expect(review.reach).toBeUndefined();
  }, 30_000);

  const assignment = async (mode: "add" | "remove" | "replace", userIds: string[], batch: boolean) => {
    const input = { mailboxId: mailboxShortId, assigneeUserIds: userIds, mode };
    return batch
      ? unwrap(
          await mailCapabilities.actions["conversation.assign.batch"].review(
            { ...input, conversationIds: conversations.map((c) => c.shortId) },
            context(),
          ),
        )
      : unwrap(
          await mailCapabilities.actions["conversation.assign"].review({ ...input, conversationId: conversations[0]!.shortId }, context()),
        );
  };
  const seedAssignees = async () => {
    await grant(memberId);
    await grant(assignedId, "assigned");
    for (const c of conversations)
      await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id)
        VALUES (${c.id}::uuid, ${assignedId}::uuid), (${c.id}::uuid, ${memberId}::uuid)`;
  };

  test("single and batch adding another person asks, assigning only yourself stays silent", async () => {
    await grant(memberId);
    for (const batch of [false, true]) {
      expect((await assignment("add", [memberId], batch)).ask).toBe("involves_people");
      expect((await assignment("add", [ownerId], batch)).ask).toBeUndefined();
      const review = await assignment("add", [memberId], batch);
      expect(review.slots.people).toMatchObject({ people: [{ name: "Member", userId: memberId, address: "Member@internal.test" }] });
      assertCapabilityReview(review);
    }
  }, 30_000);

  test("single and batch removing assigned-only readers asks, removing mailbox members does not", async () => {
    await seedAssignees();
    for (const batch of [false, true]) {
      const removed = await assignment("remove", [assignedId], batch);
      expect(removed.ask).toBe("changes_access");
      expect(JSON.stringify(removed.consequences)).toContain(assignedId);
      expect((await assignment("remove", [memberId], batch)).ask).toBeUndefined();
      expect((await assignment("add", [memberId], batch)).ask).toBeUndefined(); // already assigned
    }
  }, 30_000);

  test("a tag name with a joiner, as in an emoji, still gives a valid update review", async () => {
    const tag = unwrap(
      await createLocalTag({ context: owner, mailboxId, input: { name: "Team \u{1F469}\u200D\u{1F4BB}", color: "#0f766e" } }),
    );
    const ids = await publicIds("tags", [tag.id]);
    const review = unwrap(
      await mailCapabilities.actions["mailbox.tag.update"].review(
        { mailboxId: mailboxShortId, tagId: ids.get(tag.id)!, expectedRevision: tag.revision, color: "#1d4ed8" },
        context(),
      ),
    );
    assertCapabilityReview(review);
  }, 30_000);

  test("removing only unknown users is refused as bad input instead of an invalid review", async () => {
    for (const conversationIds of [undefined, conversations.map((c) => c.shortId)]) {
      const input = { mailboxId: mailboxShortId, assigneeUserIds: ["99999999-9999-4999-8999-999999999999"], mode: "remove" as const };
      const result = conversationIds
        ? await mailCapabilities.actions["conversation.assign.batch"].review({ ...input, conversationIds }, context())
        : await mailCapabilities.actions["conversation.assign"].review({ ...input, conversationId: conversations[0]!.shortId }, context());
      expect(result).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    }
  }, 30_000);

  test("single and batch replace detects lost assigned-only access, with adding people taking precedence", async () => {
    await seedAssignees();
    const newcomerId = await createUser("Newcomer");
    await grant(newcomerId);
    for (const batch of [false, true]) {
      expect((await assignment("replace", [], batch)).ask).toBe("changes_access");
      expect((await assignment("replace", [ownerId, memberId], batch)).ask).toBe("changes_access");
      expect((await assignment("replace", [assignedId, memberId], batch)).ask).toBeUndefined();
      const replace = await assignment("replace", [newcomerId], batch);
      expect(replace.ask).toBe("involves_people");
      expect(replace.consequences).toHaveLength(2);
      assertCapabilityReview(replace);
    }
  }, 30_000);

  test("mailbox-wide group membership prevents an assigned-only loss of access", async () => {
    await seedAssignees();
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${assignedId}::uuid, ${groupId}::uuid)`;
    const fullGroup = unwrap(
      await grantMailboxAccess({ context: owner, mailboxId, principal: { type: "group", groupId }, permission: "read" }),
    );
    grantIds.push(fullGroup.id);
    for (const batch of [false, true]) expect((await assignment("remove", [assignedId], batch)).ask).toBeUndefined();
  }, 30_000);

  test("assignment and both status batches report their conversation effects", async () => {
    await seedAssignees();
    expect((await assignment("remove", [assignedId], true)).effects).toBe(conversations.length);
    for (const status of ["done", "open"] as const) {
      const review = unwrap(
        await mailCapabilities.actions["conversation.status.update.batch"].review(
          { mailboxId: mailboxShortId, conversationIds: conversations.map((c) => c.shortId), status },
          context(),
        ),
      );
      expect(review.effects).toBe(conversations.length);
      expect(review.ask).toBeUndefined();
    }
  }, 30_000);

  test("send review shows the chosen identity, exact recipients, every MIME part, rendered signature, schedule, safety and revision", async () => {
    const input = {
      mailboxId: mailboxShortId,
      draftId: draftShortId,
      senderIdentityId: identityShortId,
      expectedRevision: 7,
      scheduledAt: at,
      undoSeconds: 20,
    };
    const review = unwrap(await mailCapabilities.actions["draft.send"].review(input, context()));
    assertCapabilityReview(review);
    expect(review.preview).toMatchObject({
      kind: "message",
      from: { name: "Team Ops", address: "team@internal.test" },
      to: [recipient],
      cc: [{ name: "Mira", address: "mira@internal.test" }],
      bcc: [{ name: "Tom", address: "tom@internal.test" }],
      sendAt: at,
    });
    if (review.preview?.kind !== "message") throw new Error("Expected message preview");
    expect(review.preview.body).toContain("Regards Team Ops");
    expect(review.preview.attachments?.map((a) => a.name)).toEqual(["plan.pdf", "calendar.ics", "logo.png", "contact.vcf"]);
    expect(review.preview.attachments?.every((a) => a.size !== undefined)).toBeTrue();
    expect(review.preview.warnings?.join(" ")).toContain("1 externer Empfänger.");
    expect(review.check).toEqual({
      query: "draft.send.check",
      input: { mailboxId: mailboxShortId, draftId: draftShortId, expectedRevision: 7 },
    });
    expect(review.links?.[0]?.href).toContain("?revision=7&sendContent=");
    const immediate = unwrap(await mailCapabilities.actions["draft.send"].review({ ...input, scheduledAt: undefined }, context()));
    expect(immediate.consequences?.[0]?.text).toContain("20 Sekunden");
    const noUndo = unwrap(
      await mailCapabilities.actions["draft.send"].review({ ...input, scheduledAt: undefined, undoSeconds: 0 }, context()),
    );
    expect(noUndo.consequences).toBeUndefined();
    expect(
      (await mailCapabilities.actions["draft.send"].review({ ...input, senderIdentityId: otherIdentityShortId }, context("en"))).ok,
    ).toBeFalse();
    expect((await mailCapabilities.actions["draft.send"].review({ ...input, expectedRevision: 8 }, context())).ok).toBeFalse();
    await sql`UPDATE mail.drafts SET to_addresses = '[]'::jsonb, cc_addresses = '[]'::jsonb, bcc_addresses = '[]'::jsonb WHERE id = ${draftId}::uuid`;
    try {
      expect(await mailCapabilities.actions["draft.send"].review(input, context("en"))).toMatchObject({
        ok: false,
        error: { message: "At least one recipient is required before sending" },
      });
    } finally {
      await sql`UPDATE mail.drafts SET to_addresses = ${[recipient]}::jsonb WHERE id = ${draftId}::uuid`;
    }
  }, 30_000);

  test("a signature change beyond the display limit changes the approval digest", async () => {
    await sql`UPDATE mail.drafts SET body_markdown = ${"Long body. ".repeat(2000)} WHERE id = ${draftId}::uuid`;
    const input = { mailboxId: mailboxShortId, draftId: draftShortId, senderIdentityId: identityShortId, expectedRevision: 7 };
    const first = unwrap(await mailCapabilities.actions["draft.send"].review(input, context()));
    await sql`UPDATE mail.compose_templates SET body_template = 'Changed signature', revision = revision + 1
      WHERE id = (SELECT signature_template_id FROM mail.drafts WHERE id = ${draftId}::uuid)`;
    const second = unwrap(await mailCapabilities.actions["draft.send"].review(input, context()));
    expect(first.preview).toEqual(second.preview);
    expect(first.links).not.toEqual(second.links);
  }, 30_000);

  test("time-dependent content beyond the display limit changes the approval digest", async () => {
    await sql`UPDATE mail.drafts SET body_markdown = ${"Long body. ".repeat(2000)} WHERE id = ${draftId}::uuid`;
    const signature = "{{ 'now' | date: '%s' }}";
    await sql`UPDATE mail.compose_templates SET body_template = ${signature}
      WHERE id = (SELECT signature_template_id FROM mail.drafts WHERE id = ${draftId}::uuid)`;
    const input = { mailboxId: mailboxShortId, draftId: draftShortId, senderIdentityId: identityShortId, expectedRevision: 7 };
    try {
      setSystemTime(new Date(at));
      const first = unwrap(await mailCapabilities.actions["draft.send"].review(input, context()));
      setSystemTime(new Date("2026-10-20T06:01:00.000Z"));
      const second = unwrap(await mailCapabilities.actions["draft.send"].review(input, context()));
      expect(first.preview).toEqual(second.preview);
      expect(first.links).not.toEqual(second.links);
    } finally {
      setSystemTime();
    }
  }, 30_000);

  test("a user-delegated API key and its browser user have the same hash for the same rendered message", async () => {
    if (owner.actor.kind !== "user") throw new Error("Expected fixture owner user");
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES ('Review API key', 'user_delegated', ${ownerId}::uuid) RETURNING id`;
    if (!account) throw new Error("Missing delegated fixture account");
    try {
      const delegated: MailRequestContext = {
        ...owner,
        actor: {
          kind: "service_account",
          delegatedUser: owner.actor.user,
          scopes: [],
          serviceAccount: {
            id: account.id,
            name: "Review API key",
            kind: "user_delegated",
            status: "active",
            delegatedUserId: ownerId,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: null,
            createdAt: at,
          },
        },
      };
      const draft = unwrap(await getDraft(owner, mailboxId, draftId));
      const browser = unwrap(await loadSendReviewContent({ context: owner, mailboxId, draft, senderIdentityId: identityId }));
      const apiKey = unwrap(await loadSendReviewContent({ context: delegated, mailboxId, draft, senderIdentityId: identityId }));
      expect(apiKey.draft).toEqual(browser.draft);
      expect(apiKey.contentHash).toBe(browser.contentHash);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
    }
  }, 30_000);

  const checkInput = () => ({ mailboxId: mailboxShortId, draftId: draftShortId, expectedRevision: 7 });
  const check = () => mailCapabilities.queries["draft.send.check"].run(checkInput(), context());
  // Snapshot full rows, including updated_at, as well as counts: a pure query may touch none.
  const snapshot = () => sql`SELECT
    (SELECT count(*) FROM mail.drafts WHERE mailbox_id = ${mailboxId}::uuid) AS draft_count,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM mail.drafts d WHERE d.mailbox_id = ${mailboxId}::uuid) AS drafts,
    (SELECT count(*) FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid) AS command_count,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM mail.commands c WHERE c.mailbox_id = ${mailboxId}::uuid) AS commands,
    (SELECT count(*) FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid) AS submission_count,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM mail.outbox_submissions o WHERE o.mailbox_id = ${mailboxId}::uuid) AS submissions`;
  const readWithoutWrites = async () => {
    const before = await snapshot();
    const result = unwrap(await check()).data;
    expect(await snapshot()).toEqual(before);
    return result;
  };
  const submission = async (state: "undo_window" | "scheduled" = "undo_window") => {
    const [resource] = await sql<{ id: string }[]>`INSERT INTO mail.remote_resources
      (mailbox_id, remote_locator, server_identity, scope_fingerprint)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"f".repeat(64)}) RETURNING id`;
    const [connection] = await sql<{ id: string }[]>`INSERT INTO mail.provider_connections
      (owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, status)
      VALUES (${mailboxId}::uuid, 'Test', 'team@internal.test', 'team@internal.test', 'imap.example.test', 993, 'implicit',
        'smtp.example.test', 587, 'starttls', 'password', 'revoked') RETURNING id`;
    const [binding] = await sql<{ id: string }[]>`INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, remote_locator)
      VALUES (${resource!.id}::uuid, ${connection!.id}::uuid, '{}'::jsonb) RETURNING id`;
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, state, actor_kind, actor_id, access_subject_kind, access_subject_id, idempotency_key, request_hash, target, payload, created_at, updated_at)
      VALUES (${mailboxId}::uuid, 'send', 'queued', 'user', ${ownerId}::uuid, 'user', ${ownerId}::uuid, ${newShortId()}, ${"a".repeat(64)},
        ${{ draftId, expectedDraftRevision: 7, senderIdentityId: identityId }}::jsonb,
        ${state === "scheduled" ? { scheduledAt: at } : {}}::jsonb, ${at}, ${at}) RETURNING id`;
    const [outbox] = await sql<{ id: string }[]>`INSERT INTO mail.outbox_submissions
      (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id,
       state, scheduled_at, requested_at, mime_date, created_at, updated_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${draftId}::uuid, ${command!.id}::uuid, ${identityId}::uuid,
        ${binding!.id}::uuid, ${`<${newShortId()}@internal.test>`}, ${state}, ${at}, ${at}, ${at}, ${at}, ${at}) RETURNING id`;
    await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${draftId}::uuid`;
    return { commandId: command!.id, outboxId: outbox!.id };
  };

  test("no send and future revisions are not_done, without writes", async () => {
    expect((await readWithoutWrites()).outcome).toBe("not_done");
    await sql`UPDATE mail.drafts SET state = 'sent' WHERE id = ${draftId}::uuid`;
    expect((await readWithoutWrites()).outcome).toBe("not_done"); // no matching submission
    expect(
      unwrap(await mailCapabilities.queries["draft.send.check"].run({ ...checkInput(), expectedRevision: 8 }, context())).data.outcome,
    ).toBe("not_done");
  }, 30_000);

  test("queued undo-window delivery is done and the check writes nothing", async () => {
    await submission();
    const result = await readWithoutWrites();
    expect(result.outcome).toBe("done");
    expect(result.receipt?.text).toContain("wird gesendet");
  }, 30_000);

  test("scheduled delivery is done with planned wording and no writes", async () => {
    await submission("scheduled");
    const result = await readWithoutWrites();
    expect(result.outcome).toBe("done");
    expect(result.receipt?.text).toContain("geplant für");
    expect(result.receipt?.slots?.at).toMatchObject({ start: at });
  }, 30_000);

  test("all delivery states override command success and are read without writes", async () => {
    const { commandId, outboxId } = await submission();
    await sql`UPDATE mail.commands SET state = 'confirmed' WHERE id = ${commandId}::uuid`;
    for (const [state, outcome, draftState] of [
      ["undo_window", "done", "scheduled"],
      ["sending", "done", "sending"],
      ["accepted", "done", "sending"],
      ["sent_sync_pending", "done", "sent"],
      ["sent", "done", "sent"],
      ["reconciled_accepted", "done", "sent"],
      ["failed", "not_done", "draft"],
      ["cancelled", "not_done", "draft"],
      ["reconciled_unsent", "not_done", "draft"],
      ["unknown", "pending", "sent"],
      ["needs_attention", "pending", "sent"],
    ] as const) {
      await sql`UPDATE mail.outbox_submissions SET state = ${state} WHERE id = ${outboxId}::uuid`;
      // Editable failures/restores may have advanced; in-flight and uncertain sends retain revision 7.
      const revision = draftState === "draft" ? 8 : 7;
      await sql`UPDATE mail.drafts SET state = ${draftState}, revision = ${revision} WHERE id = ${draftId}::uuid`;
      const result = await readWithoutWrites();
      expect(result.outcome).toBe(outcome);
      if (outcome === "done") expect(result.receipt?.text).toContain("wird gesendet");
    }
    expect(
      unwrap(await mailCapabilities.queries["draft.send.check"].run({ ...checkInput(), expectedRevision: 8 }, context())).data.outcome,
    ).toBe("not_done");
  }, 30_000);

  test("failed and cancelled drafts at the send revision remain not_done", async () => {
    const { commandId, outboxId } = await submission();
    for (const [state, draftState, revision] of [
      ["failed", "draft", 7],
      ["cancelled", "discarded", 7],
      ["cancelled", "draft", 8],
    ] as const) {
      await sql`UPDATE mail.commands SET state = ${state} WHERE id = ${commandId}::uuid`;
      await sql`UPDATE mail.outbox_submissions SET state = ${state} WHERE id = ${outboxId}::uuid`;
      await sql`UPDATE mail.drafts SET state = ${draftState}, revision = ${revision} WHERE id = ${draftId}::uuid`;
      expect((await readWithoutWrites()).outcome).toBe("not_done");
    }
  }, 30_000);

  test("outcome checks enforce draft visibility for an assigned-only reader", async () => {
    await grant(assignedId, "assigned");
    const user = await accounts.users.get({ id: assignedId });
    if (!user) throw new Error("Missing user");
    expect(
      (
        await mailCapabilities.queries["draft.send.check"].run(checkInput(), {
          ...context(),
          actor: { kind: "user", user },
          accessSubject: { type: "user", userId: assignedId },
          user,
        })
      ).ok,
    ).toBeFalse();
  }, 30_000);
});
