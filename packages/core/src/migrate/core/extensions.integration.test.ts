// biome-ignore assist/source/organizeImports: Resolve test targets before runtime imports.
import { requireDatabaseUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "./extensions";

suiteFor("database")("Core-owned pgcrypto", () => {
  test("different application migrations boot concurrently on a freshly provisioned database", async () => {
    const name = `extensions_${crypto.randomUUID().replaceAll("-", "")}_test`;
    const admin = new SQL(requireDatabaseUrl());
    const url = new URL(requireDatabaseUrl());
    url.pathname = `/${name}`;
    let db: SQL | undefined;
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`).simple();
      db = new SQL(url.href);
      const [before] = await db<
        { installed: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS installed`;
      expect(before?.installed).toBe(false);
      await migrate(db);
      const [provisioned] = await db<
        { installed: boolean }[]
      >`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS installed`;
      expect(provisioned?.installed).toBe(true);
      // Tools only needs this foreign-key target from Core. Extension ownership
      // is exercised without booting unrelated identity or background services.
      await db`CREATE SCHEMA auth`.simple();
      await db`CREATE TABLE auth.users (id uuid PRIMARY KEY)`.simple();
      for (const app of ["tools", "gateway-ops"]) {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "--no-env-file",
            "-e",
            `const {migrate}=await import(${JSON.stringify(new URL(`../../../../${app}/src/migrate.ts`, import.meta.url).pathname)}); await migrate(); process.exit(0);`,
          ],
          env: { ...process.env, DATABASE_URL: url.href },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
      }
      const results = await Promise.all(
        children.map(async (child) => {
          const output = Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
          const exit = await child.exited;
          const [, error] = await output;
          return { exit, error };
        }),
      );
      for (const result of results) expect(result).toEqual({ exit: 0, error: "" });
      const [after] = await db<{ count: number }[]>`SELECT count(*)::integer AS count FROM pg_extension WHERE extname = 'pgcrypto'`;
      expect(after?.count).toBe(1);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await db?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).simple();
      await admin.close();
    }
  }, 60_000);
});
