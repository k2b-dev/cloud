import { type AppVaultBlob, type AppVaultConfig, type AppVaultSession, appApproval } from "@k2b/cloud/browser/app-approval";

export interface VaultHeader {
  revision: string;
  config: AppVaultConfig;
}
export interface SealedRecord {
  id: string;
  vault: string;
  blob: AppVaultBlob;
}
export const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cloud-login", 2);
    let failed = false;
    request.onupgradeneeded = () => {
      for (const name of ["bindings", "enrollments", "operations", "vault"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(new Error("storage"));
    };
    request.onsuccess = () => {
      if (failed) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
export async function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
let session: AppVaultSession | undefined;
let revision: string | undefined;
export function currentSession() {
  if (!session) throw new Error("locked");
  session.check();
  return session;
}
export function lockStorage() {
  session?.lock();
  session = undefined;
  revision = undefined;
}
export function unlockStorage(value: AppVaultSession, header: VaultHeader) {
  lockStorage();
  session = value;
  revision = header.revision;
}
export async function readHeader(): Promise<VaultHeader | undefined> {
  const value = await transaction<VaultHeader | undefined>("vault", "readonly", (s) => s.get("header"));
  if (!value) return undefined;
  if (typeof value.revision !== "string") throw new Error("storage");
  return { revision: value.revision, config: appApproval.vault.parseConfig(value.config) };
}
export async function hasLegacy() {
  return (
    (await transaction<unknown[]>("bindings", "readonly", (s) => s.getAll())).length > 0 ||
    (await transaction<unknown[]>("enrollments", "readonly", (s) => s.getAll())).length > 0
  );
}
export const readRevision = () =>
  transaction<{ revision?: unknown } | undefined>("vault", "readonly", (s) => s.get("header")).then((value) => value?.revision);
/** Compare-and-swap also invalidates writes from unlocked tabs using a previous configuration. */
export async function saveHeader(header: VaultHeader | undefined, expected?: unknown, reset = false) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["vault", "bindings", "enrollments", "operations"], "readwrite");
      const store = tx.objectStore("vault");
      const read = store.get("header");
      read.onsuccess = () => {
        if (read.result?.revision !== expected) {
          tx.abort();
          return;
        }
        if (reset) for (const name of ["bindings", "enrollments", "operations"]) tx.objectStore(name).clear();
        if (header) store.put(header, "header");
        else store.delete("header");
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error("storage"));
    });
  } finally {
    db.close();
  }
}
export async function guarded<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const owner = currentSession();
  const expected = revision;
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["vault", name], mode);
      let request: IDBRequest<T>;
      const header = tx.objectStore("vault").get("header");
      header.onsuccess = () => {
        if (session !== owner || header.result?.revision !== expected) {
          tx.abort();
          return;
        }
        request = run(tx.objectStore(name));
      };
      tx.oncomplete = () => {
        if (session !== owner) reject(new Error("locked"));
        else resolve(request.result);
      };
      tx.onabort = tx.onerror = () => reject(new Error("storage"));
    });
  } finally {
    db.close();
  }
}
