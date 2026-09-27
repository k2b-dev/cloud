import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const natsImport =
  /(?:import\s*\{[^}]*\bconnect\b[^}]*\}\s*from|\{[^}]*\bconnect\b[^}]*\}\s*=\s*await import\()\s*["']@nats-io\/transport-node["']/;
const connectCall = /(?<![.\w])connect\(/g;
const testInfraImport = /scripts\/fixtures\/test-infra/;
const credentials = /\b(?:authenticator|user)\s*:/;

/** The argument text of the call whose opening parenthesis is at `open`. */
const callArguments = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  return source.slice(open + 1);
};

/**
 * `text` without the contents of its parenthesized groups, so credentials in a
 * conditional spread, `...(file ? { authenticator } : {})`, do not count.
 */
const outsideParentheses = (text: string): string => {
  let depth = 0;
  let outside = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0) outside += char;
  }
  return outside;
};

/** 1-based lines of the NATS `connect(` calls in `source` that do not always carry credentials of their own. */
export const unauthenticatedNatsConnections = (source: string): number[] =>
  natsImport.test(source)
    ? [...source.matchAll(connectCall)]
        .filter((call) => !credentials.test(outsideParentheses(callArguments(source, call.index + call[0].length - 1))))
        .map((call) => source.slice(0, call.index).split("\n").length)
    : [];

/**
 * Locally, tests share the development broker, where a connection without
 * credentials lands in the development account. `connectTestNats()` adds the
 * test identity from `CLOUD_TEST_NATS_CREDS_FILE` and refuses the development
 * account, so a test's streams stay in the bounded TEST account where the
 * fixture deletes them. Test code is every test file plus every helper that
 * imports the fixture. A connection to a broker the test starts itself passes
 * its own credentials unconditionally; optional credentials would fall back
 * to the development account.
 */
export const rule: Rule = {
  name: "test-nats-connections",
  description: "NATS connections in tests use connectTestNats(), so they never land in the development account",
  run: async ({ workspaceRoot }) => {
    const roots = [...workspacePackages(workspaceRoot), "tests"].map((path) => join(workspaceRoot, path));
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("@nats-io/transport-node") || !(isTestFile(file) || testInfraImport.test(source))) continue;
      for (const line of unauthenticatedNatsConnections(source)) {
        findings.push({
          file,
          line,
          message:
            "connect through connectTestNats() (scripts/fixtures/test-infra) so the test uses the TEST account; see docs-site/docs/en/contributing/testing.md",
        });
      }
    }
    return findings;
  },
};
