import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import * as registry from "../../_internal/registry";
import type { MailContentContext, PlatformPermission } from "../../contracts/outgoing-mail";
import { audit } from "../audit";
import { buildProjectedUser } from "../session/user";
import { mail } from "./index";
import { retainOutgoingMailBatch } from "./retention";
import { mailAppIdSha256, outgoingMailStore } from "./store";

const user = buildProjectedUser({ id: "14180000-0000-4000-8000-000000000001", uid: "reader-user", provider: "local", profile: "user" });
const context: MailContentContext = { actor: { kind: "user", user }, requestId: "mail-content-1418" };
const admin = { actor: { userId: user.id } };
const identity = (appId = "reader", permissions: PlatformPermission[] = ["mail:read"]) => {
  clearProcessApplicationId();
  bindProcessApplicationId(appId, permissions);
};
const grant = (content = true) =>
  outgoingMailStore.setAppLogAccess("reader", { apps: ["source"], contentApps: content ? ["source"] : [] }, admin);
let sequence = 0;
const insert = async (appId = "source", text: string | null = "private text") => {
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
  test("metadata defaults, old-client downgrade, own bodies and exact source grants", async () => {
    const id = await insert();
    const own = await insert("reader");
    expect(await mail.content(id, context)).toEqual(await mail.content("14180000-0000-4000-8000-999999999999", context));
    await grant(false);
    expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "app_not_allowed", status: 403 } });
    await grant();
    expect(await mail.content(id, context)).toEqual({
      ok: true,
      data: { purged: false, text: "private text", attachmentNames: ["<img src=x>.pdf"] },
    });
    const page = await mail.list({ apps: ["reader", "source"] });
    expect(page.ok && page.data.items.find((item) => item.id === id)).not.toHaveProperty("text");
    expect(page.ok && page.data.items.find((item) => item.id === own)?.text).toBe("private text");
    await outgoingMailStore.setAppLogAccess("reader", { apps: ["source"] }, admin);
    expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
    for (const permissions of [["mail:send"], ["mail:read"]] satisfies PlatformPermission[][]) {
      identity("reader", permissions);
      expect(await mail.content(own, context)).toMatchObject({ ok: true });
    }
    identity();
    for (const appId of ["erp_v2", "ERP", "1crm", "a/b"]) {
      const exact = await insert(appId);
      await outgoingMailStore.setAppLogAccess("reader", { apps: [appId], contentApps: [appId] }, admin);
      expect(await mail.content(exact, context)).toMatchObject({ ok: true });
      expect(await mail.content(await insert(`${appId}-other`), context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
      if (appId === "ERP")
        expect(await mail.content(await insert("erp"), context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
      expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
    }
  });
  test("Core and undeclared foreign reads stay hidden even with corrupt stored grants or an admin actor", async () => {
    const core = await insert("core");
    const source = await insert();
    await grant();
    await sql`ALTER TABLE outgoing_mail.app_log_access DROP CONSTRAINT app_log_access_source_app_id_check`.simple();
    try {
      await sql`INSERT INTO outgoing_mail.app_log_access(app_id, source_app_id, level) VALUES ('reader', 'core', 'content'), ('core', 'source', 'content')`;
      expect(await mail.content(core, { actor: { kind: "user", user: { ...user, roles: ["admin"] } } })).toMatchObject({
        ok: false,
        error: { code: "message_unknown", status: 404 },
      });
      identity("reader", ["mail:send"]);
      expect(await mail.content(source, context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
      identity("core");
      expect(await mail.content(core, context)).toMatchObject({ ok: true });
      expect(await mail.content(source, context)).toMatchObject({ ok: false, error: { code: "message_unknown" } });
    } finally {
      await sql`DELETE FROM outgoing_mail.app_log_access WHERE source_app_id = 'core'`;
      await sql`ALTER TABLE outgoing_mail.app_log_access ADD CHECK(source_app_id <> 'core')`.simple();
    }
  });
  test("purge markers require content access; null and empty bodies are not purged; audit failure releases no content", async () => {
    await grant();
    const id = await insert();
    for (const text of ["", null]) {
      const empty = await insert("source", text);
      expect(await mail.content(empty, context)).toMatchObject({ ok: true, data: { purged: false, text } });
    }
    await sql`UPDATE outgoing_mail.messages SET text_body = NULL, html_body = NULL, headers = NULL,
      content_purged_at = '2026-10-21T12:00:00Z' WHERE id = ${id}::uuid`;
    expect(await mail.content(id, context)).toEqual({ ok: true, data: { purged: true, contentPurgedAt: "2026-10-21T12:00:00.000Z" } });
    expect(await readEvents()).toHaveLength(3);
    await grant(false);
    expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
    await grant();
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
    await grant();
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
        appId: "source",
        appIdSha256: mailAppIdSha256("source"),
        readingAppId: "reader",
        readingAppIdSha256: mailAppIdSha256("reader"),
      });
    expect(JSON.stringify(events)).not.toMatch(/private|<img|sha256.*digest/);
    const filtered = await audit.list({ filter: { serviceAccountId: account.id } });
    expect(filtered.items.filter((event) => event.action === "outgoing_mail.message.read")).toHaveLength(3);
  });
  test("100 grants and long IDs survive audit sanitizing; failed replacement rolls levels back", async () => {
    const prefix = "a".repeat(500);
    const apps = [...Array.from({ length: 98 }, (_, i) => `app-${String(i).padStart(3, "0")}`), `${prefix}1`, `${prefix}2`].sort();
    const contentApps = apps.filter((_, i) => i % 2 === 0);
    await outgoingMailStore.setAppLogAccess("reader", { apps, contentApps }, admin);
    const failAudit = spyOn(audit, "record").mockRejectedValue(new Error("audit failure"));
    try {
      await expect(grant(false)).rejects.toThrow("audit failure");
    } finally {
      failAudit.mockRestore();
    }
    const [event] = await sql<{ metadata: { after: { appId: string; appIdSha256: string; level: string }[][] } }[]>`
      SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.app_log_access.update'`;
    const entries = event!.metadata.after.flat();
    expect(entries).toHaveLength(100);
    expect(entries.map((entry) => entry.appIdSha256)).toEqual(apps.map(mailAppIdSha256));
    expect(entries.map((entry) => entry.level)).toEqual(apps.map((id) => (contentApps.includes(id) ? "content" : "metadata")));
    for (const appId of [`${prefix}1`, `${prefix}2`]) {
      identity(appId);
      await mail.content(await insert(appId), context);
    }
    const events = await readEvents();
    expect(events[0]?.metadata.appId).toBe(events[1]?.metadata.appId);
    expect(events[0]?.metadata.appIdSha256).not.toBe(events[1]?.metadata.appIdSha256);
    expect(events[0]?.metadata.readingAppIdSha256).not.toBe(events[1]?.metadata.readingAppIdSha256);
    expect(await sql`SELECT source_app_id FROM outgoing_mail.app_log_access WHERE level = 'content'`).toHaveLength(50);
    identity();
    await outgoingMailStore.setAppLogAccess("reader", { apps }, admin);
    const [replacement] = await sql<{ metadata: { before: unknown[][]; after: { level: string }[][] } }[]>`
      SELECT metadata FROM audit.events WHERE action = 'outgoing_mail.app_log_access.update' ORDER BY id DESC LIMIT 1`;
    expect(replacement?.metadata.before.flat()).toHaveLength(100);
    expect(replacement?.metadata.after.flat().every((entry) => entry.level === "metadata")).toBe(true);
  });
  test("revoke-first and downgrade-first block a waiting read at the actual policy lock", async () => {
    const id = await insert();
    for (const revoke of [true, false]) {
      await grant();
      const writer = await sql.reserve();
      let reading: ReturnType<typeof mail.content> | undefined;
      try {
        await writer`BEGIN`.simple();
        await writer`SELECT pg_advisory_xact_lock(hashtextextended('outgoing_mail.policy', 0))`;
        if (revoke) await writer`DELETE FROM outgoing_mail.app_log_access WHERE app_id = 'reader'`;
        else await writer`UPDATE outgoing_mail.app_log_access SET level = 'metadata' WHERE app_id = 'reader'`;
        reading = mail.content(id, context);
        await waitForBlocked();
        await writer`COMMIT`.simple();
        expect(await reading).toMatchObject({ ok: false, error: { code: revoke ? "message_unknown" : "app_not_allowed" } });
      } finally {
        await writer`ROLLBACK`.simple();
        writer.release();
        await reading;
      }
    }
    expect(await readEvents()).toHaveLength(0);
  });
  test("read-first audit commit precedes revocation/downgrade, and retention skips its locked row", async () => {
    const id = await insert();
    await sql`UPDATE outgoing_mail.messages SET created_at = now() - interval '2 days' WHERE id = ${id}::uuid`;
    for (const content of [false, true]) {
      await grant();
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
      let writing: ReturnType<typeof grant> | undefined;
      try {
        await withinBarrierDeadline(entered.promise);
        expect(await retainOutgoingMailBatch(1, 36500)).toEqual({ purged: 0, deleted: 0 });
        expect(await retainOutgoingMailBatch(1, 1)).toEqual({ purged: 0, deleted: 0 });
        writing = content ? outgoingMailStore.setAppLogAccess("reader", { apps: [] }, admin) : grant(false);
        await waitForBlocked();
        expect(await readEvents()).toHaveLength(content ? 1 : 0);
        release.resolve();
        expect(await reading).toMatchObject({ ok: true });
        await writing;
        expect(await mail.content(id, context)).toMatchObject({ ok: false });
      } finally {
        release.resolve();
        await reading;
        await writing;
        barrier.mockRestore();
      }
    }
    expect(await readEvents()).toHaveLength(2);
  });
  test("purge-first and delete-first settle before a waiting read, never returning a mixed body", async () => {
    await grant();
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
  test("policy lock budget aborts and releases the transaction before returning unavailable", async () => {
    const id = await insert();
    await grant();
    const writer = await sql.reserve();
    try {
      await writer`BEGIN`.simple();
      await writer`SELECT pg_advisory_xact_lock(hashtextextended('outgoing_mail.policy', 0))`;
      expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "mail_unavailable", status: 500 } });
      expect(await readEvents()).toHaveLength(0);
    } finally {
      await writer`ROLLBACK`.simple();
      writer.release();
    }
    await grant(false);
    expect(await mail.content(id, context)).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
  }, 10000);
});
