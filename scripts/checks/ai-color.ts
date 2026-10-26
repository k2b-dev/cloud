import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Rule } from "./rule";

/**
 * Cyan means AI: `--k2b-ai-accent` marks AI surfaces in light and dark. An app color must not be mistaken for it, so
 * every app `appearance` color and every launchpad fallback tile color keeps at least `MIN_HUE_DISTANCE` degrees of
 * OKLCH hue from both AI accents. Near-gray colors (chroma below `MIN_CHROMA`) carry no hue and pass. The Assistant
 * is the AI app and may use the AI colors.
 */
const MIN_HUE_DISTANCE = 20;
const MIN_CHROMA = 0.03;
const AI_APPS = new Set(["assistant"]);
const TOKENS = "packages/ui/src/styles/index.css";
const LAUNCHPAD = "packages/cloud/src/ssr/AppLaunchpadPanel.tsx";

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** OKLCH chroma and hue in degrees of a six-digit hex color. */
export const oklchHue = (hex: string): { chroma: number; hue: number } => {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [linear(n >> 16), linear((n >> 8) & 255), linear(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { chroma: Math.hypot(a, bb), hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
};

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The text of the `{...}` or `[...]` that opens at or after `from`. */
const balanced = (source: string, from: number): string => {
  const start = source.slice(from).search(/[{[]/) + from;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{" || source[i] === "[") depth++;
    if (source[i] === "}" || source[i] === "]") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
};

const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

export const rule: Rule = {
  name: "ai-color",
  description: "App colors keep their hue apart from the AI accent (cyan means AI)",
  run: async ({ workspaceRoot }) => {
    const tokens = join(workspaceRoot, TOKENS);
    if (!existsSync(tokens)) return [];
    const aiColors = [...readFileSync(tokens, "utf8").matchAll(/--k2b-ai-accent:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1]!);
    if (aiColors.length === 0) return [{ file: tokens, message: "No --k2b-ai-accent hex value found; the ai-color rule needs it." }];
    const aiHues = aiColors.map((color) => oklchHue(color).hue);

    const findings: Finding[] = [];
    const inspect = (file: string, source: string, block: string, offset: number, owner: string) => {
      for (const match of block.matchAll(/#[0-9a-f]{6}\b/gi)) {
        const { chroma, hue } = oklchHue(match[0]);
        if (chroma < MIN_CHROMA) continue;
        const distance = Math.min(...aiHues.map((aiHue) => hueDistance(hue, aiHue)));
        if (distance >= MIN_HUE_DISTANCE) continue;
        findings.push({
          file,
          line: lineAt(source, offset + (match.index ?? 0)),
          message: `${owner} color ${match[0]} sits ${distance.toFixed(1)}° of OKLCH hue from the AI accent (${aiColors.join(", ")}); cyan means AI, so keep app colors at least ${MIN_HUE_DISTANCE}° apart.`,
        });
      }
    };

    const packages = join(workspaceRoot, "packages");
    const apps = existsSync(packages) ? readdirSync(packages, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
    for (const app of apps.map((entry) => entry.name).sort()) {
      if (AI_APPS.has(app)) continue;
      const file = join(packages, app, "src", "config.ts");
      if (!existsSync(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bappearance\s*:/g)) {
        const block = balanced(source, match.index + match[0].length);
        inspect(file, source, block, source.indexOf(block, match.index), `The ${app} app`);
      }
    }

    const launchpad = join(workspaceRoot, LAUNCHPAD);
    if (existsSync(launchpad)) {
      const source = readFileSync(launchpad, "utf8");
      const at = source.search(/\bappIconPalette\b[^=]*=/);
      if (at >= 0) {
        const block = balanced(source, source.indexOf("=", at) + 1);
        inspect(launchpad, source, block, source.indexOf(block, at), "A launchpad fallback");
      }
    }
    return findings;
  },
};
