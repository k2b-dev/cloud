import { expect, onTestFinished, test } from "bun:test";
import { resolve } from "node:path";

test("Mail declarations and data modules load before platform startup", async () => {
  const root = resolve(import.meta.dir, "../../../..");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      'await import("./packages/mail/src/config"); await import("./packages/mail/src/service/index.ts"); await import("./packages/mail/src/migrate.ts");',
    ],
    { cwd: root, env: { ...process.env, BUN_OPTIONS: "--no-env-file" }, stdout: "pipe", stderr: "pipe" },
  );
  onTestFinished(() => {
    if (child.exitCode === null) child.kill();
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
