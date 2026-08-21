import { describe, expect, test } from "bun:test";
import { BusinessDocumentGqlIssueSchema, BusinessDocumentIssueSchema } from "./business-document-contracts";
import { exactDecimalSchema } from "./business-document-profiles";
import { canonicalBusinessDocumentJson, MAX_BUSINESS_DOCUMENT_INPUT_BYTES } from "./service/business-documents";

describe("Business Document contracts", () => {
  test("canonicalizes object key order and bounds exact JSON input", () => {
    expect(canonicalBusinessDocumentJson({ b: 2, a: { d: 4, c: 3 } })).toEqual(canonicalBusinessDocumentJson({ a: { c: 3, d: 4 }, b: 2 }));
    expect(() => canonicalBusinessDocumentJson({ value: "x".repeat(MAX_BUSINESS_DOCUMENT_INPUT_BYTES) })).toThrow("byte limit");
  });

  test("rejects unsafe identities, incomplete correction metadata, and unstable GQL observations", () => {
    const native = {
      profileId: "test.statement",
      profileVersion: 1,
      idempotencyKey: "order-42",
      source: { appId: "orders\0hidden", resourceType: "order", resourceId: "42" },
      sourceRevision: { id: "v1", observedAt: "2026-08-22T10:00:00.000Z", evidence: {} },
      snapshot: {},
      relationship: "correction",
    };
    expect(BusinessDocumentIssueSchema.safeParse(native).success).toBe(false);
    expect(
      BusinessDocumentGqlIssueSchema.safeParse({
        profileId: "test.statement",
        profileVersion: 1,
        idempotencyKey: "gql-v1",
        relationship: "original",
        query: "from table Orders",
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
