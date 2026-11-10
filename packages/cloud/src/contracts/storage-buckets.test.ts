import { expect, test } from "bun:test";
import { DEFAULT_STORAGE_BUCKET_ID, parseStorageBucketId } from "./storage-buckets";

test("bucket references normalize default and UUIDs and reject all other shapes", () => {
  expect(parseStorageBucketId(" DEFAULT ")).toBe(DEFAULT_STORAGE_BUCKET_ID);
  expect(String(parseStorageBucketId(" ABCDEF12-1234-5678-90AB-ABCDEF123456 "))).toBe("abcdef12-1234-5678-90ab-abcdef123456");
  for (const value of [undefined, null, 42, {}, "", "cloud-test", "~default", "../default", "00000000-0000-0000-0000-00000000000z"])
    expect(parseStorageBucketId(value)).toBeNull();
});
