import { expect, test } from "bun:test";
import { chatDrafts } from "./chat-drafts";

const storage = () => {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
  };
};
test("a panel replacement and full view recover only this reader's exact chat draft, including invalid input", () => {
  const tab = storage();
  const first = chatDrafts("reader1", tab);
  const text = "🙂".repeat(20_001);
  first.write("chat1", text);
  first.write("chat2", "Other draft");
  const reopened = chatDrafts("reader1", tab);
  expect(reopened.read("chat1")).toBe(text);
  expect(reopened.read("chat2")).toBe("Other draft");
  expect(chatDrafts("reader2", tab).read("chat1")).toBe("");
  reopened.write("chat1", "");
  expect(chatDrafts("reader1", tab).read("chat1")).toBe("");
  expect(first.read("chat2")).toBe("Other draft");
});
test("a storage failure remains observable to the caller instead of claiming that the draft is safe", () => {
  const drafts = chatDrafts("reader", {
    ...storage(),
    setItem: () => {
      throw new Error("quota");
    },
  });
  expect(() => drafts.write("chat", "Keep me")).toThrow("quota");
});
test("panel selection is reader-bound and rejects malformed stored conversation identities", () => {
  const tab = storage();
  const reader = chatDrafts("reader1", tab);
  reader.select("Chat01");
  expect(chatDrafts("reader1", tab).selection()).toBe("Chat01");
  expect(chatDrafts("reader2", tab).selection()).toBeNull();
  tab.setItem("cloud.chat.panel:reader1", "../Chat02");
  expect(reader.selection()).toBeNull();
  reader.select(null);
  expect(reader.selection()).toBeNull();
});

test("another view's write or deletion cannot be silently replaced by a stale draft", () => {
  const tab = storage();
  const panel = chatDrafts("reader", tab);
  const full = chatDrafts("reader", tab);
  panel.write("chat", "Original", "");
  full.write("chat", "Newer text", "Original");
  expect(() => panel.write("chat", "Stale edit", "Original")).toThrow("Another view changed this draft");
  expect(panel.read("chat")).toBe("Newer text");
  panel.write("chat", "Chosen local text", "Newer text");
  full.write("chat", "", "Chosen local text");
  expect(() => panel.write("chat", "Resurrected draft", "Chosen local text")).toThrow("Another view changed this draft");
  expect(full.read("chat")).toBe("");
});
