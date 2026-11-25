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
    await tx`DROP SCHEMA IF EXISTS faq CASCADE`.simple();
    await tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM auth.app_access WHERE app_id = ${appId})`;
    await tx`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
    await tx`DELETE FROM auth.access WHERE id IN (
      SELECT a.access_id FROM auth.rail_shortcut_access a JOIN auth.rail_shortcuts s ON s.id = a.shortcut_id
      WHERE s.shortcut->>'kind' = 'app' AND s.shortcut->>'appId' = ${appId}
    )`;
    await tx`DELETE FROM auth.rail_shortcuts WHERE shortcut->>'kind' = 'app' AND shortcut->>'appId' = ${appId}`;
    await tx`UPDATE auth.rail_preferences p SET visibility = visibility - ${appId},
      shortcuts = COALESCE((SELECT jsonb_agg(s.value ORDER BY s.position)
        FROM jsonb_array_elements(p.shortcuts) WITH ORDINALITY s(value, position)
        WHERE NOT (s.value->>'kind' = 'app' AND s.value->>'appId' = ${appId})), '[]'::jsonb),
      revision = revision + 1
      WHERE visibility ? ${appId} OR EXISTS (SELECT FROM jsonb_array_elements(p.shortcuts) s
        WHERE s->>'kind' = 'app' AND s->>'appId' = ${appId})`;
    await tx`DELETE FROM auth.file_chooser_places WHERE app_id = ${appId}`;
    await tx`DELETE FROM auth.panel_context_consent WHERE provider = ${appId}`;
    await tx`DELETE FROM auth.mandates WHERE owner_app_id = ${appId}`;
    // Narrow surviving workloads' grants, preserving every unrelated grant and policy field.
    await tx`UPDATE auth.mandates m SET policy = jsonb_set(
      CASE WHEN jsonb_typeof(policy->'apps') = 'array' THEN jsonb_set(
        CASE WHEN policy->'apps' = jsonb_build_array(${appId}::text) AND policy->>'actions' = 'preapproved'
          THEN jsonb_set(policy, '{actions}', '"deny"'::jsonb) ELSE policy END, '{apps}',
        COALESCE((SELECT jsonb_agg(a.value ORDER BY a.position)
          FROM jsonb_array_elements(policy->'apps') WITH ORDINALITY a(value, position)
          WHERE a.value <> to_jsonb(${appId}::text)), '[]'::jsonb)) ELSE policy END,
      '{grants}', COALESCE((SELECT jsonb_agg(g.value ORDER BY g.position)
        FROM jsonb_array_elements(COALESCE(policy->'grants', '[]'::jsonb)) WITH ORDINALITY g(value, position)
        WHERE g.value->>'appId' IS DISTINCT FROM ${appId}), '[]'::jsonb)),
      state = CASE WHEN state = 'active' THEN 'paused' ELSE state END,
      revision = revision + 1, updated_at = now()
      WHERE (jsonb_typeof(policy->'apps') = 'array' AND policy->'apps' ? ${appId})
        OR EXISTS (SELECT FROM jsonb_array_elements(COALESCE(policy->'grants', '[]'::jsonb)) g WHERE g->>'appId' = ${appId})`;
    await tx`UPDATE auth.mandates SET revoked_by_app_id = NULL WHERE revoked_by_app_id = ${appId}`;
    // App-owned Code and its children must go before their resource-bound/code accounts.
    await tx`DELETE FROM code.codes WHERE owner_app_id = ${appId}`;
    await tx`DELETE FROM auth.service_accounts WHERE app_id = ${appId}`;
    await tx`DELETE FROM auth.app_workload_instances WHERE app_id = ${appId}`;
    await tx`DELETE FROM auth.app_start_rejections WHERE app_id = ${appId}`;

    await tx`DELETE FROM notifications.events WHERE definition_id IN (
      SELECT id FROM notifications.definitions WHERE app_id = ${appId})`;
    await tx`DELETE FROM notifications.definitions WHERE app_id = ${appId}`;
    await tx`DELETE FROM approvals.requests WHERE app_id = ${appId} OR requester_app_id = ${appId}`;
    await tx`DELETE FROM audit.events WHERE (target_type IN ('app', 'cloud.app') AND target_id = ${appId})
      OR target_provider = ${appId} OR metadata->>'appId' = ${appId} OR metadata->>'app_id' = ${appId}`;
    await tx`DELETE FROM help.corpora WHERE app_id = ${appId}`;
    await tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.skill_access WHERE skill_id IN (
      SELECT skill_id FROM ai.app_skills WHERE app_id = ${appId}))`;
    await tx`DELETE FROM ai.skills WHERE id IN (SELECT skill_id FROM ai.app_skills WHERE app_id = ${appId})`;
    await tx`DELETE FROM ai.app_skills WHERE app_id = ${appId}`;
    await tx`DELETE FROM ai.app_skill_catalogs WHERE app_id = ${appId}`;
    await tx`DELETE FROM ai.structured_runs WHERE app_id = ${appId}`;
    await tx`DELETE FROM ai.inference_calls WHERE app_id = ${appId}`;
    await tx`DELETE FROM ai.tool_approval_preferences
      WHERE split_part(tool_name, '.', 1) = ${appId} OR split_part(tool_name, '__', 1) = ${appId}`;
    await tx`DELETE FROM ai.pending_actions
      WHERE split_part(tool_name, '.', 1) = ${appId} OR split_part(tool_name, '__', 1) = ${appId}`;
    await tx`DELETE FROM ai.tool_calls
      WHERE split_part(tool_name, '.', 1) = ${appId} OR split_part(tool_name, '__', 1) = ${appId}`;
    await tx`UPDATE ai.conversations SET launched_by_app_id = NULL WHERE launched_by_app_id = ${appId}`;
    await tx`DELETE FROM capabilities.executions WHERE app_id = ${appId} OR via_app_id = ${appId} OR actor_app_id = ${appId}`;
    await tx`DELETE FROM capabilities.idempotency_claims WHERE app_id = ${appId}`;
    await tx`DELETE FROM outgoing_mail.app_log_access WHERE app_id = ${appId} OR source_app_id = ${appId}`;
    await tx`DELETE FROM outgoing_mail.app_profiles WHERE app_id = ${appId}`;
    await tx`DELETE FROM outgoing_mail.app_access WHERE app_id = ${appId}`;
    await tx`DELETE FROM notifications.messages WHERE outgoing_mail_id IN (
      SELECT id FROM outgoing_mail.messages WHERE app_id = ${appId})`;
    await tx`DELETE FROM outgoing_mail.messages WHERE app_id = ${appId}`;
    await tx`DELETE FROM workflows.workflow WHERE app_id = ${appId}`;
    await tx`DELETE FROM workflows.event WHERE app_id = ${appId}`;
    await tx`DELETE FROM workflows.dependency_signal WHERE app_id = ${appId}`;
    await tx`DELETE FROM events.app_deliveries WHERE subscription_id IN (
      SELECT id FROM events.app_subscriptions WHERE app_id = ${appId})
      OR event_id IN (SELECT id FROM events.app_events WHERE source = ${appId})`;
    await tx`DELETE FROM events.app_subscriptions WHERE app_id = ${appId}`;
    await tx`DELETE FROM events.app_events WHERE source = ${appId}`;
    await tx`DELETE FROM events.app_declarations WHERE app_id = ${appId}`;
    await tx`DELETE FROM events.app_manifests WHERE app_id = ${appId}`;
    await tx`DELETE FROM events.outbox WHERE app_id = ${appId}
      OR (app_id = 'core' AND ordering_key = ${`app.access:${appId}`})`;
    await tx`DELETE FROM logging.trace_spans WHERE app_id = ${appId}`;
    await tx`DELETE FROM logging.run_minutes WHERE app_id = ${appId}`;
    await tx`DELETE FROM logging.entries WHERE metadata->>'appId' = ${appId}`;
    await tx`DELETE FROM settings.app_domains WHERE app_id = ${appId}`;
    const deleted = await tx<{ key: string }[]>`DELETE FROM settings.entries
      WHERE key = ${appId} OR starts_with(key, ${`${appId}.`}) RETURNING key`;
    await tx`DELETE FROM core.known_apps WHERE id = ${appId}`;
    await tx`UPDATE core.known_apps SET status_providers = status_providers - ${appId}
      WHERE status_providers ? ${appId}`;
    // This lazy registration table need not exist on a fresh installation.
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.application-packages'))`;
    const [packages] = await tx<{ present: boolean }[]>`SELECT to_regclass('platform.application_packages') IS NOT NULL AS present`;
    if (packages?.present) await tx`DELETE FROM platform.application_packages WHERE app_id = ${appId}`;
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
