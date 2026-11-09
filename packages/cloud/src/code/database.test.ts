import { afterAll, beforeAll, expect, test } from "bun:test";
import { acceptanceChecker } from "../../../core/src/code/acceptance.test-fixture";
import { checkCode } from "./checker";
import { CODE_CHECK_LIMITS } from "./checker-contract";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

let checker: Awaited<ReturnType<typeof acceptanceChecker>>;
beforeAll(async () => {
  checker = await acceptanceChecker();
});
afterAll(async () => {
  await checker?.close();
});

for (const mode of ["personal", "resource"] as const) {
  test(`${mode} Code checks typed database calls and records evidence`, async () => {
    const sdk = generateCodeSdk(
      [sdkFixture()],
      mode === "personal"
        ? { mode }
        : {
            mode,
            owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } },
          },
    );
    const result = await checkCode(
      {
        sdk,
        limits: { ...CODE_CHECK_LIMITS, checkMs: 60000 },
        aiOperations: [],
        entry: "code.ts",
        files: {
          "code.ts": `
      import { app, db } from "@sdk";
      app.schedule({ cron: "0 8 * * *" }, async () => {
        await db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
        const injection = "x'); DROP TABLE notes; --";
        await db.batch([{ sql: "INSERT INTO notes(body) VALUES (?)", params: [injection] }]);
        const rows = await db.query<{ body: string }>("SELECT body FROM notes WHERE body = ?", [injection]);
        if (rows[0]?.body !== "bound") throw new Error("Unexpected row");
      });
      export default app;
    `,
        },
      },
      checker,
    );
    expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toHaveProperty("database", true);
    expect(result.manifest.permissions).toEqual([]);
    let full = false;
    const calls: Array<{ operation: string; input: unknown }> = [];
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.bundle).toString("base64")}`);
    const entry = result.manifest.entrypoints[0]!;
    const bridge = {
      call: async (operation: string, input: unknown) => {
        calls.push({ operation, input });
        if (full) throw Object.assign(new Error("private upstream detail"), { code: "code_db_full", status: 413 });
        return operation === "db.query" ? [{ body: "bound" }] : operation === "db.batch" ? [{ changes: 1 }] : { changes: 0 };
      },
    };
    await module[entry.entrypoint]({}, bridge);
    expect(calls).toEqual([
      { operation: "db.exec", input: { sql: "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)", params: [] } },
      {
        operation: "db.batch",
        input: { statements: [{ sql: "INSERT INTO notes(body) VALUES (?)", params: ["x'); DROP TABLE notes; --"] }] },
      },
      { operation: "db.query", input: { sql: "SELECT body FROM notes WHERE body = ?", params: ["x'); DROP TABLE notes; --"] } },
    ]);
    full = true;
    const fullModule = await import(
      `data:text/javascript;base64,${Buffer.from(result.bundle + "\n// fresh quota attempt").toString("base64")}`
    );
    await expect(fullModule[entry.entrypoint]({}, bridge)).rejects.toMatchObject({
      name: "CodeError",
      code: "code_db_full",
      status: 413,
      message: "This Code has reached its database storage limit. Remove data or ask an administrator to raise the limit.",
    });
  }, 90000);
}

test("code_run explains why a temporary run cannot import db", async () => {
  const sdk = generateCodeSdk([], { mode: "code_run" });
  const result = await checkCode(
    {
      sdk,
      limits: { ...CODE_CHECK_LIMITS, checkMs: 60000 },
      aiOperations: [],
      entry: "code.ts",
      files: {
        "code.ts": 'import { db as storage } from "@sdk"; export default async () => storage.query("SELECT 1");',
      },
    },
    checker,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostics.some((d) => d.code === "code_db_temporary" && d.message.includes("Code"))).toBe(true);
}, 90000);

test("database evidence follows aliased typed calls", async () => {
  const sdk = generateCodeSdk([], { mode: "personal" });
  const result = await checkCode(
    {
      sdk,
      limits: { ...CODE_CHECK_LIMITS, checkMs: 60000 },
      aiOperations: [],
      entry: "code.ts",
      files: {
        "code.ts": `import { app, db as store } from "@sdk";
      
      app.schedule({ cron: "0 8 * * *" }, async () => { await store.query("SELECT ? AS value", ["bound"]); });
      export default app;`,
      },
    },
    checker,
  );
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
  if (result.ok) expect(result.manifest).toHaveProperty("database", true);
}, 90000);
