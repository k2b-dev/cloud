import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

let browser: Browser;
let harness: string;
let css: string;
let icons: string;
/** IBM Plex, which Cloud ships, so the wrap is measured with the product's widths. */
let plex: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CodeAccountHandle.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-code-handle",
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
  });
  if (!build.success) throw new AggregateError(build.logs, "Handle harness build failed");
  harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Handle stylesheet build failed");
  css = await styles.outputs[0]!.text();
  const iconPath = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconPath).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  icons = source.replace(
    /url\([^)]+\)/,
    `url("data:font/woff2;base64,${Buffer.from(await Bun.file(resolve(dirname(iconPath), font)).arrayBuffer()).toString("base64")}")`,
  );
  const plexPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  const plexSource = await Bun.file(plexPath).text();
  const plexFiles = [...new Set(plexSource.match(/\.\/fonts\/[^)"']+\.woff2/g) ?? [])];
  if (!plexFiles.length) throw new Error("Missing IBM Plex WOFF2 files");
  plex = plexSource;
  for (const file of plexFiles)
    plex = plex.replaceAll(
      file,
      `data:font/woff2;base64,${Buffer.from(await Bun.file(resolve(dirname(plexPath), file)).arrayBuffer()).toString("base64")}`,
    );
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [390, 1200])
  test(`${width}px: the handle copies before any run and a failed copy remains retryable`, async () => {
    const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, reducedMotion: "reduce" });
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${plex}</style><style>${css}</style><style>${icons}</style></head><body class="k2b-ui"><main id="root" style="padding:96px 16px 24px"></main></body></html>`,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.body.dataset.copied = text;
            },
          },
        });
      });
      await page.addScriptTag({ content: harness });
      await page.evaluate(async () => {
        await Promise.all(['400 14px "IBM Plex Sans"', '400 13px "IBM Plex Mono"'].map((font) => document.fonts.load(font)));
        await document.fonts.ready;
      });
      expect(await page.evaluate(() => document.fonts.check("16px tabler-icons"))).toBe(true);
      if (process.env.CODE_A2_SCREENSHOTS) {
        mkdirSync(process.env.CODE_A2_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.CODE_A2_SCREENSHOTS, `handle-${width}.png`) });
      }
      // Mockup v31 `abgelehnt · cron`: the handle is set in monospace, a little smaller than the sentence (N2-kennung-mono).
      const face = await page.evaluate(() => {
        const handle = document.querySelector<HTMLElement>("[data-code-handle]")!;
        const lead = document.querySelector<HTMLElement>(".cloud-code__lead")!;
        return {
          family: getComputedStyle(handle).fontFamily.split(",")[0]!.replaceAll('"', ""),
          smaller: Number.parseFloat(getComputedStyle(handle).fontSize) < Number.parseFloat(getComputedStyle(lead).fontSize),
          mono: document.fonts.check('400 13px "IBM Plex Mono"'),
        };
      });
      expect(face).toEqual({ family: "IBM Plex Mono", smaller: true, mono: true });
      // L127, mockup v31 `abgelehnt · cron · 390`: where the line has room for "· Kennung" but not for the handle,
      // "· Kennung" ends the sentence's line and the handle moves below with Copy, never split. The line gets exactly
      // that room, so the check does not depend on font metrics.
      const wrap = await page.evaluate(() => {
        const lead = document.querySelector<HTMLElement>(".cloud-code__lead")!;
        const sentence = lead.firstChild!;
        const text = document.createRange();
        text.selectNodeContents(sentence);
        const probe = document.createElement("span");
        probe.style.whiteSpace = "pre";
        probe.textContent = " · Kennung";
        lead.append(probe);
        lead.style.width = `${Math.ceil(text.getBoundingClientRect().width + probe.getBoundingClientRect().width) + 12}px`;
        probe.remove();
        const quote = document.createRange();
        quote.setStart(sentence, sentence.textContent!.length - 1);
        quote.setEnd(sentence, sentence.textContent!.length);
        const label = document.createRange();
        const labelNode = Array.from(lead.querySelectorAll("span"))
          .flatMap((span) => Array.from(span.childNodes))
          .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Kennung"))!;
        label.selectNodeContents(labelNode);
        const handle = document.querySelector<HTMLElement>("[data-code-handle]")!;
        const copy = lead.querySelector("button")!;
        const middle = (box: DOMRect) => box.top + box.height / 2;
        const [end, mark, code, button] = [
          quote.getBoundingClientRect(),
          label.getBoundingClientRect(),
          handle.getBoundingClientRect(),
          copy.getBoundingClientRect(),
        ];
        const result = {
          labelEndsSentenceLine: Math.abs(middle(end) - middle(mark)) < 6,
          handleBelow: code.top > mark.bottom - 1,
          handleBesideCopy: Math.abs(middle(code) - middle(button)) < 6,
          handleOneLine: handle.getClientRects().length === 1,
        };
        lead.style.width = "";
        return result;
      });
      expect(wrap).toEqual({ labelEndsSentenceLine: true, handleBelow: true, handleBesideCopy: true, handleOneLine: true });
      await page.getByRole("button", { name: "Kennung kopieren" }).click();
      await page.waitForFunction(() => document.body.dataset.copied === "code-7k2q9m4xwt");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error("Denied");
            },
          },
        });
      });
      await page.getByRole("button", { name: "Kennung kopieren" }).click();
      await page.getByText("Die Kennung konnte nicht kopiert werden.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Kennung kopieren" }).isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

// Cloud's global sans rule is unlayered; code keeps the mono face of the @k2b/ui base, and an explicit `font-sans`, as on
// Mail's plain-text message bodies, keeps sans.
test("code, kbd, samp and pre are monospace unless they ask for sans", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><style>${plex}</style><style>${css}</style></head><body class="k2b-ui">` +
        `<p>Text <code>code-7k2q9m4xwt</code> <kbd>K</kbd> <samp>S</samp></p><pre>Block</pre>` +
        `<pre class="font-sans">Plain-text mail</pre><code class="font-sans">Sans code</code></body></html>`,
    );
    const faces = await page.evaluate(() =>
      Array.from(document.querySelectorAll("p, code, kbd, samp, pre")).map(
        (element) => `${element.textContent}: ${getComputedStyle(element).fontFamily.split(",")[0]!.replaceAll('"', "")}`,
      ),
    );
    expect(faces).toEqual([
      "Text code-7k2q9m4xwt K S: IBM Plex Sans",
      "code-7k2q9m4xwt: IBM Plex Mono",
      "K: IBM Plex Mono",
      "S: IBM Plex Mono",
      "Block: IBM Plex Mono",
      "Plain-text mail: IBM Plex Sans",
      "Sans code: IBM Plex Sans",
    ]);
  } finally {
    await page.close();
  }
});
