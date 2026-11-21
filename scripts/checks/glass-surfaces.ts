import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles } from "./files";
import type { Rule } from "./rule";

/**
 * Cloud flach (K16): there is no blur. A dialog or sheet dims the page with `--k2b-scrim` and no blur; glass over a
 * picture, video, or map becomes a solid surface. The privacy screen's veil is the one exception: it hides what lies
 * below. Known blurs live in `glass-surfaces.baseline`; migrations remove lines, the rule never adds one.
 */
const RULE = "glass-surfaces";
const HEADER = [
  "Known blurs (K16), one per occurrence: <file> | <selector or utility>.",
  "Lanes remove lines as they replace glass with a solid surface or the scrim; the rule never adds lines.",
  "`bun scripts/check.ts glass-surfaces --fix` removes lines whose finding is gone.",
];
const message =
  "no blur (K16): dim behind a dialog or sheet with `--k2b-scrim`, keep surfaces solid; only the privacy screen's veil blurs; see /en/ui/surfaces/flat-criteria";

/** A Tailwind blur utility, with or without variants, except the one that turns blur off. */
const blurUtility = /(?<![\w-])(?:[\w-]+(?:\/[\w-]+)?:)*!?backdrop-blur(?!-none)(?:-[\w[\]./%-]+)?(?![\w-])/g;

/**
 * The privacy screen's veil is a backdrop too: it hides everything below it, and nothing is read through it. Only rules
 * whose every selector ends on the veil itself count, so content inside or after it stays solid.
 */
const isPrivacyVeil = (selector: string) =>
  selector.split(",").every((part) =>
    /\.cloud-privacy-veil(?::[\w-]+)*$/.test(
      part
        .trim()
        .split(/[\s>+~]+/)
        .at(-1) ?? "",
    ),
  );

export const rule: Rule = {
  name: "glass-surfaces",
  description: "No backdrop blur except the privacy screen's veil (K16); known findings in a baseline",
  run: async ({ workspaceRoot, fix }) => {
    const findings: KeyedFinding[] = [];
    for (const name of packageIds(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(file)) continue;
        const original = readFileSync(file, "utf8");
        const css = file.endsWith(".css");
        const source = css ? original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")) : original;
        const path = relative(workspaceRoot, file);
        const report = (index: number, detail: string) => {
          findings.push({
            file,
            line: source.slice(0, index).split("\n").length,
            key: `${path} | ${detail}`,
            message: `${detail}: ${message}`,
          });
        };
        if (!css) {
          for (const match of source.matchAll(blurUtility)) report(match.index, match[0]);
          for (const match of source.matchAll(/backdrop-?filter/gi)) report(match.index, match[0]);
          continue;
        }
        for (const block of source.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
          const [, prelude = "", body = ""] = block;
          const selector = prelude.trim().replace(/\s+/g, " ");
          if (isPrivacyVeil(selector)) continue;
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
    return compareBaseline(workspaceRoot, RULE, HEADER, findings, fix);
  },
};
