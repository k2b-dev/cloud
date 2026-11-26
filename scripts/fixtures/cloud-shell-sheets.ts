import { resolve } from "node:path";
import type { BunPlugin } from "bun";

/**
 * The stylesheets a Cloud app page links, built from this checkout for browser tests and design pictures: Cloud's
 * global.css and the app's own sheet, keyed by the path the page asks for, in the order of its head. A page that links
 * Core's v2.css alone (a visitor page on `MinimalLayout ui="v2"`, an app page on `PwaLayout ui="v2"`) also gets it
 * with `v2Page`. `from` is the calling test's directory: Tailwind resolves from the app that uses it.
 *
 *   const assets = await loadShellAssets(await cloudShellSheets({ id: "oauth", css: resolve(dir, "../styles/app.css") }, dir));
 */
export const cloudShellSheets = async (
  app: { id: string; css: string; v2Page?: boolean },
  from: string,
): Promise<Record<string, string>> => {
  const tailwind: BunPlugin = (await import(Bun.resolveSync("bun-plugin-tailwind", from))).default;
  const build = async (entry: string, plugins: BunPlugin[]) => {
    const result = await Bun.build({ entrypoints: [entry], plugins });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
    return result.outputs[0]!.text();
  };
  const root = resolve(import.meta.dir, "../..");
  return {
    "/public/global.css": await build(resolve(root, "styles.css"), [tailwind]),
    [`/public/${app.id}/app.css`]: await build(app.css, [tailwind]),
    ...(app.v2Page ? { "/public/v2.css": await build(resolve(root, "packages/cloud/src/styles/v2-page.css"), []) } : {}),
  };
};
