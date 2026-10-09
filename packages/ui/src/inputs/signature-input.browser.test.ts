import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Pointer capture, coalesced pen samples, SVG screen matrices, and box sizes only exist in a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");

setDefaultTimeout(30_000);

const entry = resolve(import.meta.dir, "signature-input.fixture.ts");
const fixtureSource = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { LocaleProvider, SignatureInput, signatureToPng } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [value, setValue] = createSignal(null);
const [disabled, setDisabled] = createSignal(false);
window.changes = [];
window.commits = [];
window.setValue = (next) => setValue(next);
window.setDisabled = (next) => setDisabled(next);
window.current = () => value();
window.png = async () => {
  const url = await signatureToPng(value(), { scale: 1, background: "#ffffff" });
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 128) ink += 1;
  return { prefix: url.slice(0, 22), width: image.width, height: image.height, ink };
};
const form = document.createElement("form");
form.id = "form";
document.getElementById("app").append(form);
render(
  () =>
    createComponent(LocaleProvider, {
      locale: document.documentElement.lang,
      get children() {
        return createComponent(SignatureInput, {
          label: document.documentElement.lang === "de" ? "Unterschrift" : "Signature",
          description: "Bestätigt die Übergabe.",
          name: "signature",
          required: true,
          value,
          get disabled() { return disabled(); },
          onValueChange: (next) => { window.changes.push(next); setValue(next); },
          onValueCommit: (next) => window.commits.push(next),
        });
      },
    }),
  form,
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the SignatureInput fixture for the browser.");
const script = await build.outputs[0]!.text();

type Value = { kind: "drawn"; svg: string } | { kind: "typed"; name: string; svg: string } | null;
type FixtureWindow = Window & {
  changes: Value[];
  commits: Value[];
  setValue: (value: Value) => void;
  setDisabled: (disabled: boolean) => void;
  current: () => Value;
  png: () => Promise<{ prefix: string; width: number; height: number; ink: number }>;
};

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      const lang = url.searchParams.get("lang") ?? "de";
      const theme = url.searchParams.get("theme") === "dark" ? ' data-theme="dark"' : "";
      return new Response(
        `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"${theme} style="margin:0;padding:16px"><div id="app"></div><script src="/fixture.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (options: BrowserContextOptions = { viewport: { width: 800, height: 700 } }, query = "") => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${server.url.href}?${query}`);
  await page.waitForSelector(".k2b-signature-input__canvas");
  return page;
};
/** Runs a function against the fixture window; it is serialized, so it may not close over test variables. */
const fixture = <T>(page: Page, run: (window: FixtureWindow) => T | Promise<T>): Promise<T> => page.evaluate(`(${run.toString()})(window)`);
const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`${selector} has no box`);
  return rect;
};
const layout = (page: Page) =>
  page.evaluate(() =>
    [".k2b-field", ".k2b-signature-input__toolbar", ".k2b-signature-input__pad"].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? [rect.top, rect.height, rect.width].map(Math.round) : null;
    }),
  );

/** Draws one stroke of pointer events in the pad, with pressure for a pen. */
const stroke = async (page: Page, pointerType: "mouse" | "pen" | "touch", points: [number, number][], pressure = 0.5) => {
  const pad = await box(page, ".k2b-signature-input__canvas");
  await page.evaluate(
    ({ pointerType, points, pressure, pad }) => {
      const canvas = document.querySelector(".k2b-signature-input__canvas");
      if (!canvas) throw new Error("no canvas");
      const fire = (type: string, [x, y]: [number, number]) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType,
            isPrimary: true,
            button: type === "pointermove" ? -1 : 0,
            buttons: type === "pointerup" ? 0 : 1,
            pressure: type === "pointerup" ? 0 : pressure,
            clientX: pad.x + x,
            clientY: pad.y + y,
          }),
        );
      const [first, ...rest] = points;
      if (!first) return;
      fire("pointerdown", first);
      for (const point of rest) fire("pointermove", point);
      fire("pointerup", rest.at(-1) ?? first);
    },
    { pointerType, points, pressure, pad },
  );
};
const wave: [number, number][] = [
  [40, 90],
  [70, 60],
  [100, 100],
  [130, 55],
  [160, 95],
  [200, 70],
  [240, 80],
];

describe(`SignatureInput in ${browserName}`, () => {
  test("a mouse stroke reports one drawn SVG path, commits it, and fills the hidden form value", async () => {
    const page = await open();
    expect(await page.locator(".k2b-signature-input__placeholder").textContent()).toBe("Hier unterschreiben");
    await stroke(page, "mouse", wave);
    const value = await fixture(page, (window) => window.current());
    expect(value?.kind).toBe("drawn");
    expect(value?.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(value?.svg.match(/<path /g)?.length).toBe(1);
    expect(await fixture(page, (window) => window.commits.length)).toBe(1);
    const submitted = await page.evaluate(() => new FormData(document.querySelector("form") ?? undefined).get("signature"));
    expect(JSON.parse(String(submitted))).toEqual(value);
    expect(await page.locator(".k2b-signature-input__canvas").getAttribute("aria-label")).toBe("Gezeichnete Unterschrift");
    // The "Sign here" hint fades out once there is ink.
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".k2b-signature-input__placeholder") ?? document.body).opacity === "0",
    );
    await page.context().close();
  });

  test("pen pressure widens the ink, and Undo and Clear remove strokes", async () => {
    const page = await open();
    await stroke(page, "pen", wave, 0.1);
    const light = (await fixture(page, (window) => window.current()))?.svg ?? "";
    await page.getByRole("button", { name: "Leeren" }).click();
    expect(await fixture(page, (window) => window.current())).toBeNull();
    await stroke(page, "pen", wave, 1);
    const firm = (await fixture(page, (window) => window.current()))?.svg ?? "";
    const area = (svg: string) =>
      page.evaluate((svg) => {
        const host = document.createElement("div");
        host.innerHTML = svg;
        document.body.append(host);
        const size = host.querySelector("path")?.getBBox();
        host.remove();
        return size ? size.height : 0;
      }, svg);
    expect(await area(firm)).toBeGreaterThan(await area(light));

    await stroke(page, "touch", [
      [60, 120],
      [220, 120],
    ]);
    expect((await fixture(page, (window) => window.current()))?.svg.match(/<path /g)?.length).toBe(2);
    await page.getByRole("button", { name: "Rückgängig" }).click();
    expect((await fixture(page, (window) => window.current()))?.svg).toBe(firm);
    await page.getByRole("button", { name: "Rückgängig" }).click();
    expect(await fixture(page, (window) => window.current())).toBeNull();
    expect(await page.getByRole("button", { name: "Rückgängig" }).isDisabled()).toBeTrue();
    await page.context().close();
  });

  test("the keyboard reaches typing, which reports the name with an SVG in the handwriting face", async () => {
    const page = await open();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Zeichnen");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Namen eintippen");
    await page.keyboard.type("Ada <Lovelace>");
    const value = await fixture(page, (window) => window.current());
    expect(value).toMatchObject({ kind: "typed", name: "Ada <Lovelace>" });
    expect(value?.svg).toContain(">Ada &lt;Lovelace&gt;</text>");
    // Engines serialize the computed family list with or without quotes.
    expect(value?.svg).toMatch(/font-family="(?:&quot;)?Segoe Script/);
    const group = page.getByRole("group", { name: "Unterschrift" });
    expect(await group.getAttribute("aria-describedby")).toContain("description");
    await page.keyboard.press("Tab");
    expect(await fixture(page, (window) => window.commits.at(-1))).toEqual(value);
    await page.context().close();
  });

  test("switching modes, drawing, and typing never move the field or change its size", async () => {
    const page = await open();
    const before = await layout(page);
    await stroke(page, "mouse", wave);
    expect(await layout(page)).toEqual(before);
    await page.getByRole("radio", { name: "Tippen" }).click();
    expect(await layout(page)).toEqual(before);
    expect(await fixture(page, (window) => window.current())).toBeNull();
    await page.getByLabel("Namen eintippen").fill("Grace Hopper");
    expect(await layout(page)).toEqual(before);
    await page.getByRole("radio", { name: "Zeichnen" }).click();
    expect(await layout(page)).toEqual(before);
    // The drawing was kept while typing, so drawing again reports it.
    expect((await fixture(page, (window) => window.current()))?.kind).toBe("drawn");
    await fixture(page, (window) => window.setDisabled(true));
    expect(await layout(page)).toEqual(before);
    await page.context().close();
  });

  test("a value set by the application replaces the drawing, and null resets it", async () => {
    const page = await open();
    await stroke(page, "mouse", wave);
    const drawn = await fixture(page, (window) => window.current());
    await fixture(page, (window) => window.setValue(null));
    expect(await page.locator(".k2b-signature-input__canvas path").count()).toBe(0);
    await fixture(page, (window) => window.setValue({ kind: "typed", name: "Ada", svg: '<svg viewBox="0 0 10 10"></svg>' }));
    expect(await page.getByLabel("Namen eintippen").inputValue()).toBe("Ada");
    await page.evaluate((value) => (window as unknown as FixtureWindow).setValue(value), drawn);
    expect(await page.locator(".k2b-signature-input__canvas path").count()).toBe(1);
    // A restored drawing can be extended.
    await stroke(page, "mouse", [
      [60, 120],
      [220, 120],
    ]);
    expect((await fixture(page, (window) => window.current()))?.svg.match(/<path /g)?.length).toBe(2);
    await page.context().close();
  });

  test("disabled stops drawing", async () => {
    const page = await open();
    await fixture(page, (window) => window.setDisabled(true));
    await stroke(page, "mouse", wave);
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    expect(await page.getByRole("radio", { name: "Tippen" }).isDisabled()).toBeTrue();
    await page.context().close();
  });

  test("signatureToPng rasterizes the drawn ink", async () => {
    const page = await open();
    await stroke(page, "mouse", wave);
    const png = await fixture(page, (window) => window.png());
    const pad = await box(page, ".k2b-signature-input__canvas");
    expect(png.prefix).toBe("data:image/png;base64,");
    expect([png.width, png.height]).toEqual([Math.round(pad.width), Math.round(pad.height)]);
    expect(png.ink).toBeGreaterThan(50);
    await page.context().close();
  });

  test("phones keep a usable pad in portrait and landscape, and the page does not scroll while drawing", async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const page = await open({ viewport, isMobile: browserName === "chromium", hasTouch: true }, "lang=en");
      const pad = await box(page, ".k2b-signature-input__pad");
      expect(pad.height).toBeGreaterThanOrEqual(144);
      expect(pad.height).toBeLessThanOrEqual(224);
      expect(pad.x + pad.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.locator(".k2b-signature-input__canvas").evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
      expect(await page.locator(".k2b-signature-input__placeholder").textContent()).toBe("Sign here");
      await page.context().close();
    }
  });
});
