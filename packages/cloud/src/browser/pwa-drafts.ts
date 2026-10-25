/** Plain typed text only. Account and field identifiers belong in keys, never in stored payloads. */
const PREFIX = "cloud.pwa.draft:";
const key = (accountId: string, fieldId: string) => `${PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(fieldId)}`;
// A denied/full store must still protect this document from an automatic reload while typing.
const pending = new Map<string, string>();

export const pwaDrafts = {
  read(accountId: string, fieldId: string): string | undefined {
    const id = key(accountId, fieldId);
    try {
      return pending.get(id) ?? window.localStorage.getItem(id) ?? undefined;
    } catch {
      return pending.get(id);
    }
  },
  /** Call on each input, including empty text. False means the browser could not keep the draft across restarts. */
  write(accountId: string, fieldId: string, text: string): boolean {
    const id = key(accountId, fieldId);
    pending.set(id, text);
    try {
      window.localStorage.setItem(id, text);
      pending.delete(id);
      return true;
    } catch {
      return false;
    }
  },
  /** Call only after saving/sending succeeds, or the person explicitly discards the draft. */
  remove(accountId: string, fieldId: string): void {
    const id = key(accountId, fieldId);
    pending.delete(id);
    try {
      window.localStorage.removeItem(id);
    } catch {}
  },
  has(accountId: string): boolean {
    const prefix = `${PREFIX}${encodeURIComponent(accountId)}:`;
    if ([...pending.keys()].some((id) => id.startsWith(prefix))) return true;
    try {
      const storage = window.localStorage;
      return Array.from({ length: storage.length }, (_, i) => storage.key(i)).some((id) => id?.startsWith(prefix));
    } catch {
      return false;
    }
  },
  /** Sign-out, a removed device, and a new pairing erase every account's app drafts on this browser. */
  clearAll(): void {
    pending.clear();
    try {
      const storage = window.localStorage;
      for (let i = storage.length - 1; i >= 0; i--) {
        const id = storage.key(i);
        if (id?.startsWith(PREFIX)) storage.removeItem(id);
      }
    } catch {}
  },
};
