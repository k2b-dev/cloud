import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

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

// The feat/code glyph is a mask, not a font glyph. It must take the same box as the Tabler icons next to it, keep
// their padding and centre, and weigh about as much, at each size that navigation uses.
const styles = readFileSync(resolve(dist, "styles.css"), "utf8");
const sizes = [16, 20, 24] as const;
const neighbours = ["ti-code", "ti-mail", "ti-folder"] as const;
const icons = [...neighbours, "ti-feat-code"] as const;
const row = (px: number) =>
  `<div style="display:flex;align-items:flex-start;gap:${px / 2}px;font-size:${px}px;line-height:1">${icons.map((icon) => `<i class="ti ${icon}" data-size="${px}"></i>`).join("")}</div>`;
const tabs = [
  ["Mail", "ti-mail"],
  ["Files", "ti-folder"],
  ["Code", "ti-feat-code"],
  ["Calendar", "ti-calendar"],
] as const;
// The measured rows are black on white; the fixture beside them shows the glyph in a rail, in rows at each size,
// and in the shared TabBar markup, in the theme's own colours.
const brandPage = (theme: "light" | "dark") => `<!doctype html><html class="${theme}"><head><meta charset="utf-8">
<style>${styles}${preset}</style></head>
<body class="k2b-ui" style="margin:0;background:var(--k2b-surface-canvas);color:var(--k2b-text)">
<section id="measure" style="display:grid;gap:12px;width:max-content;padding:8px;background:#fff;color:#000">
  ${sizes.map(row).join("")}
  ${["ti-code", "ti-feat-code"].map((icon) => `<p data-line style="margin:0;font:16px/1.5 sans-serif">Open <i class="ti ti-code" data-text></i> <i class="ti ${icon}" data-text></i> <span>Code</span></p>`).join("")}
</section>
<section id="fixture" style="display:flex;gap:24px;align-items:flex-start;width:max-content;margin-top:16px;padding:16px;font:13px/1.4 sans-serif">
  <nav aria-label="Rail" style="display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:12px;background:var(--k2b-surface)">
    ${tabs
      .map(([label, icon]) => {
        const current = icon === "ti-feat-code";
        return `<a aria-label="${label}" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;color:var(${current ? "--k2b-text" : "--k2b-text-secondary"});background:${current ? "var(--k2b-selected)" : "transparent"}"><i class="ti ${icon}" style="font-size:20px"></i></a>`;
      })
      .join("")}
  </nav>
  <div style="display:grid;gap:10px">
    ${sizes.map((px) => `<div style="display:flex;align-items:center;gap:12px"><span style="width:40px;color:var(--k2b-text-muted)">${px} px</span>${row(px)}</div>`).join("")}
    <div style="width:390px;border-radius:12px;overflow:hidden;background:var(--k2b-surface)">
      <nav class="k2b-tab-bar" aria-label="App"><ul>${tabs
        .map(
          ([label, icon]) =>
            `<li><a href="#${label}"${icon === "ti-feat-code" ? ' aria-current="page"' : ""}><i class="ti ${icon}" aria-hidden="true"></i><span class="k2b-truncate-fade">${label}</span></a></li>`,
        )
        .join("")}</ul></nav>
    </div>
  </div>
</section></body></html>`;

const openBrandPage = async (theme: "light" | "dark") => {
  const tab = await browser.newPage({ deviceScaleFactor: 2 });
  await tab.route("http://icons.test/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: brandPage(theme) });
    if (pathname === `/${fontFile}`) return route.fulfill({ contentType: "font/woff2", path: resolve(dist, fontFile) });
    return route.fulfill({ status: 404, body: "" });
  });
  await tab.goto("http://icons.test/");
  await settled(tab);
  // The font and the mask image both arrive after layout: wait for each before reading pixels.
  await tab.evaluate(async () => {
    await document.fonts.load("16px tabler-icons");
    await document.fonts.ready;
    const mask = getComputedStyle(document.querySelector(".ti-feat-code")!, "::before").maskImage;
    const image = new Image();
    image.src = /^url\("(.+)"\)$/.exec(mask)![1]!;
    await image.decode();
    await new Promise(requestAnimationFrame);
  });
  return tab;
};

type Ink = { top: number; left: number; bottom: number; right: number; weight: number };

// Reads the painted pixels of each measured icon: the ink bounds (pixels darker than half) and the total ink, in CSS
// px relative to the icon box.
const inkOf = async (tab: Page, selector: string) => {
  const area = tab.locator("#measure");
  const origin = (await area.boundingBox())!;
  const png = (await area.screenshot()).toString("base64");
  const boxes = await tab.$$eval(`#measure ${selector}`, (elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  const ink = await tab.evaluate(
    async ({ png, boxes, origin }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / origin.width;
      return boxes.map((box): Ink => {
        const image = context.getImageData(
          Math.round((box.x - origin.x) * scale),
          Math.round((box.y - origin.y) * scale),
          Math.round(box.width * scale),
          Math.round(box.height * scale),
        );
        const ink = { top: Infinity, left: Infinity, bottom: -Infinity, right: -Infinity, weight: 0 };
        for (let index = 0; index < image.data.length; index += 4) {
          const darkness = 255 - image.data[index]!;
          ink.weight += darkness / 255;
          if (darkness < 128) continue;
          const x = (index / 4) % image.width;
          const y = Math.floor(index / 4 / image.width);
          ink.top = Math.min(ink.top, y);
          ink.left = Math.min(ink.left, x);
          ink.bottom = Math.max(ink.bottom, y + 1);
          ink.right = Math.max(ink.right, x + 1);
        }
        return {
          top: ink.top / scale,
          left: ink.left / scale,
          bottom: ink.bottom / scale,
          right: ink.right / scale,
          weight: ink.weight / scale / scale,
        };
      });
    },
    { png, boxes, origin },
  );
  return boxes.map((box, index) => ({ box, ink: ink[index]! }));
};

describe("feat/code brand glyph", () => {
  test("joins the icon set: a mask on the box, padding, and centre of the Tabler glyphs next to it", async () => {
    const tab = await openBrandPage("light");
    await settled(tab);
    try {
      const [tablerStyle, brandStyle] = await tab.evaluate(() =>
        ["ti-code", "ti-feat-code"].map((icon) => {
          const before = getComputedStyle(document.querySelector(`#measure .${icon}`)!, "::before");
          return { mask: before.maskImage, content: before.content, fill: before.webkitTextFillColor, background: before.backgroundColor };
        }),
      );
      // A Tabler glyph without ink carries the box; the mask paints the drawing in the text colour.
      expect(tablerStyle!.mask).toBe("none");
      expect(brandStyle!.mask).toStartWith('url("data:image/svg+xml,');
      expect(brandStyle).toMatchObject({ content: tablerStyle!.content, fill: "rgba(0, 0, 0, 0)", background: "rgb(0, 0, 0)" });

      for (const px of sizes) {
        const measured = await inkOf(tab, `[data-size="${px}"]`);
        const [code, mail, folder, brand] = measured.map(({ ink }) => ink);
        // The same box as every Tabler glyph, so rows, rails, and tab bars keep their layout.
        expect(measured.map(({ box }) => [box.width, box.height])).toEqual(icons.map(() => [px, measured[0]!.box.height]));
        // Tabler's padding is 2 of 24 units; the glyph stays inside it and is not empty.
        const padding = (2 / 24) * px - 0.5;
        expect(Math.min(brand!.top, brand!.left, px - brand!.right)).toBeGreaterThanOrEqual(padding);
        expect(measured[3]!.box.height - brand!.bottom).toBeGreaterThanOrEqual(padding);
        // Centred like the Tabler glyphs next to it, within one CSS pixel.
        for (const neighbour of [code!, mail!, folder!]) {
          expect(Math.abs(brand!.left + brand!.right - neighbour.left - neighbour.right) / 2).toBeLessThanOrEqual(1);
          expect(Math.abs(brand!.top + brand!.bottom - neighbour.top - neighbour.bottom) / 2).toBeLessThanOrEqual(1);
        }
        // About as much ink as its neighbours: neither a hairline nor a blot next to the 2-unit Tabler stroke.
        const weights = [code!, mail!, folder!].map((ink) => ink.weight);
        expect(brand!.weight).toBeGreaterThan(Math.min(...weights) * 0.75);
        expect(brand!.weight).toBeLessThan(Math.max(...weights) * 1.25);
      }

      // In running text the glyph sits on the baseline like the Tabler glyph before it, and nothing after it moves.
      const lines = await tab.$$eval("[data-line]", (lines) =>
        lines.map((line) => [line.getBoundingClientRect().height, line.querySelector("span")!.getBoundingClientRect().left]),
      );
      expect(lines[1]).toEqual(lines[0]!);
      const [, , before, brand] = (await inkOf(tab, "[data-text]")).map(({ box, ink }) => box.y + (ink.top + ink.bottom) / 2);
      expect(Math.abs(brand! - before!)).toBeLessThanOrEqual(1);

      const output = process.env.FEAT_CODE_ICON_SHOTS;
      if (output) {
        mkdirSync(resolve(output, browserName), { recursive: true });
        await tab.locator("#fixture").screenshot({ path: resolve(output, browserName, "feat-code-light.png") });
        const dark = await openBrandPage("dark");
        try {
          await dark.locator("#fixture").screenshot({ path: resolve(output, browserName, "feat-code-dark.png") });
        } finally {
          await dark.close();
        }
      }
    } finally {
      await tab.close();
    }
  }, 30_000);

  test("keeps the text colour in forced colours", async () => {
    const tab = await openBrandPage("light");
    try {
      await tab.emulateMedia({ forcedColors: "active" });
      await settled(tab);
      const [brand] = await inkOf(tab, '[data-size="24"].ti-feat-code');
      expect(brand!.ink.weight).toBeGreaterThan(20);
    } finally {
      await tab.close();
    }
  }, 30_000);
});

// The filled glyphs are masks, not font glyphs: each must paint, fill more than its outline counterpart, and sit on
// the same box and centre as that Tabler glyph. The names kept for stored values must paint their replacement.
const filled = ["circle", "cloud", "pin", "player-play", "point", "star"] as const;
const aliases = [
  ["app", "app-window"],
  ["mail-pencil", "file-pencil"],
  ["clock-send", "calendar-time"],
  ["user-send", "user-share"],
] as const;
const filledPage = `<!doctype html><html><head><meta charset="utf-8"><style>${preset}</style></head>
<body style="margin:0;background:#fff;color:#000"><section id="measure" style="display:grid;gap:12px;width:max-content;padding:8px">
${sizes
  .map(
    (px) =>
      `<div style="display:flex;align-items:flex-start;gap:${px / 2}px;font-size:${px}px;line-height:1">${filled.map((name) => `<i class="ti ti-${name}" data-size="${px}" data-pair="filled"></i><i class="ti ti-${name}-filled" data-size="${px}" data-pair="filled"></i>`).join("")}${aliases.map(([alias, glyph]) => `<i class="ti ti-${glyph}" data-size="${px}" data-pair="alias"></i><i class="ti ti-${alias}" data-size="${px}" data-pair="alias"></i>`).join("")}</div>`,
  )
  .join("")}
</section></body></html>`;

describe("filled glyphs", () => {
  test("paint inside the box and centre of their Tabler outline glyph", async () => {
    const tab = await browser.newPage({ deviceScaleFactor: 2 });
    try {
      await tab.route("http://icons.test/**", async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: filledPage });
        // Every font file the preset names: from Tabler 3.50 the font is split into unicode-range faces.
        if (pathname.endsWith(".woff2")) return route.fulfill({ contentType: "font/woff2", path: resolve(dist, pathname.slice(1)) });
        return route.fulfill({ status: 404, body: "" });
      });
      await tab.goto("http://icons.test/");
      await settled(tab);
      // The font and the mask images arrive after layout: wait for each before reading pixels.
      await tab.evaluate(async () => {
        await document.fonts.load("16px tabler-icons");
        await document.fonts.ready;
        const masks = [...document.querySelectorAll("[class*='-filled']")].map((icon) => getComputedStyle(icon, "::before").maskImage);
        await Promise.all(
          masks.map((mask) => {
            const image = new Image();
            image.src = /^url\("(.+)"\)$/.exec(mask)![1]!;
            return image.decode();
          }),
        );
        await new Promise(requestAnimationFrame);
      });
      const area = tab.locator("#measure");
      const origin = (await area.boundingBox())!;
      const png = (await area.screenshot()).toString("base64");
      const icons = await tab.evaluate(
        async ({ png, origin }) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const scale = bitmap.width / origin.width;
          return [...document.querySelectorAll<HTMLElement>("#measure i")].map((icon) => {
            const box = icon.getBoundingClientRect();
            const image = context.getImageData(
              Math.round((box.x - origin.x) * scale),
              Math.round((box.y - origin.y) * scale),
              Math.round(box.width * scale),
              Math.round(box.height * scale),
            );
            // Ink bounds of pixels darker than half, and the total ink, in CSS px relative to the box.
            const ink = { top: Infinity, left: Infinity, bottom: -Infinity, right: -Infinity, weight: 0 };
            for (let index = 0; index < image.data.length; index += 4) {
              const darkness = 255 - image.data[index]!;
              ink.weight += darkness / 255 / scale / scale;
              if (darkness < 128) continue;
              const x = (index / 4) % image.width;
              const y = Math.floor(index / 4 / image.width);
              ink.top = Math.min(ink.top, y / scale);
              ink.left = Math.min(ink.left, x / scale);
              ink.bottom = Math.max(ink.bottom, (y + 1) / scale);
              ink.right = Math.max(ink.right, (x + 1) / scale);
            }
            return { name: icon.className, size: icon.dataset.size, pair: icon.dataset.pair, width: box.width, height: box.height, ...ink };
          });
        },
        { png, origin },
      );

      for (let index = 0; index < icons.length; index += 2) {
        const [outline, fill] = [icons[index]!, icons[index + 1]!];
        const label = `${fill.name} at ${fill.size}px`;
        if (fill.pair === "alias") {
          // A kept name paints exactly the glyph that replaced it, never an empty box.
          expect([label, outline.weight > 5, Math.abs(fill.weight - outline.weight) < outline.weight / 100]).toEqual([label, true, true]);
          expect({ ...fill, name: "", weight: 0 }).toEqual({ ...outline, name: "", weight: 0 });
          continue;
        }
        expect([label, fill.width, fill.height]).toEqual([label, outline.width, outline.height]);
        expect([label, fill.weight > outline.weight]).toEqual([label, true]);
        expect([label, Math.abs(fill.left + fill.right - outline.left - outline.right) / 2 <= 1]).toEqual([label, true]);
        expect([label, Math.abs(fill.top + fill.bottom - outline.top - outline.bottom) / 2 <= 1]).toEqual([label, true]);
      }

      const output = process.env.FILLED_ICON_SHOTS;
      if (output) {
        mkdirSync(resolve(output, browserName), { recursive: true });
        await area.screenshot({ path: resolve(output, browserName, "filled-icons.png") });
      }
    } finally {
      await tab.close();
    }
  }, 30_000);
});
