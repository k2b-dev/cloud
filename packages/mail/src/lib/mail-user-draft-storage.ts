export class MailUserDraftStorageEndedError extends Error {
  constructor() {
    super("This browser session ended. Copy your input before leaving.");
    this.name = "MailUserDraftStorageEndedError";
  }
}

/** Same recovery window as local draft seeds; brief offline periods retain their input. */
export const MAIL_DRAFT_LOCAL_TTL_MS = 24 * 60 * 60 * 1_000;
const activeUserKey = "cloud:mail:storage-user";

/** Call only after a server response has authorized this account. */
export const synchronizeMailDraftStorageUser = (storage: Storage, userId: string): void => {
  const previous = storage.getItem(activeUserKey);
  if (previous && previous !== userId) {
    storage.setItem(`cloud:mail-storage-epoch:${previous}`, crypto.randomUUID());
    const prefixes = [`cloud:user:${previous}:mail:`, `cloud:user:${previous}:mail-expiry:`];
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) storage.removeItem(key);
    }
  }
  storage.setItem(activeUserKey, userId);
};

/** Plaintext legacy seeds/journals are scoped to the authenticated user, never claimed from global legacy keys. */
export const openMailUserDraftStorage = (storage: Storage, userId: string): Storage & { keys(): string[] } => {
  if (!userId) throw new Error("Authenticated user storage is required");
  const prefix = `cloud:user:${userId}:mail:`;
  const epochKey = `cloud:user-epoch:${userId}`;
  const epoch = storage.getItem(epochKey);
  const mailEpochKey = `cloud:mail-storage-epoch:${userId}`;
  const mailEpoch = storage.getItem(mailEpochKey);
  const expiryPrefix = `cloud:user:${userId}:mail-expiry:`;
  const check = () => {
    if (storage.getItem(epochKey) !== epoch || storage.getItem(mailEpochKey) !== mailEpoch) throw new MailUserDraftStorageEndedError();
  };
  const remove = (key: string) => {
    storage.removeItem(`${prefix}${key}`);
    storage.removeItem(`${expiryPrefix}${key}`);
  };
  const alive = (key: string) => {
    const expires = storage.getItem(`${expiryPrefix}${key}`);
    if (expires === null) {
      // Previously unbounded journals get one recovery window on first encounter.
      try {
        storage.setItem(`${expiryPrefix}${key}`, String(Date.now() + MAIL_DRAFT_LOCAL_TTL_MS));
      } catch {
        // A full device must still let the person read and recover existing input.
      }
      return true;
    }
    if (Number.isFinite(Number(expires)) && Number(expires) > Date.now()) return true;
    remove(key);
    return false;
  };
  const keys = () => {
    check();
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(prefix)))
      .filter((key) => alive(key.slice(prefix.length)));
  };
  keys();
  return {
    keys: () => keys().map((key) => key.slice(prefix.length)),
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => {
      check();
      const raw = storage.getItem(`${prefix}${key}`);
      return raw !== null && alive(key) ? raw : null;
    },
    setItem: (key, value) => {
      check();
      storage.setItem(`${expiryPrefix}${key}`, String(Date.now() + MAIL_DRAFT_LOCAL_TTL_MS));
      storage.setItem(`${prefix}${key}`, value);
    },
    removeItem: (key) => {
      check();
      remove(key);
    },
    clear: () => {
      for (const key of keys()) remove(key.slice(prefix.length));
    },
  };
};
