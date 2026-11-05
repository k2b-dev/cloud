/**
 * Test fixture server for the Assistant part in the Cloud app: the harness with the global and Assistant styles.
 * `bun AssistantPwa.browser-fixture.ts --help` explains the commands. Invented data only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");

/** Serves the harness on a free loopback port; `close` stops it. */
export async function startAssistantPwaHarness(options: { port?: number; accent?: string } = {}) {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const { appAccentStyle } = await import("../../../cloud/src/ssr/app-appearance");
  const [build, styles, assistantStyles] = await Promise.all([
    Bun.build({
      entrypoints: [resolve(import.meta.dir, "AssistantPwa.browser-harness.tsx")],
      target: "browser",
      format: "esm",
      conditions: ["browser"],
      plugins: [
        {
          name: "solid-assistant-pwa-harness",
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
  if (!build.success) throw new AggregateError(build.logs, "Assistant part harness build failed");
  for (const sheet of [styles, assistantStyles]) if (!sheet.success) throw new AggregateError(sheet.logs, "Stylesheet build failed");
  const harness = await build.outputs[0]!.text();
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = [fonts, ...(await Promise.all([styles, assistantStyles].map((sheet) => sheet.outputs[0]!.text())))].join("\n");
  // The frame gives a part its app colour (F4) once that lands; until then a test passes the accent itself.
  const accent = appAccentStyle(options.accent) ?? "";
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))));
      return new Response(
        `<!doctype html><html lang="de" class="light" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin:0;${accent}"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}/pwa/assistant`, close: () => server.stop(true) };
}

type Shot = {
  name: string;
  query: string;
  width: number;
  height: number;
  /** Text typed into a field before the taps, as `[selector, text]`. */
  fill?: [string, string];
  /** Invented files attached through the field's file input, by name. */
  attach?: string[];
  click?: string;
  tap?: string;
  focus?: string;
};

if (import.meta.main) {
  const [command, out, planFile] = Bun.argv.slice(2);
  if (command === "--help" || !command) {
    console.log(
      "Usage:\n  bun AssistantPwa.browser-fixture.ts --serve [port]   print the harness address\n" +
        "  bun AssistantPwa.browser-fixture.ts --shoot <dir> <plan.json> [accent]\n" +
        '     plan: [{ "name", "query", "width", "height", "click"?, "tap"?, "focus"? }], one Chromium, light mode',
    );
  } else if (command === "--serve") {
    const harness = await startAssistantPwaHarness({ port: Number(out ?? 0) });
    console.log(harness.url);
  } else if (command === "--shoot" && out && planFile) {
    const harness = await startAssistantPwaHarness({ accent: Bun.argv[5] });
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as Shot[];
    const { launchBrowser } = await import("../../../ui/test/browser");
    const browser = await launchBrowser();
    try {
      for (const shot of plan) {
        const context = await browser.newContext({
          viewport: { width: shot.width, height: shot.height },
          deviceScaleFactor: 2,
          isMobile: shot.width < 768,
          hasTouch: true,
          reducedMotion: "reduce",
          locale: "de-DE",
          timezoneId: "Europe/Berlin",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.clock.setFixedTime(new Date("2026-11-04T09:41:00.000Z"));
        await page.goto(`${harness.url}?${shot.query}`);
        await page.waitForSelector("body[data-ready]", { state: "attached" });
        await page.evaluate(() => document.fonts.ready);
        try {
          if (shot.fill) await page.fill(shot.fill[0], shot.fill[1], { timeout: 5_000 });
          if (shot.attach)
            await page
              .locator("input[type=file]")
              .first()
              .setInputFiles(
                shot.attach.map((name) => ({
                  name,
                  mimeType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
                  // A one-pixel PNG, or a few bytes of an invented PDF.
                  buffer: name.endsWith(".pdf")
                    ? Buffer.from("%PDF-1.4 invented")
                    : Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                        "base64",
                      ),
                })),
              );
          if (shot.click) await page.click(shot.click, { timeout: 5_000 });
          if (shot.tap) await page.tap(shot.tap, { timeout: 5_000 });
          if (shot.focus) await page.focus(shot.focus, { timeout: 5_000 });
        } catch (error) {
          errors.push(error instanceof Error ? error.message.split("\n")[0]! : String(error));
        }
        await page.waitForTimeout(400);
        await page.screenshot({ path: resolve(out, `${shot.name}.png`) });
        console.log(shot.name, errors.length ? `errors: ${errors.join(" | ")}` : "ok");
        await context.close();
      }
    } finally {
      await browser.close();
      harness.close();
    }
  }
}
