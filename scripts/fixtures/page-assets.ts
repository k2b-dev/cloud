/**
 * Page CSS and harness scripts for browser fixtures, built as the production build ships them (minified) and served
 * as linked files.
 *
 * A fixture page that carries its 2–3 MB stylesheet inline makes the HTML parser wait for all of it on every load;
 * linked, the same pages loaded about a fifth faster at 4x CPU throttle (Storage admin and dashboard suites,
 * 27.11.2026). The CSS is built once per process for the same entries, so suites in one run share it.
 *
 * ```ts
 * const css = await pageCss([appCss, rootStyles]);
 * const script = await pageScript({ entrypoints: [harness], target: "browser", format: "iife" });
 * Bun.serve({ fetch: (req) => fixtureAssetResponse(new URL(req.url).pathname) ?? page(
 *   `<link rel="stylesheet" href="${fixtureAsset(css, "css")}">…<script src="${fixtureAsset(script, "js")}"></script>`) });
 * ```
 *
 * A fixture without an origin (`page.setContent`) cannot link a file; it inlines the `pageCss` text instead.
 */
import { resolve } from "node:path";

// the root has no Tailwind of its own; the platform package owns the plugin, as the other repository fixtures load it
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../packages/cloud")))).default;

/** Cascade layer order of a Cloud page, stated first when an app's stylesheet and the shell's are joined. */
export const LAYER_ORDER = "@layer properties, theme, base, components, utilities;";

const built = new Map<string, Promise<string>>();
const assets = new Map<string, { body: string; type: string }>();
const types = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" } as const;

/**
 * The page CSS from these stylesheets in this order (Tailwind, minified), built once per process. Two or more are
 * joined under {@link LAYER_ORDER}, as an app page joins its own stylesheet and the shell's.
 */
export const pageCss = (entries: readonly string[]): Promise<string> => {
  const key = entries.join("\n");
  let css = built.get(key);
  if (!css) {
    css = Promise.all(
      entries.map(async (entry) => {
        const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind], minify: true });
        if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
        return build.outputs[0]!.text();
      }),
    ).then((outputs) => (outputs.length > 1 ? [LAYER_ORDER, ...outputs] : outputs).join("\n"));
    // a failed build is not kept, so the next suite reports its own error instead of this one
    css.catch(() => built.delete(key));
    built.set(key, css);
  }
  return css;
};

/** A harness bundle in one script file (assets it imports are left out, as before), minified as an app's islands ship. */
export const pageScript = async (config: Bun.BuildConfig): Promise<string> => {
  const build = await Bun.build({ ...config, minify: true });
  if (!build.success) throw new AggregateError(build.logs, `Could not bundle ${config.entrypoints.join(", ")}`);
  const entries = build.outputs.filter((output) => output.kind === "entry-point");
  if (entries.length !== 1 || build.outputs.some((output) => output.kind === "chunk"))
    throw new Error("A page script is one file: one entry point and no split chunks.");
  return entries[0]!.text();
};

/** The address under which {@link fixtureAssetResponse} serves this text; the same text keeps the same address. */
export const fixtureAsset = (body: string, kind: keyof typeof types): string => {
  const href = `/__fixture/${Bun.hash(body).toString(36)}.${kind}`;
  assets.set(href, { body, type: types[kind] });
  return href;
};

/** The file for an address from {@link fixtureAsset}, or `undefined` for any other path. */
export const fixtureAssetResponse = (pathname: string): Response | undefined => {
  const asset = assets.get(pathname);
  return asset
    ? new Response(asset.body, { headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" } })
    : undefined;
};
