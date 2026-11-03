import { expect, test } from "bun:test";

test("idle workers stay within their outbox and workflow safety budgets under a frozen clock", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/idle-workers.test-fixture.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("outbox 12 claims");
  expect(stdout).toContain("workflow 2 recoveries / 8 slot claims");
});
