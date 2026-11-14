/**
 * Serves the chat gallery (`chat-gallery.browser-harness.tsx`) with the global and Assistant styles, for browser tests
 * and screenshots. `bun chat-gallery.browser-fixture.ts --help` explains the commands. Invented data only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ui = resolve(import.meta.dir, "../../../../ui");
const cloud = resolve(import.meta.dir, "../../..");
const assistantStyles = resolve(import.meta.dir, "../../../../assistant/src/styles/app.css");

/** Serves the gallery on a free loopback port; `close` stops it. */
export async function startChatGallery(options: { port?: number } = {}) {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const [build, styles, assistant] = await Promise.all([
    Bun.build({
      entrypoints: [resolve(import.meta.dir, "chat-gallery.browser-harness.tsx")],
      target: "browser",
      format: "esm",
      conditions: ["browser"],
      plugins: [
        {
          name: "solid-chat-gallery",
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
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] }),
    Bun.build({ entrypoints: [assistantStyles], plugins: [tailwind] }),
  ]);
  if (!build.success) throw new AggregateError(build.logs, "Chat gallery build failed");
  for (const sheet of [styles, assistant]) if (!sheet.success) throw new AggregateError(sheet.logs, "Stylesheet build failed");
  const harness = await build.outputs[0]!.text();
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = [fonts, ...(await Promise.all([styles, assistant].map((sheet) => sheet.outputs[0]!.text())))].join("\n");
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      const lang = url.searchParams.get("lang") ?? "de";
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return new Response(
        `<!doctype html><html lang="${lang}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" data-k2b-primary="ai" style="margin:0;background:var(--k2b-surface)"><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, close: () => server.stop(true) };
}

type Shot = {
  name: string;
  query: string;
  width: number;
  height: number;
  hover?: string;
  click?: string | string[];
  /** Shoots only this element, for a close look at a detail. */
  element?: string;
};

if (import.meta.main) {
  const [command, out, planFile] = Bun.argv.slice(2);
  if (command === "--help" || !command) {
    console.log(
      "Usage:\n  bun chat-gallery.browser-fixture.ts --serve [port]   print the gallery address\n" +
        "  bun chat-gallery.browser-fixture.ts --shoot <dir> <plan.json>\n" +
        '     plan: [{ "name", "query", "width", "height", "hover"?, "click"?, "element"? }], one Chromium',
    );
  } else if (command === "--serve") {
    const gallery = await startChatGallery({ port: Number(out ?? 0) });
    console.log(gallery.url);
  } else if (command === "--shoot" && out && planFile) {
    const gallery = await startChatGallery();
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as Shot[];
    const { launchBrowser } = await import("../../../../ui/test/browser");
    const browser = await launchBrowser();
    try {
      for (const shot of plan) {
        const context = await browser.newContext({
          viewport: { width: shot.width, height: shot.height },
          deviceScaleFactor: 2,
          isMobile: shot.width < 768,
          hasTouch: shot.width < 768,
          reducedMotion: "reduce",
          locale: "de-DE",
          timezoneId: "Europe/Berlin",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${gallery.url}?${shot.query}`);
        await page.waitForSelector("body[data-ready]", { state: "attached" });
        await page.evaluate(() => document.fonts.ready);
        try {
          for (const selector of [shot.click ?? []].flat()) await page.click(selector, { timeout: 5_000 });
          if (shot.hover) await page.hover(shot.hover, { timeout: 5_000 });
        } catch (error) {
          errors.push(error instanceof Error ? error.message.split("\n")[0]! : String(error));
        }
        await page.waitForTimeout(300);
        const path = resolve(out, `${shot.name}.png`);
        if (shot.element) await page.locator(shot.element).first().screenshot({ path });
        else await page.screenshot({ path });
        console.log(shot.name, errors.length ? `errors: ${errors.join(" | ")}` : "ok");
        await context.close();
      }
    } finally {
      await browser.close();
      gallery.close();
    }
  }
}
