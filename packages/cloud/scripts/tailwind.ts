import type { BunPlugin, PluginBuilder } from "bun";
import tailwind from "bun-plugin-tailwind";

// Bun drops adjacent same-condition @supports rules (oven-sh/bun#24770).
// Remove this wrapper when Bun merges them; Tailwind's supported browsers implement color-mix().
// Match one same-property declaration in either Tailwind shape, with identical importance.
const colorMixPolyfill =
  /^([ \t]*)([^\s:;{}]+): ([^\n]+);\n\1@supports \(color: color-mix\(in lab, red, red\)\) \{\n(?:\1  \2: ([^\n]*color-mix\([^\n]+);\n|\1  & \{\n\1    \2: ([^\n]*color-mix\([^\n]+);\n\1  \}\n)\1\}/gm;

// Semicolons inside strings or functions belong to a value. A second
// declaration on the same line is authored CSS and must remain untouched.
const singleValue = (value: string): boolean => {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && (char === ";" || char === "{" || char === "}")) return false;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === "";
};

const unwrapColorMix = (match: string, indent: string, property: string, fallback: string, flat: string, nested: string): string => {
  const mixed = flat ?? nested;
  if (!singleValue(fallback) || !singleValue(mixed)) return match;
  if (/\s!important\s*$/.test(fallback) !== /\s!important\s*$/.test(mixed)) return match;
  return `${indent}${property}: ${mixed};`;
};

export function wrapTailwindPlugin(plugin: BunPlugin): BunPlugin {
  return {
    ...plugin,
    setup(build) {
      const onLoad: PluginBuilder["onLoad"] = (constraints, callback) => {
        build.onLoad(constraints, async (args) => {
          const result = await callback(args);
          if (result?.loader !== "css" || !("contents" in result) || typeof result.contents !== "string") return result;
          const contents = result.contents.replace(colorMixPolyfill, unwrapColorMix);
          return contents === result.contents ? result : { ...result, contents };
        });
        return wrappedBuild;
      };
      const wrappedBuild = new Proxy(build, {
        get(target, property, receiver) {
          return property === "onLoad" ? onLoad : Reflect.get(target, property, receiver);
        },
      });
      return plugin.setup(wrappedBuild);
    },
  };
}

export default wrapTailwindPlugin(tailwind);
