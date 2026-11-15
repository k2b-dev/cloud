import { sql } from "../runtime/clients";

/**
 * Open reports on Code pages, which every Cloud admin handles under Administration › Code. Core owns the table;
 * this is the one read of it outside Core, inside the same budget as the approvals.
 */
export const countOpenCodePageReports = (timeoutMs: number): Promise<number> =>
  sql.begin(async (tx) => {
    const budget = Math.max(1, Math.floor(timeoutMs));
    await tx.unsafe(`SET LOCAL lock_timeout = ${budget}`);
    await tx.unsafe(`SET LOCAL statement_timeout = ${budget}`);
    const [row] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM code.page_reports WHERE state='open'`;
    return row?.count ?? 0;
  });
