import { expect } from "bun:test";
import { resolve } from "node:path";
import { SQL } from "bun";
import { createDisposableDatabase, testFor } from "../../../scripts/fixtures/test-infra";

testFor("database")(
  "verification bootstrap accepts its inherited infrastructure preload",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const isolated = await createDisposableDatabase("grids_verify");
    try {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "verify.ts"), "--bootstrap"], {
        cwd: root,
        env: {
          ...process.env,
          BUN_OPTIONS: `--no-env-file --preload=${resolve(root, "scripts/fixtures/test-infra.ts")}`,
          CLOUD_TEST_DATABASE_URL: isolated.url,
          DATABASE_URL: isolated.url,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 110_000);
      try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
        expect(stderr).not.toContain("Platform has already started");
        expect(code, stderr).toBe(0);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      const db = new SQL(isolated.url);
      try {
        const [row] = await db`SELECT uid FROM auth.users WHERE uid = 'grids-verification'`;
        expect(row?.uid).toBe("grids-verification");
      } finally {
        await db.close();
      }
    } finally {
      await isolated.drop();
    }
  },
  120_000,
);
