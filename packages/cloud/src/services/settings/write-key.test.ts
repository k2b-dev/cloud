import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { encryptValue } from "./crypto";
import { registerSettings } from "./defaults";
import { SettingUnreadableError, writeKey } from "./store";

const key = "test.write_key_conflict";
registerSettings([{ key, kind: "url", default: "", description: "Write conflict probe", group: "test" }]);
const previousSecret = process.env.APP_SECRET;
beforeAll(() => {
  process.env.APP_SECRET = "test-only-write-key-conflict";
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = previousSecret;
});

// Script the SQL replies at the caller-owned transaction boundary, without a database or timing hooks.
const transaction = (replies: { key?: string; value?: string }[][]) => {
  const queries: string[] = [];
  const client = new SQL("postgres://localhost/unused_test");
  const db = new Proxy(client, {
    apply(_target, _receiver, args) {
      const [strings] = args;
      if (!Array.isArray(strings)) throw new Error("Expected a tagged SQL query");
      queries.push(strings.join("?").replace(/\s+/g, " ").trim());
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected SQL query");
      return Promise.resolve(reply);
    },
  });
  return { db, queries, close: () => client.close() };
};

test("a missing setting is inserted without an overwrite on conflict", async () => {
  const tx = transaction([[], [{ key }]]);
  try {
    await writeKey(key, "https://replacement.test", tx.db);
    expect(tx.queries).toHaveLength(2);
    expect(tx.queries[0]).toContain("FOR UPDATE");
    expect(tx.queries[1]).toContain("ON CONFLICT (key) DO NOTHING RETURNING key");
  } finally {
    await tx.close();
  }
});

for (const invalid of [false, true]) {
  test(`an insert conflict rechecks a ${invalid ? "decrypted but invalid" : "non-decryptable"} winner before updating`, async () => {
    const value = invalid ? await encryptValue("not a url") : "foreign-ciphertext";
    const tx = transaction([[], [], [{ value }]]);
    try {
      await expect(writeKey(key, "https://replacement.test", tx.db)).rejects.toBeInstanceOf(SettingUnreadableError);
      expect(tx.queries).toHaveLength(3);
      expect(tx.queries[2]).toBe(tx.queries[0]);
      expect(tx.queries.some((query) => query.startsWith("UPDATE"))).toBe(false);
    } finally {
      await tx.close();
    }
  });
}

test("an insert conflict permits an explicit replacement after locking the winner", async () => {
  const tx = transaction([[], [], [{ value: "foreign-ciphertext" }], []]);
  try {
    await writeKey(key, "https://replacement.test", tx.db, { replaceUnreadable: true });
    expect(tx.queries[2]).toBe(tx.queries[0]);
    expect(tx.queries[3]).toBe("UPDATE settings.entries SET value = ?, updated_at = now() WHERE key = ?");
  } finally {
    await tx.close();
  }
});

for (const conflict of [false, true]) {
  test(`a readable ${conflict ? "insert winner" : "existing row"} is updated after its check`, async () => {
    const row = [{ value: await encryptValue("https://saved.test") }];
    const tx = transaction(conflict ? [[], [], row, []] : [row, []]);
    try {
      await writeKey(key, "https://replacement.test", tx.db);
      expect(tx.queries).toHaveLength(conflict ? 4 : 2);
      expect(tx.queries.at(-1)).toStartWith("UPDATE settings.entries");
    } finally {
      await tx.close();
    }
  });
}
