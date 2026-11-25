import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import * as registry from "../../_internal/registry";
import type { MailContentContext, PlatformPermission } from "../../contracts/outgoing-mail";
import { sql } from "../../runtime/clients";
import { audit } from "../audit";
import { buildProjectedUser } from "../session/user";
import { mail } from "./index";
import { retainOutgoingMailBatch } from "./retention";
import { mailAppIdSha256 } from "./store";

const user = buildProjectedUser({ id: "14180000-0000-4000-8000-000000000001", uid: "reader-user", provider: "local", profile: "user" });
const context: MailContentContext = { actor: { kind: "user", user }, requestId: "mail-content-1418" };
const identity = (appId = "reader", permissions: PlatformPermission[] = ["mail:read"]) => {
  clearProcessApplicationId();
  bindProcessApplicationId(appId, permissions);
};
let sequence = 0;
const insert = async (appId = "reader", text: string | null = "private text") => {
  const id = `14180000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  await sql`INSERT INTO outgoing_mail.messages(id, app_id, profile_key, lane, to_addresses, recipient_count,
    subject, text_body, html_body, headers, attachments, attachment_refs, message_id_header, status, deadline_at, created_at, actor_type, actor_id, actor_name)
    VALUES (${id}::uuid, ${appId}, 'sender', 'immediate', ARRAY['private@example.org'], 1,
      'private subject', ${text}, '<p>private html</p>', '{"x-private":"secret"}',
      '[{"filename":"<img src=x>.pdf","contentType":"application/pdf","size":4,"sha256":"private digest"}]',
      '[]', ${id}, 'sent', '2020-01-01T00:00:00Z'::timestamptz, '2020-01-01T00:00:00Z'::timestamptz,
      'user', '14180000-0000-4000-8000-000000000009', 'Original sender')`;
  return id;
};
// A database-observed barrier: no sleep establishes ordering between competing transactions.
const waitForBlocked = async () => {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const [row] = await sql<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock') AS blocked`;
    if (row?.blocked) return;
  }
  throw new Error("Expected a competing DB connection to reach its lock barrier.");
};
const withinBarrierDeadline = async (barrier: Promise<void>) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Read did not reach its audit barrier.")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const readEvents = () => sql<{ actor_user_id: string | null; request_id: string | null; metadata: Record<string, unknown> }[]>`
  SELECT actor_user_id, request_id, metadata FROM audit.events WHERE action = 'outgoing_mail.message.read' ORDER BY id`;

databaseSuite()("audited application mail content", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("mail_content");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.simple();
    await migrate();
    await migrateAudit();
    registered = spyOn(registry, "listApps").mockResolvedValue([]);
  });
  beforeEach(async () => {
    identity();
    sequence = 0;
    await sql`TRUNCATE outgoing_mail.messages, outgoing_mail.app_log_access, audit.events`;
  });
  afterAll(async () => {
    registered?.mockRestore();
    clearProcessApplicationId();
    await sql.close();
    await fresh?.drop();
  });
  test("an app reads the content of its own mail only, with exact app IDs and whatever an older Core stored", async () => {
    const own = await insert();
    const foreign = await insert("source");
    const unknown = await mail.content("14180000-0000-4000-8000-999999999999", context);
    expect(await mail.content(own, context)).toEqual({
      ok: true,
      data: { purged: false, text: "private text", attachmentNames: ["<img src=x>.pdf"] },
    });
    // Another app's mail answers exactly like mail that does not exist, also with a content grant from an older Core.
    expect(await mail.content(foreign, context)).toEqual(unknown);
    await sql`INSERT INTO outgoing_mail.app_log_access(app_id, source_app_id, level) VALUES ('reader', 'source', 'content')`;
    expect(await mail.content(foreign, context)).toEqual(unknown);
    for (const permissions of [["mail:send"], ["mail:read"]] satisfies PlatformPermission[][]) {
      identity("reader", permissions);
      expect(await mail.content(own, context)).toMatchObject({ ok: true });
    }
    for (const appId of ["erp_v2", "ERP", "1crm", "a/b"]) {
      identity(appId);
      expect(await mail.content(await insert(appId), context)).toMatchObject({ ok: true });
      expect(await mail.content(await insert(`${appId}-other`), context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
      if (appId === "ERP")
        expect(await mail.content(await insert("erp"), context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
    }
    // Core reads only its own mail, and an administrator acting through an app reads no other app's mail.
    const core = await insert("core");
    identity("reader");
    expect(await mail.content(core, { actor: { kind: "user", user: { ...user, roles: ["admin"] } } })).toMatchObject({
      ok: false,
      error: { code: "message_unknown", status: 404 },
    });
    identity("core");
    expect(await mail.content(core, context)).toMatchObject({ ok: true });
    expect(await mail.content(own, context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
  });
  test("purge markers, null and empty bodies; audit failure releases no content", async () => {
    const id = await insert();
    for (const text of ["", null]) {
      const empty = await insert("reader", text);
      expect(await mail.content(empty, context)).toMatchObject({ ok: true, data: { purged: false, text } });
    }
    await sql`UPDATE outgoing_mail.messages SET text_body = NULL, html_body = NULL, headers = NULL,
      content_purged_at = '2026-10-21T12:00:00Z' WHERE id = ${id}::uuid`;
    expect(await mail.content(id, context)).toEqual({ ok: true, data: { purged: true, contentPurgedAt: "2026-10-21T12:00:00.000Z" } });
    expect(await readEvents()).toHaveLength(3);
    const failAudit = spyOn(audit, "record").mockRejectedValue(new Error("private database failure"));
    try {
      expect(await mail.content(id, context)).toEqual({
        ok: false,
        error: { code: "mail_unavailable", message: "Outgoing mail storage is unavailable.", status: 500 },
      });
    } finally {
      failAudit.mockRestore();
    }
    expect(await readEvents()).toHaveLength(3);
  });
  test("user, personal key, standalone, resource-bound and mandate provenance reach the content audit without payload", async () => {
    const id = await insert();
    const account = {
      id: "14180000-0000-4000-8000-000000000002",
      name: "technical reader",
      kind: "standalone" as const,
      status: "active" as const,
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-21T00:00:00Z",
    };
    const actors: MailContentContext["actor"][] = [
      context.actor,
      {
        kind: "service_account",
        serviceAccount: { ...account, kind: "user_delegated", delegatedUserId: user.id },
        delegatedUser: user,
        scopes: [],
      },
      { kind: "service_account", serviceAccount: account, delegatedUser: null, scopes: [] },
      {
        kind: "service_account",
        serviceAccount: { ...account, kind: "resource_bound", appId: "reader", resourceType: "invoice", resourceId: "42" },
        delegatedUser: null,
        scopes: [],
      },
      {
        ...context.actor,
        delegation: {
          kind: "invocation",
          callingAppId: "upstream",
          credentialKind: "mandate",
          invocationId: "invocation-1418",
          mandateId: "mandate-1418",
          mandateRevision: 7,
          workloadType: "report",
          workloadId: "report-42",
          requestId: "invoked-request",
        },
      },
    ];
    for (const actor of actors) expect(await mail.content(id, { actor })).toMatchObject({ ok: true });
    const events = await readEvents();
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ actor_user_id: user.id, metadata: { actorKind: "user" } });
    for (const event of events.slice(1, 4))
      expect(event).toMatchObject({ actor_user_id: null, metadata: { actorKind: "service_account", serviceAccountId: account.id } });
    expect(events[1]?.metadata).toMatchObject({ delegatedUserId: user.id });
    expect(events[4]).toMatchObject({
      request_id: "invoked-request",
      metadata: {
        readingAppId: "reader",
        delegation: {
          callingAppId: "upstream",
          mandateId: "mandate-1418",
          mandateRevision: 7,
          invocationId: "invocation-1418",
          workloadType: "report",
          workloadId: "report-42",
        },
      },
    });
    for (const event of events)
      expect(event.metadata).toMatchObject({
        appId: "reader",
        appIdSha256: mailAppIdSha256("reader"),
        readingAppId: "reader",
        readingAppIdSha256: mailAppIdSha256("reader"),
      });
    expect(JSON.stringify(events)).not.toMatch(/private|<img|sha256.*digest/);
    const filtered = await audit.list({ filter: { serviceAccountId: account.id } });
    expect(filtered.items.filter((event) => event.action === "outgoing_mail.message.read")).toHaveLength(3);
  });
  test("long app IDs stay distinguishable after audit sanitizing", async () => {
    const prefix = "a".repeat(500);
    for (const appId of [`${prefix}1`, `${prefix}2`]) {
      identity(appId);
      await mail.content(await insert(appId), context);
    }
    const events = await readEvents();
    expect(events[0]?.metadata.appId).toBe(events[1]?.metadata.appId);
    expect(events[0]?.metadata.appIdSha256).not.toBe(events[1]?.metadata.appIdSha256);
    expect(events[0]?.metadata.readingAppIdSha256).not.toBe(events[1]?.metadata.readingAppIdSha256);
  });
  test("a read whose audit is still open keeps its row from retention", async () => {
    const id = await insert();
    await sql`UPDATE outgoing_mail.messages SET created_at = now() - interval '2 days' WHERE id = ${id}::uuid`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = audit.record;
    const barrier = spyOn(audit, "record").mockImplementation(async (params, db) => {
      if (params.action === "outgoing_mail.message.read") {
        entered.resolve();
        await release.promise;
      }
      return original(params, db);
    });
    const reading = mail.content(id, context);
    try {
      await withinBarrierDeadline(entered.promise);
      expect(await retainOutgoingMailBatch(1, 36500)).toEqual({ purged: 0, deleted: 0 });
      expect(await retainOutgoingMailBatch(1, 1)).toEqual({ purged: 0, deleted: 0 });
      release.resolve();
      expect(await reading).toMatchObject({ ok: true });
    } finally {
      release.resolve();
      await reading;
      barrier.mockRestore();
    }
    expect(await readEvents()).toHaveLength(1);
  });
  test("purge-first and delete-first settle before a waiting read, never returning a mixed body", async () => {
    for (const remove of [false, true]) {
      const id = await insert();
      const writer = await sql.reserve();
      let reading: ReturnType<typeof mail.content> | undefined;
      try {
        await writer`BEGIN`.simple();
        if (remove) await writer`DELETE FROM outgoing_mail.messages WHERE id = ${id}::uuid`;
        else
          await writer`UPDATE outgoing_mail.messages SET text_body = NULL, html_body = NULL, headers = NULL,
          content_purged_at = '2026-10-21T12:00:00Z' WHERE id = ${id}::uuid`;
        reading = mail.content(id, context);
        await waitForBlocked();
        await writer`COMMIT`.simple();
        expect(await reading).toEqual(
          remove
            ? { ok: false, error: { code: "message_unknown", message: "Outgoing mail message does not exist.", status: 404 } }
            : { ok: true, data: { purged: true, contentPurgedAt: "2026-10-21T12:00:00.000Z" } },
        );
      } finally {
        await writer`ROLLBACK`.simple();
        writer.release();
        await reading;
      }
    }
  });
});
