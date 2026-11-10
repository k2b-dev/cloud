import { expect, test } from "bun:test";
import { storageBucketCheck } from "./store";

test("a check describes only its exact effective signature", () => {
  const check = { bucket_id: "default", signature: "one", ok: true, step: null, checked_at: "2026-11-10T10:00:00Z" };
  expect(storageBucketCheck(check, "one")).toEqual({ state: "ok", step: null, checkedAt: "2026-11-10T10:00:00.000Z" });
  expect(storageBucketCheck(check, "two")).toEqual({ state: "untested", step: null, checkedAt: null });
  expect(storageBucketCheck(undefined, "one").state).toBe("untested");
  expect(storageBucketCheck({ ...check, ok: false, step: "write" }, "one").state).toBe("failed");
});
