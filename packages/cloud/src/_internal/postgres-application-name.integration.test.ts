import { expect, test } from "bun:test";
import { requireDatabaseUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";

// Explicit opt-in. These checks only open connections and issue SELECT queries.
const suite = suiteFor("database");

suite("defineApp Postgres connection identity", () => {
  for (const mode of ["default", "operator", "already-initialized", "services-and-ai-imports"] as const) {
    test(`${mode}: names the complete default pool without replacing existing configuration`, async () => {
      const url = new URL(requireDatabaseUrl());
      url.searchParams.delete("options");
      url.searchParams.delete("application_name");
      if (mode === "operator") url.searchParams.set("application_name", "operator-owned");
      const entry = new URL("../index.ts", import.meta.url).pathname;
      const source = `
        import { sql } from "bun";
        import { defineApp } from ${JSON.stringify(entry)};
        ${mode === "services-and-ai-imports" ? `await import(${JSON.stringify(new URL("../services/index.ts", import.meta.url).pathname)}); await import(${JSON.stringify(new URL("../ai/index.ts", import.meta.url).pathname)});` : ""}
        const readName = "SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid";
        const before = ${mode === "already-initialized"} ? (await sql.unsafe(readName))[0].name : undefined;
        defineApp({ id: "diagnostics-test", name: "Diagnostics test", icon: "ti ti-search", baseUrl: "http://localhost:3000", routes: ["/diagnostics-test"] });
        const connections = [];
        try {
          for (let index = 0; index < 3; index++) connections.push(await sql.reserve());
          const rows = await Promise.all(connections.map(async connection => (await connection.unsafe(readName))[0]));
          const transaction = await sql.begin(async tx => (await tx.unsafe(readName))[0]);
          console.log(JSON.stringify({ before, rows, transaction }));
        } finally {
          for (const connection of connections) connection.release();
          await sql.close();
        }
      `;
      const child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "-e", source],
        env: { DATABASE_URL: url.toString(), NODE_ENV: "production" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Avoid echoing connection strings or arbitrary subprocess diagnostics on failure.
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const result: { before?: string; rows: { name: string; pid: number }[]; transaction: { name: string; pid: number } } =
        JSON.parse(stdout);
      const expected = mode === "operator" ? "operator-owned" : mode === "already-initialized" ? result.before : "cloud:diagnostics-test";
      if (typeof expected !== "string") throw new Error("Missing pre-initialized connection name");
      expect(result.rows.map((row) => row.name)).toEqual([expected, expected, expected]);
      expect(new Set(result.rows.map((row) => row.pid)).size).toBe(3);
      expect(result.transaction.name).toBe(expected);
    }, 20_000);
  }
});
