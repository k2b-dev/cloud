import { resolve } from "node:path";
import { sql } from "bun";

/** Fails unless `integration-preload.ts` claimed a private `filesv2_*_test` database for this process. */
export const assertPrivateDatabase = async (): Promise<void> => {
  const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (!row || !/^filesv2_[0-9a-f]+_test$/.test(row.name))
    throw new Error(`Filesv2 integration suites need the private database from test/integration-preload.ts (connected to "${row?.name}")`);
};

/** The local development Filegate token, shared with the dev stack. */
export const localFilegateToken = async (): Promise<string> =>
  (await Bun.file(resolve(import.meta.dir, "../../../.local/filegate/token")).text()).trim();
