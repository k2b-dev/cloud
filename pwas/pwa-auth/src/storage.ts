import type { AppApprovalDevice, AppApprovalKey } from "@k2b/cloud/browser/app-approval";

export interface Binding extends AppApprovalDevice {
  id: string;
  label: string;
  name: string;
  /** Push token this Cloud last accepted for sign-in wake-ups. */
  pushToken?: string;
  details?: CloudDetails;
  /** When this device last approved a sign-in for this Cloud. */
  approvedAt?: string;
}
export interface Enrollment {
  comparison?: string;
  deviceId?: string;
  confirmed?: boolean;
  id: string;
  issuer: string;
  key: AppApprovalKey;
  label: string;
  name: string;
}

import { z } from "zod";
import { currentSession, guarded, type SealedRecord } from "./vault-storage";

const keySchema = z.object({
  privateKey: z.custom<CryptoKey>((v) => v instanceof CryptoKey && !v.extractable && v.type === "private"),
  publicKey: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() }),
});
const enrollmentSchema = z.object({
  id: z.string(),
  issuer: z.string(),
  key: keySchema,
  label: z.string(),
  name: z.string(),
  comparison: z.string().optional(),
  deviceId: z.string().optional(),
  confirmed: z.boolean().optional(),
});
/** The account this device signs in, as the Cloud last reported it. Kept for offline viewing. */
const detailsSchema = z.object({
  uid: z.string(),
  displayName: z.string(),
  mail: z.string().nullable(),
  deviceName: z.string(),
  pairedAt: z.string(),
  checkedAt: z.string(),
});
export type CloudDetails = z.infer<typeof detailsSchema>;
const bindingSchema = enrollmentSchema.extend({
  deviceId: z.string(),
  pushToken: z.string().optional(),
  details: detailsSchema.optional(),
  approvedAt: z.string().optional(),
});
async function read<T>(name: string, id: string, record: SealedRecord, validate: (v: unknown) => T) {
  const owner = currentSession();
  if (record.vault !== owner.id) throw new Error("storage");
  const value = await owner.openRecord(record.blob, JSON.stringify([name, id]), validate);
  owner.check();
  return value;
}
async function save(name: string, value: Enrollment | Binding) {
  const owner = currentSession();
  const blob = await owner.sealRecord(value, JSON.stringify([name, value.id]));
  owner.check();
  return guarded(name, "readwrite", (s) => s.put({ id: value.id, vault: owner.id, blob }, value.id));
}
export const bindingId = (issuer: string, deviceId: string) => JSON.stringify([issuer, deviceId]);
export const storage = {
  createKey: () => currentSession().createKey(),
  bindings: async () => {
    const rows = await guarded<SealedRecord[]>("bindings", "readonly", (s) => s.getAll());
    return Promise.all(rows.map((row) => read("bindings", row.id, row, (v) => bindingSchema.parse(v))));
  },
  saveBinding: (binding: Binding) => save("bindings", binding),
  /** Merges facts learned after pairing into the saved binding. Skips the write, and returns false,
   * when another tab renamed, updated or removed the binding since it was read. */
  updateBinding: async (id: string, change: Pick<Binding, "details" | "approvedAt">) => {
    const row = await guarded<SealedRecord | undefined>("bindings", "readonly", (s) => s.get(id));
    if (!row) return false;
    const current = await read("bindings", id, row, (v) => bindingSchema.parse(v));
    const owner = currentSession();
    const blob = await owner.sealRecord({ ...current, ...change }, JSON.stringify(["bindings", id]));
    owner.check();
    let written = false;
    await guarded("bindings", "readwrite", (store) => {
      const get = store.get(id);
      get.onsuccess = () => {
        const latest: SealedRecord | undefined = get.result;
        if (latest?.blob.iv !== row.blob.iv || latest.blob.data !== row.blob.data) return;
        store.put({ id, vault: owner.id, blob }, id);
        written = true;
      };
      return get;
    });
    return written;
  },
  removeBinding: (id: string) => guarded("bindings", "readwrite", (s) => s.delete(id)),
  enrollment: async (id: string) => {
    const row = await guarded<SealedRecord | undefined>("enrollments", "readonly", (s) => s.get(id));
    return row ? read("enrollments", id, row, (v) => enrollmentSchema.parse(v)) : undefined;
  },
  saveEnrollment: (value: Enrollment) => save("enrollments", value),
  removeEnrollment: (id: string) => guarded("enrollments", "readwrite", (s) => s.delete(id)),
  // Atomic cross-tab reservation: polls respect server cadence; decisions are at most once.
  reserve: async (id: string, until: number) => {
    let reserved = false;
    await guarded("operations", "readwrite", (store) => {
      const get = store.get(id);
      get.onsuccess = () => {
        if (typeof get.result !== "number" || get.result <= Date.now()) {
          store.put(until, id);
          reserved = true;
        }
      };
      return get;
    });
    return reserved;
  },
  defer: (id: string, until: number) => guarded("operations", "readwrite", (s) => s.put(until, id)),
  prune: () =>
    guarded("operations", "readwrite", (store) => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (row.value <= Date.now()) row.delete();
        row.continue();
      };
      return cursor;
    }),
};
