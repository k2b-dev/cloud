import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "blur only through `k2b-overlay-surface` on a layer over a picture, video, or map, or behind a dialog (::backdrop); forms, lists, menus, and notices stay solid.";

/** A Tailwind blur utility, with or without variants, except the one that turns blur off. */
const blurUtility = /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?backdrop-blur(?!-none)(?:-[\w[\]./%-]+)?(?![\w-])/g;

export const rule: Rule = {
  name: "glass-surfaces",
  description: "Glass (backdrop blur) appears only on k2b-overlay-surface and dialog backdrops",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const name of packageIds(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(file)) continue;
        const original = readFileSync(file, "utf8");
        const css = file.endsWith(".css");
        const source = css ? original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")) : original;
        const report = (index: number, detail: string) => {
          findings.push({ file, line: source.slice(0, index).split("\n").length, message: `${detail}: ${message}` });
        };
        if (!css) {
          for (const match of source.matchAll(blurUtility)) report(match.index, match[0]);
          for (const match of source.matchAll(/backdrop-?filter/gi)) report(match.index, match[0]);
          continue;
        }
        for (const block of source.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
          const [, prelude = "", body = ""] = block;
          const selector = prelude.trim().replace(/\s+/g, " ");
          if (/k2b-overlay-surface|::backdrop/.test(selector)) continue;
          const bodyIndex = block.index + block[0].indexOf("{") + 1;
          for (const declaration of body.matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;]*)/gi)) {
            const value = (declaration[1] ?? "").replace(/\s*!important\s*$/i, "").trim();
            if (/^none$/i.test(value)) continue;
            report(bodyIndex + declaration.index, `${selector} sets backdrop-filter: ${value}`);
          }
          for (const match of body.matchAll(blurUtility)) report(bodyIndex + match.index, `${selector} applies ${match[0]}`);
        }
      }
    }
    return findings;
  },
};
