import { sql } from "@k2b/cloud";
import { sharedWorkstationIdleSeconds } from "@k2b/cloud/services/session/shared-workstation";
import type { SQL } from "bun";

/** Core's existing live outbox carries identity invalidations, including directory-sync writes and cascades. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  const idleSeconds = await sharedWorkstationIdleSeconds();
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.room-access.migrate', 0))`;
    await tx`CREATE OR REPLACE FUNCTION auth.publish_room_identity(subject jsonb) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE key text := 'identity.access:' || COALESCE(subject->>'sid', subject->>'userId', subject->>'serviceAccountId', '*');
      BEGIN
        PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', key,
          jsonb_build_object('v', 1, 'k', key, 'd', jsonb_build_object('type', 'identity.access.changed') || subject), key);
      END $$`.simple();
    await tx`CREATE OR REPLACE FUNCTION auth.enqueue_identity_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item jsonb; subject jsonb; candidate record;
      BEGIN
        IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN RETURN NULL; END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END)) WHERE value <> 'null'::jsonb LOOP
          IF TG_TABLE_NAME = 'groups' THEN item := item || jsonb_build_object('group_id', item->>'id'); END IF;
          subject := CASE
            WHEN TG_TABLE_NAME = 'users' THEN jsonb_build_object('userId', item->>'id')
            WHEN TG_TABLE_NAME = 'session_families' THEN jsonb_build_object('userId', item->>'user_id', 'sid', item->>'sid')
            WHEN item->>'user_id' IS NOT NULL THEN jsonb_build_object('userId', item->>'user_id')
            WHEN TG_TABLE_NAME = 'service_accounts' THEN jsonb_build_object('serviceAccountId', item->>'id')
            WHEN item->>'service_account_id' IS NOT NULL THEN jsonb_build_object('serviceAccountId', item->>'service_account_id')
            ELSE NULL END;
          IF subject IS NOT NULL THEN PERFORM auth.publish_room_identity(subject);
          ELSE
            -- Structural group/grant changes resolve affected principals once at
            -- the source. A group-free grant applies to all accounts.
            FOR candidate IN
              WITH RECURSIVE affected(id) AS (
                SELECT value::uuid FROM jsonb_each_text(item)
                  WHERE key IN ('group_id', 'child_group_id', 'manager_group_id')
                UNION SELECT gg.child_group_id FROM auth.group_groups_v2 gg JOIN affected a ON a.id = gg.parent_group_id
              )
              SELECT DISTINCT u.id FROM auth.users u
                WHERE NOT EXISTS (SELECT FROM affected)
                  OR EXISTS (SELECT FROM auth.user_groups_v2 ug JOIN affected a ON a.id = ug.group_id WHERE ug.user_id = u.id)
                  OR EXISTS (SELECT FROM auth.ipa_user_effective_groups ug JOIN auth.groups g ON g.name = ug.group_name
                    JOIN affected a ON a.id = g.id WHERE ug.user_id = u.id)
            LOOP PERFORM auth.publish_room_identity(jsonb_build_object('userId', candidate.id)); END LOOP;
            FOR candidate IN SELECT id FROM auth.service_accounts LOOP
              PERFORM auth.publish_room_identity(jsonb_build_object('serviceAccountId', candidate.id));
            END LOOP;
          END IF;
        END LOOP;
        RETURN NULL;
      END $$`.simple();
    for (const table of [
      "user_groups_v2",
      "ipa_user_effective_groups",
      "group_groups_v2",
      "group_manager_users_v2",
      "group_manager_groups_v2",
      "groups",
      "access",
      "service_accounts",
      "service_account_groups",
      "group_manager_service_accounts",
    ]) {
      await tx.unsafe(`CREATE OR REPLACE TRIGGER room_access_changed AFTER INSERT OR UPDATE OR DELETE ON auth.${table}
        FOR EACH ROW EXECUTE FUNCTION auth.enqueue_identity_access_changed()`);
    }
    await tx`DROP TRIGGER IF EXISTS room_directory_lock_changed ON auth.user_ipa_data`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_directory_lock_changed AFTER UPDATE OF locked_at ON auth.user_ipa_data
      FOR EACH ROW WHEN (OLD.locked_at IS DISTINCT FROM NEW.locked_at) EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_directory_lock_insert AFTER INSERT ON auth.user_ipa_data
      FOR EACH ROW WHEN (NEW.locked_at IS NOT NULL) EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_directory_lock_delete AFTER DELETE ON auth.user_ipa_data
      FOR EACH ROW WHEN (OLD.locked_at IS NOT NULL) EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_credential_changed AFTER INSERT OR UPDATE OF status, revoked_at, expires_at, scopes, secret_hash OR DELETE ON auth.service_account_credentials
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_account_changed AFTER UPDATE OF auth_epoch, account_expires, provider, profile, admin OR DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_session_changed AFTER UPDATE OF revoked_at, expires_at, signing_kid OR DELETE ON auth.session_families
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    // Time passing does not change a row. Put a deadline invalidation into the
    // same durable outbox now; its existing dispatcher delivers it when due.
    await tx`CREATE OR REPLACE FUNCTION auth.enqueue_room_access_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE deadline timestamptz; event_id uuid; event_key text;
      BEGIN
        IF TG_TABLE_NAME = 'users' THEN
          IF TG_OP <> 'DELETE' THEN deadline := NEW.account_expires; END IF;
          event_key := 'identity.deadline.account:' || COALESCE(NEW.id, OLD.id)::text;
        ELSE
          IF TG_OP <> 'DELETE' AND NEW.revoked_at IS NULL THEN deadline := NEW.expires_at; END IF;
          event_key := 'identity.deadline.session:' || COALESCE(NEW.sid, OLD.sid)::text;
          IF TG_OP = 'DELETE' OR NEW.revoked_at IS NOT NULL THEN
            DELETE FROM events.outbox WHERE app_id = 'core' AND kind = 'live'
              AND ordering_key = 'identity.deadline.idle:' || COALESCE(NEW.sid, OLD.sid)::text;
          END IF;
        END IF;
        DELETE FROM events.outbox WHERE app_id = 'core' AND kind = 'live' AND ordering_key = event_key;
        IF deadline IS NOT NULL THEN
          event_id := gen_random_uuid();
          PERFORM events.enqueue(event_id, 'core', 'live', event_key,
            jsonb_build_object('v', 1, 'k', event_key, 'd', jsonb_build_object('type', 'identity.access.changed', 'userId', CASE WHEN TG_TABLE_NAME = 'users' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'user_id' END, 'sid', CASE WHEN TG_TABLE_NAME = 'session_families' THEN to_jsonb(NEW)->>'sid' ELSE NULL END)));
          UPDATE events.outbox SET attempts = 1, next_attempt_at = GREATEST(clock_timestamp(), deadline) WHERE id = event_id;
        END IF;
        RETURN NULL;
      END $$`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_account_deadline AFTER INSERT OR UPDATE OF account_expires OR DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_room_access_deadline()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_session_deadline AFTER INSERT OR UPDATE OF expires_at, revoked_at OR DELETE ON auth.session_families
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_room_access_deadline()`.simple();
    await tx`CREATE TABLE IF NOT EXISTS auth.room_access_deadlines_initialized (singleton boolean PRIMARY KEY CHECK(singleton))`.simple();
    const seeded = await tx`INSERT INTO auth.room_access_deadlines_initialized VALUES (true) ON CONFLICT DO NOTHING RETURNING singleton`;
    if (seeded.length) {
      await tx`INSERT INTO events.outbox(id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
        SELECT gen_random_uuid(), 'core', 'live', 'identity.deadline.account:' || id::text,
          jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed', 'userId', id)), 1, GREATEST(now(), account_expires)
        FROM auth.users WHERE account_expires IS NOT NULL AND account_expires > now()`;
      await tx`INSERT INTO events.outbox(id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
        SELECT gen_random_uuid(), 'core', 'live', 'identity.deadline.session:' || sid::text,
          jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed', 'userId', user_id, 'sid', sid)), 1, expires_at
        FROM auth.session_families WHERE revoked_at IS NULL AND expires_at > now()`;
    }
    await tx`CREATE OR REPLACE FUNCTION auth.reschedule_room_idle_deadlines(timeout_seconds integer) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM events.outbox WHERE app_id = 'core' AND kind = 'live' AND ordering_key LIKE 'identity.deadline.idle:%';
        INSERT INTO events.outbox(id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
          SELECT gen_random_uuid(), 'core', 'live', 'identity.deadline.idle:' || sid::text,
            jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed', 'userId', user_id, 'sid', sid)),
            1, GREATEST(now(), last_input_at + timeout_seconds * interval '1 second')
          FROM auth.session_families WHERE last_input_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now();
      END $$`.simple();
    const idleSeeded =
      await tx`INSERT INTO settings.migrations(name) VALUES ('room-idle-deadlines-v1') ON CONFLICT DO NOTHING RETURNING name`;
    if (idleSeeded.length)
      await tx`INSERT INTO events.outbox(id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
      SELECT gen_random_uuid(), 'core', 'live', 'identity.deadline.idle:' || sid::text,
        jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed', 'userId', user_id, 'sid', sid)),
        1, GREATEST(now(), last_input_at + ${idleSeconds} * interval '1 second')
      FROM auth.session_families WHERE last_input_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`;
    await tx`CREATE OR REPLACE FUNCTION auth.enqueue_room_setting_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF COALESCE(NEW.key, OLD.key) IN ('freeipa.groups.admin', 'user.session.shared_workstation_idle_minutes', 'user.category.login.enabled', 'user.category.guest.enabled', 'user.category.freeipa.enabled') THEN
          PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', 'identity.access',
            jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed')), 'identity.access');
        END IF;
        RETURN NULL;
      END $$`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_setting_changed AFTER INSERT OR UPDATE OR DELETE ON settings.entries
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_room_setting_changed()`.simple();
    await tx`CREATE OR REPLACE FUNCTION auth.enqueue_room_signer_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM auth.publish_room_identity('{}'::jsonb); RETURN NULL; END $$`.simple();
    await tx`DROP TRIGGER IF EXISTS room_signer_changed ON auth.signing_keys`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_signer_changed AFTER UPDATE OF state ON auth.signing_keys
      FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION auth.enqueue_room_signer_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_signer_deleted AFTER DELETE ON auth.signing_keys
      FOR EACH ROW EXECUTE FUNCTION auth.enqueue_room_signer_changed()`.simple();
  });
};
