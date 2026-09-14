import { sql } from "bun";

type SqlClient = typeof sql;

export type StateIdentity = {
  key: string;
  variantKey: string;
};

export const lockStateIdentities = async (baseId: string, identities: StateIdentity[], db: SqlClient): Promise<void> => {
  const keys = [...new Set(identities.map((identity) => JSON.stringify([identity.key, identity.variantKey])))].sort();
  if (keys.length === 0) return;
  await db`
    SELECT pg_advisory_xact_lock(hashtextextended(${baseId} || E'\\x1f' || identity, 0))
    FROM unnest(${sql.array(keys, "TEXT")}) identity
    ORDER BY identity
  `;
};
