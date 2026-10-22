import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const hoverVariant = /^(?:group-|peer-)?hover(?:\/[\w-]+)?$/;
const focusVariant = /^(?:group-|peer-)?focus(?:-visible|-within)?(?:\/[\w-]+)?$/;
const paintMessage = "hover and focus change only paint, such as color or opacity.";

const outerShadowUtility = (utility: string): boolean =>
  /^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl))?$/.test(utility) ||
  /^shadow-\[(?!inset).+\]$/.test(utility) ||
  (utility !== "drop-shadow-none" && /^drop-shadow(?:-.+)?$/.test(utility));

/** Split shadow layers without splitting colors or variable fallbacks. */
const shadowLayers = (value: string): string[] => {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (value[i] === "," && depth === 0) {
      layers.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
};

const variableReference = (value: string): boolean => {
  if (!/^var\(/i.test(value)) return false;
  let depth = 1;
  for (let i = 4; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (depth === 0) return i === value.length - 1;
  }
  return false;
};

export const rule: Rule = {
  name: "hover-motion",
  description: "Hover and focus change only paint: no translate, scale, rotate, or outer shadow",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const name of packageIds(workspaceRoot)) {
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(file)) continue;
        const css = file.endsWith(".css");
        const original = readFileSync(file, "utf8");
        const source = css ? original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")) : original;
        const report = (index: number, message: string) => {
          findings.push({ file, line: source.slice(0, index).split("\n").length, message });
        };

        const tokens = /(?<![\w\-:/[.])((?:[\w-]+(?:\/[\w-]+)?:)+)([!-]*[\w-]+(?:\[[^\]\r\n]*\]|[\w./%-]*))/g;
        for (const match of source.matchAll(tokens)) {
          const [, chain = "", rawUtility = ""] = match;
          const variants = chain.slice(0, -1).split(":");
          const hover = variants.some((variant) => hoverVariant.test(variant));
          const focus = variants.some((variant) => focusVariant.test(variant));
          const utility = rawUtility.replace(/^[!-]+/, "");
          if ((hover || focus) && /^(?:translate|scale|rotate)-/.test(utility)) {
            report(match.index, `${match[0]} moves the element under the pointer; ${paintMessage}`);
          } else if (hover && outerShadowUtility(utility)) {
            report(match.index, `${match[0]} lifts the element on hover; hover changes only paint, such as color.`);
          }
        }

        if (!css) continue;
        for (const block of source.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
          const [, prelude = "", body = ""] = block;
          const selector = prelude.trim().replace(/\s+/g, " ");
          if (selector.startsWith("@")) continue;
          const hover = /:hover\b/i.test(selector);
          if (!hover && !/:focus(?:-visible|-within)?\b/i.test(selector)) continue;
          const bodyIndex = block.index + block[0].indexOf("{") + 1;
          for (const declaration of body.matchAll(/(?:^|;)\s*(transform|translate|scale|rotate|box-shadow)\s*:\s*([^;]*)/gi)) {
            const [, property = "", rawValue = ""] = declaration;
            const value = rawValue.replace(/\s*!important\s*$/i, "").trim();
            if (/^none$/i.test(value)) continue;
            if (property.toLowerCase() === "box-shadow") {
              if (!hover || shadowLayers(value).every((layer) => /^inset(?:\s|$)/i.test(layer) || variableReference(layer))) continue;
            }
            report(
              bodyIndex + declaration.index + declaration[0].indexOf(property),
              `${selector} sets ${property}: ${value}; ${paintMessage}`,
            );
          }
        }
      }
    }
    return findings;
  },
};
