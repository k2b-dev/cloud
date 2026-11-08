import { sql } from "@k2b/cloud";
import { createAllowedNetworkFetch, secrets } from "@k2b/cloud/services";
import { readKeyState } from "@k2b/cloud/services/settings/store";
import { parseNetworkAllowlistEnv } from "@k2b/cloud/shared";
import { z } from "zod";
import { migrateChatCode } from "./chat-code/migrate";

/** Studio is a one-way cut. Its mixed execution tables remain an immutable operator archive. */
export async function migrateAssistant() {
  await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtext('assistant:retire-studio'))`;
    await db`CREATE SCHEMA IF NOT EXISTS assistant`.simple();
    await db`CREATE TABLE IF NOT EXISTS assistant.studio_retirement (completed boolean PRIMARY KEY CHECK(completed))`.simple();
    const [done] = await db`SELECT completed FROM assistant.studio_retirement`;
    await migrateChatCode(db);
    if (done) return;

    // Lock before reading or detaching anything. An old binary can neither race
    // the copy nor write to the archive after this transaction commits.
    await db`DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='assistant' AND tablename IN (
        'artifacts','artifact_revisions','artifact_publications','artifact_access','artifact_projects','artifact_storage',
        'artifact_databases','database_cleanup','artifact_machine_rights','artifact_machine_secrets',
        'artifact_machine_runs','artifact_checks','chat_presentations','artifact_client_calls',
        'artifact_agent_calls','artifact_agent_approvals','capability_calls','http_calls','http_secrets'
      ) ORDER BY tablename LOOP
        EXECUTE format('LOCK TABLE assistant.%I IN ACCESS EXCLUSIVE MODE',item.tablename);
      END LOOP;
    END $$`.simple();

    await db`DO $$ BEGIN
      IF to_regclass('assistant.artifacts') IS NOT NULL AND to_regclass('approvals.requests') IS NOT NULL THEN
        UPDATE approvals.requests r SET requester_title=coalesce(r.requester_title,a.title)
          FROM assistant.capability_calls c JOIN assistant.artifacts a ON a.id=c.artifact_id
          WHERE r.requester_kind='studio_app' AND r.requester_ref=c.id::text;
      END IF;
      IF to_regclass('approvals.requests') IS NOT NULL THEN
        UPDATE approvals.requests SET status='cancelled' WHERE requester_kind='studio_app' AND status IN ('pending','approved');
      END IF;
    END $$`.simple();

    // The old tables keep all their rows. Only chat calls are copied into the
    // active transport, with original IDs, decisions, claims and replay fences.
    await db`DO $$ BEGIN
      IF to_regclass('assistant.artifact_agent_calls') IS NOT NULL THEN
        INSERT INTO assistant.code_agent_calls SELECT * FROM assistant.artifact_agent_calls
          WHERE input->>'operation' IN ('run','inspect','stop','export')
            AND NOT (input ?| ARRAY['id','resourceId','version']);
        INSERT INTO assistant.code_agent_approvals OVERRIDING SYSTEM VALUE
          SELECT a.* FROM assistant.artifact_agent_approvals a JOIN assistant.code_agent_calls c USING(turn_id,call_id);
        PERFORM setval(pg_get_serial_sequence('assistant.code_agent_approvals','ordinal'),
          greatest(coalesce((SELECT max(ordinal) FROM assistant.code_agent_approvals),0),1),
          EXISTS(SELECT 1 FROM assistant.code_agent_approvals));
      END IF;
      IF to_regclass('assistant.artifact_client_calls') IS NOT NULL THEN
        INSERT INTO assistant.code_client_calls SELECT * FROM assistant.artifact_client_calls
          WHERE input->>'operation'='secret' AND NOT (input ? 'resourceId');
      END IF;
      IF to_regclass('assistant.capability_calls') IS NOT NULL THEN
        INSERT INTO assistant.code_capability_calls(id,user_id,conversation_id,request,prepared,status,result,created_at,approval_id)
          SELECT id,user_id,conversation_id,jsonb_set(request,'{conversationId}',to_jsonb(conversation_id)),prepared,status,result,created_at,approval_id FROM assistant.capability_calls
          WHERE artifact_id IS NULL AND conversation_id IS NOT NULL AND NOT (request ? 'artifactId');
      END IF;
      IF to_regclass('assistant.http_calls') IS NOT NULL THEN
        -- Terminal rows retain their deduplication fence; pending encrypted
        -- scopes are checked below before anything can continue.
        INSERT INTO assistant.code_http_calls SELECT * FROM assistant.http_calls WHERE status<>'pending';
      END IF;
    END $$`.simple();
    await db`DO $$ BEGIN IF to_regclass('approvals.requests') IS NOT NULL THEN
      UPDATE approvals.requests r SET requester_ref=c.conversation_id || '/code/' || c.id::text
        FROM assistant.code_capability_calls c
        WHERE r.requester_kind='assistant_turn' AND r.requester_ref=c.id::text;
    END IF; END $$`.simple();
    const [http] = await db`SELECT to_regclass('assistant.http_calls') AS relation`;
    if (http?.relation) {
      const Pending = z.object({ scope: z.object({ conversationId: z.string().min(1), resourceId: z.string().optional() }) });
      let after = "00000000-0000-0000-0000-000000000000";
      let afterUser = after;
      for (;;) {
        const rows = await db<{ id: string; user_id: string; encrypted: string }[]>`SELECT id,user_id,encrypted FROM assistant.http_calls
          WHERE status='pending' AND (id,user_id)>(${after}::uuid,${afterUser}::uuid) ORDER BY id,user_id LIMIT 100`;
        for (const row of rows) {
          const decoded = await secrets.decrypt<unknown>(row.encrypted);
          const stored = Pending.safeParse(decoded);
          if (stored.success && !stored.data.scope.resourceId)
            await db`INSERT INTO assistant.code_http_calls SELECT * FROM assistant.http_calls WHERE id=${row.id}::uuid AND user_id=${row.user_id}::uuid`;
          else if (
            !stored.success &&
            !(
              decoded &&
              typeof decoded === "object" &&
              "scope" in decoded &&
              decoded.scope &&
              typeof decoded.scope === "object" &&
              "resourceId" in decoded.scope
            )
          )
            throw new Error("Unreadable pending HTTP scope; Studio retirement cannot safely preserve this request");
        }
        if (rows.length < 100) break;
        after = rows.at(-1)!.id;
        afterUser = rows.at(-1)!.user_id;
      }
    }

    // Remove only Studio credentials; chat secrets retain their encrypted value,
    // revision, owner and scope. Detach only Studio app FKs before dropping app data.
    // Existing account/chat cascades still enforce their lifecycle and retention.
    await db`DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
        WHERE contype='f' AND connamespace='assistant'::regnamespace AND conrelid IN (
          SELECT oid FROM pg_class WHERE relnamespace='assistant'::regnamespace AND relname IN (
            'capability_calls','http_secrets','artifact_agent_calls','artifact_agent_approvals','artifact_client_calls',
            'http_calls','artifact_machine_runs','artifact_checks','chat_presentations'
          )
        ) AND confrelid=to_regclass('assistant.artifacts')
      LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.relation,item.conname); END LOOP;
      IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='assistant' AND table_name='http_secrets' AND column_name='resource_id') THEN
        DELETE FROM assistant.http_secrets WHERE resource_id IS NOT NULL OR scope LIKE 'resource:%';
        ALTER TABLE assistant.http_secrets DROP COLUMN resource_id;
      END IF;
      IF to_regclass('assistant.artifact_access') IS NOT NULL THEN
        DELETE FROM auth.access WHERE id IN (SELECT access_id FROM assistant.artifact_access);
      END IF;
      IF to_regclass('ai.conversation_resource_refs') IS NOT NULL THEN
        DELETE FROM ai.conversation_resource_refs WHERE resource_type IN ('assistant.artifact','assistant.app');
      END IF;
      IF to_regclass('ai.project_resource_refs') IS NOT NULL THEN
        DELETE FROM ai.project_resource_refs WHERE resource_type IN ('assistant.artifact','assistant.app');
      END IF;

    END $$`.simple();

    // Namespace deletion is idempotent. If a remote deletion fails, all local
    // mappings and credentials remain for the next startup; never orphan data.
    let cleanup: ((namespace: string) => Promise<void>) | undefined;
    for (const table of ["artifact_databases", "database_cleanup"]) {
      const [exists] = await db`SELECT to_regclass(${"assistant." + table}) AS relation`;
      if (!exists?.relation) continue;
      let after = "";
      for (;;) {
        const rows = await db.unsafe<{ namespace: string }[]>(
          `SELECT DISTINCT namespace FROM assistant.${table} WHERE namespace>$1 ORDER BY namespace LIMIT 100`,
          [after],
        );
        if (rows.length && !cleanup) {
          const url = await readKeyState("assistant.rsql_url", db);
          const token = await readKeyState("assistant.rsql_api_token", db);
          const targets = await readKeyState("assistant.rsql_allowed_targets", db);
          if (url.stored !== "readable" || token.stored !== "readable" || targets.stored === "unreadable")
            throw new Error("Studio namespace cleanup requires readable rsql settings from the pre-cut release");
          const base = new URL(z.string().min(1).parse(url.value));
          if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
            throw new Error("Invalid stored Studio rsql address");
          const bearer = z.string().min(1).parse(token.value);
          const request = createAllowedNetworkFetch(
            parseNetworkAllowlistEnv(
              "assistant.rsql_allowed_targets",
              targets.stored === "none" ? ["rsql"] : z.array(z.string()).parse(targets.value),
            ),
          );
          cleanup = async (namespace) => {
            const response = await request(`${base.href.replace(/\/$/, "")}/v1/namespaces/${encodeURIComponent(namespace)}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${bearer}` },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            });
            await response.body?.cancel();
            if (response.status !== 204 && response.status !== 404)
              throw new Error(`Studio namespace cleanup failed (HTTP ${response.status}); retained settings and mappings allow retry`);
          };
        }
        for (const row of rows) await cleanup!(row.namespace);
        if (rows.length < 100) break;
        after = rows.at(-1)!.namespace;
      }
    }
    await db`DO $$ BEGIN IF to_regclass('settings.entries') IS NOT NULL THEN
      DELETE FROM settings.entries WHERE key IN ('assistant.rsql_allowed_targets','assistant.rsql_url','assistant.rsql_api_token',
        'assistant.storage_file_mib','assistant.storage_total_mib'); END IF; END $$`.simple();

    await db`DROP TABLE IF EXISTS assistant.artifact_machine_rights,assistant.artifact_machine_secrets,
      assistant.artifact_storage,assistant.artifact_databases,assistant.database_cleanup,
      assistant.artifact_projects,assistant.artifact_access,assistant.artifact_publications,
      assistant.artifact_revisions,assistant.artifacts`.simple();
    await db`CREATE OR REPLACE FUNCTION assistant.reject_retired_studio_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Only existing foreign-key lifecycle cascades may remove evidence.
        IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Studio is retired; execution evidence is read-only' USING ERRCODE='55000';
      END $$`.simple();
    await db`DO $$ DECLARE item record; BEGIN
      FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='assistant' AND tablename IN (
        'artifact_client_calls','artifact_agent_calls','artifact_agent_approvals','capability_calls','http_calls',
        'artifact_machine_runs','artifact_checks','chat_presentations'
      ) LOOP
        EXECUTE format('CREATE TRIGGER retired_studio_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON assistant.%I FOR EACH STATEMENT EXECUTE FUNCTION assistant.reject_retired_studio_write()',item.tablename);
      END LOOP;
    END $$`.simple();
    // An old Assistant must fail its schema setup instead of recreating Studio.
    await db`CREATE VIEW assistant.artifacts AS SELECT NULL::uuid AS id WHERE false`.simple();
    await db`INSERT INTO assistant.studio_retirement VALUES(true)`;
  });
}
