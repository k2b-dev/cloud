import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The four type roles of @k2b/ui (K11), read from their one definition in `packages/ui/src/styles/index.css`:
 * the `--k2b-font-size-*`, `--k2b-line-height-*`, and `--k2b-font-weight-*` tokens and the `--k2b-type-roles` list,
 * which adds the line heights the mockup also measures (meta inline in a 20 px row, 22 px reading text, the 20 px
 * phone title). The `type-scale` rule, the type meter, and tests read the roles here instead of repeating numbers.
 */
export type TypeRole = { name: string; size: number; lineHeight: number; weight: number; lineHeights: number[]; weights: number[] };

const stylesheet = resolve(import.meta.dir, "../../packages/ui/src/styles/index.css");

/** A length in px; `rem` counts 16 px. */
const px = (value: string): number => {
  const match = value.trim().match(/^(\d*\.?\d+)(px|rem)$/);
  if (!match) throw new Error(`type roles: not a length: ${value}`);
  return Number.parseFloat(match[1]!) * (match[2] === "rem" ? 16 : 1);
};

const read = (): TypeRole[] => {
  const source = readFileSync(stylesheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const token = (name: string) => {
    const match = source.match(new RegExp(`${name}:\\s*([^;]+);`));
    if (!match) throw new Error(`type roles: ${name} is not defined in ${stylesheet}`);
    return match[1]!.trim();
  };
  const value = (text: string) => text.replace(/var\((--[\w-]+)\)/g, (_, name: string) => token(name));
  const list = token("--k2b-type-roles")
    .split(",")
    .map((entry) => entry.trim().split("/"));
  return ["meta", "row", "body", "lead"].map((name, index) => {
    const [head = "", weights = ""] = list[index]!;
    const [, listed = "", ...lines] = value(head).trim().split(/\s+/);
    const size = px(token(`--k2b-font-size-${name}`));
    if (px(listed) !== size) throw new Error(`type roles: --k2b-type-roles entry ${index + 1} is not the ${name} size`);
    return {
      name,
      size,
      lineHeight: px(token(`--k2b-line-height-${name}`)),
      weight: Number(token(`--k2b-font-weight-${name}`)),
      lineHeights: lines.map(px),
      weights: weights.trim().split(/\s+/).map(Number),
    };
  });
};

export const TYPE_ROLES: readonly TypeRole[] = read();
/** The four sizes in px. */
export const TYPE_SIZES: readonly number[] = TYPE_ROLES.map((role) => role.size);
/** Every line height a role takes, in px. */
export const TYPE_LINE_HEIGHTS: readonly number[] = [...new Set(TYPE_ROLES.flatMap((role) => role.lineHeights))].sort((a, b) => a - b);
/** The three weights. */
export const TYPE_WEIGHTS: readonly number[] = [...new Set(TYPE_ROLES.flatMap((role) => role.weights))].sort((a, b) => a - b);
