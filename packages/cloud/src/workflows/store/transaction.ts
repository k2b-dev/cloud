/**
 * Composing kernel writes into an app's own transaction.
 *
 * Every store function takes an optional `db`, and the whole point of that
 * option is that an app can run a kernel write inside a transaction it already
 * owns — creating a workflow and its app-side profile together, say, so a crash
 * cannot leave one without the other.
 *
 * Bun rejects `begin` inside a transaction; a nested unit is a savepoint. A
 * handle only has `savepoint` when it *is* a transaction, which is what makes
 * this reliable rather than a convention callers have to remember.
 */
import type { SQL } from "bun";
import { sql } from "../../runtime/clients";

type Savepointed = SQL & { savepoint: <T>(fn: (tx: SQL) => Promise<T>) => Promise<T> };

const isTransaction = (db: SQL): db is Savepointed => typeof (db as Partial<Savepointed>).savepoint === "function";

/** Runs `fn` atomically, nesting as a savepoint when the caller already has a transaction. */
export const withTransaction = <T>(db: SQL | undefined, fn: (tx: SQL) => Promise<T>): Promise<T> => {
  const handle = db ?? sql;
  return isTransaction(handle) ? handle.savepoint(fn) : handle.begin(fn);
};
