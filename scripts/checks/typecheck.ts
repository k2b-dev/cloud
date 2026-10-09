import { readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { workspacePackages } from "../workspace";
import { capture, type Finding, type Rule } from "./rule";

type PackageJson = { name?: string; scripts?: Record<string, string> };

/**
 * Runs every workspace's own `typecheck` script. Workspaces whose typecheck
 * (or its `pre` hook) builds shared output run first and alone; the rest run
 * in parallel, bounded by the machine's memory. Output is printed as the workspace produced it.
 */
export const rule: Rule = {
  name: "typecheck",
  description: "Each workspace's typecheck script",
  run: async ({ workspaceRoot }) => {
    const workspaces = workspacePackages(workspaceRoot).flatMap((workspace) => {
      const pkg = JSON.parse(readFileSync(join(workspaceRoot, workspace, "package.json"), "utf8")) as PackageJson;
      const script = pkg.scripts?.typecheck;
      if (!script) return [];
      const builds = /\bbuild\b/.test(`${pkg.scripts?.pretypecheck ?? ""} ${script}`);
      return [{ workspace, name: pkg.name ?? workspace, builds }];
    });

    const findings: Finding[] = [];
    const check = async ({ workspace, name }: { workspace: string; name: string }) => {
      const { code, output } = await capture(["bun", "run", "--cwd", workspace, "typecheck"], { cwd: workspaceRoot });
      if (code !== 0)
        findings.push({ file: join(workspaceRoot, workspace), message: `${name} typecheck failed (exit ${code})\n${output}` });
    };

    for (const entry of workspaces.filter((entry) => entry.builds)) await check(entry);

    const queue = workspaces.filter((entry) => !entry.builds);
    // One type checker takes up to about 2 GiB; budget 8 GiB of the machine's
    // memory per parallel workspace so a full check never fills it.
    const parallel = Math.max(1, Math.min(cpus().length, queue.length, Math.floor(totalmem() / 2 ** 33)));
    const workers = Array.from({ length: parallel }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await check(next);
    });
    await Promise.all(workers);

    return findings.toSorted((a, b) => (a.file ?? "").localeCompare(b.file ?? ""));
  },
};
