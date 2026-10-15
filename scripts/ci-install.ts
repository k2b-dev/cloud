/**
 * Install CI dependencies with a bound on registry/network hangs.
 *
 * Usage: bun scripts/ci-install.ts [bun ci arguments]
 *
 * Each attempt gets two minutes. Only a stalled install is retried, once,
 * after removing root and workspace node_modules. The Bun cache stays intact.
 *
 * This is not a test retry: it repeats only the download of the exact,
 * integrity-checked packages pinned in bun.lock before any repository code
 * runs. It cannot hide a failing test or a code defect. A deterministic
 * install failure is not retried.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Warm-cache installs take ~2–5 s; healthy cold registry installs took at most
// ~22 s across 480 recent CI installs. Two minutes is a stall, not a slow install.
export const INSTALL_LIMIT_MS = 2 * 60 * 1000;

const cleanNodeModules = async () => {
  const manifest: { workspaces: { packages: string[] } } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  await Promise.all(
    [".", ...manifest.workspaces.packages].map((path) => rm(join(root, path, "node_modules"), { recursive: true, force: true })),
  );
};

export const install = async ({
  command = ["bun", "ci", ...Bun.argv.slice(2)],
  limitMs = INSTALL_LIMIT_MS,
  killAfterMs = 10_000,
  clean = cleanNodeModules,
  log = console.log,
}: {
  command?: string[];
  limitMs?: number;
  killAfterMs?: number;
  clean?: () => Promise<void>;
  log?: (message: string) => void;
} = {}): Promise<number> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = performance.now();
    const child = Bun.spawn(command, { cwd: root, env: process.env, stdio: ["inherit", "inherit", "inherit"] });
    let stalled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const limitTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stalled = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, killAfterMs);
    }, limitMs);

    let code: number;
    try {
      code = await child.exited;
    } finally {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
    }
    log(`bun ci attempt ${attempt} finished after ${((performance.now() - started) / 1000).toFixed(1)} seconds`);
    if (!stalled) {
      if (code !== 0) log(`::error title=bun ci failed::bun ci exited with ${code}`);
      return code;
    }
    if (attempt === 2) {
      log("::error title=bun ci stalled::The second attempt did not finish within 2 minutes: registry/network hang. No retries remain.");
      return 1;
    }
    log("::warning title=bun ci stalled::The attempt did not finish within 2 minutes: registry/network hang. The install is retried once.");
    await clean();
  }
  return 1;
};

if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    const header = readFileSync(import.meta.path, "utf8").split("*/")[0] ?? "";
    console.log(
      header
        .replace(/^\/\*\*\n/, "")
        .replace(/^ \* ?/gm, "")
        .trim(),
    );
  } else {
    process.exit(await install());
  }
}
