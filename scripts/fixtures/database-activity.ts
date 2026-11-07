import { SQL } from "bun";

const connectTimeoutSeconds = 5;

/**
 * What the test database is doing right now, across every private database on the server, for the log of a failed
 * suite: statements still running, what each waits on and which backends block it. A statement can outlive its test,
 * and hold the locks the next suite then waits for.
 */
export const describeDatabaseActivity = async (url: string): Promise<string> => {
  const sql = new SQL({ url, max: 1, connectionTimeout: connectTimeoutSeconds });
  try {
    const rows = await sql<{ pid: number; database: string; wait: string | null; blocked_by: number[]; seconds: number; query: string }[]>`
      SELECT pid, datname AS database, wait_event_type || ':' || wait_event AS wait,
        pg_blocking_pids(pid) AS blocked_by,
        round(extract(epoch FROM now() - query_start))::int AS seconds,
        left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query
      FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND state <> 'idle'
      ORDER BY query_start
    `;
    if (rows.length === 0) return "Database activity: no statement is running.";
    return [
      `Database activity: ${rows.length} statement(s) still running.`,
      ...rows.map((row) => {
        const blocked = row.blocked_by.length > 0 ? ` blocked by ${row.blocked_by.join(",")}` : "";
        return `  [${row.pid}] ${row.database} ${row.seconds}s wait=${row.wait ?? "none"}${blocked}: ${row.query}`;
      }),
    ].join("\n");
  } catch (error) {
    return `Database activity unavailable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await sql.close();
  }
};
