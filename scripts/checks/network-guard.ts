import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** The one module that resolves host names for outbound requests and checks every answer. */
const owner = "packages/cloud/src/services/network-security.ts";

// Address lookups that bypass the platform guard: `lookup`, `resolve`, `resolve4`, `resolve6`, or `resolveAny`
// imported from node:dns, or any call through a dns namespace.
const directLookup =
  /\bimport\s*\{[^}]*\b(?:lookup|resolve|resolve4|resolve6|resolveAny)\b[^}]*\}\s*from\s*["'](?:node:)?dns(?:\/promises)?["']|\bdns(?:Promises)?\.(?:lookup|resolve|resolve4|resolve6|resolveAny)\s*\(/g;

const httpImport = /from\s*["'](?:node:)?https?["']/;
const pinnedLookup = /\blookup:\s*pinnedNetworkLookup\(/g;
const directAgent = /\bagent:\s*false\b/g;

/**
 * Person-chosen outbound requests resolve through `resolvePublicNetworkAddresses`
 * and connect through `pinnedNetworkLookup`. A second resolver in an app would
 * bring back its own address classifier and a gap between check and connect.
 */
export const rule: Rule = {
  name: "network-guard",
  description: "host names for outbound requests are resolved only by the platform network guard",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const roots = packageIds(workspaceRoot).map((id) => join(workspaceRoot, "packages", id));
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const path = relative(workspaceRoot, file);
      if (path === owner || isTestFile(path)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(directLookup)) {
        findings.push({
          file,
          line: source.slice(0, match.index).split("\n").length,
          message: "resolve outbound hosts with resolvePublicNetworkAddresses from @k2b/cloud/services/network-security",
        });
      }
      // node:http and node:https may send a request through an environment proxy, which resolves the name again.
      const pinned = [...source.matchAll(pinnedLookup)];
      if (httpImport.test(source) && pinned.length > [...source.matchAll(directAgent)].length) {
        findings.push({
          file,
          line: source.slice(0, pinned[0]?.index).split("\n").length,
          message: "pass agent: false next to lookup: pinnedNetworkLookup(...) so no proxy resolves the host again",
        });
      }
    }
    return findings;
  },
};
