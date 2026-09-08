import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

    const run = async (args: string[]) => {
      const child = Bun.spawn([join(directory, "build", `cld_${target}`), ...args], {
        cwd: directory,
        env: { HOME: directory, CLD_CONFIG: join(directory, "config.json") },
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

    const offline = await run(["--json", "grids", "evidence", "verify", join(directory, "missing.tar")]);
    expect(offline.exitCode).toBe(1);
    expect(offline.stdout).toBe("");
    expect(JSON.parse(offline.stderr).error.message).toContain("missing.tar");
    expect(offline.stderr).not.toContain("No server configured");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
