import { describe, expect, test } from "bun:test";
import { DocumentProfileSummarySchema } from "./document-profile-contracts";
import { exactDecimalSchema } from "./document-profiles";
import { canonicalDocumentJson, MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./service/document-issuance";

describe("Document renderer contracts", () => {
  test("canonicalizes object key order and bounds exact JSON input", () => {
    expect(canonicalDocumentJson({ b: 2, a: { d: 4, c: 3 } })).toEqual(canonicalDocumentJson({ a: { c: 3, d: 4 }, b: 2 }));
    expect(() => canonicalDocumentJson({ value: "x".repeat(MAX_DOCUMENT_PROFILE_INPUT_BYTES) })).toThrow("byte limit");
  });

  test("keeps renderer registry metadata bounded and strict", () => {
    expect(
      DocumentProfileSummarySchema.safeParse({
        id: "de.zugferd.en16931",
        version: 1,
        title: "ZUGFeRD",
        description: "EN 16931 invoice renderer",
        rendererVersion: "1",
        validatorVersion: "1",
      }).success,
    ).toBe(true);
    expect(
      DocumentProfileSummarySchema.safeParse({
        id: "invalid\0id",
        version: 1,
        title: "ZUGFeRD",
        description: "EN 16931 invoice renderer",
        rendererVersion: "1",
        validatorVersion: "1",
      }).success,
    ).toBe(false);
  });

  test("keeps decimal scale lexical and bounded instead of coercing binary numbers", () => {
    const money = exactDecimalSchema({ scale: 2, nonnegative: true });
    expect(money.safeParse("19.00").success).toBe(true);
    expect(money.safeParse("19.0").success).toBe(false);
    expect(money.safeParse(19).success).toBe(false);
    expect(money.safeParse("1".repeat(201)).success).toBe(false);
  });
});
