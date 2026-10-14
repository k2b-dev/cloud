import { describe, expect, test } from "bun:test";
import { allowedEmailInlineStyleValue } from "./email-inline-style-policy";

describe("email inline style policy", () => {
  test("rejects escapes that spell blocked function names outside quoted strings", () => {
    for (const value of [
      String.raw`u\72l(https://x)`,
      String.raw`u\000072l(https://x)`,
      String.raw`u\r\l(https://x)`,
      String.raw`\75rl(https://x)`,
      String.raw`image\-set("x" 1x)`,
      String.raw`-webkit-image\-set("x" 1x)`,
    ]) {
      for (const property of ["font-family", "background"]) {
        expect(allowedEmailInlineStyleValue(property, value)).toBe(false);
      }
    }
  });

  test("keeps non-ASCII font escapes, quoted string escapes, and escaped spaces", () => {
    for (const value of [
      String.raw`\5FAE\8F6F, sans-serif`,
      String.raw`"\5FAE\8F6F", sans-serif`,
      String.raw`'O\'Reilly Sans', serif`,
      String.raw`Font\ Name, serif`,
    ]) {
      expect(allowedEmailInlineStyleValue("font-family", value)).toBe(true);
    }
  });
});
