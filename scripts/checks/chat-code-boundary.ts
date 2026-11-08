import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** Chat runtime code may share UI helpers, but cannot regain Studio through one of them. */
export const rule: Rule = {
  name: "chat-code-boundary",
  description: "Keep Assistant chat code independent of Studio and Chromium hosts",
  run: async ({ workspaceRoot }) => {
    const assistant = resolve(workspaceRoot, "packages/assistant/src");
    const roots = listFiles(join(assistant, "chat-code"), sourceFilePattern).filter((file) => !isTestFile(file));
    const findings: Finding[] = [];
    const visited = new Set<string>();
    const visit = (file: string, chain: string[]) => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      const specifiers = /(?:\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?|\b(?:import|require)\(\s*)["']([^"']+)["']/g;
      for (const match of source.matchAll(specifiers)) {
        const specifier = match[1]!;
        const path = specifier.startsWith("@/")
          ? resolve(assistant, specifier.slice(2))
          : specifier.startsWith(".")
            ? resolve(dirname(file), specifier)
            : isAbsolute(specifier)
              ? specifier
              : resolve(workspaceRoot, specifier);
        const local = relative(assistant, path).replaceAll("\\", "/");
        if (local.startsWith("artifacts/") || /^cli\/code-host(?:[./-]|$)/.test(local)) {
          findings.push({
            file,
            line: source.slice(0, match.index).split("\n").length,
            message: `Chat code must not import Studio or Chromium (${specifier}); reached through ${chain.join(" → ")}.`,
          });
          continue;
        }
        if (
          /^import\s+type\b|^export\s+type\b/.test(match[0]) ||
          !(specifier.startsWith(".") || specifier.startsWith("@/")) ||
          local.startsWith("../")
        )
          continue;
        const target = [path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts"), join(path, "index.tsx")].find(
          (candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate),
        );
        if (target && !isTestFile(target)) visit(target, [...chain, relative(assistant, target)]);
      }
    };
    for (const root of roots) visit(root, [relative(assistant, root)]);
    return findings;
  },
};
