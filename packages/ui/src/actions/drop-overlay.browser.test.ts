import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "drop-overlay.fixture.ts");
// A list whose rows drag onto an overlay of targets (S7), and a folder in a sidebar outside the overlay. Fictional data.
const source = `
import { createComponent, insert, render } from "solid-js/web";
import { DragSource, DropOverlay, DropTarget, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.drops = []; window.shift = 0; window.requests = 0; window.menus = []; window.cancels = [];
window.addEventListener("pointerdown", (event) => { window.lastPointer = event.pointerId; }, true);
const drop = (target) => (payload) => window.drops.push({ target, value: payload.value, count: payload.count ?? 1 });
const level = (id) => {
  if (id === "people") return { title: "Assign to someone else · Frequent", tiles: ["Nora", "Tobias", "Mira"].map((name) => ({ id: name, label: name, icon: "ti ti-user", onDrop: drop(name) })) };
  if (id === "folders") return { title: "Move to folder", tiles: ["Complaints", "Invoices"].map((name) => ({ id: name, label: name, icon: "ti ti-folder", onDrop: drop(name) })) };
  return { tiles: [
    { id: "me", label: "Assign to me", icon: "ti ti-user-plus", description: "Others stay responsible", onDrop: drop("me") },
    { id: "other", label: "Assign to someone else", icon: "ti ti-users", opens: "people", onDrop: drop("chooser") },
    { id: "folder", label: "Move to folder", icon: "ti ti-folder-symlink", opens: "folders" },
    { id: "done", label: "Mark as done", icon: "ti ti-check", disabled: "Already done" },
  ] };
};
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  const side = document.createElement("nav"); side.className = "side";
  insert(side, createComponent(DropTarget, { accept: ["demo.mail"], label: "Archive", class: "archive", onDrop: drop("Archive"), children: "Archive" }));
  const main = document.createElement("main"); main.className = "main";
  const list = document.createElement("div"); list.className = "list";
  insert(list, ["Quote for the trade fair", "Invoice 2026-117", "Delivery delayed"].map((subject, index) => {
    const row = document.createElement("div"); row.className = "row"; row.textContent = subject;
    return createComponent(DragSource, { threshold: 6, touch: "none", onLongPress: (point) => window.menus.push(index), get payload() {
      return window.many ? { type: "demo.mail", value: "m" + index, label: "3 conversations", count: 3 } : { type: "demo.mail", value: "m" + index, label: subject, icon: "ti ti-mail" };
    }, children: row });
  }));
  main.append(list);
  insert(main, createComponent(DropOverlay, { accept: ["demo.mail"], level, hint: "Folders on the left work too", onCancel: (payload) => window.cancels.push(payload.value) }));
  return [side, main];
} }), document.getElementById("app"));
new PerformanceObserver((entries) => { for (const shift of entries.getEntries()) window.shift += shift.value; }).observe({ type: "layout-shift", buffered: true });
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: source },
  target: "browser",
  conditions: ["browser"],
  format: "esm",
  splitting: true,
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the drop overlay fixture.");
const files = new Map(
  await Promise.all(build.outputs.map(async (output) => [output.path.replace(/^\.\//, ""), await output.text()] as const)),
);
const fixture = [...files.keys()].find((name) => name.includes("drop-overlay.fixture"))!;
// The overlay's own chunk, which the page loads on demand.
const overlayChunk = [...files.entries()].find(([, text]) => text.includes("Drop here: nothing happens"))?.[0];

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const ORIGIN = "http://drop-overlay.test";
const open = async ({ delay = 0, missing = false, ...options }: BrowserContextOptions & { delay?: number; missing?: boolean } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...options });
  const page = await context.newPage();
  let served!: () => void;
  const overlayLoaded = new Promise<void>((done) => {
    served = done;
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "" || name === "index.html")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><style>${css}</style><style>
          body { margin: 0; } #app { display: grid; grid-template-columns: 200px 1fr; height: 100vh; }
          .side { padding: 12px; } .archive { padding: 16px; } .main { position: relative; overflow: hidden; }
          .row { height: 48px; padding: 0 16px; display: flex; align-items: center; }
          </style></head><body class="k2b-ui"><div id="app"></div><script type="module" src="/${fixture}"></script></body></html>`,
      });
    const text = files.get(name);
    if (text === undefined) return route.fulfill({ status: 404 });
    if (name === overlayChunk) {
      if (missing) return route.fulfill({ status: 404 });
      if (delay) await new Promise((done) => setTimeout(done, delay));
      served();
    }
    return route.fulfill({ contentType: "text/javascript", body: text });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.locator(".row").first().waitFor();
  return { page, context, overlayLoaded };
};
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const drops = (page: Page) => page.evaluate(() => (window as unknown as { drops: unknown[] }).drops);
/** Moves the pointer of the press in progress and lets go in one task, so no timer of the page runs in between. */
const moveAndRelease = (page: Page, point: { x: number; y: number }) =>
  page.evaluate((point) => {
    const pointerId = (window as unknown as { lastPointer: number }).lastPointer;
    const init = { pointerId, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, clientX: point.x, clientY: point.y };
    const target = document.elementFromPoint(point.x, point.y) ?? document.body;
    target.dispatchEvent(new PointerEvent("pointermove", init));
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, button: 0 }));
    return document.querySelector(".k2b-drop-overlay") === null;
  }, point);
/** Presses the first row and moves past the 6 px threshold. */
const start = async (page: Page) => {
  const row = await center(page, ".row");
  await page.mouse.move(row.x, row.y);
  await page.mouse.down();
  await page.mouse.move(row.x + 7, row.y);
  await page.locator(".k2b-drop-overlay").waitFor();
  return row;
};
const armed = (page: Page) => page.waitForFunction(() => !document.querySelector(".k2b-drop-overlay[data-arming]"));
const clean = (page: Page) => page.waitForFunction(() => !document.querySelector(".k2b-drop-overlay, .k2b-drag-preview"));

describe(`drop overlay in ${browserName}`, () => {
  test("the overlay code splits off; preloaded while idle, the first drag shows it at the threshold, with the preview at the pointer", async () => {
    expect(overlayChunk, "The overlay must be its own chunk").toBeDefined();
    expect(overlayChunk).not.toBe(fixture);
    expect(files.get(fixture)!.includes("Drop here: nothing happens")).toBe(false);
    const { page, context, overlayLoaded } = await open({ delay: 600 });
    try {
      // Idle loads it long before anyone drags.
      await overlayLoaded;
      await settled(page);
      const row = await center(page, ".row");
      await page.mouse.move(row.x, row.y);
      await page.mouse.down();
      await page.mouse.move(row.x + 5, row.y);
      expect(await page.locator(".k2b-drag-preview, .k2b-drop-overlay").count()).toBe(0);
      await page.mouse.move(row.x + 7, row.y);
      // In the frame the drag starts, both the overlay and the preview are there, the preview at the pointer.
      const first = await page.evaluate(
        () =>
          new Promise<{ overlay: boolean; at: number[] }>((done) =>
            requestAnimationFrame(() => {
              const preview = document.querySelector<HTMLElement>(".k2b-drag-preview");
              done({
                overlay: document.querySelector(".k2b-drop-overlay") !== null,
                at: (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(preview?.style.transform ?? "") ?? []).slice(1).map(Number),
              });
            }),
          ),
      );
      expect(first.overlay).toBe(true);
      expect(first.at.map(Math.round)).toEqual([Math.round(row.x + 7), Math.round(row.y)]);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("while the overlay still loads, the first drag has no gap: the preview follows at once, the overlay comes when ready, nothing shifts", async () => {
    // The chunk takes 1.5 s, so it is still on its way when the drag starts right after the page loads.
    const { page, context, overlayLoaded } = await open({ delay: 1500 });
    try {
      let arrived = false;
      void overlayLoaded.then(() => {
        arrived = true;
      });
      await settled(page);
      const row = await center(page, ".row");
      await page.mouse.move(row.x, row.y);
      await page.mouse.down();
      await page.mouse.move(row.x + 7, row.y);
      const at = () =>
        page.evaluate(() => {
          const preview = document.querySelector<HTMLElement>(".k2b-drag-preview");
          return (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(preview?.style.transform ?? "") ?? [])
            .slice(1)
            .map((value) => Math.round(Number(value)));
        });
      // The preview is part of the static engine: it is there and at the pointer before the overlay code arrives.
      await page.locator(".k2b-drag-preview").waitFor();
      expect(arrived).toBe(false);
      expect(await page.locator(".k2b-drop-overlay").count()).toBe(0);
      const [x0, y0] = await at();
      expect(Math.abs(x0! - (row.x + 7))).toBeLessThanOrEqual(1);
      expect(Math.abs(y0! - row.y)).toBeLessThanOrEqual(1);
      for (const step of [40, 80, 120]) {
        await page.mouse.move(row.x + step, row.y + step / 4);
        // WebKit reports whole pixels, so the preview counts as at the pointer within 1 px.
        await page.waitForFunction(
          (expected) => {
            const preview = document.querySelector<HTMLElement>(".k2b-drag-preview");
            const [x, y] = (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(preview?.style.transform ?? "") ?? []).slice(1).map(Number);
            return x !== undefined && y !== undefined && Math.abs(x - expected.x) <= 1 && Math.abs(y - expected.y) <= 1;
          },
          { x: row.x + step, y: row.y + step / 4 },
        );
      }
      // The overlay appears once its code is there, during the same drag, and nothing shifted meanwhile.
      await page.locator(".k2b-drop-overlay").waitFor({ timeout: 4000 });
      expect(arrived).toBe(true);
      const [x1, y1] = await at();
      expect(Math.abs(x1! - (row.x + 120))).toBeLessThanOrEqual(1);
      expect(Math.abs(y1! - (row.y + 30))).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => (window as unknown as { shift: number }).shift)).toBe(0);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("new tiles take nothing while arming; after it, the target under the pointer is found again", async () => {
    const { page, context } = await open();
    try {
      await start(page);
      // Straight onto "Assign to me" and let go in the same task: the level is still arming, so nothing happens.
      const me = await center(page, ".k2b-drop-overlay__tile >> nth=0");
      expect(await page.locator(".k2b-drop-overlay[data-arming]").count()).toBe(1);
      expect(await moveAndRelease(page, me)).toBe(true);
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
      await settled(page);
      await start(page);
      await page.mouse.move(me.x, me.y);
      // Without moving, the tile under the pointer becomes the target once armed, and says so.
      await page.waitForFunction(() => document.querySelector(".k2b-drop-overlay__tile")?.getAttribute("data-drop") === "over");
      await page.waitForFunction(() => document.querySelector(".k2b-drag-announcer")?.textContent?.includes("Over Assign to me."));
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "me", value: "m0", count: 1 }]);
    } finally {
      await context.close();
    }
  });

  test("sweeping over a tile with a level does not open it; resting does, then a person takes the drop", async () => {
    const { page, context } = await open();
    try {
      await start(page);
      await armed(page);
      const other = await center(page, ".k2b-drop-overlay__tile >> nth=1");
      const folder = await center(page, ".k2b-drop-overlay__tile >> nth=2");
      await page.mouse.move(other.x, other.y, { steps: 2 });
      await page.mouse.move(folder.x, folder.y, { steps: 2 });
      await page.mouse.move(other.x, other.y + 20, { steps: 2 });
      expect(await page.locator(".k2b-drop-overlay").getAttribute("data-level")).toBe("root");
      // Resting fills the ring and opens the people.
      await page.waitForFunction(() => document.querySelector(".k2b-drop-overlay")?.getAttribute("data-level") === "inner", undefined, {
        timeout: 2000,
      });
      expect(await page.locator(".k2b-drop-overlay__title").textContent()).toBe("Assign to someone else · Frequent");
      expect(await page.locator(".k2b-drop-overlay__tile >> nth=0").textContent()).toContain("Back");
      await armed(page);
      // "Back" now lies under the still pointer; resting there opens nothing until the pointer moves.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 700)));
      expect(await page.locator(".k2b-drop-overlay__title").textContent()).toBe("Assign to someone else · Frequent");
      const tobias = await center(page, ".k2b-drop-overlay__tile >> nth=2");
      await page.mouse.move(tobias.x, tobias.y, { steps: 2 });
      await page.waitForFunction(() => document.querySelectorAll(".k2b-drop-overlay__tile")[2]?.getAttribute("data-drop") === "over");
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Tobias", value: "m0", count: 1 }]);
    } finally {
      await context.close();
    }
  });

  test("a drop straight on a tile with a level runs its own drop; a disabled tile and the cancel area change nothing", async () => {
    const { page, context } = await open();
    try {
      await start(page);
      await armed(page);
      const other = await center(page, ".k2b-drop-overlay__tile >> nth=1");
      await page.mouse.move(other.x, other.y, { steps: 2 });
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "chooser", value: "m0", count: 1 }]);
      for (const selector of [".k2b-drop-overlay__tile >> nth=3", ".k2b-drop-overlay__cancel"]) {
        await settled(page);
        await start(page);
        await armed(page);
        const point = await center(page, selector);
        await page.mouse.move(point.x, point.y, { steps: 2 });
        if (selector.includes("tile")) {
          // The disabled tile refuses and says why.
          await page.waitForFunction(
            () => document.querySelectorAll(".k2b-drop-overlay__tile")[3]?.getAttribute("data-drop") === "refused",
          );
          await page.waitForFunction(() => document.querySelector(".k2b-drag-announcer")?.textContent?.includes("Already done"));
        }
        await page.mouse.up();
        await clean(page);
      }
      expect(await page.locator(".k2b-drag-announcer").textContent()).toContain("not moved");
      expect(await drops(page)).toEqual([{ target: "chooser", value: "m0", count: 1 }]);
      // The host is told twice that nothing changed, so it can say so; the drop was not a cancel.
      expect(await page.evaluate(() => (window as unknown as { cancels: string[] }).cancels)).toEqual(["m0", "m0"]);
    } finally {
      await context.close();
    }
  });

  test("Escape and leaving the window cancel; a folder outside the overlay takes the drop; nothing shifts and nothing loads", async () => {
    const { page, context, overlayLoaded } = await open();
    try {
      // The overlay's own code loads ahead of the drag (WebKit has no idle callback, so after 200 ms); from then on,
      // dragging loads nothing.
      await overlayLoaded;
      await settled(page);
      let requests = 0;
      page.on("request", () => requests++);
      await start(page);
      await page.keyboard.press("Escape");
      await clean(page);
      await page.mouse.up();
      await settled(page);
      await start(page);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await clean(page);
      await page.mouse.up();
      expect(await drops(page)).toEqual([]);
      await page.evaluate(() => {
        (window as unknown as { many: boolean }).many = true;
      });
      await settled(page);
      await start(page);
      expect(await page.locator(".k2b-drop-overlay__what").textContent()).toBe("3 conversations");
      expect(await page.locator(".k2b-drag-preview__count").textContent()).toBe("3");
      // Over the overlay the preview is a 24 px badge at the pointer's tip, so it covers no tile's words.
      await settled(page);
      const badge = await page.evaluate(() => {
        const box = document.querySelector(".k2b-drag-preview")!.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height), left: box.left, top: box.top };
      });
      const row = await center(page, ".row");
      expect(badge).toMatchObject({ width: 24, height: 24 });
      expect(Math.abs(badge.left - (row.x + 7))).toBeLessThanOrEqual(12);
      expect(Math.abs(badge.top - row.y)).toBeLessThanOrEqual(12);
      const archive = await center(page, ".archive");
      await page.mouse.move(archive.x, archive.y, { steps: 3 });
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "m0", count: 3 }]);
      expect(requests).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { shift: number }).shift)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("when the overlay cannot load, the drag says so and other targets still take it", async () => {
    const { page, context } = await open({ missing: true });
    try {
      await settled(page);
      const row = await center(page, ".row");
      await page.mouse.move(row.x, row.y);
      await page.mouse.down();
      await page.mouse.move(row.x + 7, row.y);
      await page.locator(".k2b-drag-preview").waitFor();
      await page.waitForFunction(() =>
        document.querySelector(".k2b-drag-announcer")?.textContent?.includes("drop targets are not available"),
      );
      expect(await page.locator(".k2b-drop-overlay").count()).toBe(0);
      const archive = await center(page, ".archive");
      await page.mouse.move(archive.x, archive.y, { steps: 3 });
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "m0", count: 1 }]);
    } finally {
      await context.close();
    }
  });

  test("a finger does not drag: held 500 ms it opens the host's menu, moved more than 8 px it does nothing", async () => {
    const { page, context } = await open({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
    try {
      const row = await center(page, ".row");
      await page.evaluate(
        async ({ row }) => {
          const target = document.querySelector(".row")!;
          const pointer = (type: string, x: number) =>
            target.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 3,
                pointerType: "touch",
                isPrimary: true,
                button: 0,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: row.y,
              }),
            );
          pointer("pointerdown", row.x);
          await new Promise((done) => setTimeout(done, 300));
          pointer("pointermove", row.x + 6);
          await new Promise((done) => setTimeout(done, 300));
          pointer("pointermove", row.x + 30);
          pointer("pointerup", row.x + 30);
          // A second press moves 12 px early: no menu.
          pointer("pointerdown", row.x);
          pointer("pointermove", row.x + 12);
          await new Promise((done) => setTimeout(done, 600));
          pointer("pointerup", row.x + 12);
        },
        { row },
      );
      expect(await page.locator(".k2b-drag-preview, .k2b-drop-overlay").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { menus: number[] }).menus)).toEqual([0]);
    } finally {
      await context.close();
    }
  });
});
