import { crypto } from "@k2b/stdlib";
import type { SQL } from "bun";

export const AI_SHORT_ID_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/;

export const createAiShortId = (): string => crypto.common.readableId(6);

export const withAiShortId = async <T>(
  constraint: string,
  insert: (shortId: string) => Promise<T>,
  allocate: () => string = createAiShortId,
): Promise<T> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await insert(allocate());
    } catch (error) {
      const uniqueViolation = typeof error === "object" && error !== null && (("code" in error && error.code === "23505") || ("errno" in error && error.errno === "23505"));
      const collision =
        typeof error === "object" &&
        error !== null &&
        uniqueViolation &&
        "constraint" in error &&
        error.constraint === constraint;
      if (!collision) throw error;
    }
  }
  throw new Error("Failed to allocate a unique AI short ID");
};

type TransactionSql = SQL & { savepoint: <T>(fn: (db: SQL) => Promise<T>) => Promise<T> };

const isTransaction = (db: SQL): db is TransactionSql => typeof (db as Partial<TransactionSql>).savepoint === "function";

/** Keep a short-ID collision from aborting the caller's surrounding transaction. */
export const withAiShortIdForDb = <T>(
  db: SQL,
  constraint: string,
  insert: (db: SQL, shortId: string) => Promise<T>,
  allocate: () => string = createAiShortId,
): Promise<T> =>
  withAiShortId(
    constraint,
    (shortId) => (isTransaction(db) ? db.savepoint((attempt) => insert(attempt, shortId)) : insert(db, shortId)),
    allocate,
  );
