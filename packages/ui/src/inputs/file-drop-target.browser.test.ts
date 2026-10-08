import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// The drag events, the top layer, and modal dialogs only behave like this in a real engine. The page fakes a drag
// from outside the browser with the events and the DataTransfer an engine hands the page for one.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");

setDefaultTimeout(30_000);

const entry = resolve(import.meta.dir, "file-drop-target.fixture.ts");
const fixtureSource = `
import { createComponent, render } from "solid-js/web";
import { FileDropTarget, FileDropzone, LocaleProvider, fileDropTarget } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.drops = [];
const record = (target) => (files) => window.drops.push({ target, names: files.map((file) => file.name) });
const html = (tag, attributes, ...children) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.append(...children);
  return element;
};

const sidebar = html("nav", { id: "sidebar", style: "width:240px;flex:none" }, "Navigation");
const row = html("div", { id: "row", style: "height:40px" }, "Rechnungen");
const text = html("p", { id: "text", draggable: "true" }, "Ein Absatz");
const zoneHost = html("div", { id: "zone", style: "width:320px" });
const pageHost = html("div", { id: "page-target" });
const main = html("main", { id: "main", class: "k2b-app-workspace__main", style: "flex:1;min-width:0;padding:24px" }, row, text, zoneHost, pageHost);
document.getElementById("app").append(html("div", { style: "display:flex;height:100vh" }, sidebar, main));
const dialogHost = html("div", { id: "dialog-body", style: "padding:24px" }, "Dateien wählen");
const dialog = html("dialog", { id: "dialog", style: "width:400px;height:240px" }, dialogHost);
document.body.append(dialog);

const locale = () => "de";
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        fileDropTarget({ label: "Ablegen, um in „Rechnungen“ hochzuladen", onDrop: record("row") })(row);
        render(() => createComponent(FileDropzone, { label: "Bild", accept: "image/*", onDrop: record("zone") }), zoneHost);
        return createComponent(FileDropTarget, {
          label: "Ablegen, um an die Nachricht anzuhängen",
          accept: "image/*,.pdf",
          maxSize: 1000,
          onDrop: record("page"),
        });
      },
    }),
  pageHost,
);
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(FileDropTarget, { label: "Ablegen, um diese Dateien zu wählen", onDrop: record("dialog") });
      },
    }),
  dialogHost,
);

/** Fires one drag event at the element; \`files\` are [name, type, size], \`kind\` "text" drags a selection instead. */
window.drag = (type, selector, kind = "files", files = [["foto.png", "image/png", 10]]) => {
  const transfer = new DataTransfer();
  if (kind === "files") for (const [name, mime, size] of files) transfer.items.add(new File([new Uint8Array(size)], name, { type: mime }));
  else transfer.setData("text/plain", "Ein Absatz");
  const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer });
  document.querySelector(selector).dispatchEvent(event);
  return event.defaultPrevented;
};
window.overlays = () =>
  [...document.querySelectorAll(".k2b-file-drop")]
    .filter((overlay) => overlay.matches(":popover-open"))
    .map((overlay) => {
      const box = overlay.getBoundingClientRect();
      return { state: overlay.dataset.state, text: overlay.textContent, box: [box.left, box.top, box.width, box.height].map(Math.round) };
    });
window.box = (selector) => {
  const box = document.querySelector(selector).getBoundingClientRect();
  return [box.left, box.top, box.width, box.height].map(Math.round);
};
window.announced = () => document.querySelector("[data-k2b-live]")?.textContent ?? "";
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the FileDropTarget fixture for the browser.");
const script = await build.outputs[0]!.text();

type Overlay = { state: string; text: string; box: number[] };
type FixtureWindow = Window & {
  drops: { target: string; names: string[] }[];
  drag: (type: string, selector: string, kind?: "files" | "text", files?: [string, string, number][]) => boolean;
  overlays: () => Overlay[];
  box: (selector: string) => number[];
  announced: () => string;
};

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="app"></div><script src="/fixture.js"></script></body></html>`,
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

const open = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  await page.goto(server.url.href);
  await page.waitForFunction(() => document.querySelectorAll(".k2b-file-drop").length === 2);
  return page;
};
const drag = (page: Page, type: string, selector: string, kind: "files" | "text" = "files", files?: [string, string, number][]) =>
  page.evaluate(([type, selector, kind, files]) => (window as unknown as FixtureWindow).drag(type, selector, kind, files), [
    type,
    selector,
    kind,
    files,
  ] as const);
const overlays = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).overlays());
const drops = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).drops);
const box = (page: Page, selector: string) => page.evaluate((selector) => (window as unknown as FixtureWindow).box(selector), selector);

describe(`FileDropTarget in ${browserName}`, () => {
  test("a file drag covers the workspace main area, not the sidebar, says what happens, and moves nothing", async () => {
    const page = await open();
    const before = await box(page, "#row");
    expect(await drag(page, "dragenter", "#text")).toBe(true);
    expect(await overlays(page)).toEqual([
      { state: "over", text: "Ablegen, um an die Nachricht anzuhängen", box: await box(page, "#main") },
    ]);
    expect(await box(page, "#row")).toEqual(before);
    await page.waitForFunction(() => (window as unknown as FixtureWindow).announced().includes("Ablegen, um an die Nachricht anzuhängen"));
    // Over the sidebar the area stays visible, but a drop there is refused instead of opening the file.
    await drag(page, "dragenter", "#sidebar");
    await drag(page, "dragleave", "#text");
    expect((await overlays(page)).map((overlay) => overlay.state)).toEqual(["available"]);
    expect(await drag(page, "drop", "#sidebar")).toBe(true);
    expect(await overlays(page)).toEqual([]);
    expect(await drops(page)).toEqual([]);
    await page.close();
  });

  test("text and in-page element drags never show it", async () => {
    const page = await open();
    expect(await drag(page, "dragenter", "#text", "text")).toBe(false);
    await drag(page, "dragover", "#text", "text");
    expect(await overlays(page)).toEqual([]);
    // An element dragged within the page may carry files (an image does), but it is not an upload.
    await drag(page, "dragstart", "#text");
    await drag(page, "dragenter", "#main");
    expect(await overlays(page)).toEqual([]);
    await drag(page, "dragend", "#text");
    await drag(page, "dragenter", "#main");
    expect(await overlays(page)).toHaveLength(1);
    await page.close();
  });

  test("moving across elements does not flicker, and leaving, Escape, or a pointer move never leaves it stuck", async () => {
    const page = await open();
    await drag(page, "dragenter", "#main");
    // The engine enters the next element before it leaves the previous one.
    await drag(page, "dragenter", "#text");
    await drag(page, "dragleave", "#main");
    expect(await overlays(page)).toHaveLength(1);
    await drag(page, "dragleave", "#text");
    expect(await overlays(page)).toEqual([]);

    await drag(page, "dragenter", "#text");
    await page.keyboard.press("Escape");
    expect(await overlays(page)).toEqual([]);

    await drag(page, "dragenter", "#text");
    await page.mouse.move(10, 10);
    await page.mouse.move(20, 20);
    expect(await overlays(page)).toEqual([]);

    // An element that disappears under the pointer never reports leaving; it does not keep the overlay open.
    await drag(page, "dragenter", "#text");
    await drag(page, "dragenter", "#row");
    await page.evaluate(() => document.getElementById("text")!.remove());
    await drag(page, "dragleave", "#row");
    expect(await overlays(page)).toEqual([]);
    await page.close();
  });

  test("a more specific target wins and its sentence replaces the area's", async () => {
    const page = await open();
    await drag(page, "dragenter", "#row");
    expect(await overlays(page)).toEqual([
      { state: "over", text: "Ablegen, um in „Rechnungen“ hochzuladen", box: await box(page, "#main") },
    ]);
    expect(await page.getAttribute("#row", "data-file-drop")).toBe("over");
    expect(await drag(page, "drop", "#row", "files", [["rechnung.exe", "application/x-msdownload", 10]])).toBe(true);
    expect(await page.getAttribute("#row", "data-file-drop")).toBeNull();

    await drag(page, "dragenter", "#zone button");
    expect((await overlays(page))[0]?.text).toBe("Zum Hochladen ablegen");
    expect(await page.getAttribute("#zone button", "data-file-drop")).toBe("over");
    await drag(page, "drop", "#zone button");
    expect(await drops(page)).toEqual([
      { target: "row", names: ["rechnung.exe"] },
      { target: "zone", names: ["foto.png"] },
    ]);
    await page.close();
  });

  test("a drop hands over the files that fit and says which ones it left out", async () => {
    const page = await open();
    await drag(page, "dragenter", "#text");
    expect(
      await drag(page, "drop", "#text", "files", [
        ["foto.png", "image/png", 10],
        ["setup.exe", "application/x-msdownload", 10],
        ["scan.pdf", "application/pdf", 5000],
      ]),
    ).toBe(true);
    expect(await drops(page)).toEqual([{ target: "page", names: ["foto.png"] }]);
    await page.waitForFunction(() =>
      document.body.textContent?.includes("Nicht hinzugefügt, dieser Dateityp wird hier nicht angenommen: setup.exe"),
    );
    await page.waitForFunction(() => document.body.textContent?.includes("Nicht hinzugefügt, größer als"));
    await page.waitForFunction(() => (window as unknown as FixtureWindow).announced().includes("foto.png abgelegt"));
    await page.close();
  });

  test("an open modal dialog takes the drop with its own target and turns the page's off", async () => {
    const page = await open();
    await page.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).showModal());
    await drag(page, "dragenter", "#dialog-body");
    expect(await overlays(page)).toEqual([{ state: "over", text: "Ablegen, um diese Dateien zu wählen", box: await box(page, "#dialog") }]);
    await drag(page, "drop", "#dialog-body");
    expect(await drops(page)).toEqual([{ target: "dialog", names: ["foto.png"] }]);
    await page.evaluate(() => (document.getElementById("dialog") as HTMLDialogElement).close());
    await drag(page, "dragenter", "#text");
    expect((await overlays(page)).map((overlay) => overlay.text)).toEqual(["Ablegen, um an die Nachricht anzuhängen"]);
    await page.close();
  });
});
