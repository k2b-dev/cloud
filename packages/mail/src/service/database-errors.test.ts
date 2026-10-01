import { describe, expect, test } from "bun:test";
import { databaseErrorCode, isPermanentDataError } from "./database-errors";

const postgresError = (sqlState: string) =>
  Object.assign(new Error("Postgres rejected the statement"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState });

describe("databaseErrorCode", () => {
  test("reads SQLSTATE codes with letters and ignores system error codes", () => {
    expect(databaseErrorCode(postgresError("22P05"))).toBe("22P05");
    expect(databaseErrorCode(postgresError("40P01"))).toBe("40P01");
    expect(databaseErrorCode(Object.assign(new Error("pipe"), { code: "EPIPE", errno: -32 }))).toBeNull();
  });
});

describe("isPermanentDataError", () => {
  test("treats data exceptions, not-null and check violations, and exceeded limits as permanent", () => {
    expect(isPermanentDataError(postgresError("23514"))).toBe(true);
    expect(isPermanentDataError(postgresError("22021"))).toBe(true);
    expect(isPermanentDataError(postgresError("22P05"))).toBe(true);
    expect(isPermanentDataError(postgresError("22P02"))).toBe(true);
    expect(isPermanentDataError(postgresError("54000"))).toBe(true);
    expect(isPermanentDataError(Object.assign(new Error("wrapped"), { cause: postgresError("23502") }))).toBe(true);
  });

  test("leaves conflicts a concurrent writer can cause to the retry policy", () => {
    expect(isPermanentDataError(postgresError("23505"))).toBe(false);
    expect(isPermanentDataError(postgresError("23503"))).toBe(false);
    expect(isPermanentDataError(postgresError("23P01"))).toBe(false);
  });

  test("leaves transient and non-database failures to the retry policy", () => {
    expect(isPermanentDataError(postgresError("40001"))).toBe(false);
    expect(isPermanentDataError(postgresError("40P01"))).toBe(false);
    expect(isPermanentDataError(postgresError("57P01"))).toBe(false);
    expect(isPermanentDataError(Object.assign(new Error("timeout"), { code: "CONNECT_TIMEOUT" }))).toBe(false);
  });
});
