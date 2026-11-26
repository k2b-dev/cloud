import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { migrateWorkflowAi } from "@k2b/cloud/ai/tasks";
import { mandatePolicyAllows, parseMandatePolicy } from "@k2b/cloud/services/mandates";
import { SQL } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./remove-capabilities-app";

const retired = "capabilities";
const survivor = "surviving-app";
const instant = "2026-01-01T00:00:00Z";

suiteFor(
  "database",
  "nats",
  "valkey",
)("removed capabilities application data", () => {
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  let db: SQL;
  beforeAll(async () => {
    disposable = await useFreshDatabase("remove_capabilities_app");
    db = new SQL(disposable.url);
    // Exercise the always-running production owner, including a never-installed application.
    await (await import("../../runtime-helpers")).runCoreSetup();
  }, 120_000);
  afterAll(async () => {
    await db?.close();
    await sql.close();
    await disposable?.drop();
  });

  test("deletes an old installation atomically and idempotently without changing another app", async () => {
    // Core's fresh-install pass above already succeeded without any old application tables.
    await migrate(db);

    await migrateWorkflowAi(db);
    expect<unknown>(await db`SELECT id FROM audit.events WHERE action = 'app.removed' AND target_id = ${retired}`).toEqual([]);
    // Legacy runs could outlive a missing definition before the scope foreign keys existed.
    await db`ALTER TABLE workflows.run DROP CONSTRAINT run_workflow_scope_fk,
      DROP CONSTRAINT run_workflow_version_id_workflow_id_fkey`.simple();
    await db`DELETE FROM settings.migrations WHERE name = ${`remove-${retired}-app-v1`}`;
    await db`CREATE SCHEMA IF NOT EXISTS platform`.simple();
    await db`CREATE TABLE IF NOT EXISTS platform.application_packages(app_id TEXT PRIMARY KEY, package_name TEXT NOT NULL)`.simple();
    const grants: string[] = [];
    const credentials: string[] = [];
    const users: string[] = [];
    for (const appId of [retired, survivor]) {
      const userId = crypto.randomUUID();
      const accountId = crypto.randomUUID();
      const keyId = crypto.randomUUID();
      const grantId = crypto.randomUUID();
      const railGrantId = crypto.randomUUID();
      users.push(userId);
      credentials.push(keyId);
      grants.push(grantId, railGrantId);
      await db`INSERT INTO auth.users(id, uid, provider, profile)
        VALUES (${userId}::uuid, ${appId}, 'local', 'user')`;
      await db`INSERT INTO core.known_apps(id, name) VALUES (${appId}, ${appId})`;
      await db`INSERT INTO platform.application_packages(app_id, package_name) VALUES (${appId}, ${appId})`;
      await db`INSERT INTO auth.service_accounts(id, name, kind, app_id, resource_type, resource_id)
        VALUES (${accountId}::uuid, ${appId}, 'resource_bound', ${appId}, 'cloud.app', ${appId})`;
      await db`INSERT INTO auth.service_account_credentials(id, service_account_id, name, kind, public_key, fingerprint)
        VALUES (${keyId}::uuid, ${accountId}::uuid, 'old key', 'app_key',
          ${(appId === retired ? "A" : "B").repeat(43)}, ${(appId === retired ? "a" : "b").repeat(32)})`;
      await db`INSERT INTO auth.app_workload_instances(app_id, instance_id, credential_id)
        VALUES (${appId}, 'old-instance', ${keyId}::uuid)`;
      await db`INSERT INTO auth.app_proof_replays(key_id, jti, retain_until)
        VALUES (${keyId}::uuid, 'old-proof', ${instant}::timestamptz)`;
      await db`INSERT INTO auth.app_access_state(app_id) VALUES (${appId})`;
      await db`INSERT INTO auth.access(id, user_id) VALUES (${grantId}::uuid, ${userId}::uuid), (${railGrantId}::uuid, ${userId}::uuid)`;
      await db`INSERT INTO auth.app_access(app_id, access_id) VALUES (${appId}, ${grantId}::uuid)`;
      await db`INSERT INTO auth.rail_shortcuts(id, position, shortcut) VALUES (${appId}, 0,
        ${JSON.stringify({ id: appId, kind: "app", appId })}::text::jsonb)`;
      await db`INSERT INTO auth.rail_shortcut_access(shortcut_id, access_id) VALUES (${appId}, ${railGrantId}::uuid)`;
      await db`INSERT INTO auth.rail_preferences(user_id, revision, visibility, shortcuts)
        VALUES (${userId}::uuid, 1, ${JSON.stringify({ [appId]: false })}::text::jsonb,
          ${JSON.stringify([
            { id: appId, kind: "app", appId },
            { id: "link", kind: "link", href: "/notes", title: "Notes", icon: "ti ti-link" },
          ])}::text::jsonb)`;
      await db`INSERT INTO auth.panel_context_consent(user_id, provider, allowed, revision)
        VALUES (${userId}::uuid, ${appId}, true, 1)`;
      await db`INSERT INTO auth.file_chooser_places(user_id, app_id) VALUES (${userId}::uuid, ${appId})`;
      await db`INSERT INTO settings.entries(key, value) VALUES (${`${appId}.example`}, 'old encrypted value')`;
      await db`INSERT INTO settings.app_domains(host, app_id) VALUES (${`${appId}.example.test`}, ${appId})`;
      await db`INSERT INTO notifications.definitions(id, app_id, kind, label, description, recipient_kind)
        VALUES (${`${appId}.changed`}, ${appId}, 'changed', 'Changed', 'Old notification', 'user')`;
      await db`INSERT INTO notifications.preferences(user_id, definition_id, channels)
        VALUES (${userId}::uuid, ${`${appId}.changed`}, ARRAY['browser'])`;
      const [event] = await db<{ id: string }[]>`INSERT INTO notifications.events(
        definition_id, recipient_user_id, recipient_key, idempotency_key, title)
        VALUES (${`${appId}.changed`}, ${userId}::uuid, ${appId}, 'old', 'Old event') RETURNING id`;
      if (!event) throw new Error("Missing seeded notification event");
      await db`INSERT INTO notifications.deliveries(event_id, channel, destination_key, destination_label, status)
        VALUES (${event.id}::uuid, 'browser', ${appId}, 'Browser', 'delivered')`;
      await db`INSERT INTO approvals.requests(app_id, action, requester_kind, requester_ref, requester_app_id,
        subject_id, approver_user_id, assurance, sentence, args_digest, review_digest, expires_at)
        VALUES (${appId}, 'old.action', 'assistant_turn', ${appId}, ${appId}, ${userId}::uuid,
          ${userId}::uuid, 'confirm', 'Old request', 'args', 'review', ${instant}::timestamptz)`;
      await db`INSERT INTO audit.events(action, outcome, target_type, target_id)
        VALUES ('app.access.changed', 'allowed', 'app', ${appId})`;
      await db`INSERT INTO help.corpora(app_id, manifest_hash, base_locale) VALUES (${appId}, 'old', 'en')`;
      await db`INSERT INTO help.documents(app_id, manifest_hash, locale, document_id, title, sort_order,
        markdown, search_text, search_config, search_document)
        VALUES (${appId}, 'old', 'en', 'old', 'Old help', 0, 'Old content', 'Old content', 'english', to_tsvector('english', 'Old content'))`;
      await db`INSERT INTO capabilities.executions(request_id, origin, app_id, capability, kind, status)
        VALUES (${appId}, 'http', ${appId}, 'old.query', 'query', 'succeeded')`;
      await db`INSERT INTO capabilities.idempotency_claims(app_id, capability, principal, key_hash, request_hash, state)
        VALUES (${appId}, 'old.action', ${appId}, 'old', 'digest', 'succeeded')`;
      await db`INSERT INTO ai.inference_calls(id, model_profile_id, kind, task, provider_model, app_id, lease_expires_at, cost)
        VALUES (${crypto.randomUUID()}::uuid, 'test-profile', 'background', 'old-task', 'test-model', ${appId}, ${instant}::timestamptz, 0.25)`;
      await db`INSERT INTO outgoing_mail.messages(id, app_id, profile_key, lane, to_addresses, recipient_count, subject,
        message_id_header, status, deadline_at)
        VALUES (${crypto.randomUUID()}::uuid, ${appId}, 'old', 'immediate', ARRAY['example@example.test'], 1,
          'Old mail', ${appId}, 'sent', ${instant}::timestamptz)`;
      await db`INSERT INTO logging.entries(source, message, metadata)
        VALUES ('old-app', 'Historical log', ${JSON.stringify({ appId })}::text::jsonb)`;
      await db`INSERT INTO logging.trace_spans(trace_id, span_id, name, source, app_id)
        VALUES (${appId}, 'old-span', 'Old operation', 'old-app', ${appId})`;
      await db`INSERT INTO ai.workflow_scope_budget(app_id, scope_id, tokens) VALUES (${appId}, 'old', 1)`;
      await db`INSERT INTO ai.workflow_scope_admission(app_id, scope_id, source_id, task_id)
        VALUES (${appId}, 'old', 'old', ${crypto.randomUUID()}::uuid)`;
      await db`INSERT INTO workflows.run(app_id, scope_id, workflow_id, workflow_version_id, mode, authorization_snapshot,
        idempotency_key, occurred_at)
        VALUES (${appId}, 'old', ${crypto.randomUUID()}::uuid, ${crypto.randomUUID()}::uuid, 'execute',
          '{}'::jsonb, ${appId}, ${instant}::timestamptz)`;
      await db`INSERT INTO auth.mandates(subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy)
        VALUES ('user', ${userId}::uuid, ${appId}, 'old.workload', 'old',
          '{"version":1,"apps":["surviving-app"],"operations":["search.query"],"actions":"deny"}'::jsonb)`;
    }

    // The provider's execution history remains even when the removed app was its caller.
    await db`INSERT INTO capabilities.executions(request_id, origin, app_id, capability, kind, status, via_app_id, actor_app_id)
      VALUES ('foreign-provider', 'app', ${survivor}, 'old.query', 'query', 'succeeded', ${retired}, ${retired})`;
    await db`INSERT INTO audit.events(action, outcome, target_type, target_id, target_provider)
      VALUES ('identity.history', 'allowed', 'user', 'unrelated-user', ${retired})`;
    const noGrantsPolicy = { version: 1, apps: [retired, survivor], operations: ["search.query"], actions: "deny" };
    await db`INSERT INTO auth.mandates(subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy)
      VALUES ('user', ${users[1]!}::uuid, 'no-grants-workload', 'old.workload', 'no-grants',
        ${JSON.stringify(noGrantsPolicy)}::text::jsonb)`;
    // A lookalike namespace must survive; no substring/prefix-without-boundary deletion.
    await db`INSERT INTO settings.entries(key, value) VALUES (${`${retired}-other.setting`}, 'keep')`;
    // Preserve another workload while narrowing only its explicit reference to the removed provider.
    const mixedPolicy = {
      version: 1,
      apps: [retired, survivor],
      operations: ["search.query"],
      actions: "deny",
      grants: [retired, survivor].map((appId) => ({ appId, capabilityId: "search", kind: "query", fixedInput: {} })),
    };
    await db`INSERT INTO auth.mandates(subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy)
      VALUES ('user', ${users[1]!}::uuid, 'mixed-workload', 'old.workload', 'mixed', ${JSON.stringify(mixedPolicy)}::text::jsonb)`;
    await db`INSERT INTO auth.mandates(subject_kind, subject_user_id, owner_app_id, workload_type, workload_id,
      policy, state, revision, revoked_at, revoke_reason)
      VALUES ('user', ${users[1]!}::uuid, 'revoked-workload', 'old.workload', 'revoked',
        ${JSON.stringify(mixedPolicy)}::text::jsonb, 'revoked', 7, ${instant}::timestamptz, 'historical revocation')`;
    const revokedBefore = await db`SELECT * FROM auth.mandates WHERE owner_app_id = 'revoked-workload'`;
    await db`UPDATE core.known_apps SET status_providers = ${JSON.stringify({ [retired]: { old: true }, [survivor]: { keep: true } })}::text::jsonb
      WHERE id = ${survivor}`;
    const exclusivePolicy = {
      ...mixedPolicy,
      apps: [retired],
      actions: "preapproved",
      grants: mixedPolicy.grants.filter((grant) => grant.appId === retired),
    };
    await db`INSERT INTO auth.mandates(subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy)
      VALUES ('user', ${users[1]!}::uuid, 'exclusive-workload', 'old.workload', 'exclusive', ${JSON.stringify(exclusivePolicy)}::text::jsonb)`;

    // Snapshot the real schema's app-id keyed rows, rather than a mirrored list of DELETE statements.
    const tables = await db<{ schema: string; name: string }[]>`SELECT c.table_schema AS schema, c.table_name AS name
      FROM information_schema.columns c JOIN information_schema.tables t USING (table_catalog, table_schema, table_name)
      WHERE c.column_name = 'app_id' AND t.table_type = 'BASE TABLE' ORDER BY c.table_schema, c.table_name`;
    const snapshot = async (appId: string) => {
      const rows: Record<string, unknown> = {};
      for (const table of tables) {
        const qualified = '"' + table.schema.replaceAll('"', '""') + '"."' + table.name.replaceAll('"', '""') + '"';
        rows[`${table.schema}.${table.name}`] = await db.unsafe(
          `SELECT to_jsonb(t) AS row FROM ${qualified} t WHERE app_id = $1 ORDER BY to_jsonb(t)::text`,
          [appId],
        );
      }
      return rows;
    };
    const before = await snapshot(survivor);
    const retainedTables = new Set([
      "ai.inference_calls",
      "ai.structured_runs",
      "outgoing_mail.messages",
      "logging.trace_spans",
      "logging.run_minutes",
    ]);
    const retiredBefore = await snapshot(retired);
    const historicalAudit = await db`SELECT * FROM audit.events ORDER BY id`;
    const historicalLogs = await db`SELECT * FROM logging.entries WHERE source = 'old-app' ORDER BY id`;

    const [railBefore] = await db`SELECT * FROM auth.rail_preferences WHERE user_id = ${users[1]!}::uuid`;
    // A late failure must roll back earlier deletes (and the schema drop), including the receipt.
    await db`CREATE FUNCTION core.fail_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'retirement rollback probe'; END $$`.simple();
    await db`CREATE TRIGGER fail_retirement BEFORE DELETE ON core.known_apps
      FOR EACH ROW EXECUTE FUNCTION core.fail_retirement()`.simple();
    await expect(migrate(db)).rejects.toThrow("retirement rollback probe");
    await db`DROP TRIGGER fail_retirement ON core.known_apps`.simple();
    await db`DROP FUNCTION core.fail_retirement()`.simple();
    expect((await db`SELECT id FROM core.known_apps WHERE id = ${retired}`).length).toBe(1);
    expect((await db`SELECT id FROM auth.service_account_credentials WHERE id = ${credentials[0]!}::uuid`).length).toBe(1);
    expect<unknown>(await db`SELECT name FROM settings.migrations WHERE name = ${`remove-${retired}-app-v1`}`).toEqual([]);

    await migrate(db);
    await migrate(db);
    expect(await snapshot(survivor)).toEqual(before);
    expect<unknown>(await db`SELECT * FROM auth.mandates WHERE owner_app_id = 'revoked-workload'`).toEqual(revokedBefore);
    expect<unknown>(await db`SELECT status_providers FROM core.known_apps WHERE id = ${survivor}`).toEqual([
      { status_providers: { [survivor]: { keep: true } } },
    ]);
    for (const [table, rows] of Object.entries(await snapshot(retired))) {
      expect(rows).toEqual(retainedTables.has(table) ? retiredBefore[table] : []);
    }
    expect<unknown>(await db`SELECT * FROM audit.events WHERE action NOT IN ('app.removed', 'mandate.pause') ORDER BY id`).toEqual(
      historicalAudit,
    );
    expect<unknown>(await db`SELECT * FROM logging.entries WHERE source = 'old-app' ORDER BY id`).toEqual(historicalLogs);
    expect<unknown>(await db`SELECT id FROM core.known_apps WHERE id = ${retired}`).toEqual([]);
    expect<unknown>(await db`SELECT key FROM settings.entries WHERE key = ${`${retired}.example`}`).toEqual([]);
    expect<unknown>(await db`SELECT value FROM settings.entries WHERE key = ${`${retired}-other.setting`}`).toEqual([{ value: "keep" }]);
    expect<unknown>(await db`SELECT id FROM auth.access WHERE id IN (${grants[0]!}::uuid, ${grants[1]!}::uuid)`).toEqual([]);
    expect((await db`SELECT id FROM auth.access WHERE id IN (${grants[2]!}::uuid, ${grants[3]!}::uuid)`).length).toBe(2);
    expect<unknown>(await db`SELECT id FROM auth.service_account_credentials WHERE id = ${credentials[0]!}::uuid`).toEqual([]);
    expect((await db`SELECT id FROM auth.service_account_credentials WHERE id = ${credentials[1]!}::uuid`).length).toBe(1);
    expect<unknown>(await db`SELECT key_id FROM auth.app_proof_replays WHERE key_id = ${credentials[0]!}::uuid`).toEqual([]);
    expect<unknown>(await db`SELECT id FROM approvals.requests WHERE app_id = ${retired} OR requester_app_id = ${retired}`).toEqual([]);
    expect((await db`SELECT id FROM audit.events WHERE action = 'app.access.changed' AND target_id = ${retired}`).length).toBe(1);
    expect<unknown>(await db`SELECT provider FROM auth.panel_context_consent WHERE provider = ${retired}`).toEqual([]);
    expect<unknown>(await db`SELECT id FROM auth.rail_shortcuts WHERE shortcut->>'appId' = ${retired}`).toEqual([]);
    expect<unknown>(await db`SELECT visibility, shortcuts, revision FROM auth.rail_preferences WHERE user_id = ${users[0]!}::uuid`).toEqual(
      [
        {
          visibility: {},
          revision: 2,
          shortcuts: [{ id: "link", kind: "link", href: "/notes", title: "Notes", icon: "ti ti-link" }],
        },
      ],
    );
    expect((await db`SELECT * FROM auth.rail_preferences WHERE user_id = ${users[1]!}::uuid`)[0]).toEqual(railBefore);
    expect<unknown>(
      await db`SELECT policy, state, revision::int AS revision FROM auth.mandates WHERE owner_app_id = 'mixed-workload'`,
    ).toEqual([
      {
        policy: { ...mixedPolicy, apps: [survivor], grants: mixedPolicy.grants.filter((grant) => grant.appId === survivor) },
        state: "paused",
        revision: 2,
      },
    ]);
    expect<unknown>(await db`SELECT id FROM auth.mandates WHERE owner_app_id = ${retired}`).toEqual([]);
    const [noGrants] = await db<{ policy: unknown; state: string }[]>`SELECT policy, state FROM auth.mandates
      WHERE owner_app_id = 'no-grants-workload'`;
    expect(noGrants).toEqual({ policy: { ...noGrantsPolicy, apps: [survivor] }, state: "paused" });
    expect(
      mandatePolicyAllows(parseMandatePolicy(noGrants?.policy), {
        appId: survivor,
        operation: "search.query",
        actionApproval: "none",
      }),
    ).toBe(true);
    const removal = await db<{ metadata: { counts: Record<string, number> } }[]>`SELECT metadata FROM audit.events
      WHERE action = 'app.removed' AND target_id = ${retired}`;
    expect(removal).toHaveLength(1);
    expect(removal[0]?.metadata.counts).toMatchObject({
      "auth.service_accounts": 1,
      "auth.access": 2,
      "auth.mandates": 1,
      "auth.mandates.narrowed": 3,
      "auth.rail_preferences.changed": 1,
      "core.known_apps": 1,
      "core.known_apps.status_providers": 1,
      "workflows.run": 1,
      "ai.workflow_scope_budget": 1,
      "ai.workflow_scope_admission": 1,
      "settings.entries": 1,
      "notifications.events": 1,
      "help.corpora": 1,
      "platform.application_packages": 1,
    });
    const pauses = await db<
      { target_id: string; metadata: { expectedRevision: number; removedAppId: string; mandateOwnerAppId: string } }[]
    >`SELECT target_id, metadata
      FROM audit.events WHERE action = 'mandate.pause' ORDER BY target_id`;
    expect(pauses).toHaveLength(3);
    for (const pause of pauses) {
      expect(pause.metadata).toMatchObject({ expectedRevision: 1, removedAppId: retired });
      const [mandate] = await db`SELECT state, owner_app_id FROM auth.mandates WHERE id = ${pause.target_id}::uuid`;
      expect(mandate?.state).toBe("paused");
      expect(pause.metadata.mandateOwnerAppId).toBe(mandate?.owner_app_id);
    }

    expect<unknown>(await db`SELECT policy, state FROM auth.mandates WHERE owner_app_id = 'exclusive-workload'`).toEqual([
      {
        policy: { ...exclusivePolicy, apps: [], actions: "deny", grants: [] },
        state: "paused",
      },
    ]);
    expect<unknown>(await db`SELECT id FROM notifications.events WHERE definition_id = ${`${retired}.changed`}`).toEqual([]);
    expect<unknown>(await db`SELECT id FROM notifications.deliveries WHERE destination_key = ${retired}`).toEqual([]);
    expect<unknown>(await db`SELECT user_id FROM notifications.preferences WHERE definition_id = ${`${retired}.changed`}`).toEqual([]);

    expect((await db`SELECT to_regclass('capabilities.executions') IS NOT NULL AS present`)[0]?.present).toBe(true);
  }, 120_000);
});
