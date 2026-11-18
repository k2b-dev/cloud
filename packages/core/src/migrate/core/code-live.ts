import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.code-live.migrate', 0))`;
    await migrateCodeLive(tx);
  });
};

/** All run writers (admission, runner, retry and recovery) share the transactional live outbox. */
export async function migrateCodeLive(tx: SQL): Promise<void> {
  await tx`CREATE OR REPLACE FUNCTION code.publish_run_live() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE payload jsonb; run_key text;
    BEGIN
      PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', NEW.code_id,
        jsonb_build_object('v',1,'k',NEW.code_id,'d',jsonb_build_object(
          'type','code.run','runId',NEW.id,
          'state',NEW.state,
          'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
      run_key := 'code.run:' || NEW.code_id || ':' || NEW.id::text;
      payload := jsonb_build_object('v',1,'k',run_key,'d',jsonb_build_object(
        'type','code.run','runId',NEW.id,
        'state',NEW.state,
        'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
      PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', run_key, payload);
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER run_live_insert AFTER INSERT ON code.runs
    FOR EACH ROW EXECUTE FUNCTION code.publish_run_live()`.simple();
  await tx`CREATE OR REPLACE TRIGGER run_live_state AFTER UPDATE OF state ON code.runs
    FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION code.publish_run_live()`.simple();
  // Converge installations of the earlier draft: effect counts refresh at run completion (DATA-13).
  await tx`DROP TRIGGER IF EXISTS run_live_effect ON code.calls`.simple();
  await tx`CREATE OR REPLACE FUNCTION code.publish_access_live() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE key text;
    BEGIN
      FOR key IN SELECT DISTINCT value->>CASE WHEN TG_TABLE_NAME='codes' THEN 'id' ELSE 'code_id' END
        FROM jsonb_array_elements(jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW))) WHERE value<>'null'::jsonb
      LOOP
        PERFORM events.enqueue(gen_random_uuid(), 'core', 'live', key,
          jsonb_build_object('v',1,'k',key,'a',true));
      END LOOP;
      RETURN NULL;
    END $$`.simple();
  await tx`CREATE OR REPLACE TRIGGER code_live_access AFTER DELETE ON code.codes
    FOR EACH ROW EXECUTE FUNCTION code.publish_access_live()`.simple();
  await tx`CREATE OR REPLACE TRIGGER code_live_shares AFTER INSERT OR UPDATE OR DELETE ON code.shares
    FOR EACH ROW EXECUTE FUNCTION code.publish_access_live()`.simple();
}
