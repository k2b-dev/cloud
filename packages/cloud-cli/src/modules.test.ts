import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtInModules } from "./modules";

test.each(Object.entries(builtInModules))("built-in module %s loads under its own name and summary", async (name, entry) => {
  const { default: module } = await entry.load();
  expect(module.name).toBe(name);
  // `cld help` prints the registry summary without importing the module.
  expect(entry.summary, `Update the "${name}" summary in packages/cloud-cli/src/modules.ts.`).toBe(module.summary);
  expect(entry.germanSummary.trim()).not.toBe("");
});

// Only the host and the shared `@k2b/cloud/cli` helpers may load; module
// entry points such as `@k2b/cloud/cli/admin` or `@k2b/cloud-app-*/cli` may not.
const hostFile = /\/packages\/(cloud-cli\/src\/[^/]+|cloud\/src\/cli\/(?!(account|apps|capabilities)\.ts$)[^/]+)\.ts$/;

test("host commands load no built-in module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-modules-test-"));
  const index = resolve(import.meta.dir, "index.ts");
  const probe = `
    const { main } = await import(${JSON.stringify(index)});
    await main(JSON.parse(process.env.CLD_PROBE_ARGS));
    const loaded = Object.keys(require.cache).filter((path) => !path.includes("/node_modules/"));
    process.stderr.write("CLD_PROBE" + JSON.stringify(loaded));
  `;
  try {
    for (const args of [["--version"], ["help"], ["profile", "list"], ["plugins", "list"], ["auth", "status"], ["update", "--help"]]) {
      const child = Bun.spawn([process.execPath, "-e", probe], {
        env: {
          ...process.env,
          HOME: directory,
          XDG_CONFIG_HOME: directory,
          CLD_CONFIG: join(directory, "config.json"),
          CLD_PROBE_ARGS: JSON.stringify(args),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
      const loaded: string[] = JSON.parse(stderr.slice(stderr.indexOf("CLD_PROBE") + "CLD_PROBE".length));
      expect(loaded.length).toBeGreaterThan(0);
      expect(
        // The repo test runner preloads its own fixtures (scripts/fixtures) into every process; they are not CLI code.
        loaded.filter((path) => !hostFile.test(path) && !path.includes("/scripts/fixtures/")),
        args.join(" "),
      ).toEqual([]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
