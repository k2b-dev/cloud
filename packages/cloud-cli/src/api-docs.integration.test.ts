import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installFirstPartyModules } from "../test/fixtures/first-party";

const tempDirs: string[] = [];
const repoRoot = resolve(import.meta.dir, "../../..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("API Docs CLI integration", () => {
  test("flushes a large raw OpenAPI document completely", async () => {
    const description = "x".repeat(100_000);
    const spec = { openapi: "3.1.0", info: { title: "Large", version: "1", description }, paths: {} };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        expect(request.headers.get("authorization")).toBe("Bearer cld_test");
        if (url.pathname === "/api/api-docs/sources") {
          return Response.json({
            items: [{ id: "large", name: "Large", description: "Large test spec.", url: "/api/large/openapi.json" }],
          });
        }
        if (url.pathname === "/api/large/openapi.json") return Response.json(spec);
        return Response.json({ message: "not found" }, { status: 404 });
      },
    });

    const directory = await mkdtemp(join(tmpdir(), "cld-api-docs-test-"));
    tempDirs.push(directory);
    await installFirstPartyModules(directory, ["api-docs"]);
    const configPath = join(directory, "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ currentProfile: "default", profiles: { default: { server: server.url.href, token: "cld_test" } } })}\n`,
      { mode: 0o600 },
    );

    try {
      const proc = Bun.spawn({
        cmd: [process.execPath, "run", "packages/cloud-cli/src/index.ts", "api-docs", "spec", "large"],
        cwd: repoRoot,
        env: { ...process.env, CLD_CONFIG: configPath, XDG_CONFIG_HOME: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect((JSON.parse(stdout) as typeof spec).info.description).toHaveLength(description.length);
    } finally {
      server.stop(true);
    }
  });
});
