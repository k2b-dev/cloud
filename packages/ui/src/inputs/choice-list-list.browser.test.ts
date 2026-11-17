import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "choice-list-list.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { ChoiceList, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => {
  const [value, setValue] = createSignal("return");
  const [note, setNote] = createSignal("");
  const [commits, setCommits] = createSignal(0);
  const icons = document.body.dataset.icons === "true";
  const long = document.body.dataset.long === "true";
  return [
    createComponent(ChoiceList, { variant: "list", label: "Warum noch nicht?", value, onValueChange: setValue,
      onValueCommit: () => setCommits(n => n + 1),
      options: [
        { value: "return", label: "Käufer gibt zurück", icon: icons ? "ti ti-package-export" : undefined },
        { value: "cancel", label: "Kauf wird abgebrochen", icon: icons ? "ti ti-x" : undefined },
        { value: "relist", label: "Wird neu eingestellt", icon: icons ? "ti ti-refresh" : undefined, disabled: true,
          description: long ? "RückgabeNochNichtAbgeschlossenBitteErstDenEingangDerWareBestätigen" : "Rückgabe steht noch aus" },
        { value: "other", label: "Anderer Grund", icon: icons ? "ti ti-dots" : undefined },
      ],
      get details() {
        if (value() === "cancel") return createComponent(TextInput, { label: "Rückfrage", multiline: true, lines: 3, value: note, onValueChange: setNote });
        return value() === "other" ? createComponent(TextInput, { label: "Grund", value: note, onValueChange: setNote }) : undefined;
      },
    }),
    () => { document.querySelector("#commits").textContent = String(commits()); return null; },
  ];
}, document.querySelector("#app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the framed ChoiceList fixture.");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (theme = "light", width = 1440, icons = false, long = false, touch = false) => {
  const page = await browser.newPage({ viewport: { width, height: 700 }, hasTouch: touch });
  await page.setContent(`<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
    <style>body{margin:0}main{box-sizing:border-box;padding:24px;max-width:560px}#app{margin-block:16px}h1{font-size:18px;margin:0}</style></head>
    <body class="k2b-ui" data-theme="${theme}" data-icons="${icons}" data-long="${long}"><main>
    <h1>Noch nicht abrechnen</h1><button id="before">Davor</button><div id="app"></div><button id="after">Danach</button><output hidden id="commits"></output>
    </main></body></html>`);
  await page.addScriptTag({ content: script });
  await page.getByRole("radio").last().waitFor();
  await settled(page);
  return page;
};
const boxes = (page: Page) =>
  page.getByRole("radio").evaluateAll((rows) =>
    rows.map((row) => {
      const { x, y, width, height } = row.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

for (const icons of [false, true]) {
  test(`framed list ${icons ? "with" : "without"} icons: keyboard, row clicks and external details keep all rows still`, async () => {
    const page = await load("light", 1440, icons);
    try {
      const radios = page.getByRole("radio");
      const frame = page.getByRole("radiogroup");
      const before = await boxes(page);
      await page.locator("#before").focus();
      await page.keyboard.press("Tab");
      expect(await radios.nth(0).evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator("#after").evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("ArrowDown");
      expect(await radios.nth(1).getAttribute("aria-checked")).toBe("true");
      await settled(page);
      const tallerDetails = (await page.locator(".k2b-choice-list__details").boundingBox())!.height;
      expect(await boxes(page)).toEqual(before);
      await page.keyboard.press("ArrowRight");
      expect(await radios.nth(3).getAttribute("aria-checked")).toBe("true");
      expect(await radios.nth(3).evaluate((node) => node === document.activeElement)).toBe(true);
      await settled(page);
      const details = page.locator(".k2b-choice-list__details");
      expect((await details.boundingBox())!.height).toBeLessThan(tallerDetails);
      expect(await details.evaluate((node) => node.previousElementSibling?.getAttribute("role"))).toBe("radiogroup");
      expect(await frame.locator(".k2b-choice-list__details").count()).toBe(0);
      const frameBox = (await frame.boundingBox())!;
      expect((await details.boundingBox())!.y).toBeGreaterThanOrEqual(frameBox.y + frameBox.height);
      expect(await boxes(page)).toEqual(before);
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      expect(await page.locator("#commits").textContent()).toBe("4");
      await page.keyboard.press("Tab");
      expect(await page.getByRole("textbox").evaluate((node) => node === document.activeElement)).toBe(true);
      await page.getByRole("textbox").fill("Absprache mit dem Käufer");
      await settled(page);
      expect(await boxes(page)).toEqual(before);
      // The far right padding is part of the choice, not just its radio or label.
      const row = (await radios.nth(0).boundingBox())!;
      await page.mouse.click(row.x + row.width - 4, row.y + row.height / 2);
      await settled(page);
      expect(await radios.nth(0).getAttribute("aria-checked")).toBe("true");
      expect(await details.count()).toBe(0);
      expect(await boxes(page)).toEqual(before);
      expect(await radios.nth(2).isDisabled()).toBe(true);
      await radios.nth(0).focus();
      await page.keyboard.press("ArrowUp");
      expect(await radios.nth(3).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("ArrowLeft");
      expect(await radios.nth(1).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Home");
      expect(await radios.nth(0).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("End");
      await settled(page);
      expect(await radios.nth(3).getAttribute("aria-checked")).toBe("true");
      expect(await boxes(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 30_000);
}

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    test(`${theme} ${width}: frame, selection, contrast, wrapping and touch targets`, async () => {
      const page = await load(theme, width, true, true, width === 390);
      try {
        const radios = page.getByRole("radio");
        const style = await radios.nth(0).evaluate((row) => {
          const s = getComputedStyle(row);
          const label = getComputedStyle(row.querySelector(".k2b-choice-list__label")!);
          const radio = row.querySelector(".k2b-choice-list__radio")!.getBoundingClientRect();
          const frame = getComputedStyle(row.parentElement!);
          const probe = document.createElement("span");
          row.append(probe);
          probe.style.background = "color-mix(in srgb, var(--k2b-selected) 50%, var(--k2b-surface))";
          const expected = getComputedStyle(probe).backgroundColor;
          const ctx = document.createElement("canvas").getContext("2d")!;
          const luminance = (color: string) => {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const channels = [...ctx.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((n) => n / 255)
              .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
            return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
          };
          const a = luminance(label.color),
            b = luminance(s.backgroundColor);
          probe.remove();
          return {
            fill: s.backgroundColor,
            expected,
            weight: label.fontWeight,
            size: label.fontSize,
            shadow: s.boxShadow,
            border: frame.borderTopWidth,
            overflow: frame.overflow,
            radio: [radio.width, radio.height],
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
        expect(style.fill).toBe(style.expected);
        expect(style.weight).toBe("600");
        expect(style.size).toBe("14px");
        expect(style.shadow).toBe("none");
        expect(style.border).toBe("1px");
        expect(style.overflow).toBe("hidden");
        expect(style.radio).toEqual([16, 16]);
        expect(style.contrast).toBeGreaterThanOrEqual(4.5);
        expect((await boxes(page))[0]!.height).toBe(width === 390 ? 44 : 38);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await radios.nth(2).evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
        expect(await radios.nth(2).locator(".k2b-choice-list__description").textContent()).toContain("RückgabeNochNicht");
        if (width === 1440) {
          const rest = await radios.nth(1).evaluate((row) => getComputedStyle(row).backgroundColor);
          await hoverInPlace(radios.nth(1));
          await settled(page);
          expect(await radios.nth(1).evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe(rest);
        }
        await page.keyboard.press("Tab");
        await radios.nth(0).focus();
        await settled(page);
        const focus = await radios.nth(0).evaluate((row) => {
          const s = getComputedStyle(row);
          return [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.boxShadow];
        });
        expect(focus).toEqual(["solid", "2px", "-2px", "none"]);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await settled(page);
        expect(await radios.nth(0).evaluate((row) => Number.parseFloat(getComputedStyle(row).transitionDuration))).toBe(0);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}
