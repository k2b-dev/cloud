import { sql } from "bun";

export const AI_LIVE_FUNCTION_OUTDATED_SIGNAL =
  "AI live updates are not published: an older Core restored ai.enqueue_live_for_user. Stop every older Core replica, then restart one current Core replica";

/**
 * Whether `ai.enqueue_live_for_user` still writes to the table of a release
 * before AI moved to the platform outbox. A Core of such a release restores
 * that body whenever it starts, and no current Core publishes the table, so
 * Assistant tabs miss AI live updates until a current Core migrates again.
 */
export const aiLiveFunctionOutdated = async (): Promise<boolean> => {
  const [row] = await sql<{ outdated: boolean }[]>`
    SELECT COALESCE((
      SELECT prosrc NOT LIKE '%events.enqueue(%'
      FROM pg_proc
      WHERE oid = to_regprocedure('ai.enqueue_live_for_user(uuid,uuid,text,text,text[])')
    ), false) AS outdated
  `;
  return row?.outdated === true;
};
