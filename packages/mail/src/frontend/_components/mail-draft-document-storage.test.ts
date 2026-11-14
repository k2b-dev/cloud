import { expect, setSystemTime, test } from "bun:test";
import { openMailUserDraftStorage, synchronizeMailDraftStorageUser } from "../../lib/mail-user-draft-storage";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
};

test("a second user cannot read, overwrite or clear another user's journal or unowned legacy input", () => {
  const storage = memoryStorage();
  storage.setItem("cloud:mail:draft:Box001:Draft1", "legacy input with unknown owner");
  const first = openMailUserDraftStorage(storage, "Usr001"),
    second = openMailUserDraftStorage(storage, "Usr002");
  first.setItem("draft:Box001:Draft1", "first user's input");
  expect(second.getItem("draft:Box001:Draft1")).toBeNull();
  expect(first.keys()).toEqual(["draft:Box001:Draft1"]);
  expect(second.keys()).toEqual([]);
  second.setItem("draft:Box001:Draft1", "second user's input");
  second.clear();
  expect(first.getItem("draft:Box001:Draft1")).toBe("first user's input");
  expect(storage.getItem("cloud:mail:draft:Box001:Draft1")).toBe("legacy input with unknown owner");
});

test("logout's persistent epoch fences old tab reads/writes, including delayed asynchronous callbacks", () => {
  const storage = memoryStorage();
  const oldTab = openMailUserDraftStorage(storage, "Usr001");
  oldTab.setItem("seed", "private text");
  storage.setItem("cloud:user-epoch:Usr001", "1");
  storage.removeItem("cloud:user:Usr001:mail:seed");
  expect(() => oldTab.setItem("seed", "late response")).toThrow("session ended");
  expect(() => oldTab.getItem("seed")).toThrow("session ended");
  expect(() => oldTab.keys()).toThrow("session ended");
  expect(storage.getItem("cloud:user:Usr001:mail:seed")).toBeNull();
  const freshTab = openMailUserDraftStorage(storage, "Usr001");
  freshTab.setItem("seed", "new session");
  expect(freshTab.getItem("seed")).toBe("new session");
});

test("journals survive a short offline interval and expire after the recovery window, including legacy input", () => {
  const storage = memoryStorage();
  const start = Date.parse("2026-11-09T12:00:00Z");
  setSystemTime(start);
  try {
    storage.setItem("cloud:user:Usr001:mail:legacy", "legacy body and Bcc");
    const first = openMailUserDraftStorage(storage, "Usr001");
    first.setItem("journal", JSON.stringify({ content: { body: "Pending text", bcc: ["private@example.test"] } }));
    setSystemTime(start + 60 * 60 * 1000);
    expect(openMailUserDraftStorage(storage, "Usr001").getItem("journal")).toContain("Pending text");
    setSystemTime(start + 24 * 60 * 60 * 1000 + 1);
    expect(openMailUserDraftStorage(storage, "Usr001").keys()).toEqual([]);
    expect(storage.getItem("cloud:user:Usr001:mail:journal")).toBeNull();
    expect(storage.getItem("cloud:user:Usr001:mail:legacy")).toBeNull();
  } finally {
    setSystemTime();
  }
});

test("an authenticated account switch fences delayed journal writes", () => {
  const storage = memoryStorage();
  storage.setItem("cloud:mail:storage-user", "Usr001");
  const old = openMailUserDraftStorage(storage, "Usr001");
  old.setItem("journal", "private input");
  expect(old.getItem("journal")).toBe("private input");
  synchronizeMailDraftStorageUser(storage, "Usr002");
  expect(storage.getItem("cloud:user:Usr001:mail:journal")).toBeNull();
  expect(() => old.setItem("journal", "late callback")).toThrow("session ended");
});

test("a new account can open its own seed storage before its first draft authorization", () => {
  const storage = memoryStorage();
  synchronizeMailDraftStorageUser(storage, "Usr001");
  const old = openMailUserDraftStorage(storage, "Usr001");
  old.setItem("journal", "first account's text");
  const next = openMailUserDraftStorage(storage, "Usr002");
  next.setItem("seed", "new account's message");
  synchronizeMailDraftStorageUser(storage, "Usr002");
  expect(next.getItem("seed")).toBe("new account's message");
  expect(() => old.setItem("journal", "late callback")).toThrow("session ended");
});

test("reading a legacy journal at storage quota preserves the recovery input", () => {
  const storage = memoryStorage();
  storage.setItem("cloud:user:Usr001:mail:legacy", "body and private Bcc");
  storage.setItem = () => {
    throw new DOMException("Storage full", "QuotaExceededError");
  };
  expect(openMailUserDraftStorage(storage, "Usr001").getItem("legacy")).toBe("body and private Bcc");
});
