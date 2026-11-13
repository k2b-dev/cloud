import type { sql } from "@k2b/cloud";

/** Mail's existing live topic also carries grant and restricted-membership invalidations. */
export const migrateRoomAccessEvents = async (tx: typeof sql): Promise<void> => {
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      FOR target IN SELECT DISTINCT value FROM unnest(ARRAY[NEW.mailbox_id, OLD.mailbox_id]) value WHERE value IS NOT NULL LOOP
        PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', target::text,
          jsonb_build_object('v', 1, 'k', target::text, 'a', true), 'room.access:' || target::text);
      END LOOP;
      RETURN NULL;
    END $$`.simple();
  for (const table of ["mailbox_access", "mailbox_assigned_access"]) {
    await tx.unsafe(`CREATE OR REPLACE TRIGGER room_access_changed AFTER INSERT OR UPDATE OR DELETE ON mail.${table}
      FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`);
  }
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_assignee_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      FOR target IN SELECT DISTINCT mailbox_id FROM mail.conversations WHERE id IN (NEW.conversation_id, OLD.conversation_id) LOOP
        PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', target::text,
          jsonb_build_object('v', 1, 'k', target::text, 'a', true), 'room.access:' || target::text);
      END LOOP;
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER INSERT OR UPDATE OR DELETE ON mail.conversation_assignees
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_assignee_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_message_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      FOR target IN SELECT DISTINCT mailbox_id FROM mail.drafts
        WHERE edit_mode = 'shared' AND state = 'draft'
          AND (source_message_id IN (NEW.message_id, OLD.message_id) OR derived_from_message_id IN (NEW.message_id, OLD.message_id)) LOOP
        PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', target::text,
          jsonb_build_object('v', 1, 'k', target::text, 'a', true), 'room.access:' || target::text);
      END LOOP;
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER DELETE ON mail.conversation_messages
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_message_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_updated AFTER UPDATE ON mail.conversation_messages
    FOR EACH ROW WHEN (OLD.conversation_id IS DISTINCT FROM NEW.conversation_id OR OLD.message_id IS DISTINCT FROM NEW.message_id)
    EXECUTE FUNCTION mail.enqueue_message_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER UPDATE OF mailbox_id OR DELETE ON mail.conversations
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_mailbox_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', COALESCE(NEW.id, OLD.id)::text,
        jsonb_build_object('v', 1, 'k', COALESCE(NEW.id, OLD.id)::text, 'a', true), 'room.access:' || COALESCE(NEW.id, OLD.id)::text);
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER UPDATE OF deleted_at, sync_enabled OR DELETE ON mail.mailboxes
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_mailbox_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER UPDATE OF state, edit_mode, doc_generation, doc_frozen_cursor, doc_history_complete,
    conversation_id, source_message_id, derived_from_message_id, mailbox_id OR DELETE ON mail.drafts
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER DELETE ON mail.sender_identities
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_updated AFTER UPDATE ON mail.sender_identities
    FOR EACH ROW WHEN (OLD.mailbox_id IS DISTINCT FROM NEW.mailbox_id OR OLD.short_id IS DISTINCT FROM NEW.short_id
      OR OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER DELETE ON mail.compose_templates
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_updated AFTER UPDATE ON mail.compose_templates
    FOR EACH ROW WHEN (OLD.mailbox_id IS DISTINCT FROM NEW.mailbox_id OR OLD.short_id IS DISTINCT FROM NEW.short_id
      OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
      OR OLD.scope IS DISTINCT FROM NEW.scope OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id)
    EXECUTE FUNCTION mail.enqueue_room_access_changed()`.simple();
};
