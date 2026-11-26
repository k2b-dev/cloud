import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../ui/test/browser";
import { solidTestPlugin } from "../../ui/test/solid-test-plugin";

// The chrome of both Markdown editors inside a v2 screen of Cloud (Cloud's stylesheet, v1 and v2): toolbars of the
// v2 bar height on the v2 text edge, icon buttons with the v2 icon size and hit area, no frame of their own beside the
// v2 lines, the toolbar's names and focus order kept, and nothing that moves once the page stands. Runs in Chromium
// and in WebKit (TEST_BROWSER=webkit). With K2B_EDITOR_PICTURES set it saves a picture per width there.

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "v2-chrome.browser-fixture.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [solidTestPlugin()],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the v2 chrome fixture.");
  const bundle = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  // the fonts of the page as data, so icons and type draw without a server for font files
  const ui = resolve(import.meta.dir, "../../ui/node_modules");
  const plex = [400, 500, 600]
    .map((weight) => resolve(ui, `@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`))
    .filter((path) => existsSync(path))
    .map(
      (path, index) =>
        `@font-face{font-family:"IBM Plex Sans";font-weight:${[400, 500, 600][index]};font-display:block;src:url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2")}`,
    )
    .join("");
  // the icon font's own stylesheet, as Cloud's page links it, with its font as data
  const tabler = resolve(ui, "@tabler/icons-webfont/dist");
  const icons = existsSync(resolve(tabler, "tabler-icons.min.css"))
    ? readFileSync(resolve(tabler, "tabler-icons.min.css"), "utf8").replace(
        /@font-face\{[^}]*\}/,
        `@font-face{font-family:"tabler-icons";font-display:block;src:url(data:font/woff2;base64,${readFileSync(resolve(tabler, "fonts/tabler-icons.woff2")).toString("base64")}) format("woff2")}`,
      )
    : "";
  // the editor's own stylesheet, as an app that uses it imports it
  const editorCss = readFileSync(resolve(import.meta.dir, "styles.css"), "utf8");
  const css = `${await styles.outputs[0]!.text()}
${editorCss}
${plex}${icons}`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (width: number, search = "") => {
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  await page.goto(`${server.url.href}${search}`);
  await page.waitForFunction(() => document.querySelectorAll(".cm-content").length > 0 && document.querySelector(".k2b-markdown-editor"));
  await settled(page);
  return page;
};

type Chrome = { bar: { height: number; left: number }; buttons: { width: number; height: number; icon: number; left: number }[] };

/** The toolbar of one editor: its box against its Canvas, and each icon button with the size of its icon. */
const chrome = (page: Page, which: "ui" | "shared") =>
  page.evaluate((kind): Chrome => {
    const host = document.querySelector(`[data-editor="${kind}"]`);
    const canvas = host?.closest(".k2-canvas");
    const bar = host?.querySelector(kind === "ui" ? ".k2b-markdown-editor__toolbar" : "[data-k2b-editor-toolbar]");
    if (!host || !canvas || !bar) throw new Error(`no toolbar for ${kind}`);
    const edge = canvas.getBoundingClientRect().left;
    const box = bar.getBoundingClientRect();
    const buttons = [...bar.querySelectorAll("button")].filter(
      (button) => button.getClientRects().length > 0 && !button.matches(".k2b-button:not(.k2b-icon-button)"),
    );
    return {
      bar: { height: Math.round(box.height), left: Math.round(box.left - edge) },
      buttons: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector(".ti");
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          icon: icon ? Math.round(Number.parseFloat(getComputedStyle(icon).fontSize)) : 0,
          left: Math.round(rect.left - edge),
        };
      }),
    };
  }, which);

for (const width of [1440, 390])
  test(`at ${width} px both toolbars speak v2: a 40 px bar, 28 px buttons with 16 px icons, the first glyph on the v2 text edge`, async () => {
    const page = await open(width);
    try {
      const pictures = process.env.K2B_EDITOR_PICTURES;
      if (pictures) {
        mkdirSync(pictures, { recursive: true });
        await page.screenshot({ path: resolve(pictures, `editor-chrome-${width}.png`) });
      }
      for (const kind of ["ui", "shared"] as const) {
        // on the phone the split stacks its panes: the second one is below the window
        if (width < 768 && kind === "shared") continue;
        const found = await chrome(page, kind);
        expect({ kind, height: found.bar.height }).toEqual({ kind, height: 40 });
        for (const button of found.buttons)
          expect({ kind, ...button, left: 0 }).toEqual({ kind, width: 28, height: 28, icon: 16, left: 0 });
        // the glyph of the first button (6 px into its 28 px) stands on the v2 text edge: 20 px, 16 px on the phone
        expect({ kind, edge: (found.buttons[0]?.left ?? 0) + 6 }).toEqual({ kind, edge: width < 768 ? 16 : 20 });
      }
    } finally {
      await page.close();
    }
  }, 30_000);

/** The toolbars' buttons in the order Tab reaches them from the page's start, by their names. */
const tabOrder = async (page: Page) => {
  const names: string[] = [];
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  // one round through the page: Tab until it reaches an element it reached before
  await page.evaluate(() => Reflect.set(window, "__seen", new WeakSet()));
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      const seen: unknown = Reflect.get(window, "__seen");
      if (!element || !(seen instanceof WeakSet)) return { again: true, name: "" };
      if (seen.has(element)) return { again: true, name: "" };
      seen.add(element);
      if (!element.closest(".k2b-markdown-editor__toolbar, [data-k2b-editor-toolbar]")) return { again: false, name: "" };
      return { again: false, name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "" };
    });
    if (stop.again) break;
    if (stop.name) names.push(stop.name);
  }
  return names;
};
/** Every toolbar button on the page by its accessible name, in the order of the page (the entries of a closed menu
 * are not on it). */
const toolbarNames = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".k2b-markdown-editor__toolbar button, [data-k2b-editor-toolbar] button")]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""),
  );

test("inside v2 the toolbars keep every name and the focus order they have in a v1 page", async () => {
  const [v1, v2] = [await open(1440, "?v1"), await open(1440)];
  try {
    const names = await toolbarNames(v2);
    expect(names.length).toBeGreaterThan(15);
    expect(names.every((name) => name.length > 0)).toBe(true);
    expect(names).toEqual(await toolbarNames(v1));
    expect(await tabOrder(v2)).toEqual(await tabOrder(v1));
  } finally {
    await v1.close();
    await v2.close();
  }
}, 30_000);

test("nothing in the toolbars moves once the page stands: a hover and a press keep every button in place", async () => {
  const page = await open(1440);
  try {
    const boxes = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".k2b-markdown-editor__toolbar button, [data-k2b-editor-toolbar] button")].map((button) => {
          const { left, top, width, height } = button.getBoundingClientRect();
          return [left, top, width, height].map(Math.round).join(",");
        }),
      );
    const before = await boxes();
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    const button = page.locator("[data-k2b-editor-toolbar] button").first();
    await hoverInPlace(button);
    await button.click();
    await settled(page);
    expect(await boxes()).toEqual(before);
  } finally {
    await page.close();
  }
}, 30_000);

test("every symbol in both toolbars has the v2 icon size, also on a labelled control of the host", async () => {
  const page = await open(1440);
  try {
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll(".k2b-markdown-editor__toolbar .ti, [data-k2b-editor-toolbar] .ti")]
        .filter((icon) => icon.getClientRects().length > 0)
        .map((icon) => `${icon.closest("button")?.getAttribute("aria-label")}: ${getComputedStyle(icon).fontSize}`),
    );
    expect(sizes.length).toBeGreaterThan(15);
    expect(sizes.filter((size) => !size.endsWith(": 16px"))).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

for (const width of [1440, 390])
  test(`at ${width} px the text and the line of counts of MarkdownEditor stand on the v2 text edge, the counts in the meta role`, async () => {
    const page = await open(width);
    try {
      const found = await page.evaluate(() => {
        const canvas = document.querySelector('[data-editor="ui"]')?.closest(".k2-canvas");
        const input = document.querySelector('[data-editor="ui"] .k2b-markdown-editor__input');
        const stats = document.querySelector('[data-editor="ui"] .k2b-markdown-editor__stats');
        if (!canvas || !input || !stats) throw new Error("no editor");
        const edge = canvas.getBoundingClientRect().left;
        const text = (element: Element) =>
          Math.round(element.getBoundingClientRect().left - edge + Number.parseFloat(getComputedStyle(element).paddingLeft));
        const style = getComputedStyle(stats);
        return { input: text(input), stats: text(stats), size: style.fontSize, line: style.lineHeight };
      });
      const edge = width < 768 ? 16 : 20;
      expect(found).toEqual({ input: edge, stats: edge, size: "12px", line: "16px" });
    } finally {
      await page.close();
    }
  }, 30_000);

/** Walks the focused toolbar with the arrow keys; for each button, where its 3 px ring is cut or covered. */
const ringsCut = async (page: Page, bar: string) => {
  await page.locator(`${bar} button`).first().focus();
  // the ring shows for keyboard focus: one arrow there and back starts the walk from the keyboard
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  const cut: string[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < 30; step++) {
    // a focused tool may scroll the bar: read once it stands
    await settled(page);
    const found = await page.evaluate(() => {
      const button = document.activeElement;
      if (!(button instanceof HTMLElement)) return { name: "", cut: "nothing focused" };
      const name = button.getAttribute("aria-label") ?? "";
      if (!getComputedStyle(button).boxShadow.includes("3px")) return { name, cut: "no 3 px ring" };
      const box = button.getBoundingClientRect();
      const ring = { left: box.left - 3, top: box.top - 3, right: box.right + 3, bottom: box.bottom + 3 };
      for (let clip = button.parentElement; clip && !clip.classList.contains("k2-canvas"); clip = clip.parentElement) {
        const style = getComputedStyle(clip);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const outer = clip.getBoundingClientRect();
        const left = outer.left + clip.clientLeft;
        const top = outer.top + clip.clientTop;
        if (
          ring.left < left - 0.5 ||
          ring.top < top - 0.5 ||
          ring.right > left + clip.clientWidth + 0.5 ||
          ring.bottom > top + clip.clientHeight + 0.5
        )
          return { name, cut: `cut by ${clip.className || clip.tagName}` };
      }
      // nothing that paints stands over it or its ring, such as the controls that stay at the end of a scrolled bar: at
      // the centre and at a point in the ring on each side, no box between the point and the bar has a fill of its own
      // (a neighbour without a fill lets the ring show)
      const middle = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      const points = [
        middle,
        { x: ring.left + 1, y: middle.y },
        { x: ring.right - 1, y: middle.y },
        { x: middle.x, y: ring.top + 1 },
        { x: middle.x, y: ring.bottom - 1 },
      ];
      for (const point of points) {
        const over = document.elementFromPoint(point.x, point.y);
        if (!over) return { name, cut: "outside the window" };
        for (let box: Element | null = over; box && !box.contains(button); box = box.parentElement) {
          const style = getComputedStyle(box);
          if (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none")
            return { name, cut: `covered by ${box.getAttribute("aria-label") ?? box.className}` };
        }
      }
      return { name, cut: "" };
    });
    if (seen.has(found.name)) break;
    seen.add(found.name);
    if (found.cut) cut.push(`${found.name}: ${found.cut}`);
    await page.keyboard.press("ArrowRight");
  }
  return { cut, walked: seen.size };
};

for (const width of [1440, 390])
  test(`at ${width} px the focus ring of every toolbar button shows whole, nothing cuts or covers it`, async () => {
    const page = await open(width);
    try {
      const bars = ['[data-editor="ui"] [role="toolbar"]', "[data-k2b-editor-toolbar] [role=toolbar]"];
      for (const bar of bars) {
        const walk = await ringsCut(page, bar);
        expect(walk.walked).toBeGreaterThan(7);
        expect({ bar, cut: walk.cut }).toEqual({ bar, cut: [] });
      }
    } finally {
      await page.close();
    }
  }, 60_000);

test("both toolbars show a format that is on, and a button under the pointer, the same way, in the v2 tint of selection", async () => {
  const page = await open(1440);
  try {
    // the caret in the bold word of each editor turns "Fett" on in its toolbar
    await page.locator('[data-editor="ui"] .k2b-markdown-editor__input').evaluate((input) => {
      if (!(input instanceof HTMLTextAreaElement)) return;
      const at = input.value.indexOf("Lieferung") + 3;
      input.focus();
      input.setSelectionRange(at, at);
      input.dispatchEvent(new Event("select", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.locator('[data-editor="shared"] .cm-content').getByText("Lieferung").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(':is([role="toolbar"], [data-k2b-editor-toolbar]) [aria-pressed="true"][aria-label^="Fett"]').length >= 2,
    );
    // the toolbars ease their colours (150 ms): read them once no transition runs (the caret blinks on, an animation)
    const eased = () => page.waitForFunction(() => document.getAnimations().every((motion) => !(motion instanceof CSSTransition)));
    await eased();
    const look = (selector: string) =>
      page.locator(selector).evaluate((button) => {
        const style = getComputedStyle(button);
        return `${style.color} on ${style.backgroundColor}`;
      });
    const tint = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.cssText = "color: var(--k2-blue-ink); background: var(--k2-blue-tint)";
      document.querySelector(".k2-ui")?.append(probe);
      const style = getComputedStyle(probe);
      const found = `${style.color} on ${style.backgroundColor}`;
      probe.remove();
      return found;
    });
    expect(await look('[data-editor="ui"] [role="toolbar"] [aria-pressed="true"][aria-label^="Fett"]')).toBe(tint);
    expect(await look('[data-editor="shared"] [data-k2b-editor-toolbar] [aria-pressed="true"][aria-label^="Fett"]')).toBe(tint);
    // a button under the pointer, in each toolbar
    const hovered: string[] = [];
    for (const bar of ['[data-editor="ui"] [role="toolbar"]', '[data-editor="shared"] [data-k2b-editor-toolbar]']) {
      const button = page.locator(`${bar} button[aria-label^="Kursiv"]`);
      await hoverInPlace(button);
      await eased();
      hovered.push(await look(`${bar} button[aria-label^="Kursiv"]`));
    }
    expect(hovered[0]).toBe(hovered[1]);
  } finally {
    await page.close();
  }
}, 30_000);

/** The computed look of a v2 token on a probe in the v2 scope, as the engine resolves it. */
const token = (page: Page, property: string, value: string) =>
  page.evaluate(
    ([name, of]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(name, of);
      document.querySelector(".k2-ui")?.append(probe);
      const found = getComputedStyle(probe).getPropertyValue(name);
      probe.remove();
      return found;
    },
    [property, value] as const,
  );

test("inside v2 a menu of the toolbar is the v2 menu: its button in the bar's size, its entries and heading, a chosen entry runs in the note", async () => {
  const page = await open(1440);
  try {
    const trigger = page.locator('[data-editor="shared"] [data-k2b-editor-toolbar] button[aria-label="Mehr"]');
    const box = await trigger.boundingBox();
    expect({ width: box?.width, height: box?.height, v2: await trigger.evaluate((button) => button.classList.contains("k2-btn")) }).toEqual(
      {
        width: 28,
        height: 28,
        v2: true,
      },
    );
    await page.locator('[data-editor="shared"] .cm-content').getByText("Familie Oswald").click();
    await trigger.click();
    const menu = page.locator(".k2-menu");
    await menu.waitFor();
    expect(await menu.locator(".k2-mi .k2-mi-label").allTextContents()).toEqual(["Zitat", "Code im Text", "Link", "Tabelle"]);
    expect(await menu.locator(".k2-mh").allTextContents()).toEqual(["Einfügen"]);
    expect(
      await menu.locator(".k2-mi").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height))),
    ).toEqual([32, 32, 32, 32]);
    // the arrow reaches the first entry ("Zitat"), Enter runs it on the note's line, and the note has the focus again
    const before = await page.evaluate(() => window.__k2Doc?.() ?? "");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    await page.waitForFunction((was) => window.__k2Doc?.() !== was, before);
    expect(await page.evaluate(() => window.__k2Doc?.() ?? "")).toContain("> Familie Oswald");
    expect(await noteHasFocus(page)).toBe(true);
    // Escape closes it without a change, and the focus goes back into the note, not to the button
    const now = await page.evaluate(() => window.__k2Doc?.() ?? "");
    await trigger.click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    expect(await noteHasFocus(page)).toBe(true);
    expect(await page.evaluate(() => window.__k2Doc?.() ?? "")).toBe(now);
  } finally {
    await page.close();
  }
}, 30_000);

/** Whether the note's editable text has the focus. */
const noteHasFocus = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector('[data-editor="shared"] .cm-content');
    return !!content && !!document.activeElement && content.contains(document.activeElement);
  });

test("the menu's button stands where the v1 button stood before it: the swap after mount moves nothing", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
  try {
    // every "Mehr" button that enters the page, with its box at that moment: the v1 one first, then the v2 one
    await page.addInitScript(() => {
      const boxes: string[] = [];
      Reflect.set(window, "__k2MoreBoxes", boxes);
      new MutationObserver(() => {
        for (const button of document.querySelectorAll<HTMLElement>('[data-k2b-editor-toolbar] button[aria-label="Mehr"]')) {
          if (button.dataset.seen) continue;
          button.dataset.seen = "";
          const { left, top, width, height } = button.getBoundingClientRect();
          boxes.push(`${button.classList.contains("k2-btn") ? "v2" : "v1"} ${[left, top, width, height].map(Math.round).join(",")}`);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(server.url.href);
    await page.waitForFunction(() => document.querySelector('[data-k2b-editor-toolbar] .k2-btn[aria-label="Mehr"]'));
    await settled(page);
    const boxes: unknown = await page.evaluate(() => Reflect.get(window, "__k2MoreBoxes"));
    const found = Array.isArray(boxes) ? boxes.map(String) : [];
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.at(-1)?.startsWith("v2")).toBe(true);
    expect(new Set(found.map((box) => box.slice(3))).size).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("a v1 page keeps the v1 dropdown of the toolbar", async () => {
  const page = await open(1440, "?v1");
  try {
    const trigger = page.locator('[data-editor="shared"] [data-k2b-editor-toolbar] button[aria-label="Mehr"]');
    expect(await trigger.evaluate((button) => button.classList.contains("k2-btn"))).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);

test("inside v2 the slash menu has the look of the v2 menu: its surface, 32 px entries in the row role, one fill for the keys", async () => {
  const page = await open(1440);
  try {
    await page.locator('[data-editor="shared"] .cm-content').getByText("Familie Oswald, Lindenweg 4").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const popup = page.locator(".cm-tooltip-autocomplete");
    await popup.waitFor();
    await settled(page);
    const look = await popup.evaluate((element) => {
      const style = getComputedStyle(element);
      const entries = [...element.querySelectorAll("li")];
      const chosen = element.querySelector("li[aria-selected]");
      return {
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        heights: entries.map((entry) => Math.round(entry.getBoundingClientRect().height)),
        size: getComputedStyle(entries[0]!).fontSize,
        icon: getComputedStyle(element.querySelector(".cm-slash-icon")!).fontSize,
        chosen: chosen ? getComputedStyle(chosen).backgroundColor : "",
      };
    });
    expect(look).toEqual({
      radius: await token(page, "border-top-left-radius", "var(--k2-r-overlay)"),
      background: await token(page, "background-color", "var(--k2-surface)"),
      heights: [32, 32, 32],
      size: "13px",
      icon: "16px",
      chosen: await token(page, "background-color", "var(--k2-n100)"),
    });
  } finally {
    await page.close();
  }
}, 30_000);

test("inside v2 the toolbar at a selection floats on the v2 menu surface with the bar's buttons", async () => {
  const page = await open(1440);
  try {
    await page.evaluate(() => window.__k2Select?.("Familie"));
    const bubble = page.locator(".k2b-selection-toolbar:popover-open");
    await bubble.waitFor();
    await settled(page);
    const look = await bubble.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        buttons: [...element.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector(".ti");
          return `${button.getAttribute("aria-label")}: ${Math.round(box.width)}x${Math.round(box.height)} ${icon ? getComputedStyle(icon).fontSize : ""}`;
        }),
      };
    });
    expect(look).toEqual({
      radius: await token(page, "border-top-left-radius", "var(--k2-r-overlay)"),
      background: await token(page, "background-color", "var(--k2-surface)"),
      buttons: ["Fett: 28x28 16px", "Kursiv: 28x28 16px", "Code im Text: 28x28 16px", "Link: 28x28 16px"],
    });
  } finally {
    await page.close();
  }
}, 30_000);

/** A phone: a narrow touch screen whose taps are touches, as an iPhone in Safari or Chrome on Android. */
const openPhone = async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`${server.url.href}?shared`);
  await page.waitForFunction(() => document.querySelectorAll(".cm-content").length > 0);
  await settled(page);
  return { context, page };
};
/** Whether the note has the focus, with its caret (on a phone its keyboard stays open). */
const noteFocused = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.closest('[data-editor="shared"] .cm-content') !== null &&
      document.activeElement?.closest('[data-editor="shared"] .cm-content') !== undefined,
  );

/** The note's line that holds the caret, by its words. */
const caretLine = (page: Page) =>
  page.evaluate(() => {
    const node = getSelection()?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest(".cm-line")?.textContent ?? "";
  });
/** The note's Markdown line with these words. */
const sourceLine = (page: Page, words: string) =>
  page.evaluate((text) => (window.__k2Doc?.() ?? "").split("\n").find((line) => line.includes(text)) ?? "", words);

test("on a phone a menu of the toolbar leaves the note its focus, keyboard and caret: while it is open and after an entry", async () => {
  const { context, page } = await openPhone();
  try {
    const note = page.locator('[data-editor="shared"] .cm-content');
    const more = page.locator('[data-editor="shared"] [data-k2b-editor-toolbar] button[aria-label="Mehr"]');
    await note.getByText("Familie Oswald").tap();
    expect(await noteFocused(page)).toBe(true);
    expect(await caretLine(page)).toContain("Familie Oswald");
    await more.tap();
    await page.locator(".k2-menu").waitFor();
    // while the menu is open the note keeps its focus and caret, so the phone's keyboard stays open
    await settled(page);
    expect(await noteFocused(page)).toBe(true);
    expect(await caretLine(page)).toContain("Familie Oswald");
    // "Zitat" turns the caret's line into a quote, and the note keeps its focus
    expect(await sourceLine(page, "Familie Oswald")).not.toMatch(/^> /);
    await page.locator(".k2-mi", { hasText: "Zitat" }).tap();
    await page.locator(".k2-menu").waitFor({ state: "hidden" });
    await settled(page);
    expect(await sourceLine(page, "Familie Oswald")).toMatch(/^> Familie Oswald/);
    expect(await noteFocused(page)).toBe(true);
    expect(await caretLine(page)).toContain("Familie Oswald");
  } finally {
    await context.close();
  }
}, 30_000);

// A press beside the open menu, as a phone sends it after a tap: pointer, mouse and click events. Playwright's
// `touchscreen.tap` sends no click in either engine here (logged: Chromium pointerdown, touchstart, pointerup, touchend;
// WebKit pointerdown and touchstart only), and core dismisses on the click after a tap, so the press comes from the
// mouse, in the phone's touch context. Safari and Chrome on a phone send that click.
test("on a phone a press beside an open menu, on the page's head, closes it, and the note keeps its focus and caret", async () => {
  const { context, page } = await openPhone();
  try {
    const note = page.locator('[data-editor="shared"] .cm-content');
    const more = page.locator('[data-editor="shared"] [data-k2b-editor-toolbar] button[aria-label="Mehr"]');
    await note.getByText("Familie Oswald").tap();
    await more.tap();
    await page.locator(".k2-menu").waitFor();
    // the head of the page: no field there, and nothing of the note or the menu
    const head = await page.locator('.k2-ws-main > [data-slot="head"]').boundingBox();
    const point = { x: (head?.x ?? 0) + (head?.width ?? 0) - 40, y: (head?.y ?? 0) + (head?.height ?? 0) / 2 };
    const under = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        note: !!element?.closest(".cm-content"),
        menu: !!element?.closest(".k2-menu"),
        focusable: !!element?.closest("button, a, input, [tabindex]"),
      };
    }, point);
    expect(under).toEqual({ note: false, menu: false, focusable: false });
    await page.mouse.click(point.x, point.y);
    await page.locator(".k2-menu").waitFor({ state: "hidden" });
    await settled(page);
    expect(await noteFocused(page)).toBe(true);
    expect(await caretLine(page)).toContain("Familie Oswald");
  } finally {
    await context.close();
  }
}, 30_000);
