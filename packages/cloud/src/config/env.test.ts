import { expect, test } from "bun:test";

test("Sync replicas default to three and accept only explicit supported counts", async () => {
  const path = new URL("./env.ts", import.meta.url).pathname;
  for (const value of [undefined, "1", "3", "5", "0", "2", "abc", ""]) {
    const vars = { ...process.env };
    delete vars.SYNC_REPLICAS;
    if (value !== undefined) vars.SYNC_REPLICAS = value;
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", `import {env} from ${JSON.stringify(path)}; console.log(env.SYNC_REPLICAS)`],
      { env: vars, stdout: "pipe", stderr: "pipe" },
    );
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (value === undefined || ["1", "3", "5"].includes(value)) {
      expect(status).toBe(0);
      expect(output.trim()).toBe(value ?? "3");
    } else {
      expect(status).not.toBe(0);
      expect(error).toContain("SYNC_REPLICAS");
    }
  }
});
