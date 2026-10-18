import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";

if (process.env.MAIL_REMOTE_CHANGES_TEARDOWN_CHILD === "1") {
  await import("./remote-changes-teardown.child-suite");
} else {
  suiteFor(
    "database",
    "nats",
    "valkey",
  )("remote changes teardown guard", () => {
    test("a timed-out sync ends before the next test starts", async () => {
      // #1460: a timed-out sync must finish teardown before later tests own the connector and rows.
      const root = resolve(import.meta.dir, "../../../..");
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--timeout",
          "30000",
          "--preload",
          resolve(root, "scripts/fixtures/test-infra.ts"),
          "--preload",
          resolve(root, "packages/mail/test/integration-preload.ts"),
          import.meta.path,
        ],
        {
          cwd: root,
          env: { ...process.env, MAIL_REMOTE_CHANGES_TEARDOWN_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}\n${stderr}`;
      // A piped bun:test run names failures and counts passes in its summary.
      const failed = Array.from(output.matchAll(/^\(fail\) (.*?) \[[^\]\r\n]*\]\r?$/gm), (match) => match[1]);
      const passed = Number(/^ (\d+) pass\r?$/m.exec(output)?.[1] ?? 0);
      expect({ code, failed, passed }, output).toEqual({
        code: 1,
        failed: ["remote changes teardown > a sync that outlives its test"],
        passed: 1,
      });
      // Bun reports a timed-out body's late rejection as an error between tests. It belongs to the hung
      // test when Bun prints it before that test's result, during its teardown, and comes from the held call.
      const late = Array.from(stderr.matchAll(/^# Unhandled error between tests\r?$/gm), (match) => match.index);
      const hungResult = stderr.indexOf("(fail) remote changes teardown > a sync that outlives its test");
      expect({ late: late.length, beforeHungResult: late.every((index) => index < hungResult) }, output).toEqual({
        late: 1,
        beforeHungResult: true,
      });
      expect(stderr.slice(late[0], hungResult), output).toMatch(/code: "ENDED_TEST_PROVIDER"/);
    }, 120_000);
  });
}
