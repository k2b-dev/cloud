import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

/** Compile the app and shell in their shipped page-head order for host-width comparisons. */
export const appHostCss = async (appCss: string) => {
  const outputs = await Promise.all(
    [appCss, resolve(import.meta.dir, "../../../styles.css")].map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
      return build.outputs[0]!.text();
    }),
  );
  return ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
};
