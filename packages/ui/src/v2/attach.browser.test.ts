// Contract test for a Workspace the server rendered without an island: `attachWorkspaces` brings its drawer, the
// collapse of its sidebar, the toaster, `Dialog.confirm`, its grips (their place and their columns) and the folds of
// its Nav alive, and nothing moves when it attaches. Runs in Chromium and in WebKit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { transform } from "../../../ssr/src/transform";
import { transparentIslands } from "../../scripts/v2-island-css";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-behavior/frame.entry";
import type {} from "../../test/v2-behavior/frame-live.entry";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let live: string;
let markup: string;
const css = `${transparentIslands(readFileSync(resolve(import.meta.dir, "v2.css"), "utf8"))}\n[hidden]{display:none}`;
beforeAll(async () => {
  [bundle, live, markup, split] = await Promise.all([demoBundle("frame"), demoBundle("frame-live"), serverMarkup("frame"), splitBuild()]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(split.directory, { recursive: true, force: true });
});

/** The frame entry as a page loads it: modules with the live parts in a chunk of their own, which a test can hold back. */
type Split = { directory: string; entry: string; liveChunk: string };
let split: Split;
const splitBuild = async (): Promise<Split> => {
  const directory = mkdtempSync(join(tmpdir(), "k2-v2-frame-split-"));
  const entry = resolve(import.meta.dir, "../../test/v2-behavior/frame.entry.tsx");
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: directory,
    target: "browser",
    conditions: ["browser"],
    splitting: true,
    metafile: true,
    naming: { entry: "[name].js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "frame-split-solid",
        setup(build) {
          build.onResolve({ filter: /^solid-js(?:\/(?:web|store))?$/ }, (args) => {
            const module = args.path === "solid-js" ? "solid" : args.path.slice("solid-js/".length);
            return { path: Bun.resolveSync(`${args.path}/dist/${module}.js`, import.meta.dir) };
          });
          build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
            contents: await transform(await Bun.file(path).text(), path, "dom"),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success || !result.metafile) throw new AggregateError(result.logs, "split frame build failed");
  const liveChunk = Object.entries(result.metafile.outputs).find(([, output]) =>
    Object.keys(output.inputs).some((input) => input.endsWith("attach-live.tsx")),
  )?.[0];
  if (!liveChunk) throw new Error("the live parts have no chunk of their own");
  return { directory, entry: "frame.entry.js", liveChunk: basename(liveChunk) };
};

/** The server's page with the split frame entry from https://k2.test/; `live` answers the live parts' chunk. */
const withSplitPage = async (
  live: (fulfil: () => Promise<void>, abort: () => Promise<void>) => Promise<void>,
  run: (page: Page) => Promise<void>,
  body = markup,
) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.setDefaultTimeout(4000);
  const errors = pageErrors(page);
  try {
    await page.route("https://k2.test/**", async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      const file = () => route.fulfill({ contentType: "text/javascript", body: readFileSync(join(split.directory, name), "utf8") });
      if (name === "")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}<script type="module" src="/${split.entry}"></script></body></html>`,
        });
      if (name === split.liveChunk) return live(file, () => route.abort());
      return file();
    });
    await page.goto("https://k2.test/");
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The boxes of every part of the page, to compare before and after the frame attached (without its live parts). */
const boxes = (page: Page) =>
  page.$$eval("[data-k2-part]", (parts) =>
    parts
      .filter((part) => !part.closest("[data-k2-ws-live]"))
      .map((part) => {
        const box = part.getBoundingClientRect();
        return `${part.getAttribute("data-k2-part")} ${[box.x, box.y, box.width, box.height].map(Math.round).join(",")}`;
      }),
  );

const withPage = async (width: number, run: (page: Page) => Promise<void>, prepare?: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await prepare?.(page);
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body>${markup}</body></html>`,
    );
    await settled(page);
    const before = await boxes(page);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    expect(await boxes(page)).toEqual(before);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("the server's markup is the frame: no toaster, dialog or drawer until the page attaches it", () => {
  expect(markup).toContain("data-k2-workspace ");
  expect(markup).not.toContain("data-k2-toaster");
  expect(markup).not.toContain('data-slot="drawer-trigger"');
});

test("in a narrow window the drawer holds the sidebar's own nodes and gives them back", async () => {
  await withPage(900, async (page) => {
    const toggle = page.locator(".k2-ws-toggle");
    expect(await toggle.isVisible()).toBe(true);
    expect(await page.locator(".k2-ws-collapse").isVisible()).toBe(false);
    await toggle.click();
    const drawer = page.locator(".k2-drawer");
    await drawer.waitFor();
    expect(await drawer.locator('[data-k2-part="Nav"]').count()).toBe(1);
    expect(await page.locator('.k2-ws-side [data-k2-part="Nav"]').count()).toBe(0);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    expect(await page.locator('.k2-ws-side [data-k2-part="Nav"]').count()).toBe(1);
    await page.waitForFunction(() => document.activeElement?.classList.contains("k2-ws-toggle") === true);
    // picking an entry closes the drawer
    await toggle.click();
    await drawer.getByRole("link", { name: "Eingang" }).click();
    await drawer.waitFor({ state: "detached" });
  });
});

test("on a wide screen the sidebar collapses and expands by its button and Mod+Alt+S, and the page hears each change", async () => {
  await withPage(1440, async (page) => {
    const collapse = page.locator(".k2-ws-collapse");
    const side = page.locator(".k2-ws-side");
    expect(await page.locator(".k2-ws-toggle").isVisible()).toBe(false);
    expect(await collapse.getAttribute("aria-expanded")).toBe("true");
    expect(await collapse.getAttribute("aria-label")).toBe("Seitenleiste ausblenden");
    await collapse.click();
    await side.waitFor({ state: "hidden" });
    expect(await collapse.getAttribute("aria-expanded")).toBe("false");
    expect(await collapse.getAttribute("aria-label")).toBe("Seitenleiste zeigen");
    await page.keyboard.press("Control+Alt+KeyS");
    await side.waitFor({ state: "visible" });
    expect(await page.evaluate(() => window.__collapsed)).toEqual([true, false]);
  });
});

test("the collapse button stands at the start of the head, after the sidebar's line, and covers nothing", async () => {
  await withPage(1440, async (page) => {
    const seen = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const button = box(document.querySelector(".k2-ws-collapse")!);
      const main = box(document.querySelector(".k2-ws-main")!);
      const side = box(document.querySelector(".k2-ws-side")!);
      const parts = [...document.querySelectorAll('.k2-ws-side *, .k2-ws-main > [data-slot="head"] .k2-bar-start > *')];
      const over = parts.filter((part) => {
        const other = box(part);
        return (
          other.width > 0 &&
          other.left < button.right &&
          other.right > button.left &&
          other.top < button.bottom &&
          other.bottom > button.top
        );
      });
      return {
        afterLine: button.left >= main.left && button.left >= side.right,
        atStart: Math.round(button.left - main.left),
        over: over.map((part) => part.className || part.tagName),
      };
    });
    expect(seen.afterLine).toBe(true);
    // the button's icon on the text edge: 20 px in, the button 10 px wider on each side than its icon
    expect(seen.atStart).toBe(10);
    expect(seen.over).toEqual([]);
  });
});

test("a command of the page hides and shows the sidebar as its button does, opens the drawer where it is one, and nothing once detached", async () => {
  await withPage(1440, async (page) => {
    const collapse = page.locator(".k2-ws-collapse");
    const side = page.locator(".k2-ws-side");
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(true);
    await side.waitFor({ state: "hidden" });
    expect(await collapse.getAttribute("aria-expanded")).toBe("false");
    expect(await collapse.getAttribute("aria-label")).toBe("Seitenleiste zeigen");
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(true);
    await side.waitFor({ state: "visible" });
    expect(await page.evaluate(() => window.__collapsed)).toEqual([true, false]);
    await page.evaluate(() => window.__detach());
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(false);
    expect(await page.evaluate(() => window.__collapsed)).toEqual([true, false]);
  });
  await withPage(900, async (page) => {
    const drawer = page.locator(".k2-drawer");
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(true);
    await drawer.waitFor();
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(true);
    await drawer.waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.__collapsed)).toEqual([]);
  });
  // on the phone the sidebar leaves: there is nothing to hide
  await withPage(390, async (page) => {
    expect(await page.evaluate(() => window.__toggleSidebar())).toBe(false);
  });
});

test("a fold of the server's Nav opens and closes", async () => {
  await withPage(1440, async (page) => {
    const fold = page.getByRole("button", { name: "Archiv" });
    expect(await fold.getAttribute("aria-expanded")).toBe("false");
    expect(await page.getByRole("link", { name: "2025" }).isVisible()).toBe(false);
    await fold.click();
    expect(await fold.getAttribute("aria-expanded")).toBe("true");
    await page.getByRole("link", { name: "2025" }).waitFor();
  });
});

test("useToast and Dialog.confirm answer from the attached workspace", async () => {
  await withPage(1440, async (page) => {
    await page.evaluate(() => window.__toast("Gespeichert"));
    await page.locator('[data-k2-toaster] [data-slot="toast"]').getByText("Gespeichert").waitFor();
    const answer = page.evaluate(() => window.__confirm());
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Verwerfen" }).click();
    expect(await answer).toBe(true);
  });
});

test("the grip of a line stands in the middle of the line in sight", async () => {
  await withPage(1440, async (page) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>("[data-k2-grip]")].every((grip) => grip.style.getPropertyValue("--k2-grip-top") !== ""),
    );
  });
});

/** The rendered width of `selector`, whole px. */
const widthOf = (page: Page, selector: string) => page.$eval(selector, (element) => Math.round(element.getBoundingClientRect().width));
/** Waits until `selector` is `px` wide. */
const becomes = (page: Page, selector: string, px: number) =>
  page.waitForFunction(({ selector, px }) => Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? -1) === px, {
    selector,
    px,
  });

// Guard for a focusable control without behaviour (#4217) on the server's markup: its grips move their columns as an
// island's do, once @ui-sdk/core is there.
test("a grip of the server's markup moves its column by keys and by pointer, and says its values once it has the focus", async () => {
  await withPage(1440, async (page) => {
    const side = page.locator('.k2-grip[aria-label="Sidebar"]');
    const list = page.locator('.k2-grip[aria-label="Liste"]');
    const column = page.locator('.k2-cgrip[aria-label="Artikel"]');
    expect(await side.getAttribute("aria-valuemax")).toBeNull();
    await side.focus();
    await page.waitForFunction(() => document.querySelector('.k2-grip[aria-label="Sidebar"]')?.hasAttribute("aria-valuemax"));
    // the most leaves the list 300 and the reader 400 (the room of 950 px the server wrote, with the lines)
    expect(await page.$eval("[data-k2-workspace]", (element) => element.getAttribute("data-k2-room"))).toBe("950");
    const most = await page.$eval("[data-k2-workspace]", (element) => element.clientWidth - 950 + 248);
    expect(await side.getAttribute("aria-valuemax")).toBe(String(most));
    await page.keyboard.press("ArrowRight");
    await becomes(page, ".k2-ws-side", 256);
    // the grip says the width once it has measured it
    await page.waitForFunction(() => document.querySelector('.k2-grip[aria-label="Sidebar"]')?.getAttribute("aria-valuenow") === "256");
    await page.keyboard.press("Enter");
    await becomes(page, ".k2-ws-side", 248);
    // a drag of the list's grip: the list grows the way the pointer goes
    const before = await widthOf(page, 'section[aria-label="Liste"]');
    const box = await list.boundingBox();
    if (!box) throw new Error("no grip of the list");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await becomes(page, 'section[aria-label="Liste"]', before + 40);
    // a column of the table, by its grip in the next column's head
    const head = ".k2-table th:nth-child(1)";
    const first = await widthOf(page, head);
    await column.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await becomes(page, head, first + 64);
  });
});

test("a key on a grip before the live parts are there moves the column once they are", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withSplitPage(
    async (fulfil) => {
      await held;
      await fulfil();
    },
    async (page) => {
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.locator('.k2-grip[aria-label="Sidebar"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await widthOf(page, ".k2-ws-side")).toBe(248);
      release();
      await becomes(page, ".k2-ws-side", 256);
      // once, not again a frame later
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await widthOf(page, ".k2-ws-side")).toBe(256);
    },
  );
});

test("of two presses on a grip before the live parts are there, only the one that still holds moves the column", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withSplitPage(
    async (fulfil) => {
      await held;
      await fulfil();
    },
    async (page) => {
      await page.setViewportSize({ width: 1440, height: 800 });
      await settled(page);
      const box = await page.locator('.k2-grip[aria-label="Sidebar"]').boundingBox();
      if (!box) throw new Error("no grip of the sidebar");
      const y = box.y + box.height / 2;
      const left = box.x + 1;
      const right = box.x + box.width - 1;
      // a press let go at the grip's left edge, then a press that holds at its right edge
      await page.mouse.move(left, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.mouse.move(right, y);
      await page.mouse.down();
      release();
      await page.waitForFunction(() => document.querySelector(".k2-grip[data-dragging]") !== null);
      await page.mouse.move(right + 40, y, { steps: 4 });
      await page.mouse.up();
      // the drag counts from where the press that held began: 40 px, not from the press let go
      await becomes(page, ".k2-ws-side", 288);
    },
  );
});

test("a live part that fails to load says so with Retry, and Retry loads it and does what was asked", async () => {
  let tries = 0;
  await withSplitPage(
    (fulfil, abort) => (++tries === 1 ? abort() : fulfil()),
    async (page) => {
      await page.evaluate(() => window.__toast("Gespeichert"));
      const failure = page.getByRole("alert").filter({ hasText: "Dieser Teil der Seite konnte nicht geladen werden." });
      await failure.waitFor();
      await failure.getByRole("button", { name: "Erneut versuchen" }).click();
      await page.locator('[data-k2-toaster] [data-slot="toast"]').getByText("Gespeichert").waitFor();
      expect(await failure.count()).toBe(0);
      // the drawer loads from the chunk that is there now
      await page.locator(".k2-ws-toggle").click();
      await page.locator(".k2-drawer").waitFor();
      expect(tries).toBe(2);
    },
  );
});

test("a question still waiting for the live parts when the workspace goes is answered no, without an error", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withSplitPage(
    async (fulfil) => {
      await held;
      await fulfil();
    },
    async (page) => {
      await page.evaluate(() => {
        Reflect.set(window, "__answer", window.__confirm());
      });
      await page.evaluate(() => window.__detach());
      release();
      expect(await page.evaluate(() => Reflect.get(window, "__answer"))).toBe(false);
      await page.waitForTimeout(100); // settled: the late chunk runs after the answer; an error from it would show here
      expect(await page.locator(".k2-dialog").count()).toBe(0);
    },
  );
});

test("the sidebar in the open drawer stays reactive, and a sidebar that goes and comes back has a working drawer", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: live });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    const drawer = page.locator(".k2-drawer");
    const more = drawer.getByRole("navigation", { name: "Mehr" });
    await page.locator(".k2-ws-toggle").click();
    await more.waitFor();
    // what the Workspace stops rendering leaves the open drawer, and what it renders again comes into it
    await page.evaluate(() => window.__more(false));
    await more.waitFor({ state: "detached" });
    await page.evaluate(() => window.__more(true));
    await more.waitFor();
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    expect(await page.locator(".k2-ws-side nav").count()).toBe(2);
    // the whole sidebar goes while the drawer is open: the drawer closes with it
    await page.locator(".k2-ws-toggle").click();
    await more.waitFor();
    await page.evaluate(() => window.__sidebar(false));
    await drawer.waitFor({ state: "detached" });
    expect(await page.locator("nav").count()).toBe(0);
    // and when it comes back, its new button opens a drawer with it
    await page.evaluate(() => window.__sidebar(true));
    await page.locator(".k2-ws-toggle").click();
    await drawer.getByRole("navigation", { name: "Auftrag" }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("Mod+Alt+S is no shortcut while typing: not in a field, not with AltGr, not while composing", async () => {
  await withPage(1440, async (page) => {
    await page.getByRole("textbox", { name: "Notiz" }).focus();
    await page.keyboard.press("Control+Alt+KeyS");
    await page.evaluate(() => {
      const press = (init: KeyboardEventInit) =>
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { code: "KeyS", ctrlKey: true, altKey: true, bubbles: true, cancelable: true, ...init }),
        );
      // AltGr+S writes "ś" on a Polish keyboard; a composition is text on its way
      press({ key: "ś", modifierAltGraph: true });
      press({ key: "s", isComposing: true });
    });
    expect(await page.evaluate(() => window.__collapsed)).toEqual([]);
    expect(await page.locator(".k2-ws").getAttribute("data-collapsed")).toBeNull();
    // outside a field, the keys still work
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("Control+Alt+KeyS");
    expect(await page.evaluate(() => window.__collapsed)).toEqual([true]);
  });
});

test("two uses waiting on one failed load share one notice, and Retry loads once and runs both", async () => {
  let tries = 0;
  await withSplitPage(
    (fulfil, abort) => (++tries === 1 ? abort() : fulfil()),
    async (page) => {
      await page.evaluate(() => {
        Reflect.set(window, "__answer", window.__confirm());
        window.__toast("Gespeichert");
      });
      const failure = page.getByRole("alert").filter({ hasText: "Dieser Teil der Seite konnte nicht geladen werden." });
      await failure.waitFor();
      expect(await failure.count()).toBe(1);
      await failure.getByRole("button", { name: "Erneut versuchen" }).click();
      // both run: the toast shows and the question opens, and it answers
      await page.locator('[data-k2-toaster] [data-slot="toast"]').getByText("Gespeichert").waitFor();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Verwerfen" }).click();
      expect(await page.evaluate(() => Reflect.get(window, "__answer"))).toBe(true);
      expect(tries).toBe(2);
    },
  );
});

test("when Retry fails too, the notice offers to reload the page and to close it, which answers waiting questions no", async () => {
  let tries = 0;
  await withSplitPage(
    async (_fulfil, abort) => {
      tries++;
      await abort();
    },
    async (page) => {
      await page.evaluate(() => {
        Reflect.set(window, "__answer", window.__confirm());
      });
      const failure = page.getByRole("alert").filter({ hasText: "Dieser Teil der Seite konnte nicht geladen werden." });
      await failure.getByRole("button", { name: "Erneut versuchen" }).click();
      await failure.getByRole("button", { name: "Seite neu laden" }).waitFor();
      await failure.getByRole("button", { name: "Schließen" }).click();
      await failure.waitFor({ state: "detached" });
      expect(await page.evaluate(() => Reflect.get(window, "__answer"))).toBe(false);
      expect(tries).toBe(2);
    },
  );
});

test("the notice stands above an open modal dialog and can be pressed there", async () => {
  let tries = 0;
  await withSplitPage(
    (fulfil, abort) => (++tries === 1 ? abort() : fulfil()),
    async (page) => {
      await page.evaluate(() => window.__openDialog());
      await page.getByRole("dialog", { name: "Auftrag" }).waitFor();
      await page.evaluate(() => window.__toast("Gespeichert"));
      const retry = page.getByRole("alert").getByRole("button", { name: "Erneut versuchen" });
      await retry.waitFor();
      // the notice is a lasting layer once the registry has loaded
      await page.locator("[data-k2-ws-failed] [data-lasting]").waitFor({ state: "attached" });
      // what a press there would reach is the button itself, not the dialog's backdrop
      expect(
        await retry.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      ).toBe(true);
      await retry.click();
      await page.locator('[data-k2-toaster] [data-slot="toast"]').getByText("Gespeichert").waitFor();
    },
  );
});

test("on a Mac, Cmd+Option+S works also where Gecko reports Option as AltGr, and in a field; a textbox role is a field", async () => {
  await withPage(
    1440,
    async (page) => {
      await page.evaluate(() => {
        const press = (target: EventTarget, init: KeyboardEventInit) =>
          target.dispatchEvent(
            new KeyboardEvent("keydown", { code: "KeyS", key: "s", altKey: true, bubbles: true, cancelable: true, ...init }),
          );
        press(document.body, { metaKey: true, modifierAltGraph: true });
        const field = document.querySelector('input[aria-label="Notiz"]');
        if (field) press(field, { metaKey: true });
        // Ctrl+Alt in a textbox could type a letter there: no shortcut
        const box = document.createElement("div");
        box.setAttribute("role", "textbox");
        document.body.append(box);
        press(box, { ctrlKey: true });
      });
      expect(await page.evaluate(() => window.__collapsed)).toEqual([true, false]);
    },
    async (page) => {
      // a navigation runs the script, and the page's content then stands in that window
      await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
      await page.goto("about:blank");
    },
  );
});

test("a collapse button that comes later works: the island's Workspace attaches again", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: live });
    await page.waitForFunction(() => window.__mounted === true);
    await page.evaluate(() => window.__collapsible(true));
    const collapse = page.locator(".k2-ws-collapse");
    await collapse.waitFor();
    await collapse.click();
    await page.locator(".k2-ws-side").waitFor({ state: "hidden" });
    expect(await collapse.getAttribute("aria-expanded")).toBe("false");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("two workspaces that fail to load share one notice, which leaves with the workspaces that wait", async () => {
  await withSplitPage(
    (_fulfil, abort) => abort(),
    async (page) => {
      // at 900 px both sidebars are drawers: a press on each button waits for the drawer that does not load
      const toggles = page.locator(".k2-ws-toggle");
      expect(await toggles.count()).toBe(2);
      await toggles.nth(0).click();
      await page.locator("[data-k2-ws-failed]").waitFor({ state: "attached" });
      await toggles.nth(1).click();
      await page.waitForTimeout(300); // settled: the second failure must not add a notice, which shows only by its count
      expect(await page.locator("[data-k2-ws-failed]").count()).toBe(1);
      expect(await page.getByRole("alert").count()).toBe(1);
      // the workspaces go (a page swap): what waits for them is dropped, and the notice with it
      await page.evaluate(() => window.__detach());
      await page.locator("[data-k2-ws-failed]").waitFor({ state: "detached" });
    },
    // two workspaces one under the other: each demo frame stands in a box of its own instead of filling the window
    [markup, markup].map((frame) => frame.replace("position:fixed;inset:0", "position:relative;height:400px")).join(""),
  );
});

// Known gap of @ui-sdk/core 0.1.0-beta.14 (issue drafted in #4230): an open modal's focus trap keeps Tab inside the
// dialog, also from a lasting layer (`bindPersistentLayer`) such as the toaster or this notice; the pointer reaches it.
// `failing` until core lets Tab reach lasting layers: this test turns red then, and becomes a plain test.
test.failing("Tab reaches the notice's button over an open modal dialog", async () => {
  await withSplitPage(
    (_fulfil, abort) => abort(),
    async (page) => {
      await page.evaluate(() => window.__openDialog());
      await page.getByRole("dialog", { name: "Auftrag" }).waitFor();
      await page.evaluate(() => window.__toast("Gespeichert"));
      await page.locator("[data-k2-ws-failed] [data-lasting]").waitFor({ state: "attached" });
      const onRetry = () => page.evaluate(() => document.activeElement?.closest("[data-k2-ws-failed]") !== null);
      let reached = false;
      for (let step = 0; step < 8 && !reached; step++) {
        await page.keyboard.press("Tab");
        reached = await onRetry();
      }
      expect(reached).toBe(true);
    },
  );
});
