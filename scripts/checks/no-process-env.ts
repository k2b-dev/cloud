import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** Repository-relative paths that may read the process environment directly. */
const allowed: RegExp[] = [
  /^packages\/cloud\/src\/config\/env\.ts$/,
  /^packages\/cloud\/src\/config\/define-env\.ts$/,
  /^packages\/[^/]+\/src\/env\.ts$/,
  /^packages\/cloud-cli\/src\/config\.ts$/,
  /^packages\/[^/]+\/scripts\//,
  /^packages\/[^/]+\/test\//,
  /^packages\/[^/]+\/bench\//,
  /^packages\/ui\//,
  // Operator verification tools that run against a live installation, not application runtime.
  /^packages\/oauth\/src\/verification\//,
  /^packages\/pulse\/src\/service\/high-cardinality-load\.ts$/,
  // Test-only worker process; the parent test passes its targets explicitly.
  /^packages\/grids\/src\/service\/document-workflow-crash\.worker\.ts$/,
  /^packages\/grids\/src\/service\/document-zip-crash\.worker\.ts$/,
  // Browser-safe module with zero imports; must not pull the registry's schema dependency.
  /^packages\/cloud\/src\/desktop\/index\.ts$/,
  // Whole-environment passthrough to child processes and OS conventions (PATH, EDITOR, VISUAL).
  /^packages\/assistant\/src\/cli\/local-bash\.ts$/,
  /^packages\/assistant\/src\/cli\/text-editor\.ts$/,
  /^packages\/cloud\/src\/_internal\/postgres-application-name\.ts$/,
  /^packages\/cloud\/src\/ai\/pdf-render\.ts$/,
  // Evaluation harness invoked by scripts, not application runtime.
  /\.eval\.ts$/,
  /^scripts\//,
  /^docs-site\//,
  /^pwas\//,
];

const envRead = /\b(?:process|Bun)\.env\b/;

/**
 * Configuration enters through the typed env definitions; everything else
 * receives values through those modules. Tests and tooling stay free to read
 * the environment directly.
 */
export const rule: Rule = {
  name: "no-process-env",
  description: "process.env and Bun.env are read only in env definition modules, tooling, and tests",
  run: async ({ workspaceRoot }) => {
    const roots = [...packageIds(workspaceRoot).map((id) => join(workspaceRoot, "packages", id)), join(workspaceRoot, "tests")];
    const findings: Finding[] = [];

    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const path = relative(workspaceRoot, file);
      if (isTestFile(path) || allowed.some((pattern) => pattern.test(path))) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (envRead.test(line))
            findings.push({ file, line: index + 1, message: "read configuration through the application's env module" });
        });
    }

    return findings;
  },
};
