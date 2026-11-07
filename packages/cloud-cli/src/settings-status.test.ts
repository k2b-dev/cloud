import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFirstPartyModule, installFirstPartyModules } from "../test/fixtures/first-party";

beforeAll(async () => {
  await bundleFirstPartyModule("admin");
});
test("settings status --env returns JSON and propagates attention as exit 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-settings-status-"));
  try {
    await installFirstPartyModules(directory, ["admin"]);
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({ currentProfile: "test", profiles: { test: { server: "https://installation.example", token: "test-only-token" } } }),
    );
    for (const needsAttention of [false, true]) {
      const result = {
        needsAttention,
        processes: [
          {
            appId: "core",
            status: "ok",
            settings: [
              {
                key: "gotenberg.url",
                envVariable: "GOTENBERG_URL",
                storedValuePresent: true,
                envValuePresent: true,
                conflict: needsAttention ? "differs" : "none",
                unreadableStoredValue: false,
                invalidEnvValue: false,
                needsAttention,
              },
            ],
          },
        ],
      };
      const probe = `
        globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname !== "/api/admin/core/settings/env/status") throw new Error("Unexpected request");
          if (request.headers.get("authorization") !== "Bearer test-only-token") throw new Error("Wrong profile");
          return Response.json(JSON.parse(process.env.TEST_STATUS_REPLY));
        };
        const { main } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
        process.exitCode = await main(["--profile", "test", "--json", "admin", "settings", "status", "--env"]);
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", probe], {
        env: { ...process.env, CLD_CONFIG: config, XDG_CONFIG_HOME: directory, TEST_STATUS_REPLY: JSON.stringify(result) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(needsAttention ? 1 : 0);
      expect(JSON.parse(stdout)).toEqual(result);
      expect(stderr).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
