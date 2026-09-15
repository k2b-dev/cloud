// Copied into the fresh consumer: every platform import resolves from its tarball.
import { strict as assert } from "node:assert";
import { getApp, startProcessSync } from "@k2b/cloud";

const sync = await startProcessSync({ application: "consumer-observer" });
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const port = reservation.port;
await reservation.stop(true);
const baseUrl = `http://127.0.0.1:${port}`;
const child = Bun.spawn([process.execPath, "--no-env-file", "dist/server.js"], {
  env: { ...process.env, PORT: String(port), CONSUMER_BASE_URL: baseUrl },
  stdout: "pipe",
  stderr: "pipe",
});
const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`App exited before readiness: ${await output}`);
    const entry = await getApp("inventory");
    if (entry) {
      assert.equal(entry.baseUrl, baseUrl);
      assert.deepEqual(entry.routes, ["/api/inventory"]);
      const response = await fetch(`${baseUrl}/api/inventory/health`).catch(() => null);
      if (response) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { app: "inventory", status: "ok" });
        ready = true;
        break;
      }
    }
    await Bun.sleep(250);
  }
  assert.ok(ready, "Packed app must register and serve its declared route");
  child.kill("SIGTERM");
  assert.equal(await child.exited, 0, `Graceful shutdown failed: ${await output}`);
  assert.equal(await getApp("inventory"), null, "Shutdown must remove registry entry before exiting");
  const response = await fetch(`${baseUrl}/api/inventory/health`).catch(() => null);
  assert.equal(response, null, "Shutdown must close the HTTP listener");
  console.log("Packed production app registered, served HTTP, exited 0 and removed its registry entry.");
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  await sync.stop();
}
