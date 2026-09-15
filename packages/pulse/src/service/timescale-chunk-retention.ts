import { SQL, sql } from "bun";

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Release empty Timescale storage after ordinary per-base retention and vacuum. */
export const pruneEmptyTimescaleChunk = async (db: typeof sql = sql): Promise<{ dropped: number; deferred: boolean }> => {
  let deferred = false;
  for (const hypertable of ["metric_samples", "metric_rollups_hourly", "events"]) {
    try {
      const dropped = await db.begin(async (tx) => {
        // Maintenance must yield to readers/writers instead of building a DDL lock queue.
        await tx`SET LOCAL lock_timeout = '25ms'`;
        await tx`SET LOCAL statement_timeout = '250ms'`;
        const [extension] = await tx`SELECT 1 FROM pg_extension WHERE extname='timescaledb'`;
        if (!extension) return null;
        const [candidate] = await tx<
          {
            hypertable_name: string;
            chunk_schema: string;
            chunk_name: string;
            range_start: Date;
            range_end: Date;
          }[]
        >`
        SELECT c.hypertable_name,c.chunk_schema,c.chunk_name,c.range_start,c.range_end
        FROM timescaledb_information.chunks c
        JOIN timescaledb_information.hypertables h
          ON h.hypertable_schema=c.hypertable_schema AND h.hypertable_name=c.hypertable_name
        WHERE c.hypertable_schema='pulse'
          AND c.hypertable_name=${hypertable}
          AND h.num_dimensions=1 AND NOT c.is_compressed AND c.range_end<=now()
          AND pg_relation_size(format('%I.%I',c.chunk_schema,c.chunk_name)::regclass)=0
        ORDER BY c.range_end,c.hypertable_name LIMIT 1
      `;
        if (!candidate) return 0;
        const parent = `pulse.${quoteIdentifier(candidate.hypertable_name)}`;
        const chunk = `${quoteIdentifier(candidate.chunk_schema)}.${quoteIdentifier(candidate.chunk_name)}`;
        await tx.unsafe(`LOCK TABLE ONLY ${parent} IN ACCESS EXCLUSIVE MODE NOWAIT`);
        await tx.unsafe(`LOCK TABLE ${chunk} IN ACCESS EXCLUSIVE MODE NOWAIT`);
        const [occupied] = await tx.unsafe<{ present: boolean }[]>(`SELECT EXISTS(SELECT 1 FROM ${chunk}) AS present`);
        if (occupied?.present !== false) return 0;
        // Exact bounds address one time chunk; space-partitioned hypertables are excluded above.
        const dropped = await tx`
        SELECT drop_chunks(${parent}::regclass,
          newer_than=>${candidate.range_start}::timestamptz,
          older_than=>${candidate.range_end}::timestamptz)
      `;
        if (dropped.length !== 1) throw new Error("Expected exactly one empty Pulse time chunk");
        return 1;
      });
      if (dropped === null) return { dropped: 0, deferred: false };
      if (dropped === 1) return { dropped, deferred };
    } catch (error) {
      if (!(error instanceof SQL.PostgresError)) throw error;
      if (["55P03", "57014"].includes(error.errno ?? "")) deferred = true;
      // Another worker may remove the candidate between discovery and our lock.
      else if (error.errno !== "42P01") throw error;
    }
  }
  return { dropped: 0, deferred };
};
