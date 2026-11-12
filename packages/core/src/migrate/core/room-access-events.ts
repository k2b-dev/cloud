import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Core's existing live outbox carries identity invalidations, including directory-sync writes and cascades. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.room-access.migrate', 0))`;
    await tx`CREATE OR REPLACE FUNCTION auth.enqueue_identity_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', 'identity.access',
          jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed')),
          'identity.access');
        RETURN NULL;
      END $$`.simple();
    // Statement triggers coalesce once per transaction. Session input heartbeats and
    // ordinary profile edits are deliberately excluded from this source.
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
        FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`);
    }
    await tx`CREATE OR REPLACE TRIGGER room_directory_lock_changed AFTER INSERT OR UPDATE OF locked_at OR DELETE ON auth.user_ipa_data
      FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_credential_changed AFTER INSERT OR UPDATE OF status, revoked_at, expires_at, scopes, secret_hash OR DELETE ON auth.service_account_credentials
      FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_account_changed AFTER UPDATE OF auth_epoch, account_expires, provider, profile, admin OR DELETE ON auth.users
      FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
    await tx`CREATE OR REPLACE TRIGGER room_session_changed AFTER UPDATE OF revoked_at, expires_at, signing_kid OR DELETE ON auth.session_families
      FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
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
            jsonb_build_object('v', 1, 'k', event_key, 'd', jsonb_build_object('type', 'identity.access.changed')));
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
          jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed')), 1, GREATEST(now(), account_expires)
        FROM auth.users WHERE account_expires IS NOT NULL AND account_expires > now()`;
      await tx`INSERT INTO events.outbox(id, app_id, kind, ordering_key, payload, attempts, next_attempt_at)
        SELECT gen_random_uuid(), 'core', 'live', 'identity.deadline.session:' || sid::text,
          jsonb_build_object('v', 1, 'k', 'identity.access', 'd', jsonb_build_object('type', 'identity.access.changed')), 1, expires_at
        FROM auth.session_families WHERE revoked_at IS NULL AND expires_at > now()`;
    }
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
    await tx`CREATE OR REPLACE TRIGGER room_signer_changed AFTER UPDATE OR DELETE ON auth.signing_keys
      FOR EACH STATEMENT EXECUTE FUNCTION auth.enqueue_identity_access_changed()`.simple();
  });
};
