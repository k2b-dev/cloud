import { join } from "node:path";

export function buildPrelude(): Promise<string> {
  return buildFrame("frame.ts");
}

export function buildCheckPrelude(): Promise<string> {
  return buildFrame("check-frame.ts");
}

async function buildFrame(entry: string): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "import.meta.url": JSON.stringify("about:blank") },
    plugins: [
      {
        name: "offline-chart-module",
        setup(build) {
          build.onResolve({ filter: /^\.\/chart-renderers-rare$/ }, () => ({
            path: join(import.meta.dir, "../runtime/chart-renderers-frame.ts"),
          }));
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "The app frame prelude did not build");
  // The prelude is the text of an inline <script>; a literal "</script" would end it early.
  return (await build.outputs[0]!.text()).trim().replace(/<\/(script)/gi, "<\\/$1");
}

/** Separate ESM asset: transported with the frame, parsed only on first rare chart. */
export async function buildChartModule(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../chat-code/runtime/chart-renderers-rare.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "The offline chart module did not build");
  return build.outputs[0]!.text();
}

export { buildBaseCss } from "../../chat-code/build-document-css";
