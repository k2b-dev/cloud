/** The model chooser harness: the Assistant's empty chat, real composer, chip, card and note, fictional models. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");

export async function startModelChooserHarness(options: { port?: number } = {}) {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const [build, styles, assistantStyles] = await Promise.all([
    Bun.build({
      entrypoints: [resolve(import.meta.dir, "model-chooser.browser-harness.tsx")],
      target: "browser",
      format: "iife",
      conditions: ["browser"],
      plugins: [
        {
          name: "solid-model-chooser-harness",
          setup(builder) {
            builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
              const result = await transformAsync(await Bun.file(path).text(), {
                filename: path,
                babelrc: false,
                configFile: false,
                presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
              });
              return { contents: result.code, loader: "js" };
            });
          },
        },
      ],
    }),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/app.css")], plugins: [tailwind] }),
  ]);
  if (!build.success) throw new AggregateError(build.logs, "Model chooser harness build failed");
  if (!styles.success || !assistantStyles.success)
    throw new AggregateError([...styles.logs, ...assistantStyles.logs], "Stylesheet build failed");
  const harness = await build.outputs[0]!.text();
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = `${fonts}\n${await styles.outputs[0]!.text()}\n${await assistantStyles.outputs[0]!.text()}`;
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return new Response(
        `<!doctype html><html lang="de" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, close: () => server.stop(true) };
}

if (import.meta.main) console.log((await startModelChooserHarness({ port: Number(Bun.argv[2] ?? 0) })).url);
