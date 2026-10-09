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

const search = new URLSearchParams(location.search);
const [value, setValue] = createSignal(null);
const [disabled, setDisabled] = createSignal(false);
const [readOnly, setReadOnly] = createSignal(false);
window.changes = [];
window.commits = [];
window.setValue = (next) => setValue(next);
window.setDisabled = (next) => setDisabled(next);
window.setReadOnly = (next) => setReadOnly(next);
window.current = () => value();
// The pointer that went down last, so a test can take its capture away.
document.addEventListener("pointerdown", (event) => { window.lastPointer = event.pointerId; }, true);
window.pngError = (svg) => signatureToPng({ kind: "typed", name: "x", svg }).then(() => "", (error) => error.message);
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
// A page taller than the screen, so a test can tell whether a swipe scrolls it.
if (search.has("tall")) document.getElementById("app").style.minHeight = "300vh";
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
          allowTyped: search.get("allowTyped") !== "0",
          value,
          get disabled() { return disabled(); },
          get readOnly() { return readOnly(); },
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
  setReadOnly: (readOnly: boolean) => void;
  current: () => Value;
  lastPointer: number;
  png: () => Promise<{ prefix: string; width: number; height: number; ink: number }>;
  pngError: (svg: string) => Promise<string>;
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

/**
 * Dispatches one stroke of pointer events at the pad. Playwright has no pen, so pressure, pen buttons, and a pen next to
 * a touch use these events; they bypass hit testing and pointer capture, which `drawWithMouse` and `touch` cover.
 */
const stroke = async (
  page: Page,
  pointerType: "mouse" | "pen" | "touch",
  points: [number, number][],
  pressure = 0.5,
  { button = 0, pointerId = 7, down = true, up = true }: { button?: number; pointerId?: number; down?: boolean; up?: boolean } = {},
) => {
  const pad = await box(page, ".k2b-signature-input__canvas");
  await page.evaluate(
    ({ pointerType, points, pressure, pad, button, pointerId, down, up }) => {
      const canvas = document.querySelector(".k2b-signature-input__canvas");
      if (!canvas) throw new Error("no canvas");
      const fire = (type: string, [x, y]: [number, number]) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType,
            isPrimary: pointerId === 7,
            button: type === "pointermove" ? -1 : button,
            buttons: type === "pointerup" ? 0 : 1,
            pressure: type === "pointerup" ? 0 : pressure,
            clientX: pad.x + x,
            clientY: pad.y + y,
          }),
        );
      const [first, ...rest] = points;
      if (!first) return;
      if (down) fire("pointerdown", first);
      for (const point of rest) fire("pointermove", point);
      if (up) fire("pointerup", rest.at(-1) ?? first);
    },
    { pointerType, points, pressure, pad, button, pointerId, down, up },
  );
};
/** Moves the real mouse through points relative to the pad, so hit testing and pointer capture take part. */
const drawWithMouse = async (page: Page, points: [number, number][], { up = true }: { up?: boolean } = {}) => {
  const pad = await box(page, ".k2b-signature-input__canvas");
  const [first, ...rest] = points;
  if (!first) return;
  await page.mouse.move(pad.x + first[0], pad.y + first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(pad.x + x, pad.y + y, { steps: 3 });
  if (up) await page.mouse.up();
};
/** Swipes a finger through Chromium's input protocol, which Playwright offers for moving touches; WebKit only gets taps. */
const swipe = async (page: Page, from: [number, number], to: [number, number], end: "touchEnd" | "touchCancel" = "touchEnd") => {
  const cdp = await page.context().newCDPSession(page);
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
  for (let step = 1; step <= steps; step++) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps;
    const y = from[1] + ((to[1] - from[1]) * step) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: end, touchPoints: [] });
};
const inkPaths = (page: Page) => page.locator(".k2b-signature-input__canvas path").count();
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
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
    await drawWithMouse(page, wave);
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

  test("pointer capture keeps a stroke that leaves the pad and ends outside it", async () => {
    const page = await open();
    const pad = await box(page, ".k2b-signature-input__canvas");
    await drawWithMouse(page, [
      [40, 60],
      [pad.width - 20, 80],
      [pad.width + 60, pad.height + 80],
    ]);
    expect(await fixture(page, (window) => window.commits.length)).toBe(1);
    expect((await fixture(page, (window) => window.current()))?.kind).toBe("drawn");
    expect(await page.locator(".k2b-signature-input__canvas path").count()).toBe(1);
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

  test("a pen's barrel button and eraser do not draw, and a pen takes over from a resting palm", async () => {
    const page = await open();
    await stroke(page, "pen", wave, 0.5, { button: 2 });
    await stroke(page, "pen", wave, 0.5, { button: 5 });
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    // A palm lands first and stays down; the pen's stroke still draws, and the palm's later release adds nothing.
    await stroke(page, "touch", [[20, 20]], 0.5, { up: false });
    await stroke(page, "pen", wave, 0.5, { pointerId: 8 });
    await stroke(page, "touch", [[20, 20]], 0.5, { down: false });
    expect(await fixture(page, (window) => window.commits.length)).toBe(1);
    expect((await fixture(page, (window) => window.current()))?.svg.match(/<path /g)?.length).toBe(1);
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

  test("Clear and the last Undo keep keyboard focus in the field", async () => {
    const page = await open();
    for (const name of ["Leeren", "Rückgängig"]) {
      await drawWithMouse(page, wave);
      await page.getByRole("radio", { name: "Zeichnen" }).focus();
      // Tab from the mode switch, so the button gets focus the way a keyboard user gives it.
      await page.keyboard.press("Tab");
      if (name === "Leeren") await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(name);
      await page.keyboard.press("Enter");
      expect(await fixture(page, (window) => window.current())).toBeNull();
      await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-signature-input__canvas"), undefined, {
        timeout: 5_000,
      });
    }
    await page.context().close();
  });

  test("switching modes, drawing, and typing never move the field or change its size", async () => {
    const page = await open();
    const before = await layout(page);
    await drawWithMouse(page, wave);
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

  test("a value set by the application replaces both inputs, and null resets them", async () => {
    const page = await open();
    await drawWithMouse(page, wave);
    const drawn = await fixture(page, (window) => window.current());
    await fixture(page, (window) => window.setValue(null));
    expect(await inkPaths(page)).toBe(0);
    await drawWithMouse(page, wave);
    // Another record's typed value arrives: the earlier signer's drawing does not come back behind the switch.
    await fixture(page, (window) => window.setValue({ kind: "typed", name: "Bob", svg: '<svg viewBox="0 0 10 10"></svg>' }));
    expect(await page.getByLabel("Namen eintippen").inputValue()).toBe("Bob");
    await page.getByRole("radio", { name: "Zeichnen" }).click();
    expect(await fixture(page, (window) => window.current())).toBeNull();
    expect(await inkPaths(page)).toBe(0);
    // And the other way round: a drawn value replaces a typed name.
    await page.getByRole("radio", { name: "Tippen" }).click();
    await page.getByLabel("Namen eintippen").fill("Alice");
    await page.evaluate((value) => (window as unknown as FixtureWindow).setValue(value), drawn);
    expect(await inkPaths(page)).toBe(1);
    await page.getByRole("radio", { name: "Tippen" }).click();
    expect(await page.getByLabel("Namen eintippen").inputValue()).toBe("");
    expect(await fixture(page, (window) => window.current())).toBeNull();
    // A restored drawing can be extended.
    await page.evaluate((value) => (window as unknown as FixtureWindow).setValue(value), drawn);
    await drawWithMouse(page, [
      [60, 120],
      [220, 120],
    ]);
    expect((await fixture(page, (window) => window.current()))?.svg.match(/<path /g)?.length).toBe(2);
    await page.context().close();
  });

  test("a stroke in progress ends without a value when the field is disabled, reset, or switched to typing", async () => {
    const page = await open();
    await drawWithMouse(page, wave, { up: false });
    await fixture(page, (window) => window.setDisabled(true));
    expect(await inkPaths(page)).toBe(0);
    await page.mouse.move(400, 200);
    await page.mouse.up();
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    await fixture(page, (window) => window.setDisabled(false));

    await drawWithMouse(page, wave);
    await drawWithMouse(page, wave, { up: false });
    await fixture(page, (window) => window.setValue(null));
    await page.mouse.up();
    expect(await fixture(page, (window) => window.current())).toBeNull();
    expect(await inkPaths(page)).toBe(0);

    // The pad leaves while the button is down and the release happens elsewhere; drawing works again afterwards.
    await drawWithMouse(page, wave, { up: false });
    await fixture(page, (window) => window.setValue({ kind: "typed", name: "Ada", svg: "" }));
    await page.mouse.up();
    await page.getByRole("radio", { name: "Zeichnen" }).click();
    await drawWithMouse(page, wave);
    expect((await fixture(page, (window) => window.current()))?.svg.match(/<path /g)?.length).toBe(1);
    await page.context().close();
  });

  test("a stroke whose pointer capture is taken away is dropped, and the pad keeps working", async () => {
    const page = await open();
    await drawWithMouse(page, wave, { up: false });
    await page.evaluate(() => {
      const canvas = document.querySelector(".k2b-signature-input__canvas");
      canvas?.releasePointerCapture((window as unknown as FixtureWindow).lastPointer);
    });
    // Without capture, the release outside the pad never reaches it.
    await page.mouse.move(10, 10);
    await page.mouse.up();
    expect(await inkPaths(page)).toBe(0);
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    await drawWithMouse(page, wave);
    expect(await fixture(page, (window) => window.commits.length)).toBe(1);
    await page.context().close();
  });

  test("ink drawn after the pad changed its shape stays in the stored SVG, and earlier ink does not move", async () => {
    const page = await open({ viewport: { width: 390, height: 844 } });
    await drawWithMouse(page, wave);
    const firstPath = () => page.locator(".k2b-signature-input__canvas path").first().boundingBox();
    await page.setViewportSize({ width: 844, height: 390 });
    const pad = await box(page, ".k2b-signature-input__canvas");
    const before = await firstPath();
    // The rotated pad is wider than the drawing, so this stroke lies in the margin beside it.
    await drawWithMouse(page, [
      [pad.width - 200, 40],
      [pad.width - 120, 90],
      [pad.width - 30, 50],
    ]);
    const after = await firstPath();
    for (const key of ["x", "y", "width", "height"] as const) expect(after?.[key]).toBeCloseTo(before?.[key] ?? Number.NaN, 2);
    const value = await fixture(page, (window) => window.current());
    const fits = await page.evaluate((svg) => {
      const host = document.createElement("div");
      host.innerHTML = svg;
      document.body.append(host);
      const root = host.querySelector("svg");
      const view = root?.viewBox.baseVal;
      const boxes = [...host.querySelectorAll("path")].map((path) => path.getBBox());
      host.remove();
      if (!view) return null;
      return boxes.map(
        (size) =>
          size.x >= view.x - 0.2 &&
          size.y >= view.y - 0.2 &&
          size.x + size.width <= view.x + view.width + 0.2 &&
          size.y + size.height <= view.y + view.height + 0.2,
      );
    }, value?.svg ?? "");
    expect(fits).toEqual([true, true]);
    const png = await fixture(page, (window) => window.png());
    expect(png.ink).toBeGreaterThan(100);
    await page.context().close();
  });

  test("disabled stops drawing", async () => {
    const page = await open();
    await fixture(page, (window) => window.setDisabled(true));
    await drawWithMouse(page, wave);
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    expect(await page.getByRole("radio", { name: "Tippen" }).isDisabled()).toBeTrue();
    await page.context().close();
  });

  test("without the Type option, a typed value shows read-only and Clear returns to drawing", async () => {
    const page = await open(undefined, "allowTyped=0");
    await fixture(page, (window) => window.setValue({ kind: "typed", name: "Ada", svg: "" }));
    const name = page.getByLabel("Namen eintippen");
    expect(await name.inputValue()).toBe("Ada");
    expect(await name.getAttribute("readonly")).not.toBeNull();
    await page.getByRole("button", { name: "Leeren" }).click();
    expect(await fixture(page, (window) => window.current())).toBeNull();
    await drawWithMouse(page, wave);
    expect((await fixture(page, (window) => window.current()))?.kind).toBe("drawn");
    await page.context().close();
  });

  test("signatureToPng rasterizes the drawn ink, and refuses a size the browser cannot draw", async () => {
    const page = await open();
    await drawWithMouse(page, wave);
    const png = await fixture(page, (window) => window.png());
    const pad = await box(page, ".k2b-signature-input__canvas");
    expect(png.prefix).toBe("data:image/png;base64,");
    expect([png.width, png.height]).toEqual([Math.round(pad.width), Math.round(pad.height)]);
    expect(png.ink).toBeGreaterThan(50);
    const huge =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000" width="100000" height="100000"><text x="12" y="55" font-size="48" fill="currentColor">x</text></svg>';
    expect(await page.evaluate((svg) => (window as unknown as FixtureWindow).pngError(svg), huge)).toBe(
      "The signature is too large for a PNG at this scale.",
    );
    await page.context().close();
  });

  test("phones keep a usable pad in portrait and landscape, and only an editable pad holds touches", async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const page = await open({ viewport, isMobile: browserName === "chromium", hasTouch: true }, "lang=en");
      const pad = await box(page, ".k2b-signature-input__pad");
      expect(pad.height).toBeGreaterThanOrEqual(144);
      expect(pad.height).toBeLessThanOrEqual(224);
      expect(pad.x + pad.width).toBeLessThanOrEqual(viewport.width);
      const touchAction = () => page.locator(".k2b-signature-input__canvas").evaluate((element) => getComputedStyle(element).touchAction);
      expect(await touchAction()).toBe("none");
      await fixture(page, (window) => window.setReadOnly(true));
      expect(await touchAction()).toBe("auto");
      await fixture(page, (window) => window.setReadOnly(false));
      await fixture(page, (window) => window.setDisabled(true));
      expect(await touchAction()).toBe("auto");
      expect(await page.locator(".k2b-signature-input__placeholder").textContent()).toBe("Sign here");
      await page.context().close();
    }
  });

  test.skipIf(browserName === "webkit")(
    "a finger draws on an editable pad without scrolling, and scrolls the page over a read-only one",
    async () => {
      for (const readOnly of [false, true]) {
        const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "lang=en&tall");
        if (readOnly) await fixture(page, (window) => window.setReadOnly(true));
        await frames(page);
        const pad = await box(page, ".k2b-signature-input__canvas");
        await swipe(page, [pad.x + 100, pad.y + pad.height - 20], [pad.x + 140, pad.y + 20]);
        await frames(page);
        if (readOnly) {
          await page.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 5_000 });
          expect(await fixture(page, (window) => window.changes.length)).toBe(0);
        } else {
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
          expect((await fixture(page, (window) => window.current()))?.kind).toBe("drawn");
        }
        await page.context().close();
      }
    },
  );

  test.skipIf(browserName === "webkit")("a cancelled touch is not a stroke", async () => {
    const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "lang=en");
    const pad = await box(page, ".k2b-signature-input__canvas");
    await swipe(page, [pad.x + 40, pad.y + 40], [pad.x + 240, pad.y + 90], "touchCancel");
    expect(await inkPaths(page)).toBe(0);
    expect(await fixture(page, (window) => window.changes.length)).toBe(0);
    await swipe(page, [pad.x + 40, pad.y + 40], [pad.x + 240, pad.y + 90]);
    expect(await fixture(page, (window) => window.commits.length)).toBe(1);
    await page.context().close();
  });
});
