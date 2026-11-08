import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { basename, resolve } from "node:path";
import type { Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

setDefaultTimeout(30_000);
const uiRoot = resolve(import.meta.dir, "../../../ui");
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", uiRoot))).default;
const buildHarness = async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", uiRoot));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", uiRoot))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", uiRoot))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "FileImageEditor.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-files-image-editor",
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
  if (!build.success) throw new AggregateError(build.logs, "Files image harness build failed");
  return build.outputs[0]!.text();
};
const script = await buildHarness();
const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "FileImageEditor.browser.css")], plugins: [tailwind] });
if (!styles.success) throw new AggregateError(styles.logs, "Files image styles build failed");
const css = await styles.outputs[0]!.text();
const cssAssets = new Map(styles.outputs.slice(1).map((asset) => [basename(asset.path), asset]));
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const asset = cssAssets.get(basename(url.pathname));
      if (asset) return new Response(asset);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(
        `<!doctype html><html lang="${url.searchParams.has("de") ? "de" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" data-theme="${url.searchParams.has("dark") ? "dark" : "light"}" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
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

type Upload = { path: string; expectedRevision?: string; onConflict: string; size: number; idempotencyKey: string };
const setup = async (
  options: {
    versioned?: boolean;
    managed?: boolean;
    width?: number;
    query?: string;
    write?: boolean;
    name?: string;
    canCreate?: boolean;
    conflict?: boolean;
    copyConflict?: boolean;
    ambiguous?: boolean;
    receiptUnknown?: boolean;
    corrupt?: boolean;
    etag?: string;
    sourceChanged?: boolean;
    noWebp?: boolean;
    large?: boolean;
    images?: boolean;
  } = {},
) => {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  if (options.noWebp)
    await page.addInitScript(() => {
      const encode = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        return encode.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
      };
    });
  const largeImage = options.large
    ? Buffer.from(
        await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 5000;
          canvas.height = 4000;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#487a9b";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/jpeg").split(",")[1]!;
          canvas.width = canvas.height = 0;
          return data;
        }),
        "base64",
      )
    : undefined;
  await page.addInitScript(() => {
    const sizes: number[][] = [];
    Object.defineProperty(window, "fileExportSizes", { value: sizes });
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      sizes.push([this.width, this.height]);
      return encode.call(this, callback, type, quality);
    };
  });
  const uploads: Upload[] = [];
  let contentReads = 0;
  let metadataReads = 0;
  let commitCalls = 0;
  let revision = "revision-1";
  let latest: Upload | undefined;
  const name = options.name ?? "Photo.jpg";
  const entry = (path = `Trips/${name}`) => ({
    path,
    name: path.split("/").at(-1),
    size: 10_000,
    modified: "2026-11-07T10:00:00Z",
    directory: false,
    revision,
    actions: { write: options.write ?? true, move: true, share: true },
  });
  const base = { id: "photos", managed: options.managed ?? true, versioningEnabled: options.versioned ?? true };
  await page.route("**/api/filesv2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/entry")) {
      metadataReads++;
      return route.fulfill({ json: { base, entry: entry(url.searchParams.get("path") ?? undefined) } });
    }
    if (url.pathname.endsWith("/download"))
      return route.fulfill({ json: { url: new URL("/original", server.url).href, method: "GET", expires: "2099-01-01T00:00:00Z" } });
    if (url.pathname.endsWith("/thumbnail")) return route.fulfill({ status: 404, json: { code: "unavailable", message: "No thumbnail" } });
    if (url.pathname.endsWith("/uploads")) {
      latest = request.postDataJSON();
      uploads.push(latest!);
      if (options.copyConflict && uploads.length === 1)
        return route.fulfill({ status: 409, json: { code: "path_conflict", message: "Copy already exists" } });
      // A committed receipt exercises the real adapter's reconciliation without a Filegate test service.
      return route.fulfill({ json: { id: "receipt", path: latest!.path, size: latest!.size, chunkSize: 1, state: "committed" } });
    }
    if (url.pathname.endsWith("/commit")) {
      commitCalls++;
      if (options.ambiguous && commitCalls === 1) return route.abort("failed");
      if (options.receiptUnknown && commitCalls === 2)
        return route.fulfill({ status: 409, json: { code: "receipt_unknown", message: "Receipt unavailable" } });
      if (options.conflict && commitCalls === 1)
        return route.fulfill({ status: 409, json: { code: "write_conflict", message: "File changed" } });
      revision = `revision-${commitCalls + 1}`;
      return route.fulfill({ json: { base, entry: entry(latest!.path) } });
    }
    if (url.pathname.endsWith("/abort")) return route.fulfill({ json: { success: true } });
    return route.fulfill({ status: 404, json: { code: "unknown", message: "Unexpected fixture route" } });
  });
  await page.route("**/original", async (route) => {
    contentReads++;
    if (options.sourceChanged && metadataReads > 0) revision = "revision-newer";
    if (options.corrupt) return route.fulfill({ body: "Not an image", contentType: "image/heic", headers: { etag: '"revision-1"' } });
    await route.fulfill({
      ...(largeImage ? { body: largeImage } : { path: resolve(uiRoot, "src/inputs/image-editor/fixtures/photo.jpg") }),
      contentType: "image/jpeg",
      headers: { etag: options.etag ?? '"revision-1"' },
    });
  });
  await page.goto(`${server.url}?${options.query ?? ""}`);
  await page.evaluate(({ name, write, canCreate, images }) => window.fileImages.open(name, { write, canCreate, images }), {
    name,
    write: options.write,
    canCreate: options.canCreate,
    images: options.images,
  });
  await page.getByRole("dialog").waitFor();
  return { page, errors, uploads, reads: () => contentReads, commits: () => commitCalls };
};
const edit = async (page: Page, de = false) => {
  await page.getByRole("button", { name: de ? "Bild bearbeiten" : "Edit image", exact: true }).click();
  await page.waitForFunction(
    () =>
      (document.querySelector(".k2b-image-editor canvas")?.getAttribute("width") ?? "0") !== "0" &&
      !!document.querySelector(".k2b-image-editor canvas"),
  );
  await page.locator(".filesv2-image-save-actions button").first().waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".filesv2-image-save-actions button")?.disabled);
  await settled(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(
    await page.evaluate(() => Array.from(document.fonts).some((face) => face.family === "tabler-icons" && face.status === "loaded")),
  ).toBe(true);
};
/** The main button saves a new version where that is possible, else a copy; other ways wait in its menu. */
const save = async (page: Page, copy = false) => {
  const main = page.locator(".filesv2-image-save-actions button").first();
  const label = copy ? "Save copy" : "Save";
  if ((await main.innerText()).trim() === label) return main.click();
  await page.getByRole("button", { name: "More saving options", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${copy ? "Save copy" : "Save new version"}`) }).click();
};
const rotate = async (page: Page) => {
  const crop = page.getByRole("tab", { name: "Crop", exact: true });
  if ((await crop.getAttribute("aria-selected")) !== "true") await crop.click();
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
  await settled(page);
};

describe("Files photo editing", () => {
  test("pins source bytes and advances the expected revision after each new version", async () => {
    const { page, errors, uploads, reads } = await setup();
    try {
      await edit(page);
      const pinned = reads();
      await rotate(page);
      await save(page);
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      await rotate(page);
      await save(page);
      await page.waitForFunction(() => window.fileImages.saved.length === 2);
      expect(uploads.map((upload) => [upload.path, upload.expectedRevision, upload.onConflict])).toEqual([
        ["Trips/Photo.jpg", "revision-1", "overwrite"],
        ["Trips/Photo.jpg", "revision-2", "overwrite"],
      ]);
      expect(reads()).toBe(pinned);
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("Files requests original dimensions above the library default output limit", async () => {
    const { page, errors } = await setup({ large: true });
    try {
      await edit(page);
      await rotate(page);
      await save(page);
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(await page.evaluate<number[][]>("window.fileExportSizes")).toContainEqual([4000, 5000]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("a stale revision keeps the draft and allows an independent copy", async () => {
    const { page, errors, uploads } = await setup({ conflict: true });
    try {
      await edit(page);
      await rotate(page);
      await save(page);
      await page.getByText("The file changed. Your edits are preserved. Save a copy instead.").first().waitFor();
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("true");
      expect(await page.evaluate(() => window.fileImages.saved.length)).toBe(0);
      await save(page, true);
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads.at(-1)!.path).toBe("Trips/Photo (edited).jpg");
      expect(uploads.at(-1)!.onConflict).toBe("error");
      expect(uploads.at(-1)!.expectedRevision).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("an unconfirmed result exposes an explicit check and resumes the same upload", async () => {
    const { page, errors, uploads, commits } = await setup({ ambiguous: true });
    try {
      await edit(page);
      await rotate(page);
      await save(page);
      await page.locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true }).waitFor();
      expect(commits()).toBe(1);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(
        await page
          .getByText("The upload result is not yet known. Check this upload before saving anything else. Your edits are preserved.", {
            exact: true,
          })
          .last()
          .isVisible(),
      ).toBe(true);
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("true");
      await rotate(page);
      await page.locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true }).click();
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads.length).toBe(2);
      expect(uploads[1]).toEqual(uploads[0]);
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("true");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("a missing receipt keeps a lost copy reserved until the same upload is confirmed", async () => {
    const { page, errors, uploads, commits } = await setup({ ambiguous: true, receiptUnknown: true, versioned: false });
    try {
      await edit(page);
      await rotate(page);
      await save(page, true);
      const check = page.locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true });
      await check.waitFor();
      await check.click();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".filesv2-image-save-actions button")?.disabled);
      expect(commits()).toBe(2);
      expect(await check.count()).toBe(1);
      expect(await page.evaluate(() => window.fileImages.saved.length)).toBe(0);
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(uploads[1]).toEqual(uploads[0]);
      await check.click();
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads).toEqual([uploads[0]!, uploads[0]!, uploads[0]!]);
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("storage failure while checking an ambiguous copy never releases its reservation", async () => {
    const { page, errors, uploads } = await setup({ ambiguous: true, versioned: false });
    try {
      await edit(page);
      await rotate(page);
      await save(page, true);
      const check = page.locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true });
      await check.waitFor();
      await page.evaluate(() => {
        const getItem = Storage.prototype.getItem;
        Object.defineProperty(window, "restoreUploadStorage", {
          value: () => {
            Storage.prototype.getItem = getItem;
          },
        });
        Storage.prototype.getItem = () => {
          throw new DOMException("Storage unavailable", "SecurityError");
        };
      });
      await check.click();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".filesv2-image-save-actions button")?.disabled);
      expect(uploads).toHaveLength(1);
      expect(await check.count()).toBe(1);
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog").count()).toBe(1);
      await page.evaluate("window.restoreUploadStorage()");
      await check.click();
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads[1]).toEqual(uploads[0]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("storage preflight failure issues no request and leaves a discardable draft", async () => {
    const { page, errors, uploads } = await setup();
    try {
      await edit(page);
      await rotate(page);
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage unavailable", "SecurityError");
        };
      });
      await save(page);
      await page.locator(".k2b-image-editor").getByText("The image could not be saved. Your edits are preserved.").first().waitFor();
      expect(uploads).toEqual([]);
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("true");
      expect(await page.getByRole("button", { name: "Check upload", exact: true }).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.getByText("Discard unsaved changes?", { exact: true }).waitFor();
      await page.getByRole("dialog").last().getByRole("button", { name: "Confirm", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("unversioned and foreign original formats only offer a copy, and read-only entries edit and download", async () => {
    for (const options of [
      { versioned: false },
      { managed: false, versioned: true },
      { name: "Photo.avif" },
      { name: "Photo.webp", noWebp: true },
    ]) {
      const { page, errors, uploads } = await setup(options);
      try {
        await edit(page);
        const main = page.locator(".filesv2-image-save-actions button").first();
        expect((await main.innerText()).trim()).toBe("Save copy");
        await page.getByRole("button", { name: "More saving options", exact: true }).click();
        expect(await page.getByRole("menuitem", { name: /^Save new version/ }).count()).toBe(0);
        expect(await page.getByRole("menuitem", { name: /^Download/ }).count()).toBe(1);
        await page.getByRole("button", { name: "More saving options", exact: true }).click();
        if ("managed" in options && !options.managed) {
          await main.click();
          await page.waitForFunction(() => window.fileImages.saved.length === 1);
          expect(uploads.map(({ path, onConflict, expectedRevision }) => ({ path, onConflict, expectedRevision }))).toEqual([
            { path: "Trips/Photo (edited).jpg", onConflict: "error", expectedRevision: undefined },
          ]);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
    // Read only: editing and downloading work; a new version is visible but locked with its reason.
    const { page, errors, uploads, commits } = await setup({ write: false, canCreate: false });
    try {
      await edit(page);
      await page.getByText("You may only view this file. Editing and downloading work.", { exact: true }).waitFor();
      expect((await page.locator(".filesv2-image-save-actions button").first().innerText()).trim()).toBe("Download");
      await page.getByRole("button", { name: "More saving options", exact: true }).click();
      const locked = page.getByRole("menuitem", { name: /^Save new version/ });
      expect(await locked.innerText()).toContain("You may not change this file");
      expect(await locked.isDisabled()).toBe(true);
      await page.getByRole("button", { name: "More saving options", exact: true }).click();
      const download = page.waitForEvent("download");
      await page.locator(".filesv2-image-save-actions button").first().click();
      expect((await download).suggestedFilename()).toBe("Photo.jpg");
      expect(uploads).toEqual([]);
      expect(commits()).toBe(0);
      expect(await page.evaluate(() => window.fileImages.saved)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("phone and dark states keep editing inside the existing dialog, with dirty dismissal guarded", async () => {
    for (const width of [1440, 390]) {
      const { page, errors } = await setup({ width, query: "dark=1" });
      try {
        await edit(page);
        await rotate(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.keyboard.press("Escape");
        await page.getByText("Discard unsaved changes?", { exact: true }).waitFor({ timeout: 5_000 });
        expect(await page.locator(".k2b-image-editor").count()).toBe(1);
        const canvases = await page.evaluateHandle(() =>
          Array.from(document.querySelectorAll<HTMLCanvasElement>(".k2b-image-editor canvas")),
        );
        await page.getByRole("dialog").last().getByRole("button", { name: "Confirm", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("dialog[open]"));
        expect(
          await page.evaluate((items) => items.length > 0 && items.every((canvas) => canvas.width === 0 && canvas.height === 0), canvases),
        ).toBe(true);
        await canvases.dispose();
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });
  test("each image in the strip keeps its edits, and an unresolved save of one keeps the dialog open from another", async () => {
    const { page, errors, uploads } = await setup({ images: true, ambiguous: true });
    try {
      const visible = () => page.locator(".filesv2-image-session:not([hidden]) .k2b-image-editor");
      const open = async (name: string) => {
        await visible()
          .getByRole("navigation", { name: "Images" })
          .getByRole("button", { name: new RegExp(`^${name}`) })
          .click();
        await page.waitForFunction(
          (target) =>
            document.querySelector(".filesv2-image-session:not([hidden]) .k2b-image-editor__name")?.textContent?.includes(target) &&
            (document.querySelector<HTMLCanvasElement>(".filesv2-image-session:not([hidden]) .k2b-image-editor__image > canvas")?.width ??
              0) > 1,
          name,
        );
        await settled(page);
      };
      await edit(page);
      await rotate(page);
      await open("Beach.jpg");
      expect(await visible().getAttribute("data-dirty")).toBe("false");
      expect(await visible().getByRole("button", { name: "Photo.jpg, not saved" }).count()).toBe(1);
      await open("Photo.jpg");
      expect(await visible().getAttribute("data-dirty")).toBe("true");
      // Photo's upload stays unresolved; closing from Beach must not drop it, and asks nothing while it runs.
      await save(page);
      await visible().locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true }).waitFor();
      await open("Beach.jpg");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(await page.getByText("Discard unsaved changes?", { exact: true }).count()).toBe(0);
      await open("Photo.jpg");
      await visible().locator(".filesv2-image-save-actions").getByRole("button", { name: "Check upload", exact: true }).click();
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads.every((upload) => upload.path === "Trips/Photo.jpg")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("an existing copy keeps edits and explicit retry uses a different name", async () => {
    const { page, errors, uploads } = await setup({ versioned: false, copyConflict: true });
    try {
      await edit(page);
      await rotate(page);
      await save(page, true);
      await page.getByText("That copy already exists. Save a copy again to use the next name.").first().waitFor();
      expect(await page.locator(".k2b-image-editor").getAttribute("data-dirty")).toBe("true");
      await save(page, true);
      await page.waitForFunction(() => window.fileImages.saved.length === 1);
      expect(uploads.map((upload) => upload.path)).toEqual(["Trips/Photo (edited).jpg", "Trips/Photo (edited 2).jpg"]);
      expect(uploads.every((upload) => upload.onConflict === "error")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("source revision failures stop before editing and offer a visible retry", async () => {
    for (const options of [{ etag: 'W/"revision-1"' }, { managed: false, sourceChanged: true }]) {
      const { page, errors, uploads } = await setup(options);
      try {
        await page.getByRole("button", { name: "Edit image", exact: true }).click();
        await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        expect(await page.locator(".k2b-image-editor").count()).toBe(0);
        expect(uploads).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });
  test("a browser that cannot decode an image shows a visible recovery state", async () => {
    const { page, errors } = await setup({ corrupt: true, name: "Camera.heic" });
    try {
      await page.getByRole("button", { name: "Edit image", exact: true }).click();
      await page.locator(".k2b-image-editor__center").getByRole("button", { name: "Try again", exact: true }).waitFor();
      expect(await page.locator(".k2b-image-editor__center").textContent()).toContain("cannot be opened");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
