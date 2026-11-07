import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "./browser";

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
        `<!doctype html><html lang="${url.searchParams.get("locale") === "de" ? "de" : "en"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" data-theme="light" style="margin:0"><div id="editor"></div><script src="/editor.js"></script></body></html>`,
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
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors = pageErrors(page);
  await page.goto(`${server.url}?${query}`);
  await page.locator(".k2b-image-editor__save button").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__save button")?.disabled);
  await page.waitForFunction(() => (document.querySelector("canvas")?.width ?? 0) > 1);
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
const stageBox = (page: Page) => page.locator(".k2b-image-editor__stage").boundingBox();

describe("public ImageEditor interactions", () => {
  test("inherits German and keeps phone regions stable across tools and errors", async () => {
    const { page, errors } = await open("locale=de&failure=1", 390);
    try {
      const before = await stageBox(page);
      await page.getByRole("radio", { name: "Anpassen", exact: true }).click();
      await slider(page, "Helligkeit", [20]);
      await page.getByRole("button", { name: "Fertig", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Upload unavailable" }).waitFor();
      expect(await stageBox(page)).toEqual(before);
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("upload rejection preserves edits, retry stays in place and awaits success", async () => {
    const { page, errors } = await open("failure=1");
    try {
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
      const before = await stageBox(page);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Upload unavailable" }).waitFor();
      expect(await dirty(page)).toBe("true");
      expect(await stageBox(page)).toEqual(before);
      await fixture(page, 'mode = "success"');
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".k2b-image-editor")?.getAttribute("data-dirty") === "false");
      expect(await fixture(page, "attempts")).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a pending upload marks only the captured entry saved; undo reaches it", async () => {
    const { page, errors } = await open();
    try {
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
      await fixture(page, 'mode = "pending"');
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction("window.editorFixture.attempts === 1");
      expect(await page.getByRole("button", { name: "Saving…", exact: true }).isDisabled()).toBe(true);
      await page.getByRole("button", { name: "Flip horizontally", exact: true }).click();
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
      const before = await stageBox(page);
      await page.getByRole("radio", { name: "Adjust", exact: true }).click();
      await slider(page, "Brightness", [4, 15, 31]);
      expect(await dirty(page)).toBe("true");
      expect(await stageBox(page)).toEqual(before);
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

  test("minimal square crop supports keyboard corners and exports square after rotation", async () => {
    const { page, errors } = await open("minimal=1", 390);
    try {
      expect(await page.getByRole("radio").count()).toBe(1);
      const corner = page.getByRole("button", { name: "Resize crop (se)", exact: true });
      await corner.focus();
      await page.keyboard.press("ArrowLeft");
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
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
    const { page, errors } = await open();
    try {
      await page.getByRole("radio", { name: "Annotate", exact: true }).click();
      await page.getByRole("combobox", { name: "Annotate", exact: true }).click();
      await page.getByRole("option", { name: "Text", exact: true }).click();
      await page.getByRole("button", { name: "Add text", exact: true }).click();
      await page.getByRole("textbox", { name: "Type on the photo", exact: true }).fill("Test note");
      await page.keyboard.press("Enter");
      await page.getByRole("radio", { name: "Redact", exact: true }).click();
      const image = (await page.locator(".k2b-image-editor__image").boundingBox())!;
      await page.mouse.move(image.x + image.width * 0.2, image.y + image.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(image.x + image.width * 0.4, image.y + image.height * 0.4);
      await page.mouse.up();
      const pixel = await page
        .locator("canvas")
        .first()
        .evaluate((canvas) => [
          ...(canvas as HTMLCanvasElement)
            .getContext("2d")!
            .getImageData(
              Math.floor((canvas as HTMLCanvasElement).width * 0.3),
              Math.floor((canvas as HTMLCanvasElement).height * 0.3),
              1,
              1,
            ).data,
        ]);
      expect(pixel).toEqual([0, 0, 0, 255]);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("size refusal requires an explicit reduced retry and keeps edits", async () => {
    const { page, errors } = await open();
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
      await page.getByRole("button", { name: "Flip horizontally", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "could not save at this size" }).waitFor();
      expect(await fixture(page, "attempts")).toBe(0);
      expect(await dirty(page)).toBe("true");
      await page.getByRole("button", { name: /Save again at .* MP/ }).click();
      await page.waitForFunction("window.editorFixture.results.length === 1");
      expect(await fixture(page, "results[0].downscaled")).toBe(true);
      expect(await dirty(page)).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("changing source cancels stale saving and cleanup removes unload guards", async () => {
    const { page, errors } = await open();
    try {
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
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
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__save button")?.disabled);
      await page.getByRole("button", { name: "Flip horizontally", exact: true }).click();
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
