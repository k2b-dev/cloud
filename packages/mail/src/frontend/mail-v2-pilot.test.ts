import { describe, expect, test } from "bun:test";
import { showsMailV2 } from "./mail-v2-pilot";

describe("Mail v2 pilot", () => {
  test("nobody sees v2 while the list is empty", () => {
    expect(showsMailV2([], "ada@example.com")).toBe(false);
  });

  test("a listed address sees v2, without case or surrounding space", () => {
    expect(showsMailV2([" Ada@Example.com "], "ada@example.COM")).toBe(true);
    expect(showsMailV2(["ada@example.com"], "jonas@example.com")).toBe(false);
  });

  test("* shows v2 to everyone, also to a person without an address", () => {
    expect(showsMailV2(["*"], null)).toBe(true);
  });

  test("a person without an address never matches an empty entry", () => {
    expect(showsMailV2(["", "  "], null)).toBe(false);
    expect(showsMailV2([""], "")).toBe(false);
  });
});
