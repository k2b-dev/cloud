import { describe, expect, test } from "bun:test";
import { isOAuthTokenEpochCurrent } from "./oauth-tokens";

describe("OAuth user token epochs", () => {
  test("accepts matching safe epochs from PostgreSQL representations", () => {
    for (const epoch of [0, 1, Number.MAX_SAFE_INTEGER]) {
      for (const live of [epoch, String(epoch), BigInt(epoch)]) {
        expect(isOAuthTokenEpochCurrent({ auth_epoch: epoch }, live)).toBe(true);
      }
    }
  });

  test("rejects missing, non-numeric, negative, fractional and mismatched claims", () => {
    for (const claim of [undefined, null, "1", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2]) {
      expect(isOAuthTokenEpochCurrent({ auth_epoch: claim }, 1)).toBe(false);
    }
  });

  test("rejects invalid live epochs without coercing other types", () => {
    for (const live of [
      undefined,
      null,
      true,
      {},
      [],
      "",
      " ",
      "1.0",
      "1e0",
      "-1",
      -1,
      -1n,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      9007199254740992n,
      "9007199254740992",
      2,
    ]) {
      expect(isOAuthTokenEpochCurrent({ auth_epoch: 1 }, live)).toBe(false);
    }
  });
});
