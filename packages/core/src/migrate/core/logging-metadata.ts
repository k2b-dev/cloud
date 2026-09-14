import { sql } from "bun";

/** SQL counterpart of the log reader's object/string JSON decoding.
 * Invalid diagnostic metadata must not abort an aggregate query.
 */
export async function migrateLogMetadataReader(): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION logging.object_metadata(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
    BEGIN
      IF jsonb_typeof(payload) = 'string' THEN payload := (payload #>> '{}')::jsonb; END IF;
      IF jsonb_typeof(payload) = 'object' THEN RETURN payload; END IF;
      RETURN NULL;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
    END;
    $$
  `.simple();
}
