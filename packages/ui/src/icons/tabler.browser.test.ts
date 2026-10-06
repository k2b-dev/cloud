import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

// Which width a browser gives a glyph before its font has loaded is a question of
// layout, which happy-dom does not model, so a real engine loads the shipped preset.
const dist = resolve(import.meta.dir, "../../dist");
const preset = readFileSync(resolve(dist, "tabler.css"), "utf8");
const fontFile = /\.\/(tabler-icons-[\w-]+\.woff2)/.exec(preset)![1]!;

// An icon in running text, an icon with a label, an icon-only control at another size, and text after each. The
// preset is inline: a linked stylesheet could still be on its way when the first measurement runs.
const page = `<!doctype html><html><head><meta charset="utf-8"><style>${preset}</style></head>
<body style="margin:0;font:14px/1.5 sans-serif">
<p>Sign in <i class="ti ti-login"></i> to continue</p>
<div style="display:flex;align-items:center;gap:8px">
  <span style="display:inline-flex;align-items:center;gap:4px"><i class="ti ti-language"></i>EN</span>
  <button style="display:inline-flex;align-items:center;padding:4px;font-size:20px"><i class="ti ti-moon"></i></button>
  <span>after</span>
</div></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("Tabler icon preset", () => {
  test("icons and the content after them keep their width while the icon font loads", async () => {
    const tab = await browser.newPage();
    // The font is large, so on a slow connection it arrives after the first frame: hold it until then.
    const firstFrame = Promise.withResolvers<void>();
    try {
      await tab.route("http://icons.test/**", async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: page });
        if (pathname === `/${fontFile}`) {
          await firstFrame.promise;
          return route.fulfill({ contentType: "font/woff2", path: resolve(dist, fontFile) });
        }
        return route.fulfill({ status: 404, body: "" });
      });
      await tab.goto("http://icons.test/", { waitUntil: "domcontentloaded" });
      const measure = () =>
        tab.evaluate(() => {
          const boxes = Array.from(document.body.querySelectorAll("*")).map((element) => {
            const { left, width } = element.getBoundingClientRect();
            return `${element.tagName.toLowerCase()}.${element.className} "${element.textContent?.trim()}" ${left} ${width}`;
          });
          const font: string[] = [];
          document.fonts.forEach((face) => {
            if (face.family === "tabler-icons") font.push(face.status);
          });
          return { boxes, font };
        });
      const before = await measure();
      firstFrame.resolve();
      await tab.evaluate(() => document.fonts.ready);
      const after = await measure();

      expect([before.font, after.font]).toEqual([["loading"], ["loaded"]]);
      expect(after.boxes.filter((box) => box.startsWith("i.ti ")).map((box) => box.split(" ").at(-1))).toEqual(["14", "14", "20"]);
      expect(before.boxes).toEqual(after.boxes);
    } finally {
      firstFrame.resolve();
      await tab.close();
    }
  }, 30_000);
});
