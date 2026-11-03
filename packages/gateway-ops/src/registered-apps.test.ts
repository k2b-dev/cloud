import { expect, test } from "bun:test";

// Keep the SQL double confined to a subprocess.
test("registered app heartbeats do not write SQL; departures and content changes do", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/registered-apps.test-fixture.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("5 and 20 apps: 0 idle SQL writes");
});
