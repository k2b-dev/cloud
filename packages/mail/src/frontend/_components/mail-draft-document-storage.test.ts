import { expect, test } from "bun:test";
import { openMailUserDraftStorage } from "./mail-user-draft-storage";

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
  expect(storage.getItem("cloud:user:Usr001:mail:seed")).toBeNull();
  const freshTab = openMailUserDraftStorage(storage, "Usr001");
  freshTab.setItem("seed", "new session");
  expect(freshTab.getItem("seed")).toBe("new session");
});
