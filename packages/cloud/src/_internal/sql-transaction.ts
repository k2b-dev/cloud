/** Shared by durable AI tasks and workflow stores; caller-owned transactions nest as savepoints. */
import type { SQL } from "bun";
import { sql } from "../runtime/clients";

type Savepointed = SQL & { savepoint: <T>(fn: (tx: SQL) => Promise<T>) => Promise<T> };

const isTransaction = (db: SQL): db is Savepointed => typeof (db as Partial<Savepointed>).savepoint === "function";

/** Runs `fn` atomically, nesting as a savepoint when the caller already has a transaction. */
export const withTransaction = <T>(db: SQL | undefined, fn: (tx: SQL) => Promise<T>): Promise<T> => {
  const handle = db ?? sql;
  return isTransaction(handle) ? handle.savepoint(fn) : handle.begin(fn);
};
