import type { AdminStorageBucket, StorageBucketCheckStep } from "@k2b/cloud/contracts/storage-buckets";
import type { StatusTone } from "@k2b/ui";
import type { StorageAreaMessages } from "./messages";

export const STORAGE_AREA_HREF = "/admin/storage";

/** The area's address with a bucket open; `new` opens the form for a new one. */
export const storageBucketHref = (id: string): string => `${STORAGE_AREA_HREF}?bucket=${encodeURIComponent(id)}`;

export type StorageBucketState = "ok" | "failed" | "untested" | "removed";

export const storageBucketState = (bucket: AdminStorageBucket): StorageBucketState => (bucket.removedAt ? "removed" : bucket.check.state);

export const storageStateLabel = (t: StorageAreaMessages, state: StorageBucketState): string =>
  state === "ok" ? t.stateOk : state === "failed" ? t.stateFailed : state === "removed" ? t.stateRemoved : t.stateUntested;

export const STORAGE_STATE_TONE: Record<StorageBucketState, StatusTone> = {
  ok: "ok",
  failed: "error",
  untested: "neutral",
  removed: "neutral",
};

/** Every label the list's status slot can show, so the badges keep one width. */
export const storageStateLabels = (t: StorageAreaMessages): string[] => [t.stateOk, t.stateFailed, t.stateUntested, t.stateRemoved];

export const storageStepLabel = (t: StorageAreaMessages, step: StorageBucketCheckStep | null): string =>
  step === "write" ? t.writeStep : step === "read" ? t.readStep : step === "delete" ? t.deleteStep : t.configStep;

/** The administrator's name for a bucket; the default bucket is named in the reader's language. */
export const storageBucketName = (t: StorageAreaMessages, bucket: Pick<AdminStorageBucket, "isDefault" | "name">): string =>
  bucket.isDefault ? t.defaultName : bucket.name;

const host = (endpoint: string | null): string => (endpoint ? endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "");

/** The list row's second line: where the bucket lives. */
export const storageBucketLine = (t: StorageAreaMessages, bucket: AdminStorageBucket): string => {
  if (bucket.removedAt) return t.removedLine({ name: bucket.bucket });
  const where = bucket.access === "inherit" ? t.likeDefault : host(bucket.endpoint);
  return [where, bucket.bucket].filter(Boolean).join(" · ");
};
