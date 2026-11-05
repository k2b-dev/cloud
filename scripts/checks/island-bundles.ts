import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildIslands } from "../../packages/ssr/src/build";
import { islandIdFromFile } from "../../packages/ssr/src/island-id";
import type { Finding, Rule } from "./rule";

// Production static closures include Solid, the mount runtime and Cloud's error fallback.
// Measured 2026-11-04: 88,446 / 103,432 / 213,247 B; budgets round up with approximately 10% headroom.
// Dynamic imports are excluded, exactly as in the production SSR asset manifest.
const budgets = [
  { file: "packages/cloud/src/ssr/PwaPartCount.island.tsx", kib: 96 },
  { file: "packages/pwa/src/frontend/_components/PairingNotice.island.tsx", kib: 112 },
  { file: "packages/pwa/src/frontend/_components/StartParts.island.tsx", kib: 230 },
  // The Assistant part renders a chat on its first frame, so the shared chat timeline is part of its closure.
  // Measured 2026-11-05: 2,153,535 B.
  { file: "packages/assistant/src/pwa/AssistantPwa.island.tsx", kib: 2320 },
  // The web Assistant renders chat Markdown; KaTeX loads only for math, so it stays out of the static closure.
  // Measured 2026-11-05: 3,267,899 B with KaTeX, 2,992,646 B without.
  { file: "packages/assistant/src/frontend/AssistantWorkspace.island.tsx", kib: 2990 },
];
const manifestSchema = z.object({ entries: z.record(z.string(), z.array(z.string())) });

export const rule: Rule = {
  name: "island-bundles",
  description: "PWA islands and the web Assistant stay within measured production JavaScript budgets",
  async run({ workspaceRoot }) {
    const output = await mkdtemp(join(tmpdir(), "cloud-island-budgets-"));
    try {
      const cwd = workspaceRoot;
      await buildIslands({
        cwd,
        componentRoots: [
          join(workspaceRoot, "packages/pwa/src"),
          join(workspaceRoot, "packages/cloud/src"),
          join(workspaceRoot, "packages/assistant/src/pwa"),
          join(workspaceRoot, "packages/assistant/src/frontend"),
        ],
        pattern: "**/*.{island,client}.tsx",
        outdir: output,
        verbose: false,
        dev: false,
        errorFallback: join(workspaceRoot, "packages/cloud/src/ssr/IslandError.tsx"),
      });
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")));
      const findings: Finding[] = [];
      for (const { file, kib } of budgets) {
        const modules = manifest.entries[islandIdFromFile(join(workspaceRoot, file), cwd)];
        if (!modules?.length) throw new Error(`Missing production bundle for ${file}`);
        let bytes = 0;
        for (const module of new Set(modules)) bytes += (await stat(join(output, module))).size;
        console.info(`${file}: ${bytes} B / ${kib * 1024} B`);
        if (bytes > kib * 1024)
          findings.push({
            file: join(workspaceRoot, file),
            message: `Static island closure is ${bytes} B; budget is ${kib * 1024} B. Import the smallest public component or contract entry.`,
          });
      }
      return findings;
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
};
