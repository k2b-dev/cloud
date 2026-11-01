import { sql } from "@k2b/cloud";
import type { Result } from "@k2b/stdlib";
import type { SqlClient } from "./audit";

type Begin<T> = (work: (client: SqlClient) => Promise<T>) => Promise<T>;

/**
 * Runs `work` in a transaction that `rollback` ends with a value. A SQL error that was turned into a value has
 * aborted the transaction, so committing it would reject with `ERR_POSTGRES_COMMIT_ROLLED_BACK`.
 */
export const transactionWithRollback = async <T>(
  work: (client: SqlClient, rollback: (value: T) => never) => Promise<T>,
  begin: Begin<T> = (run) => sql.begin(run),
): Promise<T> => {
  let rolledBack: { value: T } | undefined;
  const marker = new Error("Transaction rolled back with a value");
  try {
    return await begin((client) =>
      work(client, (value) => {
        rolledBack = { value };
        throw marker;
      }),
    );
  } catch (error) {
    if (rolledBack && error === marker) return rolledBack.value;
    throw error;
  }
};

/** A failed `Result` rolls the transaction back and is returned to the caller. */
export const resultTransaction = <T>(work: (client: SqlClient) => Promise<Result<T>>): Promise<Result<T>> =>
  transactionWithRollback(async (client, rollback) => {
    const result = await work(client);
    return result.ok ? result : rollback(result);
  });
