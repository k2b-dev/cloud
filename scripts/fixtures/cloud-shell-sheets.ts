import { resolve } from "node:path";
import type { BunPlugin } from "bun";

/**
 * The stylesheets a Cloud app page links, built from this checkout for browser tests and design pictures: Cloud's
 * global.css, the app's own sheet and Core's v2.css (v2 with Cloud's v2 frames), keyed by the path the page asks for,
 * in the order of its head. `from` is the calling test's directory: Tailwind resolves from the app that uses it.
 *
 *   const assets = await loadShellAssets(await cloudShellSheets({ id: "oauth", css: resolve(dir, "../styles/app.css") }, dir));
 */
export const cloudShellSheets = async (app: { id: string; css: string }, from: string): Promise<Record<string, string>> => {
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
    "/public/v2.css": await build(resolve(root, "packages/cloud/src/styles/v2-page.css"), []),
  };
};
