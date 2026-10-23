import { describe, expect, test } from "bun:test";
import { MAX_SIGNATURE_BYTES, REQUEST_BYTES } from "../src/constants";
import { SignSchema, SubjectSchema } from "../src/domain";
import { VisitViewSchema } from "../src/model";
import { fixtureSnapshot } from "./fixtures";

const signature = {
  kind: "typed" as const,
  name: "Lea Muster",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 77" width="264" height="77"><text x="12" y="55" font-family="cursive" font-size="48" fill="currentColor">Lea Muster</text></svg>',
};
const valid = () => ({ documentId: "contract", revision: 1, signature, consent: true });
describe("example domain boundary", () => {
  test("parses and rebuilds a real shared SignatureInput value", () => {
    expect(SignSchema.parse(valid()).signature).toEqual(signature);
  });
  test("rejects arbitrary SVG, missing consent, unknown documents and stale-shaped revisions", () => {
    for (const value of [
      { ...valid(), signature: { ...signature, svg: '<svg onload="alert(1)"></svg>' } },
      { ...valid(), consent: false },
      { ...valid(), documentId: "other-app" },
      { ...valid(), revision: 0 },
      { ...valid(), signature: { ...signature, svg: "x".repeat(MAX_SIGNATURE_BYTES) } },
    ])
      expect(SignSchema.safeParse(value).success).toBe(false);
  });
  test("bounds the request envelope even with JSON escaping", () => {
    const escaped = JSON.stringify({
      visitId: "1".repeat(36),
      attemptId: "2".repeat(36),
      input: { ...valid(), signature: "\u0000".repeat(MAX_SIGNATURE_BYTES) },
    });
    expect(new TextEncoder().encode(escaped).byteLength).toBeLessThan(REQUEST_BYTES);
  });
  test("subjects are app-owned IDs; no injected staff or permission fields", () => {
    expect(SubjectSchema.safeParse({ customerId: "10000000-0000-4000-8000-000000000001" }).success).toBe(true);
    expect(SubjectSchema.safeParse({ customerId: "employee", ownerUserId: "admin" }).success).toBe(false);
  });
  test("the read model strips signatures and credentials", () => {
    const snapshot = fixtureSnapshot();
    const view = VisitViewSchema.parse({ ...snapshot.visit, signature, token: "private" });
    expect(JSON.stringify(view)).not.toContain(signature.svg);
    expect(JSON.stringify(view)).not.toContain("private");
  });
});
