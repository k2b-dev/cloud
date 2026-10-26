import type { Result, ServiceError } from "@k2b/cloud/server";

/** A failed step inside a transaction: thrown to roll it back, turned into the step's result by the transaction. */
export class TransactionFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}
export const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new TransactionFailure(result.error);
  return result.data;
};
