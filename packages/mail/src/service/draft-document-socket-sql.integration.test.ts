import { expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { DRAFT_DOCUMENT_ACCESS_REFRESH_MS } from "./draft-document-socket-sql";

suiteFor("database")("Mail draft transaction cancellation under pool saturation", () => {
  test("saturated pool cancellation and an already-aborted lazy query both return their reservations", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./scripts/fixtures/test-infra.ts",
        "./packages/mail/test/fixtures/draft-cancel-pool.ts",
      ],
      {
        cwd: new URL("../../../../", import.meta.url).pathname,
        env: { ...process.env, CLOUD_DATABASE_POOL_MAX: "2" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    // Two access-check periods cover connection establishment and cancellation.
    // Kill only this owned child if the old circular pool wait returns.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 2 * DRAFT_DOCUMENT_ACCESS_REFRESH_MS);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(timedOut).toBe(false);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("cancelled=2 sql-pool-recovered lazy-query-not-started");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
});
