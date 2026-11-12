import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { persistedSignature, persistedSignatures } from "../../_internal/object-store-config";
import { connectionFixture, stubConnections } from "../../runtime/connections.test-fixture";
import { storageBucketCheck } from "./store";

test("a check describes only its exact effective signature", () => {
  const check = { bucket_id: "default", signature: "one", ok: true, step: null, checked_at: "2026-11-10T10:00:00Z" };
  expect(storageBucketCheck(check, "one")).toEqual({ state: "ok", step: null, checkedAt: "2026-11-10T10:00:00.000Z" });
  expect(storageBucketCheck(check, "two")).toEqual({ state: "untested", step: null, checkedAt: null });
  expect(storageBucketCheck(undefined, "one").state).toBe("untested");
  expect(storageBucketCheck({ ...check, ok: false, step: "write" }, "one").state).toBe("failed");
});

test("an old-root connection check remains valid during overlap and becomes untested after removal", () => {
  const check = { bucket_id: "default", signature: "A-signature", ok: true, step: null, checked_at: "2030-01-02T00:00:00Z" };
  expect(storageBucketCheck(check, ["B-signature", "A-signature"]).state).toBe("ok");
  expect(storageBucketCheck(check, ["B-signature"]).state).toBe("untested");
});

let snapshot: ReturnType<typeof stubConnections> | undefined;
afterEach(() => snapshot?.mockRestore());
test("persisted check signatures retain the legacy recipe and verify the full root ring", () => {
  const A = "ab".repeat(32),
    B = "cd".repeat(32);
  const expected = createHmac("sha256", `cloud.storage-bucket-check:${A}`).update("config-fingerprint").digest("hex");
  snapshot = stubConnections({ appSecret: { current: A } });
  expect(persistedSignature("config-fingerprint")).toBe(expected);
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));
  const candidates = persistedSignatures("config-fingerprint");
  expect(candidates).toHaveLength(2);
  expect(candidates[1]).toBe(expected);
  expect(persistedSignature("config-fingerprint")).toBe(candidates[0]!);
  snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B } }));
  expect(persistedSignatures("config-fingerprint")).not.toContain(expected);
});
