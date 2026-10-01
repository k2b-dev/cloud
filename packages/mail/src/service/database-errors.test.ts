import { describe, expect, test } from "bun:test";
import { isPermanentDataError } from "./database-errors";

const postgresError = (sqlState: string) =>
  Object.assign(new Error("Postgres rejected the statement"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState });

describe("isPermanentDataError", () => {
  test("treats data exceptions and constraint violations as permanent", () => {
    expect(isPermanentDataError(postgresError("23514"))).toBe(true);
    expect(isPermanentDataError(postgresError("22021"))).toBe(true);
    expect(isPermanentDataError(Object.assign(new Error("wrapped"), { cause: postgresError("23502") }))).toBe(true);
  });

  test("leaves transient and non-database failures to the retry policy", () => {
    expect(isPermanentDataError(postgresError("40001"))).toBe(false);
    expect(isPermanentDataError(postgresError("57P01"))).toBe(false);
    expect(isPermanentDataError(Object.assign(new Error("timeout"), { code: "CONNECT_TIMEOUT" }))).toBe(false);
  });
});
