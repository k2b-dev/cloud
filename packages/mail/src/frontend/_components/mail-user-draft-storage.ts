export class MailUserDraftStorageEndedError extends Error {
  constructor() {
    super("This browser session ended. Copy your input before leaving.");
    this.name = "MailUserDraftStorageEndedError";
  }
}

/** Plaintext legacy seeds/journals are scoped to the authenticated user, never claimed from global legacy keys. */
export const openMailUserDraftStorage = (storage: Storage, userId: string): Storage => {
  if (!userId) throw new Error("Authenticated user storage is required");
  const prefix = `cloud:user:${userId}:mail:`;
  const epochKey = `cloud:user-epoch:${userId}`;
  const epoch = storage.getItem(epochKey);
  const check = () => {
    if (storage.getItem(epochKey) !== epoch) throw new MailUserDraftStorageEndedError();
  };
  const keys = () => {
    check();
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string =>
      Boolean(key?.startsWith(prefix)),
    );
  };
  return {
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => {
      check();
      return storage.getItem(`${prefix}${key}`);
    },
    setItem: (key, value) => {
      check();
      storage.setItem(`${prefix}${key}`, value);
    },
    removeItem: (key) => {
      check();
      storage.removeItem(`${prefix}${key}`);
    },
    clear: () => {
      for (const key of keys()) storage.removeItem(key);
    },
  };
};
