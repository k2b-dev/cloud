import { describe, expect, test } from "bun:test";
import { assertCapabilityReview, compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { gridsCapabilities } from "./capabilities";
import { AtomicRecordsInputSchema } from "./integrity-contracts";
import { gridsActionReview } from "./integrity-review";

const target = { tableId: "Table1", recordId: "Record", ifVersion: 1 };
describe("Grids integrity capability contract", () => {
  test("ordinary row and draft writes have silent shared policy; issuing and finalizing always ask", () => {
    const manifest = compileCapabilityManifest("grids", gridsCapabilities);
    for (const id of [
      "record.create",
      "record.update",
      "record.upsert-external",
      "record.atomic",
      "record.correction-draft",
      "document.capture",
    ]) {
      expect(manifest.policies?.[id]).toEqual({ silent: "shared" });
    }
    for (const id of ["document.create", "document.issue", "document.confirm", "record.close", "record.finalize"]) {
      expect(manifest.policies?.[id]).toEqual({ ask: "cannot_undo" });
    }
    for (const action of manifest.actions) expect(manifest.policies?.[action.localId]).toBeDefined();
  });
  test("requires bounded coordination and rejects unsafe atomic operations and spoofed provenance", () => {
    const input = {
      baseId: "Base01",
      locks: [{ tableId: target.tableId, recordId: target.recordId }],
      checks: [target],
      changes: [{ kind: "update", ...target, values: { Field1: "new" } }],
    };
    expect(AtomicRecordsInputSchema.safeParse(input).success).toBeTrue();
    expect(
      AtomicRecordsInputSchema.safeParse({ ...input, checks: [{ query: "from table {Table1}", assert: "empty" }] }).success,
    ).toBeTrue();
    expect(
      AtomicRecordsInputSchema.safeParse({ ...input, checks: [{ query: "from table {Table1}", assert: "anything" }] }).success,
    ).toBeFalse();
    expect(AtomicRecordsInputSchema.safeParse({ ...input, locks: [] }).success).toBeFalse();
    expect(AtomicRecordsInputSchema.safeParse({ ...input, locks: Array(101).fill(target) }).success).toBeFalse();
    expect(AtomicRecordsInputSchema.safeParse({ ...input, changes: Array(51).fill(input.changes[0]) }).success).toBeFalse();
    expect(AtomicRecordsInputSchema.safeParse({ ...input, changes: [{ kind: "finalize", ...target }] }).success).toBeFalse();
    expect(AtomicRecordsInputSchema.safeParse({ ...input, origin: "workflow" }).success).toBeFalse();
    expect(
      gridsCapabilities.actions["record.correction-draft"].input.safeParse({
        recordId: target.recordId,
        ifVersion: target.ifVersion,
        typeFieldId: "Field1",
        originalFieldId: "Field2",
        typeValue: "correction",
        values: {},
        actorId: "forged",
      }).success,
    ).toBeFalse();
  });
  test("capture handles expose only public IDs and fixed digests", () => {
    const data = gridsCapabilities.actions["document.capture"].data;
    expect(
      data.safeParse({ id: "Capture", sha256: "a".repeat(64), rowCount: 1, capturedAt: "2026-11-06T00:00:00.000Z" }).success,
    ).toBeFalse();
    expect(
      data.safeParse({ id: "Capt01", sha256: "a".repeat(64), rowCount: 1, capturedAt: "2026-11-06T00:00:00.000Z" }).success,
    ).toBeTrue();
    expect(
      data.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        sha256: "a".repeat(64),
        rowCount: 1,
        capturedAt: "2026-11-06T00:00:00.000Z",
      }).success,
    ).toBeFalse();
  });
  test.each(["en", "de"])("complete reviews preserve a large proposal in %s", (locale) => {
    const context = { locale };
    const proposal = { rows: Array.from({ length: 1000 }, (_, i) => ({ name: `Item ${i}`, amount: "12.34" })) };
    const review = gridsActionReview(context, locale === "de" ? "Finanzexport bestätigen" : "Confirm financial export", proposal);
    assertCapabilityReview(review);
    expect(review.content?.kind).toBe("page");
    expect(JSON.parse(review.content!.body)).toEqual(proposal);
    expect(review.preview?.kind === "page" && review.preview.truncated).toBeTrue();
  });
});
