import * as Y from "yjs";
import {
  listSharedTextOfflineGenerations,
  logoutSharedTextOffline,
  openSharedTextOffline,
  type SharedTextOfflineSession,
} from "./shared-text-offline";

// Instrument real engine resources; storage, locks, aborts and broadcasts stay native.
const databases = new Set<IDBDatabase>();
const channels = new Set<BroadcastChannel>();
let writes = 0;
let notifications = 0;
const nativeOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (...args: Parameters<IDBFactory["open"]>) => {
  const request = nativeOpen(...args);
  request.addEventListener("success", () => {
    const db = request.result;
    databases.add(db);
    const close = db.close.bind(db);
    db.close = () => {
      databases.delete(db);
      close();
    };
    db.addEventListener("close", () => databases.delete(db));
  });
  return request;
};
const nativeTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
  if (args[1] === "readwrite") writes++;
  return nativeTransaction.apply(this, args);
};
const NativeChannel = BroadcastChannel;
window.BroadcastChannel = class extends NativeChannel {
  constructor(name: string) {
    super(name);
    channels.add(this);
    this.addEventListener("message", () => {
      notifications++;
    });
  }
  override close() {
    channels.delete(this);
    super.close();
  }
};

const rawDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("cloud-shared-text-offline", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const sessions = new Map<string, SharedTextOfflineSession>();
const docs = new Map<string, Y.Doc>();
const pending = new Map<string, Promise<string>>();
let blocker: { release: () => Promise<void> } | undefined;

const fixture = {
  Y,
  open: openSharedTextOffline,
  generations: listSharedTextOfflineGenerations,
  logout: logoutSharedTextOffline,
  sessions,
  docs,
  pending,
  rawDatabase,
  resources: () => ({ databases: databases.size, channels: channels.size, writes }),
  notifications: () => notifications,
  suppressLogout: () => {
    for (const channel of channels) channel.onmessage = null;
  },
  doc: (id: number, state?: Uint8Array | null) => {
    const doc = new Y.Doc();
    doc.clientID = id;
    if (state) Y.applyUpdate(doc, state);
    return doc;
  },
  // Keep an actual IDB write lock without sleeps or timers. The test releases it
  // after arranging the transactions queued by the independent tabs.
  holdWrites: async () => {
    const db = await rawDatabase();
    const tx = db.transaction(["users", "drafts"], "readwrite");
    let held = true;
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
    const next = () => {
      const request = tx.objectStore("users").get("fixture-lock");
      request.onsuccess = () => {
        if (held) next();
      };
    };
    next();
    blocker = {
      release: async () => {
        held = false;
        await done;
      },
    };
  },
  releaseWrites: async () => {
    await blocker?.release();
    blocker = undefined;
  },
  close: async () => {
    for (const session of sessions.values()) session.close();
    sessions.clear();
    for (const doc of docs.values()) doc.destroy();
    docs.clear();
    await blocker?.release();
    blocker = undefined;
    await Promise.all(pending.values());
    pending.clear();
    return { databases: databases.size, channels: channels.size };
  },
};

declare global {
  interface Window {
    sharedTextOfflineTest: typeof fixture;
  }
}
window.sharedTextOfflineTest = fixture;
