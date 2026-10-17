import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { encryptValue } from "./crypto";
import { registerSettings } from "./defaults";
import { SettingUnreadableError, writeKey } from "./store";

const key = "test.write_key_conflict";
const lockQuery = "UPDATE settings.entries SET value = value WHERE key = ? RETURNING value";
const writeQuery = "UPDATE settings.entries SET value = ?, updated_at = now() WHERE key = ?";
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
    expect(tx.queries[0]).toBe(lockQuery);
    expect(tx.queries[1]).toContain("ON CONFLICT (key) DO NOTHING RETURNING key");
  } finally {
    await tx.close();
  }
});

for (const attempt of [2, 3]) {
  test(`a reset deleting the insert winner retries and inserts on attempt ${attempt}`, async () => {
    const tx = transaction([...Array.from({ length: (attempt - 1) * 3 }, () => []), [], [{ key }]]);
    try {
      await writeKey(key, "https://replacement.test", tx.db);
      expect(tx.queries).toHaveLength((attempt - 1) * 3 + 2);
      expect(tx.queries.filter((query) => query.startsWith("INSERT"))).toHaveLength(attempt);
      expect(tx.queries.filter((query) => query === lockQuery)).toHaveLength((attempt - 1) * 2 + 1);
      expect(tx.queries).not.toContain(writeQuery);
    } finally {
      await tx.close();
    }
  });
}

test("a retry still refuses an unreadable row after a reset deleted the first winner", async () => {
  const tx = transaction([[], [], [], [{ value: "foreign-ciphertext" }]]);
  try {
    await expect(writeKey(key, "https://replacement.test", tx.db)).rejects.toBeInstanceOf(SettingUnreadableError);
    expect(tx.queries).toHaveLength(4);
    expect(tx.queries.filter((query) => query === lockQuery)).toHaveLength(3);
    expect(tx.queries).not.toContain(writeQuery);
  } finally {
    await tx.close();
  }
});

for (const replaceUnreadable of [false, true]) {
  test(`repeated resets fail after three attempts (replaceUnreadable: ${replaceUnreadable})`, async () => {
    const tx = transaction(Array.from({ length: 9 }, () => []));
    try {
      const error = await writeKey(key, "https://replacement.test", tx.db, { replaceUnreadable }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected a write failure");
      expect(error.constructor).toBe(Error);
      expect(error).toHaveProperty("message", expect.stringContaining(key));
      expect(tx.queries).toHaveLength(9);
      expect(tx.queries.filter((query) => query.startsWith("INSERT"))).toHaveLength(3);
      expect(tx.queries.filter((query) => query === lockQuery)).toHaveLength(6);
      expect(tx.queries).not.toContain(writeQuery);
    } finally {
      await tx.close();
    }
  });
}

for (const invalid of [false, true]) {
  test(`an insert conflict rechecks a ${invalid ? "decrypted but invalid" : "non-decryptable"} winner before updating`, async () => {
    const value = invalid ? await encryptValue("not a url") : "foreign-ciphertext";
    const tx = transaction([[], [], [{ value }]]);
    try {
      await expect(writeKey(key, "https://replacement.test", tx.db)).rejects.toBeInstanceOf(SettingUnreadableError);
      expect(tx.queries).toHaveLength(3);
      expect(tx.queries[0]).toBe(lockQuery);
      expect(tx.queries[2]).toBe(lockQuery);
      expect(tx.queries).not.toContain(writeQuery);
    } finally {
      await tx.close();
    }
  });
}

test("an insert conflict permits an explicit replacement after locking the winner", async () => {
  const tx = transaction([[], [], [{ value: "foreign-ciphertext" }], []]);
  try {
    await writeKey(key, "https://replacement.test", tx.db, { replaceUnreadable: true });
    expect(tx.queries[0]).toBe(lockQuery);
    expect(tx.queries[2]).toBe(lockQuery);
    expect(tx.queries[3]).toBe(writeQuery);
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
      expect(tx.queries[0]).toBe(lockQuery);
      if (conflict) expect(tx.queries[2]).toBe(lockQuery);
      expect(tx.queries.at(-1)).toBe(writeQuery);
    } finally {
      await tx.close();
    }
  });
}
