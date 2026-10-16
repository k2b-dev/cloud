import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** The one module that resolves host names for outbound requests and checks every answer. */
const owner = "packages/cloud/src/services/network-security.ts";

// Any route to the system resolver: static, dynamic, or required imports of node:dns, and Bun's dns.
// Named imports of record lookups that return no addresses to connect to (SRV, MX, TXT) stay allowed.
const dnsAccess =
  /\bimport\s+([^;]*?)\s*from\s*["'](?:node:)?dns(?:\/promises)?["']|\b(?:require|import)\s*\(\s*["'](?:node:)?dns(?:\/promises)?["']\s*\)|\bBun\.dns\b|\bimport\s*\{[^}]*\bdns\b[^}]*\}\s*from\s*["']bun["']/g;
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
const pinnedCall = /\bpinnedNetworkLookup\(/g;
const pinnedAlias = /\bpinnedNetworkLookup\s+as\b/g;
const directAgent = /\bagent:\s*false\b/;
const guardImport = /from\s*["']@k2b\/cloud\/services\/network-security["']|from\s*["'][./]+network-security["']/;
const personChosenServerRoots = ["packages/pulse/src/", "packages/notebooks/src/"];
const isPersonChosenServer = (path: string) =>
  personChosenServerRoots.some((root) => path.startsWith(root)) &&
  !path.includes("/frontend/") &&
  !path.endsWith(".tsx") &&
  !path.includes("/cli/");
const globalFetch = /(?<![.\w])fetch\s*\(/g;
const personChosenFetch = /(?<![.\w])(?:(?:Bun|globalThis|self)\.)?fetch\s*\(/g;
// Options of one request object stay within a few lines of each other.
const SAME_REQUEST_LINES = 6;

const lineOf = (source: string, index = 0) => source.slice(0, index).split("\n").length;

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
          line: lineOf(source, match.index),
          message: "resolve outbound hosts with resolvePublicNetworkAddresses from @k2b/cloud/services/network-security",
        });
      }
      for (const match of source.matchAll(pinnedAlias)) {
        findings.push({ file, line: lineOf(source, match.index), message: "import pinnedNetworkLookup under its own name" });
      }
      // node:http and node:https may send a request through an environment proxy, which resolves the name again.
      const httpMatch = source.match(httpImport);
      if (httpMatch) {
        if (isPersonChosenServer(path) && !source.match(pinnedCall)) {
          findings.push({
            file,
            line: lineOf(source, httpMatch.index),
            message: "Server code that sends node:http requests must connect through pinnedNetworkLookup with agent: false",
          });
        }
        const lines = source.split("\n");
        for (const match of source.matchAll(pinnedCall)) {
          const line = lineOf(source, match.index);
          const near = lines.slice(Math.max(0, line - 1 - SAME_REQUEST_LINES), line + SAME_REQUEST_LINES).join("\n");
          if (directAgent.test(near)) continue;
          findings.push({
            file,
            line,
            message: "pass agent: false in the same request as pinnedNetworkLookup(...) so no proxy resolves the host again",
          });
        }
      }
      // SDK clients resolve independently. In these roots allow S3 only for local
      // presigning beside a pinned transport, with no SDK I/O methods in the file.
      if (isPersonChosenServer(path)) {
        const s3 = /\bBun\.s3\b|\bBun\.S3Client\b|\bnew\s+S3Client\b|\bimport\s*\{[^}]*\b(?:s3|S3Client)\b[^}]*\}\s*from\s*["']bun["']/g;
        const sdkIO = /\.(?:write|file|delete|exists|list|stat|size|unlink)\s*\(/;
        for (const match of source.matchAll(s3)) {
          if (!/\bBun\.s3\b|\bs3\b/.test(match[0]) && source.match(pinnedCall) && /\.presign\s*\(/.test(source) && !sdkIO.test(source))
            continue;
          findings.push({
            file,
            line: lineOf(source, match.index),
            message: "S3 clients may only presign beside a pinned transport; SDK network I/O bypasses the guard",
          });
        }
      }
      // fetch() resolves the name again after the check, so a checked host must not reach it.
      if (guardImport.test(source) || isPersonChosenServer(path)) {
        for (const match of source.matchAll(isPersonChosenServer(path) ? personChosenFetch : globalFetch)) {
          findings.push({
            file,
            line: lineOf(source, match.index),
            message: isPersonChosenServer(path)
              ? "Server code requests person-chosen URLs; use a guarded transport (resolveAllowedNetworkAddresses + pinnedNetworkLookup), never fetch()"
              : "connect to checked addresses with requestPublicHttps or pinnedNetworkLookup; fetch() resolves the host again",
          });
        }
      }
    }
    return findings;
  },
};
