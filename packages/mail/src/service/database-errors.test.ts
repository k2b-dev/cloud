import { describe, expect, test } from "bun:test";
import { databaseErrorCode, isPermanentDataError, isTransientDatabaseError } from "./database-errors";

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

describe("isTransientDatabaseError", () => {
  test("treats a lost connection, connection exceptions, conflicts, and a restarting server as transient", () => {
    for (const code of ["ERR_POSTGRES_CONNECTION_CLOSED", "ERR_POSTGRES_CONNECTION_REFUSED", "ERR_POSTGRES_IDLE_TIMEOUT"]) {
      expect(isTransientDatabaseError(Object.assign(new Error(code), { code })), code).toBe(true);
    }
    for (const sqlState of ["08006", "40001", "40P01", "53300", "57P01", "57P03"]) {
      expect(isTransientDatabaseError(postgresError(sqlState)), sqlState).toBe(true);
    }
  });

  test("leaves errors about the statement or its data alone", () => {
    expect(isTransientDatabaseError(postgresError("23505"))).toBe(false);
    expect(isTransientDatabaseError(postgresError("22P02"))).toBe(false);
    expect(isTransientDatabaseError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
  });
});
