import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const syncCall = /\bcreateSync\(/g;
const testInfraImport = /scripts\/fixtures\/test-infra/;
const managed = /\btestSyncNamespace\(/;
const identifier = /^[A-Za-z_$][\w$]*$/;

/** The argument text of the call whose opening parenthesis is at `open`. */
const callArguments = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  return source.slice(open + 1);
};

/** The expression passed as `namespace`, following one `name = …` assignment in the same file. */
const namespaceSource = (source: string, args: string): string | undefined => {
  const expression =
    /\bnamespace\s*:\s*([^,}\n]+)/.exec(args)?.[1]?.trim() ?? (/[{,]\s*namespace\s*[,}]/.test(args) ? "namespace" : undefined);
  if (!expression || !identifier.test(expression)) return expression;
  return new RegExp(`\\b${expression.replaceAll("$", "\\$")}\\s*=(?!=)\\s*([^\\n]+)`).exec(source)?.[1] ?? expression;
};

/** 1-based lines of the `createSync(` calls in `source` whose namespace is not taken from `testSyncNamespace()`. */
export const unmanagedSyncNamespaces = (source: string): number[] =>
  [...source.matchAll(syncCall)]
    .filter((call) => !managed.test(namespaceSource(source, callArguments(source, call.index + call[0].length - 1)) ?? ""))
    .map((call) => source.slice(0, call.index).split("\n").length);

/**
 * JetStream reserves every stream's full size, and tests share one account,
 * locally the TEST account of the development broker, so a Sync namespace a
 * test leaves behind blocks 1.5 to 2 GiB of its limit. The fixture deletes
 * only namespaces derived from its process namespace, and `bun run test`
 * sweeps only `test-` namespaces, so a test Sync must take its
 * namespace from `testSyncNamespace()`. Test code is every test file plus every
 * helper that imports the fixture. A Sync that must outlive the fixture's
 * cleanup, like a preload's, receives its own `test-` namespace through a
 * helper parameter or `SYNC_NAMESPACE`.
 */
export const rule: Rule = {
  name: "test-sync-namespaces",
  description: "Sync instances in tests take their namespace from testSyncNamespace(), so the fixture deletes their streams",
  run: async ({ workspaceRoot }) => {
    const roots = [...workspacePackages(workspaceRoot), "tests"].map((path) => join(workspaceRoot, path));
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("createSync(") || !(isTestFile(file) || testInfraImport.test(source))) continue;
      for (const line of unmanagedSyncNamespaces(source)) {
        findings.push({
          file,
          line,
          message:
            'take the namespace from testSyncNamespace("<label>") (scripts/fixtures/test-infra) so the fixture deletes its streams; see docs-site/docs/en/contributing/testing.md',
        });
      }
    }
    return findings;
  },
};
