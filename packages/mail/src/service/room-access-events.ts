import type { sql } from "@k2b/cloud";

/** Mail's existing live topic also carries grant and restricted-membership invalidations. */
export const migrateRoomAccessEvents = async (tx: typeof sql): Promise<void> => {
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      target := COALESCE(NEW.mailbox_id, OLD.mailbox_id);
      PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', target::text,
        jsonb_build_object('v', 1, 'k', target::text, 'a', true), 'room.access:' || target::text);
      RETURN NULL;
    END $$`.simple();
  for (const table of ["mailbox_access", "mailbox_assigned_access"]) {
    await tx.unsafe(`CREATE OR REPLACE TRIGGER room_access_changed AFTER INSERT OR UPDATE OR DELETE ON mail.${table}
      FOR EACH ROW EXECUTE FUNCTION mail.enqueue_room_access_changed()`);
  }
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_assignee_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      SELECT mailbox_id INTO target FROM mail.conversations WHERE id = COALESCE(NEW.conversation_id, OLD.conversation_id);
      IF target IS NOT NULL THEN
        PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', target::text,
          jsonb_build_object('v', 1, 'k', target::text, 'a', true), 'room.access:' || target::text);
      END IF;
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER INSERT OR UPDATE OR DELETE ON mail.conversation_assignees
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_assignee_room_access_changed()`.simple();
  await tx`CREATE OR REPLACE FUNCTION mail.enqueue_mailbox_room_access_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM events.enqueue(gen_random_uuid(), 'mail', 'live', COALESCE(NEW.id, OLD.id)::text,
        jsonb_build_object('v', 1, 'k', COALESCE(NEW.id, OLD.id)::text, 'a', true), 'room.access:' || COALESCE(NEW.id, OLD.id)::text);
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER room_access_changed AFTER UPDATE OF deleted_at OR DELETE ON mail.mailboxes
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_mailbox_room_access_changed()`.simple();
};
