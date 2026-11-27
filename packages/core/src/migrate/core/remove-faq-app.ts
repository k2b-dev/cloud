import { sql } from "@k2b/cloud";
import { invalidateSettingsCache } from "@k2b/cloud/services/settings";
import type { SQL } from "bun";

const appId = "faq";

/** Core runs this after every platform table exists, even without the retired application. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  const keys = await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.remove-faq-app', 0))`;
    const applied = await tx`INSERT INTO settings.migrations(name) VALUES ('remove-faq-app-v1')
      ON CONFLICT DO NOTHING RETURNING name`;
    if (!applied.length) return [];
    const counts: Record<string, number> = {};
    const track = async (table: string, query: PromiseLike<{ count: number }>): Promise<void> => {
      const result = await query;
      counts[table] = (counts[table] ?? 0) + result.count;
    };
    const [entries] = await tx<{ present: boolean }[]>`SELECT to_regclass('faq.entries') IS NOT NULL AS present`;
    if (entries?.present) {
      const [row] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM faq.entries`;
      counts["faq.entries"] = row?.count ?? 0;
    }
    await tx`DROP SCHEMA IF EXISTS faq CASCADE`.simple();
    await track("auth.access", tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM auth.app_access WHERE app_id = ${appId})`);
    await track("auth.app_access_state", tx`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`);
    await track(
      "auth.access",
      tx`DELETE FROM auth.access WHERE id IN (
      SELECT a.access_id FROM auth.rail_shortcut_access a JOIN auth.rail_shortcuts s ON s.id = a.shortcut_id
      WHERE s.shortcut->>'kind' = 'app' AND s.shortcut->>'appId' = ${appId}
    )`,
    );
    await track(
      "auth.rail_shortcuts",
      tx`DELETE FROM auth.rail_shortcuts WHERE shortcut->>'kind' = 'app' AND shortcut->>'appId' = ${appId}`,
    );
    await track(
      "auth.rail_preferences.changed",
      tx`UPDATE auth.rail_preferences p SET visibility = visibility - ${appId},
      shortcuts = COALESCE((SELECT jsonb_agg(s.value ORDER BY s.position)
        FROM jsonb_array_elements(p.shortcuts) WITH ORDINALITY s(value, position)
        WHERE NOT (s.value->>'kind' = 'app' AND s.value->>'appId' = ${appId})), '[]'::jsonb),
      revision = revision + 1
      WHERE visibility ? ${appId} OR EXISTS (SELECT FROM jsonb_array_elements(p.shortcuts) s
        WHERE s->>'kind' = 'app' AND s->>'appId' = ${appId})`,
    );
    await track("auth.file_chooser_places", tx`DELETE FROM auth.file_chooser_places WHERE app_id = ${appId}`);
    await track("auth.panel_context_consent", tx`DELETE FROM auth.panel_context_consent WHERE provider = ${appId}`);
    await track("auth.mandates", tx`DELETE FROM auth.mandates WHERE owner_app_id = ${appId}`);
    // Lock, narrow and audit the same mandate snapshot; absent grants must stay absent.
    const [mandates] = await tx<{ count: number }[]>`WITH candidates AS MATERIALIZED (
      SELECT id, state AS previous_state, revision AS expected_revision FROM auth.mandates
      WHERE state <> 'revoked' AND (
        (jsonb_typeof(policy->'apps') = 'array' AND policy->'apps' ? ${appId})
        OR EXISTS (SELECT FROM jsonb_array_elements(COALESCE(policy->'grants', '[]'::jsonb)) g WHERE g->>'appId' = ${appId})
      )
      FOR UPDATE
    ), changed AS (
      UPDATE auth.mandates m SET policy = (
        CASE WHEN jsonb_typeof(policy->'apps') = 'array' THEN jsonb_set(
          CASE WHEN policy->'apps' = jsonb_build_array(${appId}::text) AND policy->>'actions' = 'preapproved'
            THEN jsonb_set(policy, '{actions}', '"deny"'::jsonb) ELSE policy END, '{apps}',
          COALESCE((SELECT jsonb_agg(a.value ORDER BY a.position)
            FROM jsonb_array_elements(policy->'apps') WITH ORDINALITY a(value, position)
            WHERE a.value <> to_jsonb(${appId}::text)), '[]'::jsonb)) ELSE policy END)
        || CASE WHEN policy ? 'grants' THEN jsonb_build_object('grants',
          COALESCE((SELECT jsonb_agg(g.value ORDER BY g.position)
            FROM jsonb_array_elements(policy->'grants') WITH ORDINALITY g(value, position)
            WHERE g.value->>'appId' IS DISTINCT FROM ${appId}), '[]'::jsonb)) ELSE '{}'::jsonb END,
        state = CASE WHEN m.state = 'active' THEN 'paused' ELSE m.state END,
        revision = m.revision + 1, updated_at = now()
      FROM candidates c WHERE m.id = c.id
      RETURNING m.id, m.owner_app_id, c.previous_state, c.expected_revision
    ), audited AS (
      INSERT INTO audit.events(action, outcome, target_type, target_id, metadata)
      SELECT 'mandate.pause', 'allowed', 'mandate', id::text,
        jsonb_build_object('expectedRevision', expected_revision, 'mandateOwnerAppId', owner_app_id,
          'removedAppId', ${appId}::text, 'reason', 'application_removed')
      FROM changed WHERE previous_state = 'active' RETURNING 1
    ) SELECT count(*)::int AS count FROM changed`;
    counts["auth.mandates.narrowed"] = mandates?.count ?? 0;
    // App-owned Code and its children must go before their resource-bound/code accounts.
    await track("code.codes", tx`DELETE FROM code.codes WHERE owner_app_id = ${appId}`);
    await track("auth.service_accounts", tx`DELETE FROM auth.service_accounts WHERE app_id = ${appId}`);
    await track("auth.app_workload_instances", tx`DELETE FROM auth.app_workload_instances WHERE app_id = ${appId}`);
    await track("auth.app_start_rejections", tx`DELETE FROM auth.app_start_rejections WHERE app_id = ${appId}`);

    await track(
      "notifications.events",
      tx`DELETE FROM notifications.events WHERE definition_id IN (
      SELECT id FROM notifications.definitions WHERE app_id = ${appId})`,
    );
    await track("notifications.definitions", tx`DELETE FROM notifications.definitions WHERE app_id = ${appId}`);
    await track("approvals.requests", tx`DELETE FROM approvals.requests WHERE app_id = ${appId} OR requester_app_id = ${appId}`);
    await track("help.corpora", tx`DELETE FROM help.corpora WHERE app_id = ${appId}`);
    await track(
      "auth.access",
      tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.skill_access WHERE skill_id IN (
      SELECT skill_id FROM ai.app_skills WHERE app_id = ${appId}))`,
    );
    await track("ai.skills", tx`DELETE FROM ai.skills WHERE id IN (SELECT skill_id FROM ai.app_skills WHERE app_id = ${appId})`);
    await track("ai.app_skills", tx`DELETE FROM ai.app_skills WHERE app_id = ${appId}`);
    await track("ai.app_skill_catalogs", tx`DELETE FROM ai.app_skill_catalogs WHERE app_id = ${appId}`);
    await track(
      "ai.tool_approval_preferences",
      tx`DELETE FROM ai.tool_approval_preferences
      WHERE split_part(tool_name, '.', 1) = ${appId} OR split_part(tool_name, '__', 1) = ${appId}`,
    );
    await track(
      "ai.pending_actions",
      tx`DELETE FROM ai.pending_actions
      WHERE split_part(tool_name, '.', 1) = ${appId} OR split_part(tool_name, '__', 1) = ${appId}`,
    );
    await track("capabilities.executions", tx`DELETE FROM capabilities.executions WHERE app_id = ${appId}`);
    await track("capabilities.idempotency_claims", tx`DELETE FROM capabilities.idempotency_claims WHERE app_id = ${appId}`);
    await track(
      "outgoing_mail.app_log_access",
      tx`DELETE FROM outgoing_mail.app_log_access WHERE app_id = ${appId} OR source_app_id = ${appId}`,
    );
    await track("outgoing_mail.app_profiles", tx`DELETE FROM outgoing_mail.app_profiles WHERE app_id = ${appId}`);
    await track("outgoing_mail.app_access", tx`DELETE FROM outgoing_mail.app_access WHERE app_id = ${appId}`);
    const [workflowAi] = await tx<{ admission: boolean; budget: boolean; task: boolean }[]>`SELECT
      to_regclass('ai.workflow_scope_admission') IS NOT NULL AS admission,
      to_regclass('ai.workflow_scope_budget') IS NOT NULL AS budget,
      to_regclass('ai.workflow_task') IS NOT NULL AS task`;
    if (workflowAi?.admission)
      await track("ai.workflow_scope_admission", tx`DELETE FROM ai.workflow_scope_admission WHERE app_id = ${appId}`);
    if (workflowAi?.budget) await track("ai.workflow_scope_budget", tx`DELETE FROM ai.workflow_scope_budget WHERE app_id = ${appId}`);
    if (workflowAi?.task) await track("ai.workflow_task", tx`DELETE FROM ai.workflow_task WHERE app_id = ${appId}`);
    await track("workflows.run", tx`DELETE FROM workflows.run WHERE app_id = ${appId}`);
    await track("workflows.workflow", tx`DELETE FROM workflows.workflow WHERE app_id = ${appId}`);
    await track("workflows.event", tx`DELETE FROM workflows.event WHERE app_id = ${appId}`);
    await track("workflows.dependency_signal", tx`DELETE FROM workflows.dependency_signal WHERE app_id = ${appId}`);
    await track(
      "events.app_deliveries",
      tx`DELETE FROM events.app_deliveries WHERE subscription_id IN (
      SELECT id FROM events.app_subscriptions WHERE app_id = ${appId})
      OR event_id IN (SELECT id FROM events.app_events WHERE source = ${appId})`,
    );
    await track("events.app_subscriptions", tx`DELETE FROM events.app_subscriptions WHERE app_id = ${appId}`);
    await track("events.app_events", tx`DELETE FROM events.app_events WHERE source = ${appId}`);
    await track("events.app_declarations", tx`DELETE FROM events.app_declarations WHERE app_id = ${appId}`);
    await track("events.app_manifests", tx`DELETE FROM events.app_manifests WHERE app_id = ${appId}`);
    await track(
      "events.outbox",
      tx`DELETE FROM events.outbox WHERE app_id = ${appId}
      OR (app_id = 'core' AND ordering_key = ${`app.access:${appId}`})`,
    );
    await track("settings.app_domains", tx`DELETE FROM settings.app_domains WHERE app_id = ${appId}`);
    const deleted = await tx<{ key: string }[]>`DELETE FROM settings.entries
      WHERE key = ${appId} OR starts_with(key, ${`${appId}.`}) RETURNING key`;
    await track("core.known_apps", tx`DELETE FROM core.known_apps WHERE id = ${appId}`);
    await track(
      "core.known_apps.status_providers",
      tx`UPDATE core.known_apps SET status_providers = status_providers - ${appId}
      WHERE status_providers ? ${appId}`,
    );
    // This lazy registration table need not exist on a fresh installation.
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.application-packages'))`;
    const [packages] = await tx<{ present: boolean }[]>`SELECT to_regclass('platform.application_packages') IS NOT NULL AS present`;
    if (packages?.present)
      await track("platform.application_packages", tx`DELETE FROM platform.application_packages WHERE app_id = ${appId}`);
    counts["settings.entries"] = deleted.length;
    if (Object.values(counts).some((count) => count > 0)) {
      await tx`INSERT INTO audit.events(action, outcome, target_type, target_id, metadata)
        VALUES ('app.removed', 'allowed', 'app', ${appId},
          ${JSON.stringify({ counts, countScope: "direct table mutations; foreign-key cascades are additional" })}::text::jsonb)`;
    }
    return deleted.map(({ key }) => key);
  });
  if (keys.length) {
    try {
      await invalidateSettingsCache(keys);
    } catch {
      console.warn("[settings] Removed application settings; unavailable cache entries expire within five minutes");
    }
  }
};
