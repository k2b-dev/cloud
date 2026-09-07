import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import {
  grantMailboxAccess,
  grantMailboxAccessAsPlatformAdmin,
  listMailboxAccessAsPlatformAdmin,
  revokeMailboxAccessAsPlatformAdmin,
  updateMailboxAccessAsPlatformAdmin,
} from "./access";
import type { MailRequestContext } from "./auth";
import { resolveMailExecution } from "./execution";
import {
  createMailbox,
  deleteMailbox,
  getDeletedMailbox,
  getMailbox,
  listDeletedMailboxes,
  listMailboxes,
  restoreMailbox,
} from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex } from "./provider-operation-lock";

const suite = process.env.MAIL_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const contextFor = (user: { id: string; uid: string; admin: boolean }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.com`,
      roles: user.admin ? ["admin", "user"] : ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: user.admin,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mailbox-lifecycle-${user.uid}`,
});

suite("reversible mailbox lifecycle", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  const userIds: string[] = [];
  let ownerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let platformContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const users = await sql<{ id: string; uid: string; admin: boolean }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`mailbox-owner-${suffix}`}, 'local', 'user', 'Mailbox Owner', false),
        (${`mailbox-reader-${suffix}`}, 'local', 'user', 'Mailbox Reader', false),
        (${`mailbox-platform-${suffix}`}, 'local', 'user', 'Mailbox Platform Admin', true)
      RETURNING id, uid, admin
    `;
    const owner = users.find((user) => user.uid === `mailbox-owner-${suffix}`);
    const reader = users.find((user) => user.uid === `mailbox-reader-${suffix}`);
    const platform = users.find((user) => user.uid === `mailbox-platform-${suffix}`);
    if (!owner || !reader || !platform) throw new Error("Failed to create mailbox lifecycle users");
    userIds.push(...users.map((user) => user.id));
    ownerContext = contextFor(owner);
    readerContext = contextFor(reader);
    platformContext = contextFor(platform);
  });

  afterAll(async () => {
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((entry) => entry.access_id)}::jsonb))
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

  test("platform administrators can repair access without implicit mailbox access", async () => {
    const created = await createMailbox(ownerContext, { name: `Recovery ${suffix}` });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mailboxIds.push(created.data.id);

    expect((await getMailbox(platformContext, created.data.id)).ok).toBe(false);
    expect((await listMailboxAccessAsPlatformAdmin(ownerContext, created.data.id)).ok).toBe(false);
    const initial = await listMailboxAccessAsPlatformAdmin(platformContext, created.data.id);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const ownerEntry = initial.data.find((entry) => entry.permission === "admin");
    expect(ownerEntry).toBeDefined();
    if (!ownerEntry) return;

    const readerId = readerContext.accessSubject.type === "user" ? readerContext.accessSubject.userId : "";
    const replacement = await grantMailboxAccessAsPlatformAdmin({
      context: platformContext,
      mailboxId: created.data.id,
      principal: { type: "user", userId: readerId },
      permission: "admin",
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;

    expect(
      (
        await updateMailboxAccessAsPlatformAdmin({
          context: platformContext,
          mailboxId: created.data.id,
          accessId: ownerEntry.id,
          permission: "read",
        })
      ).ok,
    ).toBe(true);
    const lastAdminRemoval = await revokeMailboxAccessAsPlatformAdmin({
      context: platformContext,
      mailboxId: created.data.id,
      accessId: replacement.data.id,
    });
    expect(lastAdminRemoval.ok).toBe(false);

    expect(
      (
        await updateMailboxAccessAsPlatformAdmin({
          context: platformContext,
          mailboxId: created.data.id,
          accessId: ownerEntry.id,
          permission: "admin",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await revokeMailboxAccessAsPlatformAdmin({
          context: platformContext,
          mailboxId: created.data.id,
          accessId: replacement.data.id,
        })
      ).ok,
    ).toBe(true);

    const [auditEntry] = await sql<{ authority: string | null }[]>`
      SELECT (metadata #>> '{}')::jsonb ->> 'authority' AS authority
      FROM audit.events
      WHERE target_type = 'mailbox'
        AND target_id = ${created.data.id}
        AND action = 'mail.mailbox.access.grant'
        AND request_id = ${platformContext.requestId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(auditEntry?.authority).toBe("platform_admin");
    expect((await getMailbox(platformContext, created.data.id)).ok).toBe(false);
  });

  test("delete fences work and restore remains paused", async () => {
    const created = await createMailbox(ownerContext, { name: `Reversible ${suffix}` });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const mailboxId = created.data.id;
    mailboxIds.push(mailboxId);
    const receivingAddress = `reversible-${suffix}@example.com`;
    await sql`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret
      ) VALUES (
        ${mailboxId}::uuid, 'Lifecycle fixture', ${receivingAddress}, ${receivingAddress},
        'imap.example.com', 993, 'implicit', 'smtp.example.com', 587, 'starttls',
        'password', 'lifecycle-fixture-secret'
      )
    `;
    expect((await getMailbox(platformContext, mailboxId)).ok).toBe(false);
    const platformMailboxes = await listMailboxes(platformContext);
    expect(platformMailboxes.ok).toBe(true);
    if (platformMailboxes.ok) {
      expect(platformMailboxes.data.some((mailbox) => mailbox.id === mailboxId)).toBe(false);
    }
    const reader = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: readerContext.accessSubject.type === "user" ? readerContext.accessSubject.userId : "" },
      permission: "read",
    });
    expect(reader.ok).toBe(true);
    const literalMatch = await listMailboxes(ownerContext, 100, undefined, `reversible ${suffix}`);
    expect(literalMatch.ok && literalMatch.data.some((mailbox) => mailbox.id === mailboxId)).toBe(true);
    if (literalMatch.ok) {
      expect(literalMatch.data.find((mailbox) => mailbox.id === mailboxId)?.receivingAddress).toBe(receivingAddress);
    }
    const addressMatch = await listMailboxes(ownerContext, 100, undefined, receivingAddress.toUpperCase());
    expect(addressMatch.ok && addressMatch.data.some((mailbox) => mailbox.id === mailboxId)).toBe(true);
    const wildcardText = await listMailboxes(ownerContext, 100, undefined, `%Reversible ${suffix}%`);
    expect(wildcardText.ok && wildcardText.data.some((mailbox) => mailbox.id === mailboxId)).toBe(false);
    const singleCharacterWildcard = await listMailboxes(ownerContext, 100, undefined, "_");
    expect(singleCharacterWildcard.ok && singleCharacterWildcard.data.some((mailbox) => mailbox.id === mailboxId)).toBe(false);

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (
        mailbox_id, remote_locator, server_identity, scope_fingerprint, status
      ) VALUES (
        ${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)}, 'active'
      )
      RETURNING id
    `;
    const requestHash = "b".repeat(64);
    const commandIds = await sql<{ id: string; idempotency_key: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id, kind, state, actor_kind, access_subject_kind,
        idempotency_key, request_hash, target, payload, attempt, started_at,
        worker_heartbeat_at, provider_effect_started_at, provider_effect_attempt
      ) VALUES
        (${mailboxId}::uuid, 'sync_mailbox', 'queued', 'system', 'system',
          ${`queued-${suffix}`}, ${requestHash}, '{}'::jsonb, '{}'::jsonb, 0, NULL, NULL, NULL, NULL),
        (${mailboxId}::uuid, 'sync_mailbox', 'executing', 'system', 'system',
          ${`executing-${suffix}`}, ${requestHash}, '{}'::jsonb, '{}'::jsonb, 1, now(), now(), NULL, NULL),
        (${mailboxId}::uuid, 'sync_mailbox', 'executing', 'system', 'system',
          ${`effect-${suffix}`}, ${requestHash}, '{}'::jsonb, '{}'::jsonb, 1, now(), now(), now(), 1)
      RETURNING id, idempotency_key
    `;
    const ownerId = ownerContext.accessSubject.type === "user" ? ownerContext.accessSubject.userId : null;
    if (!ownerId) throw new Error("Mailbox lifecycle owner must be user-backed");
    const linkTokenHash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const grantTokenHash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const [attachmentLink] = await sql<{ id: string }[]>`
      INSERT INTO mail.attachment_links (
        mailbox_id, source_kind, source_id, filename, content_type, byte_length,
        token_hash, created_by_actor_kind, created_by_actor_id
      ) VALUES (
        ${mailboxId}::uuid, 'message', ${crypto.randomUUID()}::uuid, 'deleted-mailbox.txt',
        'text/plain', 1, ${linkTokenHash}, 'user', ${ownerId}::uuid
      )
      RETURNING id
    `;
    if (!attachmentLink) throw new Error("Failed to create lifecycle attachment link");
    await sql`
      INSERT INTO mail.attachment_link_grants (token_hash, link_id, expires_at)
      VALUES (${grantTokenHash}, ${attachmentLink.id}::uuid, now() + interval '30 minutes')
    `;

    const providerLock = await mailProviderOperationMutex().acquire({ resource: resource!.id, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
    expect(providerLock).not.toBeNull();
    if (!providerLock) return;
    const deletion = deleteMailbox(ownerContext, mailboxId);
    let deletionResult: Awaited<typeof deletion>;
    try {
      await Bun.sleep(100);
      const [beforeRelease] = await sql<{ deleted: boolean }[]>`
        SELECT deleted_at IS NOT NULL AS deleted FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
      `;
      expect(beforeRelease?.deleted).toBe(false);
    } finally {
      await mailProviderOperationMutex().release(providerLock);
      deletionResult = await deletion;
    }
    expect(deletionResult.ok).toBe(true);
    expect((await deleteMailbox(ownerContext, mailboxId)).ok).toBe(true);
    expect((await getMailbox(ownerContext, mailboxId)).ok).toBe(false);
    expect((await resolveMailExecution({ mailboxId, operation: "actorRead", context: ownerContext })).ok).toBe(false);
    const [linkState] = await sql<{ revoked: boolean; grants: number }[]>`
      SELECT
        link.revoked_at IS NOT NULL AS revoked,
        (SELECT COUNT(*)::int FROM mail.attachment_link_grants link_grant WHERE link_grant.link_id = link.id) AS grants
      FROM mail.attachment_links link
      WHERE link.id = ${attachmentLink.id}::uuid
    `;
    expect(linkState).toEqual({ revoked: true, grants: 0 });
    const activeMailboxes = await listMailboxes(ownerContext);
    expect(activeMailboxes.ok && activeMailboxes.data.some((mailbox) => mailbox.id === mailboxId)).toBe(false);

    const ownerDeleted = await listDeletedMailboxes(ownerContext);
    expect(ownerDeleted.ok && ownerDeleted.data.items.some((mailbox) => mailbox.id === mailboxId)).toBe(true);
    const readerDeleted = await listDeletedMailboxes(readerContext);
    expect(readerDeleted.ok && readerDeleted.data.items.some((mailbox) => mailbox.id === mailboxId)).toBe(false);
    expect((await getDeletedMailbox(readerContext, mailboxId)).ok).toBe(false);
    const platformDeleted = await getDeletedMailbox(platformContext, mailboxId);
    expect(platformDeleted.ok).toBe(true);
    if (platformDeleted.ok) expect(JSON.stringify(platformDeleted.data)).not.toContain("secret");

    const commandStates = await sql<{ idempotency_key: string; state: string; worker_heartbeat_at: Date | null }[]>`
      SELECT idempotency_key, state, worker_heartbeat_at
      FROM mail.commands
      WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${commandIds.map((command) => command.id)}::jsonb))
      ORDER BY idempotency_key
    `;
    expect(commandStates).toEqual([
      { idempotency_key: `effect-${suffix}`, state: "needs_attention", worker_heartbeat_at: null },
      { idempotency_key: `executing-${suffix}`, state: "cancelled", worker_heartbeat_at: null },
      { idempotency_key: `queued-${suffix}`, state: "cancelled", worker_heartbeat_at: null },
    ]);

    const restored = await restoreMailbox(ownerContext, mailboxId);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.data).toMatchObject({ syncEnabled: false, health: "paused" });
    expect((await restoreMailbox(ownerContext, mailboxId)).ok).toBe(true);
    const readExecution = await resolveMailExecution({ mailboxId, operation: "actorRead", context: ownerContext });
    expect(readExecution.ok && readExecution.data.localOnly).toBe(true);
    const pausedExecution = await resolveMailExecution({ mailboxId, operation: "actorMutation", context: ownerContext });
    expect(pausedExecution.ok).toBe(false);
    if (!pausedExecution.ok) expect(pausedExecution.error.message).toBe("Mailbox transport is paused");
    const [resourceState] = await sql<{ status: string; sync_generation: string; current_fence_token: string }[]>`
      SELECT status, sync_generation::text, current_fence_token::text
      FROM mail.remote_resources
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(resourceState).toEqual({ status: "paused", sync_generation: "3", current_fence_token: "2" });
    const lifecycleActivity = await sql<{ action: string; count: number }[]>`
      SELECT action, COUNT(*)::int AS count
      FROM mail.activity_events
      WHERE mailbox_id = ${mailboxId}::uuid AND action IN ('mailbox.deleted', 'mailbox.restored')
      GROUP BY action
      ORDER BY action
    `;
    expect(lifecycleActivity).toEqual([
      { action: "mailbox.deleted", count: 1 },
      { action: "mailbox.restored", count: 1 },
    ]);
  });

  test("deleted mailbox pagination has stable, non-overlapping cursors", async () => {
    const createdIds: string[] = [];
    for (const label of ["A", "B", "C"]) {
      const created = await createMailbox(ownerContext, { name: `Deleted page ${label} ${suffix}` });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      mailboxIds.push(created.data.id);
      createdIds.push(created.data.id);
      expect((await deleteMailbox(ownerContext, created.data.id)).ok).toBe(true);
    }

    const first = await listDeletedMailboxes(ownerContext, { limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items).toHaveLength(1);
    expect(first.data.nextCursor).not.toBeNull();

    const second = await listDeletedMailboxes(ownerContext, { limit: 1, cursor: first.data.nextCursor! });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items).toHaveLength(1);
    expect(second.data.items[0]!.id).not.toBe(first.data.items[0]!.id);

    const seen = new Set([...first.data.items, ...second.data.items].map((mailbox) => mailbox.id));
    expect([...seen].every((mailboxId) => createdIds.includes(mailboxId))).toBe(true);
    expect((await listDeletedMailboxes(ownerContext, { cursor: "not-a-cursor" })).ok).toBe(false);
  });

  test("deleted mailbox cursors preserve PostgreSQL microseconds", async () => {
    const createdIds: string[] = [];
    for (const label of ["micro-a", "micro-b", "micro-c"]) {
      const created = await createMailbox(ownerContext, { name: `Deleted ${label} ${suffix}` });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      mailboxIds.push(created.data.id);
      createdIds.push(created.data.id);
      expect((await deleteMailbox(ownerContext, created.data.id)).ok).toBe(true);
    }

    await sql`
      UPDATE mail.mailboxes
      SET deleted_at = CASE id
        WHEN ${createdIds[0]}::uuid THEN '2099-01-01 00:00:00.123456+00'::timestamptz
        WHEN ${createdIds[1]}::uuid THEN '2099-01-01 00:00:00.123455+00'::timestamptz
        WHEN ${createdIds[2]}::uuid THEN '2099-01-01 00:00:00.123454+00'::timestamptz
      END
      WHERE id IN (${createdIds[0]}::uuid, ${createdIds[1]}::uuid, ${createdIds[2]}::uuid)
    `;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < createdIds.length; page += 1) {
      const result = await listDeletedMailboxes(ownerContext, { limit: 1, cursor });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.items).toHaveLength(1);
      seen.push(result.data.items[0]!.id);
      cursor = result.data.nextCursor ?? undefined;
    }
    expect(seen).toEqual(createdIds);
  });

  test("transport fence loss restores a valid hydration state", async () => {
    const created = await createMailbox(ownerContext, { name: `Hydration fence ${suffix}` });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const mailboxId = created.data.id;
    mailboxIds.push(mailboxId);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (
        mailbox_id, remote_locator, server_identity, scope_fingerprint, status
      ) VALUES (
        ${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active'
      )
      RETURNING id
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, content_hash, hydration_status, hydration_attempt
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<hydration-fence-${suffix}@example.com>`},
        'Hydration fence',
        now(),
        ${"d".repeat(64)},
        'headers',
        2
      )
      RETURNING id
    `;

    const hydration = hydrateMessageFromSource({
      messageId: message!.id,
      source: Readable.from([`Message-ID: <hydration-fence-${suffix}@example.com>\r\nSubject: Hydration fence\r\n\r\n`]),
      transportFence: { remoteResourceId: resource!.id, generation: 999 },
    });
    await expect(hydration).rejects.toMatchObject({ code: "MAILBOX_TRANSPORT_CHANGED" });
    const [state] = await sql<
      {
        hydration_status: string;
        hydration_attempt: number;
        hydration_error_code: string | null;
        hydration_claim_id: string | null;
      }[]
    >`
      SELECT hydration_status, hydration_attempt, hydration_error_code, hydration_claim_id
      FROM mail.message_contents
      WHERE id = ${message!.id}::uuid
    `;
    expect(state).toEqual({
      hydration_status: "headers",
      hydration_attempt: 2,
      hydration_error_code: null,
      hydration_claim_id: null,
    });
  });

  test("a revoked mailbox administrator cannot restore", async () => {
    const created = await createMailbox(ownerContext, { name: `Revoked restore ${suffix}` });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const mailboxId = created.data.id;
    mailboxIds.push(mailboxId);
    expect((await deleteMailbox(ownerContext, mailboxId)).ok).toBe(true);
    const ownerAccess = await sql<{ access_id: string }[]>`
      SELECT mailbox_access.access_id
      FROM mail.mailbox_access mailbox_access
      JOIN auth.access access ON access.id = mailbox_access.access_id
      WHERE mailbox_access.mailbox_id = ${mailboxId}::uuid
        AND access.user_id = ${ownerContext.accessSubject.type === "user" ? ownerContext.accessSubject.userId : null}::uuid
    `;
    await sql`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid AND access_id = ${ownerAccess[0]!.access_id}::uuid`;
    await sql`DELETE FROM auth.access WHERE id = ${ownerAccess[0]!.access_id}::uuid`;

    expect((await restoreMailbox(ownerContext, mailboxId)).ok).toBe(false);
    const platformUserId = platformContext.actor.kind === "user" ? platformContext.actor.user.id : null;
    await sql`UPDATE auth.users SET admin = false WHERE id = ${platformUserId}::uuid`;
    expect((await restoreMailbox(platformContext, mailboxId)).ok).toBe(false);
    await sql`UPDATE auth.users SET admin = true WHERE id = ${platformUserId}::uuid`;
    const restored = await restoreMailbox(platformContext, mailboxId);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data).toMatchObject({ syncEnabled: false, health: "paused" });
  });
});
