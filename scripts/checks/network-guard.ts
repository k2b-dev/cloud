import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** The one module that resolves host names for outbound requests and checks every answer. */
const owner = "packages/cloud/src/services/network-security.ts";

// Any route to the system resolver: static, dynamic, or required imports of node:dns, and Bun.dns.
// Named imports of record lookups that return no addresses to connect to (SRV, MX, TXT) stay allowed.
const dnsAccess =
  /\bimport\s+([^;]*?)\s*from\s*["'](?:node:)?dns(?:\/promises)?["']|\b(?:require|import)\s*\(\s*["'](?:node:)?dns(?:\/promises)?["']\s*\)|\bBun\.dns\b/g;
const recordLookups = new Set(["resolveSrv", "resolveMx", "resolveTxt"]);

const allowedDnsImport = (clause: string | undefined): boolean => {
  const named = clause?.trim().match(/^(?:type\s+)?\{([^}]*)\}$/);
  if (!named) return false;
  if (clause?.trim().startsWith("type")) return true;
  return (named[1] ?? "")
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .every((specifier) => specifier.startsWith("type ") || recordLookups.has(specifier.split(/\s+as\s+/)[0] ?? ""));
};

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
      for (const match of source.matchAll(dnsAccess)) {
        if (allowedDnsImport(match[1])) continue;
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
