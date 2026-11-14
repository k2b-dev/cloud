import type { SQL } from "bun";

/** Transaction-only overflow counts. No snapshots or record IDs are retained here. */
export const installGridsAppEventSchema = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_batches (
      txid xid8 NOT NULL,
      table_id uuid NOT NULL,
      table_ref text NOT NULL,
      base_ref text NOT NULL,
      counts jsonb NOT NULL,
      PRIMARY KEY (txid, table_id)
    )
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.flush_record_event_batch() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE
      batch grids.record_event_batches%ROWTYPE;
      event_id uuid := gen_random_uuid();
      envelope jsonb;
    BEGIN
      -- The first deferred insertion flushes the final counts. Later queued triggers find no row.
      DELETE FROM grids.record_event_batches
      WHERE txid = NEW.txid AND table_id = NEW.table_id RETURNING * INTO batch;
      IF NOT FOUND THEN RETURN NULL; END IF;
      envelope := jsonb_build_object(
        'id', event_id::text,
        'time', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'source', 'grids', 'type', 'grids.records.changed', 'version', 1,
        'subject', jsonb_build_object('type', 'grids.table', 'id', batch.table_ref),
        'place', jsonb_build_object('type', 'grids.base', 'id', batch.base_ref),
        'data', jsonb_build_object('counts',
          jsonb_build_object('created', 0, 'updated', 0, 'deleted', 0, 'finalized', 0) || batch.counts)
      );
      -- Use the same platform outbox as individual events, in the committing domain transaction.
      -- Match the public publisher's SHA-256 of the canonical subject JSON (sorted keys, no spaces).
      PERFORM events.enqueue(event_id, 'grids', 'event',
        encode(sha256(convert_to(format('{"id":%s,"type":"grids.table"}', to_json(batch.table_ref)::text), 'UTF8')), 'hex'),
        envelope);
      RETURN NULL;
    END $function$
  `.simple();
  await sql`DROP TRIGGER IF EXISTS flush_record_event_batch ON grids.record_event_batches`.simple();
  await sql`
    CREATE CONSTRAINT TRIGGER flush_record_event_batch
    AFTER INSERT ON grids.record_event_batches DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION grids.flush_record_event_batch()
  `.simple();
};
