import type { BunPlugin, PluginBuilder } from "bun";
import tailwind from "bun-plugin-tailwind";

// Bun drops adjacent same-condition @supports rules (oven-sh/bun#24770).
// Remove this wrapper when Bun merges them; Tailwind's supported browsers implement color-mix().
const colorMixPolyfill =
  /^([ \t]*)([\w-]+): [^;\n{}]+;\n\1@supports \(color: color-mix\(in lab, red, red\)\) \{\n(?:\1  (\2: color-mix\([^;\n{}]+;)\n|\1  & \{\n\1    (\2: color-mix\([^;\n{}]+;)\n\1  \}\n)\1\}/gm;

export function wrapTailwindPlugin(plugin: BunPlugin): BunPlugin {
  return {
    ...plugin,
    setup(build) {
      const onLoad: PluginBuilder["onLoad"] = (constraints, callback) => {
        build.onLoad(constraints, async (args) => {
          const result = await callback(args);
          if (result?.loader !== "css" || !("contents" in result) || typeof result.contents !== "string") return result;
          const contents = result.contents.replace(colorMixPolyfill, "$1$3$4");
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
