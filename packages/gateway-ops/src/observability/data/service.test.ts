import { expect, test } from "bun:test";

test("unavailable PostgreSQL sessions and indexes reject instead of reporting empty lists", async () => {
  // Closing the platform's shared pool is process-wide; isolate it from other tests.
  const clientsUrl = new URL("../../../../cloud/src/runtime/clients.ts", import.meta.url).href;
  const startUrl = new URL("../../../../cloud/src/start.ts", import.meta.url).href;
  const serviceUrl = new URL("./service.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      import { sql } from ${JSON.stringify(clientsUrl)};
      import { initializePlatform } from ${JSON.stringify(startUrl)};
      import { listPostgresSessions, listPostgresIndexes, getPostgresDiagnostics } from ${JSON.stringify(serviceUrl)};
      await initializePlatform({ appId: "gateway-ops", source: "env" });
      await sql.close();
      const results = await Promise.allSettled([listPostgresSessions(), listPostgresIndexes()]);
      const overview = await getPostgresDiagnostics();
      console.log(JSON.stringify({ statuses: results.map(result => result.status), available: overview.available }));
    `,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/closed_pool_test",
        REDIS_URL: "redis://127.0.0.1:1",
        CLOUD_APP_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual({ statuses: ["rejected", "rejected"], available: false });
});
