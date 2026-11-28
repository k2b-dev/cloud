import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "applications show no hint that says where something moved; redirect the old URL to the new place instead (IX-21, /en/docs/frontend/ssr-pages-and-routing#one-time-hints-for-moved-paths).";

/** The libraries own and document the helpers; the rule is about applications showing them. */
const LIBRARIES = new Set(["cloud", "ui", "ssr", "editor", "stdlib"]);

/** `MovedHint` from @k2b/ui, Panes' deprecated `arrangeHint`, and the seen-hint helpers from @k2b/cloud. */
const hint = /<MovedHint[\s>]|\barrangeHint\s*=|\bhintOpen\s*\(|\bmarkHintSeen\s*\(/g;

export const rule: Rule = {
  name: "no-moved-hints",
  description: "Applications open no hint that says where something moved",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const name of packageIds(workspaceRoot)) {
      if (LIBRARIES.has(name)) continue;
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.tsx?$/)) {
        if (isTestFile(file)) continue;
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(hint))
          findings.push({ file, line: source.slice(0, match.index).split("\n").length, message: `${match[0].trim()}: ${message}` });
      }
    }
    return findings;
  },
};
