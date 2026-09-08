import { describe, expect, test } from "bun:test";
import { BoundedQueryTimeoutError, isBoundedQueryTimeoutError, runBoundedQuery } from "./bounded-query";

describe("bounded query errors", () => {
  test("preserves the timeout error identity and cause", () => {
    const cause = new Error("statement cancelled");
    const error = new BoundedQueryTimeoutError(500, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BoundedQueryTimeoutError");
    expect(error.cause).toBe(cause);
    expect(error.timeoutMs).toBe(500);
    expect(isBoundedQueryTimeoutError(error)).toBe(true);
    expect(isBoundedQueryTimeoutError(cause)).toBe(false);
  });

  test("rejects an already aborted query without opening a connection", async () => {
    for (const dedupeKey of [undefined, "shared-query"]) {
      await expect(runBoundedQuery(undefined, 500, AbortSignal.abort(), dedupeKey)).rejects.toMatchObject({
        name: "BoundedQueryAbortedError",
        message: "query aborted",
      });
    }
  });
});
