import type { AppApprovalDevice, AppApprovalKey } from "@valentinkolb/cloud/browser/app-approval";

export interface Binding extends AppApprovalDevice {
  id: string;
  label: string;
  name: string;
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

// IndexedDB structured clone preserves non-extractable CryptoKeys. Never JSON encode keys.
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cloud-login", 1);
    request.onupgradeneeded = () => {
      for (const name of ["bindings", "enrollments", "operations"]) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(new Error("storage"));
    request.onblocked = () => reject(new Error("storage"));
    request.onsuccess = () => resolve(request.result);
  });
async function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = run(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error("storage"));
    });
  } finally {
    db.close();
  }
}
export const bindingId = (issuer: string, deviceId: string) => JSON.stringify([issuer, deviceId]);
export const storage = {
  bindings: () => transaction<Binding[]>("bindings", "readonly", (s) => s.getAll()),
  saveBinding: (binding: Binding) => transaction("bindings", "readwrite", (s) => s.put(binding, binding.id)),
  removeBinding: (id: string) => transaction("bindings", "readwrite", (s) => s.delete(id)),
  enrollment: (id: string) => transaction<Enrollment | undefined>("enrollments", "readonly", (s) => s.get(id)),
  saveEnrollment: (value: Enrollment) => transaction("enrollments", "readwrite", (s) => s.put(value, value.id)),
  removeEnrollment: (id: string) => transaction("enrollments", "readwrite", (s) => s.delete(id)),
  // Atomic cross-tab reservation: polls respect server cadence; decisions are at most once.
  reserve: async (id: string, until: number) => {
    const db = await database();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction("operations", "readwrite");
        const store = tx.objectStore("operations");
        let reserved = false;
        const get = store.get(id);
        get.onsuccess = () => {
          if (typeof get.result !== "number" || get.result <= Date.now()) {
            store.put(until, id);
            reserved = true;
          }
        };
        tx.oncomplete = () => resolve(reserved);
        tx.onabort = tx.onerror = () => reject(new Error("storage"));
      });
    } finally {
      db.close();
    }
  },
  defer: (id: string, until: number) => transaction("operations", "readwrite", (s) => s.put(until, id)),
  prune: async () => {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("operations", "readwrite");
        const cursor = tx.objectStore("operations").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (row.value <= Date.now()) row.delete();
          row.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(new Error("storage"));
      });
    } finally {
      db.close();
    }
  },
};
