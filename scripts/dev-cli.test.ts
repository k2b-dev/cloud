import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStartupFailure } from "./dev-cli";

const downScript = await Bun.file(new URL("./dev-down.ts", import.meta.url)).text();

describe("development startup diagnostics", () => {
  test("returns the latest actionable failure without a Compose prefix", () => {
    expect(findStartupFailure("app-core | booting\napp-core | error: browser build failed\napp-core | waiting")).toBe(
      "error: browser build failed",
    );
  });

  test("falls back to the latest log line", () => {
    expect(findStartupFailure("app-core | booting\napp-core | waiting")).toBe("waiting");
  });

  test("keeps separately composed infrastructure when removing the app stack", () => {
    expect(downScript).toContain("COMPOSE_FILE} --profile extra down");
    expect(downScript).not.toContain("--remove-orphans");
    expect(downScript).not.toContain("--volumes");
    expect(downScript).toContain('inputs.includes("--infra")');
  });
});

test("single-app start, restart and rebuild prepare missing key files before recreating containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-dev-startup-"));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    await mkdir(join(scripts, "fixtures"), { recursive: true });
    await mkdir(bin);
    for (const name of ["dev-cli", "dev-app-keys", "dev-clickhouse", "dev-rsql", "dev-filegate", "dev-start", "dev-restart", "dev-rebuild"])
      await copyFile(new URL(`./${name}.ts`, import.meta.url), join(scripts, `${name}.ts`));
    await copyFile(new URL("./fixtures/development-app-keys.json", import.meta.url), join(scripts, "fixtures/development-app-keys.json"));
    await symlink(new URL("../packages", import.meta.url).pathname, join(root, "packages"));
    await symlink(new URL("../node_modules", import.meta.url).pathname, join(root, "node_modules"));
    const docker = join(bin, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
case "$*" in
  *"config --services"*|*"ps --status running --services"*) echo app-mail ;;
  *" up "*) test -r .local/dev-app-keys/mail.key || exit 91; echo mounted-key-ready ;;
  *) exit 92 ;;
esac
`,
    );
    await chmod(docker, 0o755);
    for (const args of [
      ["dev-start", "mail"],
      ["dev-restart", "--running"],
      ["dev-rebuild", "mail"],
    ]) {
      await rm(join(root, ".local"), { recursive: true, force: true });
      const child = Bun.spawn([process.execPath, "--no-env-file", join(scripts, `${args[0]}.ts`), args[1]!], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("mounted-key-ready");
        expect(await readFile(join(root, ".local/dev-app-keys/mail.key"), "utf8")).toStartWith("cloud-app-key-v1.");
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
