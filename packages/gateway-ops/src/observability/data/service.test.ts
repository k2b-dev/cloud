import { expect, test } from "bun:test";

test("unavailable PostgreSQL sessions and indexes reject instead of reporting empty lists", async () => {
  // Closing Bun's shared pool is process-wide; isolate it from other tests.
  const serviceUrl = new URL("./service.ts", import.meta.url).href;
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      import { sql } from "bun";
      import { listPostgresSessions, listPostgresIndexes, getPostgresDiagnostics } from ${JSON.stringify(serviceUrl)};
      await sql.close();
      const results = await Promise.allSettled([listPostgresSessions(), listPostgresIndexes()]);
      const overview = await getPostgresDiagnostics();
      console.log(JSON.stringify({ statuses: results.map(result => result.status), available: overview.available }));
    `,
  ], { stdout: "pipe", stderr: "pipe" });
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual({ statuses: ["rejected", "rejected"], available: false });
});
