import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliHostBundle } from "../../assistant/src/artifacts/runtime/cli-bundle";
import { compileArtifact } from "../../assistant/src/artifacts/runtime/compile";
import { buildEchoPlugin } from "../test/fixtures/build-plugin";

test("standalone CLI starts and runs offline without Cloud server configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-standalone-test-"));
  const root = resolve(import.meta.dir, "../../..");
  const target = `${process.platform}_${process.arch}`;
  try {
    const build = Bun.spawn([process.execPath, "run", "packages/cloud-cli/scripts/build.ts"], {
      cwd: root,
      env: { ...process.env, CLD_TARGETS: target, CLD_OUTPUT_DIR: join(directory, "build"), CLD_VERSION: "1.2.3-test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildExit, buildOut, buildErr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(buildExit, `${buildOut}\n${buildErr}`).toBe(0);

    const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
      const child = Bun.spawn([join(directory, "build", `cld_${target}`), ...args], {
        cwd: directory,
        env: { HOME: directory, CLD_CONFIG: join(directory, "config.json"), ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const version = await run(["--version"]);
    expect(version.exitCode, version.stderr).toBe(0);
    expect(version.stdout).toContain("1.2.3-test");
    expect(version.stderr).toBe("");

    for (const args of [["help"], ["assistant", "help"], ["grids", "apps", "runtime", "help"]]) {
      const help = await run(args);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toContain("Usage:");
      expect(help.stderr).toBe("");
    }

    const reference = await run([
      "--server",
      "https://cloud.invalid",
      "--token",
      "test-token",
      "--json",
      "grids",
      "workflows",
      "reference",
    ]);
    expect(reference.exitCode, reference.stderr).toBe(0);
    expect(reference.stderr).toBe("");
    expect(JSON.parse(reference.stdout).language.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "createRecord" }), expect.objectContaining({ kind: "sendEmail" })]),
    );

    // A third-party module bundled with its own @k2b/cloud/cli copy loads
    // into the compiled binary from disk and gets the host's context.
    const plugin = await buildEchoPlugin(join(directory, "echo-plugin"));
    const installed = await run(["plugins", "install", plugin, "--yes"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    const echoServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        Response.json({ authorization: request.headers.get("authorization"), locale: request.headers.get("accept-language") }),
    });
    try {
      const echoed = await run(["--server", echoServer.url.origin, "--token", "plugin-token", "--json", "echo", "whoami"]);
      expect(echoed.exitCode, echoed.stderr).toBe(0);
      expect(echoed.stderr).toBe("");
      expect(JSON.parse(echoed.stdout)).toEqual({ authorization: "Bearer plugin-token", locale: "en", profile: "default", output: "json" });
    } finally {
      await echoServer.stop(true);
    }
    const listed = await run(["plugins", "list", "--json"]);
    expect(JSON.parse(listed.stdout).plugins).toEqual([
      { id: "echo", package: "@k2b-test/cld-plugin-echo", version: "1.0.0", source: plugin, status: "ok" },
    ]);

    // Exercise the compiled parent AND its internal browser subprocess, from
    // outside the checkout. No installation or user Cloud data is contacted.
    const chromium = process.env.CLOUD_CLI_CHROMIUM ?? Bun.which("google-chrome") ?? Bun.which("chromium");
    const bundle = await cliHostBundle();
    const code = "export default () => 42";
    const compiled = await compileArtifact({ entry: "main.ts", files: [{ path: "main.ts", content: code }] });
    const conversationId = crypto.randomUUID();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === `/api/ai/conversations/${conversationId}`) return Response.json({ conversation: { id: conversationId } });
        if (path.endsWith("/runtime/host.js")) return new Response(bundle);
        if (path.endsWith("/compile")) return Response.json(compiled);
        return new Response("Unexpected test request", { status: 404 });
      },
    });
    try {
      const input = join(directory, "run.json");
      await Bun.write(input, JSON.stringify({ code }));
      const executed = await run(
        [
          "--server",
          server.url.origin,
          "--token",
          "test-token",
          "--json",
          "assistant",
          "code",
          "run",
          "--chat",
          conversationId,
          "--input-file",
          input,
        ],
        {
          HOME: homedir(),
          ...(chromium ? { CLOUD_CLI_CHROMIUM: chromium } : {}),
        },
      );
      expect(executed.exitCode, executed.stderr).toBe(0);
      expect(executed.stderr).toBe("");
      expect(JSON.parse(executed.stdout)).toMatchObject({ status: "ready", output: "42" });
    } finally {
      await server.stop(true);
    }

    const offline = await run(["--json", "grids", "evidence", "verify", join(directory, "missing.tar")]);
    expect(offline.exitCode).toBe(1);
    expect(offline.stdout).toBe("");
    expect(JSON.parse(offline.stderr).error.message).toContain("missing.tar");
    expect(offline.stderr).not.toContain("No server configured");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
