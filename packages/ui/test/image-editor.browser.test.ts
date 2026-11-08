import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../test/browser";

setDefaultTimeout(30_000);
const { transformAsync } = await import("@babel/core");
const typescript = (await import("@babel/preset-typescript")).default;
const solid = (await import("babel-preset-solid")).default;
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "image-editor.fixture.tsx")],
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [
    {
      name: "solid-image-editor-test",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
          });
          if (!result?.code) throw new Error(`Could not compile ${path}`);
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Could not build public ImageEditor fixture");
const script = await build.outputs[0]!.text();
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/editor.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/styles.css") return new Response(Bun.file(resolve(import.meta.dir, "../dist/styles.css")));
      if (url.pathname === "/photo.jpg" || url.pathname === "/logo.png")
        return new Response(Bun.file(resolve(import.meta.dir, `../src/inputs/image-editor/fixtures${url.pathname}`)));
      return new Response(
        `<!doctype html><html lang="${url.searchParams.get("locale") === "de" ? "de" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" data-theme="light" style="margin:0"><div data-nav-shell="editor-test" data-nav-scope="/"><a href="/destination" id="destination-link" ${url.searchParams.has("nav") ? "" : "hidden"}>Destination</a><main data-nav-root data-path="${url.pathname}"><div id="editor" style="height:calc(100dvh - 1rem);min-height:34rem"></div></main></div><script src="/editor.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
const open = async (query = "", width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  await page.goto(`${server.url}?${query}`);
  await page.locator(".k2b-image-editor__save button").first().waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__actions button")?.disabled);
  await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>(".k2b-image-editor__image > canvas")?.width ?? 0) > 1);
  await settled(page);
  return { page, errors };
};
const dirty = (page: Page) => page.locator(".k2b-image-editor").getAttribute("data-dirty");
const fixture = (page: Page, expression: string) => page.evaluate(`window.editorFixture.${expression}`);
const slider = async (page: Page, name: string, values: number[]) => {
  await page.getByRole("slider", { name, exact: true }).evaluate((element, values) => {
    const input = element as HTMLInputElement;
    for (const value of values) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, values);
};
const selectTool = async (page: Page, name: string) => {
  await page.getByRole("tab", { name, exact: true }).click();
  await settled(page);
};
const markTool = (page: Page, name: string | RegExp) =>
  page.getByRole("radiogroup", { name: "Tool", exact: true }).getByRole("radio", { name, exact: typeof name === "string" });
const canvasBox = (page: Page) => page.locator(".k2b-image-editor__canvas").boundingBox();
const imageBox = async (page: Page) => (await page.locator(".k2b-image-editor__image").boundingBox())!;
const drag = async (page: Page, from: [number, number], to: [number, number], settle = true) => {
  const image = await imageBox(page);
  await page.mouse.move(image.x + image.width * from[0], image.y + image.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(image.x + image.width * to[0], image.y + image.height * to[1], { steps: 6 });
  await page.mouse.up();
  if (settle) await settled(page);
};
const centerPixel = (page: Page, x = 0.3, y = 0.3) =>
  page
    .locator(".k2b-image-editor__image > canvas")
    .first()
    .evaluate(
      (element, [x, y]) => {
        const target = element as HTMLCanvasElement;
        return [...target.getContext("2d")!.getImageData(Math.floor(target.width * x!), Math.floor(target.height * y!), 1, 1).data];
      },
      [x, y],
    );

describe("public ImageEditor interactions", () => {
  test("caller save actions expose only browser-verified permitted encoders", async () => {
    const { page, errors } = await open("actions=1&pngOnly=1");
    try {
      await page.waitForFunction("window.editorFixture.formats().length > 0");
      expect(await fixture(page, "formats()")).toEqual(["image/png"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("confirmed dirty click and Back use enhanced navigation without adding a document load", async () => {
    for (const back of [false, true]) {
      const { page, errors } = await open("nav=1");
      try {
        const before = await page.evaluate(() => {
          Object.assign(window, { navigationSentinel: true });
          return history.length;
        });
        const entryIndex = await page.evaluate<number | undefined>("window.navigation?.currentEntry?.index");
        await selectTool(page, "Crop");
        await page.getByRole("button", { name: "Mirror", exact: true }).click();
        if (back) await page.evaluate(() => history.back());
        else await page.locator("#destination-link").click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("dialog[open]"));
        expect(new URL(page.url()).pathname).toBe("/editing");
        expect(await dirty(page)).toBe("true");
        if (back) await page.evaluate(() => history.back());
        else await page.locator("#destination-link").click();
        await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
        await page.waitForFunction(
          (path) => document.querySelector("[data-nav-root]")?.getAttribute("data-path") === path,
          back ? "/" : "/destination",
        );
        expect(await page.evaluate<boolean>("window.navigationSentinel")).toBe(true);
        expect(new URL(page.url()).pathname).toBe(back ? "/" : "/destination");
        if (back) {
          expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
          if (entryIndex !== undefined) expect(await page.evaluate<number>("window.navigation.currentEntry.index")).toBe(entryIndex - 1);
        }
        await fixture(page, "dispose()");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

  test("locked widescreen survives rotation and export", async () => {
    const { page, errors } = await open("minimal=1&wide=1");
    try {
      expect(await page.getByRole("tab").count()).toBe(1);
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.editorFixture.results.length === 1");
      const ratio = await page.evaluate<number>("window.editorFixture.results[0].width / window.editorFixture.results[0].height");
      expect(Math.abs(ratio - 16 / 9)).toBeLessThan(0.005);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("aspect choice and orientation undo together with keyboard crop sizing", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Crop");
      const aspects = page.getByRole("radiogroup", { name: "Aspect ratio", exact: true });
      const choose = (name: string) => aspects.getByRole("radio", { name, exact: true }).click();
      await choose("1:1");
      await choose("16:9");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await aspects.getByRole("radio", { name: "1:1", exact: true }).getAttribute("aria-checked")).toBe("true");
      const crop = page.locator(".k2b-image-editor__crop-move");
      await crop.focus();
      await page.keyboard.press("Shift+ArrowLeft");
      await settled(page);
      const box = (await page.locator(".k2b-image-editor__crop").boundingBox())!;
      expect(Math.abs(box.width / box.height - 1)).toBeLessThan(0.01);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await choose("16:9");
      await page.getByRole("button", { name: "Portrait/landscape", exact: true }).click();
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await crop.focus();
      await page.keyboard.press("Shift+ArrowLeft");
      await settled(page);
      const restored = (await page.locator(".k2b-image-editor__crop").boundingBox())!;
      expect(Math.abs(restored.width / restored.height - 16 / 9)).toBeLessThan(0.01);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("portrait previews keep their aspect, fit inside the overlays and lossless output hides quality", async () => {
    for (const width of [1440, 390]) {
      const { page, errors } = await open("", width);
      try {
        const source = await page.evaluate(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 300;
          canvas.height = 600;
          canvas.getContext("2d")!.fillRect(0, 0, 300, 600);
          return canvas.toDataURL();
        });
        await page.evaluate((source) => Object.assign(window, { portrait: source }), source);
        await fixture(page, "source(window.portrait)");
        await page.locator(".k2b-image-editor").getByText("300 × 600 px", { exact: true }).first().waitFor({ state: "attached" });
        await settled(page);
        const image = await imageBox(page);
        expect(Math.abs(image.width / image.height - 0.5)).toBeLessThan(0.01);
        // Fit keeps the whole photo clear of the chips, the view bar and the tool pane.
        for (const overlay of [".k2b-image-editor__chips", ".k2b-image-editor__bottom", ".k2b-image-editor__pane"]) {
          const box = (await page.locator(overlay).boundingBox())!;
          const overlaps =
            image.x < box.x + box.width && image.x + image.width > box.x && image.y < box.y + box.height && image.y + image.height > box.y;
          if (overlay !== ".k2b-image-editor__chips" || width > 600) expect(overlaps, overlay).toBe(false);
        }
        expect(
          await page
            .locator(".k2b-image-editor__look-thumb canvas")
            .evaluateAll((canvases) =>
              canvases.every((element) => (element as HTMLCanvasElement).width / (element as HTMLCanvasElement).height === 0.5),
            ),
        ).toBe(true);
        if (width > 600) {
          await page.locator(".k2b-image-editor__output-trigger").click();
          await page.getByRole("dialog", { name: "Output" }).waitFor();
          expect(await page.getByRole("slider", { name: "Quality", exact: true }).count()).toBe(0);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

  test("dark desktop and phone keep every tool reachable without moving the canvas", async () => {
    for (const width of [1440, 390]) {
      const { page, errors } = await open("dark=1", width);
      try {
        const before = await canvasBox(page);
        for (const tool of ["Crop", "Adjust", "Mark up"]) {
          await selectTool(page, tool);
          expect(await page.getByRole("tab", { name: tool, exact: true }).getAttribute("aria-selected")).toBe("true");
          expect(await page.locator(".k2b-image-editor__tabs").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
          expect(await canvasBox(page)).toEqual(before);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

  test("inherits German and keeps the phone canvas still across tools and errors", async () => {
    const { page, errors } = await open("locale=de&failure=1", 390);
    try {
      const before = await canvasBox(page);
      await page.getByRole("radio", { name: /^Helligkeit/ }).click();
      await slider(page, "Helligkeit", [20]);
      await page.getByRole("button", { name: "Fertig", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Upload unavailable" }).first().waitFor();
      expect(await canvasBox(page)).toEqual(before);
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).first().isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("all approved looks and strength participate in shared history", async () => {
    const { page, errors } = await open();
    try {
      const looks = page.getByRole("radiogroup", { name: "Look", exact: true }).first();
      for (const label of ["Mono hard", "Faded", "Vintage"]) {
        await looks.getByRole("radio", { name: label, exact: true }).click();
        expect(await looks.getByRole("radio", { name: label, exact: true }).getAttribute("aria-checked")).toBe("true");
      }
      await slider(page, "Strength", [80, 60, 40]);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await page.getByRole("slider", { name: "Strength", exact: true }).inputValue()).toBe("100");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await looks.getByRole("radio", { name: "Faded", exact: true }).getAttribute("aria-checked")).toBe("true");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("Auto moves the sliders as one undo step, marks them and leaves them free", async () => {
    const { page, errors } = await open();
    try {
      const values = () =>
        Promise.all(
          ["Brightness", "Contrast", "Saturation", "Warmth"].map((name) =>
            page.getByRole("slider", { name: new RegExp(`^${name}`) }).inputValue(),
          ),
        );
      expect(await values()).toEqual(["0", "0", "0", "0"]);
      await page.getByRole("button", { name: "Auto", exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector(".k2b-image-editor")?.getAttribute("data-dirty") === "true");
      await settled(page);
      const auto = await values();
      expect(auto.some((value) => value !== "0")).toBe(true);
      expect(await page.locator(".k2b-image-editor__adjust-pane .k2b-image-editor__auto-tag[data-on]").count()).toBeGreaterThan(0);
      // Every slider stays free after Auto; moving one is its own undo step.
      const index = auto.findIndex((value) => value !== "0");
      const changed = page.getByRole("slider", { name: new RegExp(`^${["Brightness", "Contrast", "Saturation", "Warmth"][index]}`) });
      await changed.evaluate((element, value) => {
        const input = element as HTMLInputElement;
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, Number(auto[index]) + 5);
      expect(await changed.inputValue()).toBe(String(Number(auto[index]) + 5));
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await values()).toEqual(auto);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await values()).toEqual(["0", "0", "0", "0"]);
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("an edit during the Auto animation lands after Auto, each as one undo step", async () => {
    const { page, errors } = await open();
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const vivid = page.getByRole("radio", { name: "Vivid", exact: true });
      // Choose a look one frame into the 450 ms animation.
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            const buttons = [...document.querySelectorAll<HTMLButtonElement>(".k2b-image-editor button")];
            buttons.find((button) => button.textContent?.trim() === "Auto")!.click();
            requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>(".k2b-image-editor__look[role=radio]:nth-child(2)")!.click();
              done();
            });
          }),
      );
      await page.waitForTimeout(700);
      await settled(page);
      expect(await vivid.getAttribute("aria-checked")).toBe("true");
      const brightness = page.getByRole("slider", { name: /^Brightness/ });
      const contrast = page.getByRole("slider", { name: /^Contrast/ });
      const auto = [await brightness.inputValue(), await contrast.inputValue()];
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await vivid.getAttribute("aria-checked")).toBe("false");
      expect([await brightness.inputValue(), await contrast.inputValue()]).toEqual(auto);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("arrow keys move the look selection and focus together", async () => {
    const { page, errors } = await open();
    try {
      // Without other images the name is a plain label, not a dimmed control.
      expect(await page.locator(".k2b-image-editor__name").evaluate((element) => element.tagName)).toBe("SPAN");
      await page.getByRole("radio", { name: "Natural", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await settled(page);
      expect(await page.getByRole("radio", { name: "Vivid", exact: true }).getAttribute("aria-checked")).toBe("true");
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Vivid");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("upload rejection preserves edits, retry stays in place and awaits success", async () => {
    const { page, errors } = await open("failure=1");
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      await settled(page);
      const before = await canvasBox(page);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Upload unavailable" }).first().waitFor();
      expect(await dirty(page)).toBe("true");
      expect(await canvasBox(page)).toEqual(before);
      await fixture(page, 'mode = "success"');
      await page.getByRole("button", { name: "Try again", exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector(".k2b-image-editor")?.getAttribute("data-dirty") === "false");
      expect(await fixture(page, "attempts")).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a pending upload marks only the captured entry saved; undo reaches it", async () => {
    const { page, errors } = await open("", 390);
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      await fixture(page, 'mode = "pending"');
      await settled(page);
      const canvasBefore = await canvasBox(page);
      const chipsBefore = await page.locator(".k2b-image-editor__chips").boundingBox();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.editorFixture.attempts === 1");
      expect(await page.getByRole("button", { name: "Saving…", exact: true }).isDisabled()).toBe(true);
      await settled(page);
      expect(await canvasBox(page)).toEqual(canvasBefore);
      expect(await page.locator(".k2b-image-editor__chips").boundingBox()).toEqual(chipsBefore);
      // Editing continues while the upload is pending; only the captured entry becomes saved.
      await page.getByRole("button", { name: "Mirror", exact: true }).click();
      await fixture(page, "accept()");
      await page.getByRole("button", { name: "Done", exact: true }).waitFor();
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a slider gesture is one undo step and tools do not move the canvas", async () => {
    const { page, errors } = await open();
    try {
      const before = await canvasBox(page);
      await slider(page, "Brightness", [4, 15, 31]);
      expect(await dirty(page)).toBe("true");
      await settled(page);
      expect(await canvasBox(page)).toEqual(before);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await page.getByRole("slider", { name: "Brightness", exact: true }).inputValue()).toBe("0");
      expect(await dirty(page)).toBe("false");
      expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      expect(await page.getByRole("slider", { name: "Brightness", exact: true }).inputValue()).toBe("31");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("minimal square crop supports keyboard sizing and exports square after rotation", async () => {
    const { page, errors } = await open("minimal=1", 390);
    try {
      expect(await page.getByRole("tab").count()).toBe(1);
      await page.locator(".k2b-image-editor__crop-move").focus();
      await page.keyboard.press("Shift+ArrowLeft");
      await page.keyboard.up("Shift");
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.editorFixture.results.length === 1");
      expect(await fixture(page, "results[0].width === window.editorFixture.results[0].height")).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("inline text and opaque redaction share undo and export", async () => {
    const { page, errors } = await open("", 390);
    try {
      await selectTool(page, "Mark up");
      await markTool(page, "Text").click();
      await settled(page);
      const image = await imageBox(page);
      await page.mouse.click(image.x + image.width * 0.3, image.y + image.height * 0.6);
      const text = page.getByRole("textbox", { name: "Type on the photo", exact: true });
      await text.waitFor();
      const bounds = (await text.boundingBox())!;
      const canvas = (await canvasBox(page))!;
      expect(bounds.x).toBeGreaterThanOrEqual(canvas.x);
      expect(await imageBox(page)).toEqual(image);
      await text.fill("Test note");
      await page.keyboard.press("Enter");
      await markTool(page, /^Redact/).click();
      await settled(page);
      await drag(page, [0.2, 0.2], [0.4, 0.4]);
      expect(await centerPixel(page)).toEqual([0, 0, 0, 255]);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("committing a redaction and undo paint before a deferred animation frame", async () => {
    const { page, errors } = await open("", 390);
    try {
      await selectTool(page, "Mark up");
      await markTool(page, /^Redact/).click();
      const original = await centerPixel(page);
      // A backgrounded or busy WebKit may postpone preview frames beyond pointerup.
      await page.evaluate(() => {
        window.requestAnimationFrame = () => 0;
      });
      // settled: deliberately exercise synchronous painting while animation frames are deferred.
      await drag(page, [0.2, 0.2], [0.4, 0.4], false);
      expect(await centerPixel(page)).toEqual([0, 0, 0, 255]);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await centerPixel(page)).toEqual(original);
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("each drawing tool renders a gesture and undo restores the photo", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Mark up");
      const canvas = page.locator(".k2b-image-editor__image > canvas").first();
      const original = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
      for (const tool of ["Pen", "Marker", "Arrow", "Rectangle", "Ellipse"]) {
        await markTool(page, tool).click();
        await settled(page);
        await drag(page, [0.25, 0.25], [0.6, 0.6]);
        expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(original);
        expect(await dirty(page)).toBe("true");
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await settled(page);
        expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).toBe(original);
        expect(await dirty(page)).toBe("false");
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("phones keep a fact with an icon as an icon chip and drop the others", async () => {
    const { page, errors } = await open("facts=1", 390);
    try {
      const facts = page.locator(".k2b-image-editor__fact");
      expect(await facts.locator("visible=true").count()).toBe(1);
      const lock = facts.filter({ hasText: "Read only" });
      expect((await lock.boundingBox())!.width).toBe(32);
      expect(await lock.getAttribute("title")).toBe("You may only view this file");
      expect(await page.getByText("Read only", { exact: true }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("the desktop shows the redaction notice once, above the save actions", async () => {
    const { page, errors } = await open("redactionNotice=1");
    try {
      await selectTool(page, "Mark up");
      await markTool(page, /^Redact/).click();
      await settled(page);
      await drag(page, [0.6, 0.2], [0.8, 0.3]);
      // The phone copy inside the layer list stays hidden on a desktop.
      expect(await page.getByText("Older versions keep the original.", { exact: true }).locator("visible=true").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("layers select, reorder inside their group, hide from export and keep redactions on top", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Mark up");
      await markTool(page, "Rectangle").click();
      await settled(page);
      await drag(page, [0.1, 0.1], [0.3, 0.3]);
      await markTool(page, "Arrow").click();
      await settled(page);
      await drag(page, [0.5, 0.5], [0.7, 0.6]);
      await markTool(page, /^Redact/).click();
      await settled(page);
      await drag(page, [0.6, 0.2], [0.8, 0.3]);
      const names = () => page.locator(".k2b-image-editor__layer-name").allInnerTexts();
      expect(await names()).toEqual(["Redaction 1", "Arrow", "Rectangle"]);
      // A redaction never moves below the markings.
      await page.getByRole("button", { name: "Redaction 1", exact: true }).focus();
      await page.keyboard.press("Alt+ArrowDown");
      expect(await names()).toEqual(["Redaction 1", "Arrow", "Rectangle"]);
      await page.getByRole("button", { name: "Rectangle", exact: true }).focus();
      await page.keyboard.press("Alt+ArrowUp");
      expect(await names()).toEqual(["Redaction 1", "Rectangle", "Arrow"]);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Rectangle");
      // Clicking a mark on the canvas selects it; the canvas shows the selection box.
      await settled(page);
      const image = await imageBox(page);
      await page.mouse.click(image.x + image.width * 0.1, image.y + image.height * 0.2);
      await page.locator(".k2b-image-editor__selection").waitFor();
      expect(await page.locator(".k2b-image-editor__layer[data-selected] .k2b-image-editor__layer-name").innerText()).toBe("Rectangle");
      // Hidden marks are neither drawn nor exported, and the footer says so.
      const canvas = page.locator(".k2b-image-editor__image > canvas").first();
      const shown = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
      await page.getByRole("button", { name: "Hide Rectangle", exact: true }).click();
      expect(await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(shown);
      await page.getByText("One hidden marking is not saved.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: /Redaction 1: hold/ }).count()).toBe(1);
      expect(await page.getByRole("button", { name: /^Hide Redaction/ }).count()).toBe(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await page.getByRole("button", { name: "Hide Rectangle", exact: true }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("the image strip moves focus with the arrow keys, marks the open and unsaved images and selects", async () => {
    const { page, errors } = await open("items=1");
    try {
      const strip = page.getByRole("navigation", { name: "Images" });
      const current = strip.locator('[aria-current="true"]');
      expect(await current.getAttribute("aria-label")).toBe("b.jpg, open");
      expect(await strip.getByRole("button", { name: "a.jpg, not saved" }).count()).toBe(1);
      await current.focus();
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("c.jpg");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.waitForFunction("window.editorFixture.selected.length === 1");
      expect(await fixture(page, "selected")).toEqual(["d"]);
      expect(await page.locator(".k2b-image-editor__name").innerText()).toContain("4/4");
      // With a strip the name is a button and still shows the photo's thumbnail.
      expect(
        await page.locator(".k2b-image-editor__name").evaluate((element) => ({
          tag: element.tagName,
          thumb: element.querySelector("canvas")?.width,
        })),
      ).toEqual({ tag: "BUTTON", thumb: 40 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("size refusal requires an explicit reduced retry and keeps edits", async () => {
    const { page, errors } = await open("locale=de", 390);
    try {
      await page.evaluate(() => {
        const encode = HTMLCanvasElement.prototype.toBlob;
        let refuse = true;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          if (refuse && this.width > 1) {
            refuse = false;
            callback(null);
            return;
          }
          encode.call(this, callback, type, quality);
        };
      });
      await selectTool(page, "Zuschnitt");
      await page.getByRole("button", { name: "Spiegeln", exact: true }).click();
      await settled(page);
      const before = await canvasBox(page);
      await page.getByRole("button", { name: "Fertig", exact: true }).click();
      const notice = page.getByRole("alert").filter({ hasText: "in dieser Größe" }).first();
      await notice.waitFor();
      expect(await canvasBox(page)).toEqual(before);
      expect(await fixture(page, "attempts")).toBe(0);
      expect(await dirty(page)).toBe("true");
      await page
        .getByRole("button", { name: /Mit .* MP erneut versuchen/ })
        .first()
        .click();
      await page.waitForFunction("window.editorFixture.results.length === 1");
      expect(await fixture(page, "results[0].downscaled")).toBe(true);
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a discard confirmed in one editor never marks it saved when another editor keeps the page", async () => {
    const { page, errors } = await open("nav=1&pair=1");
    try {
      // This test is about the leave checks of two editors, not their look. Two glass overlays repainted over two
      // changing canvases take seconds per frame in software-rendered WebKit (CI and the Playwright image); the
      // editor's solid high-contrast surface keeps the frames short. The other editor tests keep the glass.
      await page.emulateMedia({ contrast: "more" });
      const editors = page.locator(".k2b-image-editor");
      for (const index of [0, 1]) {
        const editor = editors.nth(index);
        await editor.getByRole("tab", { name: "Crop", exact: true }).click();
        await editor.getByRole("button", { name: "Mirror", exact: true }).click();
      }
      const dirtyStates = () => editors.evaluateAll((all) => all.map((editor) => editor.getAttribute("data-dirty")));
      expect(await dirtyStates()).toEqual(["true", "true"]);
      const dialog = page.getByRole("dialog");
      // Each editor asks in turn; the next prompt may open as soon as the previous one closes.
      const answer = async (button: "Confirm" | "Cancel", prompts: number) => {
        await page.waitForFunction((count) => (window as unknown as { prompted: number }).prompted >= count, prompts);
        await dialog.getByRole("button", { name: button, exact: true }).click();
        await settled(page);
      };
      await page.evaluate(() => {
        Object.assign(window, { prompted: 0 });
        new MutationObserver((records) => {
          for (const record of records)
            if (record.target instanceof HTMLDialogElement && record.target.open) (window as unknown as { prompted: number }).prompted++;
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
      });
      // Confirm the first editor, keep the page in the second: both photos stay unsaved.
      await page.locator("#destination-link").click();
      await answer("Confirm", 1);
      await answer("Cancel", 2);
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      expect(new URL(page.url()).pathname).toBe("/editing");
      expect(await dirtyStates()).toEqual(["true", "true"]);
      // The cancelled navigation used up the first confirmation, so the next attempt asks both again.
      await page.locator("#destination-link").click();
      await answer("Confirm", 3);
      await answer("Confirm", 4);
      await page.waitForFunction(() => document.querySelector("[data-nav-root]")?.getAttribute("data-path") === "/destination");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a discard confirmed for a navigation that another page guard stops is asked again next time", async () => {
    const { page, errors } = await open("nav=1");
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Mirror", exact: true }).click();
      await fixture(page, "vetoNextLeave()");
      const dialog = page.getByRole("dialog");
      await page.locator("#destination-link").click();
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      await settled(page);
      expect(new URL(page.url()).pathname).toBe("/editing");
      expect(await dirty(page)).toBe("true");
      // The stopped attempt used up the consent: leaving again asks again.
      await page.locator("#destination-link").click();
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      expect(new URL(page.url()).pathname).toBe("/editing");
      expect(await dirty(page)).toBe("true");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a page guard registered before the editor that stops the retry voids the confirmed discard", async () => {
    const { page, errors } = await open("nav=1&earlyGuard=1");
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Mirror", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await page.locator("#destination-link").click();
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      await settled(page);
      expect(new URL(page.url()).pathname).toBe("/editing");
      expect(await dirty(page)).toBe("true");
      // The page still warns before unloading the unsaved photo.
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      // The next attempt asks again instead of reusing the consent.
      await page.locator("#destination-link").click();
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      expect(new URL(page.url()).pathname).toBe("/editing");
      expect(await dirty(page)).toBe("true");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("cancel and enhanced navigation preserve dirty edits when the warning is dismissed", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Mirror", exact: true }).click();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await fixture(page, "cancellations")).toBe(0);
      expect(await dirty(page)).toBe("true");
      expect(await fixture(page, "leave()")).toBe(true);
      await dialog.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.waitForFunction("window.editorFixture.cancellations === 1");
      await fixture(page, "dispose()");
      expect(await fixture(page, "leave()")).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test.skipIf(browserName !== "chromium")("phone pinch changes only the view and fit restores it", async () => {
    const { page, errors } = await open("minimal=1", 390);
    try {
      const before = await canvasBox(page);
      const zoom = () => page.locator(".k2b-image-editor__zoom-value").textContent();
      const fitted = await zoom();
      const touch = await page.context().newCDPSession(page);
      const box = await imageBox(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: x - 30, y, id: 1 },
          { x: x + 30, y, id: 2 },
        ],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: x - 60, y, id: 1 },
          { x: x + 60, y, id: 2 },
        ],
      });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settled(page);
      expect(await zoom()).not.toBe(fitted);
      expect(await dirty(page)).toBe("false");
      expect(await canvasBox(page)).toEqual(before);
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await settled(page);
      expect(await zoom()).toBe(fitted);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test.skipIf(browserName !== "chromium")("a second finger beside the crop cancels the crop drag and pinches", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Crop");
      await settled(page);
      const crop = (await page.locator(".k2b-image-editor__crop-move").boundingBox())!;
      const canvas = (await canvasBox(page))!;
      const image = await imageBox(page);
      const a = { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2, id: 1 };
      // Empty canvas left of the photo.
      const b = { x: (canvas.x + image.x) / 2, y: a.y, id: 2 };
      expect(b.x).toBeLessThan(image.x);
      const touch = await page.context().newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...a, x: a.x + 30, y: a.y + 20 }] });
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...a, x: a.x + 30, y: a.y + 20 }, b] });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { ...a, x: a.x + 60, y: a.y + 20 },
          { ...b, x: b.x - 30 },
        ],
      });
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settled(page);
      expect(await page.locator(".k2b-image-editor__crop[data-dragging]").count()).toBe(0);
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a failed preview retries the same source and restores editing", async () => {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    let requests = 0;
    try {
      await page.route("**/not-an-image.jpg", (route) =>
        ++requests === 1
          ? route.fulfill({ contentType: "image/jpeg", body: "damaged image" })
          : route.fulfill({ contentType: "image/jpeg", path: resolve(import.meta.dir, "../src/inputs/image-editor/fixtures/photo.jpg") }),
      );
      await page.goto(`${server.url}?broken=1`);
      await page.getByRole("alert").filter({ hasText: "This image cannot be opened" }).waitFor();
      expect(await page.locator(".k2b-image-editor__actions button").isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__actions button")?.disabled);
      expect(requests).toBe(2);
      expect(await dirty(page)).toBe("false");
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("changing source cancels stale saving and cleanup removes unload guards", async () => {
    const { page, errors } = await open();
    try {
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Rotate right", exact: true }).click();
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      await fixture(page, 'mode = "pending"');
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.editorFixture.attempts === 1");
      await fixture(page, 'source("/logo.png")');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__actions button")?.disabled);
      await selectTool(page, "Crop");
      await page.getByRole("button", { name: "Mirror", exact: true }).click();
      await fixture(page, "accept()");
      expect(await dirty(page)).toBe("true");
      await fixture(page, "dispose()");
      expect(
        await page.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
