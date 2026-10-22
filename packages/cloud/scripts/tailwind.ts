import type { BunPlugin, PluginBuilder } from "bun";
import tailwind from "bun-plugin-tailwind";

// Bun drops adjacent same-condition @supports rules (oven-sh/bun#24770).
// Remove this wrapper when Bun merges them; Tailwind's supported browsers implement color-mix().
// Match one same-property declaration in either Tailwind shape, with identical importance.
const colorMixPolyfill =
  /^([ \t]*)([^\s:;{}]+): ([^\n]+);\n\1@supports \(color: color-mix\(in lab, red, red\)\) \{\n(?:\1  \2: ([^\n]*color-mix\([^\n]+);\n|\1  & \{\n\1    \2: ([^\n]*color-mix\([^\n]+);\n\1  \}\n)\1\}/gm;

const unwrapColorMix = (match: string, indent: string, property: string, fallback: string, flat: string, nested: string): string => {
  const mixed = flat ?? nested;
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
