import { describe, expect, test } from "bun:test";
import { commitMailRecipients, formatMailRecipients, parseMailRecipients, shouldCommitMailRecipient } from "./mail-recipient";

describe("mail recipient tokens", () => {
  test("round-trips display names", () => {
    const recipients = [{ name: "Ada Lovelace", address: "ada@example.test" }];
    expect(parseMailRecipients(formatMailRecipients(recipients))).toEqual(recipients);
  });

  test("normalizes and deduplicates addresses", () => {
    expect(parseMailRecipients(["ADA@example.test", "Ada Lovelace <ada@example.test>"])).toEqual([
      { name: "Ada Lovelace", address: "ada@example.test" },
    ]);
  });

  test("drops invalid recipient tokens before draft persistence", () => {
    expect(parseMailRecipients(["not an address", "valid@example.test"])).toEqual([{ name: null, address: "valid@example.test" }]);
  });

  test("adds and replaces formatted recipient tokens", () => {
    expect(commitMailRecipients(["one@example.test"], "Ada Lovelace <ADA@example.test>")).toEqual({
      values: ["one@example.test", "Ada Lovelace <ada@example.test>"],
      rest: "",
    });
    expect(commitMailRecipients(["one@example.test", "two@example.test"], "updated@example.test", 0)).toEqual({
      values: ["updated@example.test", "two@example.test"],
      rest: "",
    });
    expect(commitMailRecipients(["one@example.test"], "not an address")).toEqual({ values: ["one@example.test"], rest: "not an address" });
  });

  test("splits lists at commas, semicolons and line breaks, but not inside a quoted name", () => {
    expect(commitMailRecipients([], 'a@x.de; "Kolb, Bernd" <B@y.de>,\nc@z.de\r\nbernd@firma, bernd')).toEqual({
      values: ["a@x.de", "Kolb, Bernd <b@y.de>", "c@z.de"],
      rest: "bernd@firma, bernd",
    });
    expect(commitMailRecipients(["one@example.test", "two@example.test"], "a@x.de; b@y.de", 0)).toEqual({
      values: ["a@x.de", "b@y.de", "two@example.test"],
      rest: "",
    });
  });

  test("accepts space as a separator only after a complete address", () => {
    expect(shouldCommitMailRecipient("ada@example.test", " ")).toBeTrue();
    expect(shouldCommitMailRecipient("Ada Lovelace", " ")).toBeFalse();
    expect(shouldCommitMailRecipient("Ada Lovelace <ada@example.test>", " ")).toBeTrue();
    expect(shouldCommitMailRecipient("ada@example.test", ",")).toBeTrue();
    expect(shouldCommitMailRecipient("ada@example.test", ";")).toBeTrue();
    expect(shouldCommitMailRecipient("", "Enter")).toBeFalse();
  });
});
