import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";

// Pointer types, the top layer, layout, and the engine's timers decide when
// and where the card opens, none of which happy-dom models, so a real engine
// runs the shipped browser build against a list beside a reader.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "hover-preview.fixture.ts");
const fixture = `
import { createEffect } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { createHoverPreview, HoverPreview } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const frame = document.getElementById("frame");
const list = document.getElementById("list");
list.innerHTML = Array.from({ length: 30 }, (_, i) =>
  '<div class="row" data-id="r' + i + '"><a href="#r' + i + '">Conversation ' + i + '</a><button type="button">More</button></div>'
).join("");
// The row menu of r2 is a light-dismiss popover inside the row, like a Dropdown.
const more = list.querySelector('.row[data-id="r2"] button');
more.setAttribute("popovertarget", "menu");
more.insertAdjacentHTML("afterend", '<div id="menu" popover>Menu</div>');
// As in Safari, pressing the button does not focus it.
more.addEventListener("mousedown", (event) => event.preventDefault());

render(() => {
  // r1 is the conversation already open in the reader.
  const preview = createHoverPreview({ openDelay: 200, placement: { beside: () => list, within: () => frame }, disabled: (id) => id === "r1" });
  window.preview = preview;
  for (const row of list.querySelectorAll(".row")) {
    preview.anchor(row.dataset.id)(row);
    // The documented wiring that tells screen readers the card's state.
    const link = row.querySelector("a");
    link.setAttribute("aria-controls", preview.id);
    createEffect(() => link.setAttribute("aria-expanded", String(preview.active() === row.dataset.id)));
  }
  return createComponent(HoverPreview, {
    preview,
    label: "Quick look",
    size: "fixed",
    children: (id) => {
      const card = document.createElement("div");
      card.dataset.card = id;
      card.textContent = "Conversation " + id;
      return card;
    },
  });
}, document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the hover preview fixture for the browser.");
const script = await build.outputs[0]!.text();

const html = (theme: "light" | "dark") =>
  "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>
    body { margin: 0; }
    #frame { position: fixed; inset: 16px; display: flex; }
    #nav { flex: none; width: 200px; }
    #list { flex: none; width: 360px; height: 100%; overflow: auto; }
    .row { display: flex; height: 72px; align-items: center; justify-content: space-between; }
    #reader { flex: 1; min-width: 0; }
  </style></head><body class="k2b-ui" data-theme="${theme}">` +
  "<div id='frame'><nav id='nav'>Folders</nav><div id='list'></div><main id='reader'>Reader</main></div><div id='app'></div>" +
  "</body></html>";

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions = desktop, theme: "light" | "dark" = "light") => {
  const page = await (await browser.newContext(options)).newPage();
  // Fake timers make the delays exact; Playwright's mouse and keyboard need no
  // animation frames, unlike locator actions.
  await page.clock.install();
  await page.setContent(html(theme));
  await page.addScriptTag({ content: script });
  // An installed clock still follows real time until it is paused.
  await page.clock.pauseAt(Date.now() + 60_000);
  return page;
};
const close = (page: Page) => page.context().close();

type Box = { top: number; left: number; width: number; height: number };
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { top, left, width, height } = element.getBoundingClientRect();
    return { top, left, width, height };
  }, selector) as Promise<Box | null>;
const row = (id: string) => `.row[data-id="${id}"]`;
const focusLink = (page: Page, id: string) =>
  page.evaluate((id) => document.querySelector<HTMLElement>(`.row[data-id="${id}"] a`)?.focus(), id);
const expanded = (page: Page, id: string) =>
  page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] a`)?.getAttribute("aria-expanded"), id);
const menuOpen = (page: Page) => page.evaluate(() => document.getElementById("menu")!.matches(":popover-open"));
const card = ".k2b-hover-preview";
const shown = (page: Page) =>
  page.evaluate(() => {
    const surface = document.querySelector(".k2b-hover-preview");
    return surface?.matches(":popover-open") ? (surface.querySelector<HTMLElement>("[data-card]")?.dataset.card ?? "") : null;
  });
const pointAt = async (page: Page, selector: string, x = 0.5) => {
  const target = (await box(page, selector))!;
  await page.mouse.move(target.left + target.width * x, target.top + target.height / 2);
};
/** Every box beside the card: the rows, the list, the navigation, and the reader. */
const layout = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#frame, #nav, #list, #reader, .row, .row > *")].map((element) => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return [top, left, width, height];
    }),
  );

describe("HoverPreview", () => {
  test("opens after the mouse rests, beside the list and top-aligned with the row, without moving anything", async () => {
    const page = await load();
    try {
      const before = await layout(page);
      await pointAt(page, row("r3"));
      await page.clock.runFor(199);
      expect(await shown(page)).toBeNull();
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("r3");

      const surface = (await box(page, card))!;
      const list = (await box(page, "#list"))!;
      const anchor = (await box(page, row("r3")))!;
      expect(surface.left).toBe(list.left + list.width + 8);
      expect(surface.top).toBe(anchor.top);
      expect([surface.width, surface.height]).toEqual([352, 320]);
      expect(await layout(page)).toEqual(before);
      // Hovering opens a card; it activates nothing.
      expect(await page.evaluate(() => location.hash)).toBe("");
    } finally {
      await close(page);
    }
  });

  test("swaps quickly between rows, keeping one size, and stays open while the pointer moves into it", async () => {
    const page = await load();
    try {
      const before = await layout(page);
      await pointAt(page, row("r3"));
      await page.clock.runFor(200);
      const first = (await box(page, card))!;

      await pointAt(page, row("r5"));
      await page.clock.runFor(89);
      expect(await shown(page)).toBe("r3");
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("r5");
      const second = (await box(page, card))!;
      expect(second.top).toBe((await box(page, row("r5")))!.top);
      expect([second.left, second.width, second.height]).toEqual([first.left, first.width, first.height]);
      expect(await layout(page)).toEqual(before);

      // Straight from the row into the card, then rest there.
      await page.mouse.move(second.left + 40, second.top + 40);
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBe("r5");

      await pointAt(page, "#reader", 0.9);
      await page.clock.runFor(179);
      expect(await shown(page)).toBe("r5");
      await page.clock.runFor(2);
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }
  });

  test("Escape closes it until the pointer leaves the row; a scrolling list closes it too", async () => {
    const page = await load();
    try {
      await pointAt(page, row("r3"));
      await page.clock.runFor(200);
      await page.keyboard.press("Escape");
      expect(await shown(page)).toBeNull();
      await pointAt(page, row("r3"), 0.3);
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("r4"));
      await page.clock.runFor(200);
      expect(await shown(page)).toBe("r4");
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            const list = document.getElementById("list")!;
            list.addEventListener("scroll", () => done(), { once: true });
            list.scrollTop = 100;
          }),
      );
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }
  });

  test("Space on the focused row toggles the card and keeps focus there; Enter still follows the row", async () => {
    const page = await load();
    try {
      await focusLink(page, "r6");
      expect(await expanded(page, "r6")).toBe("false");
      await page.keyboard.press("Space");
      expect([await shown(page), await expanded(page, "r6")]).toEqual(["r6", "true"]);
      const focus = () => page.evaluate(() => document.activeElement?.getAttribute("href"));
      expect(await focus()).toBe("#r6");
      expect(await page.evaluate(() => document.getElementById("list")!.scrollTop)).toBe(0);

      // Moving focus to another row moves the card with it.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.clock.runFor(90);
      expect(await focus()).toBe("#r7");
      expect(await shown(page)).toBe("r7");

      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();
      expect(await focus()).toBe("#r7");
      // Space on a button inside the row keeps the button's own meaning.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();

      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => location.hash)).toBe("#r7");
    } finally {
      await close(page);
    }
  });

  test("only a rest opens the card: a moving mouse, a press, or Escape during the delay keep it closed", async () => {
    const page = await load();
    try {
      // Steady movement across the row never counts as rest.
      const target = (await box(page, row("r4")))!;
      for (let step = 0; step <= 12; step++) {
        await page.mouse.move(target.left + 20 + step * 20, target.top + target.height / 2);
        await page.clock.runFor(20);
      }
      // 260 ms of movement, then 20 ms of rest: the delay counts from the last move.
      expect(await shown(page)).toBeNull();
      await page.clock.runFor(179);
      expect(await shown(page)).toBeNull();
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("r4");

      await pointAt(page, "#reader", 0.9);
      await page.clock.runFor(200);
      await pointAt(page, row("r5"));
      await page.clock.runFor(100);
      await page.keyboard.press("Escape");
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBeNull();
      await pointAt(page, row("r5"), 0.3);
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("r6"));
      await page.clock.runFor(100);
      await page.mouse.down();
      await page.mouse.up();
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }
  });

  test("never closes a menu someone opened", async () => {
    const page = await load();
    try {
      // Clicking the row's menu button during the delay: the menu stays.
      await pointAt(page, row("r2"), 0.2);
      await page.clock.runFor(100);
      await pointAt(page, `${row("r2")} button`);
      await page.mouse.down();
      await page.mouse.up();
      expect(await menuOpen(page)).toBe(true);
      await page.clock.runFor(1_000);
      expect([await menuOpen(page), await shown(page)]).toEqual([true, null]);

      // Resting on other rows while the menu is open opens no card either.
      await pointAt(page, row("r4"));
      await page.clock.runFor(1_000);
      expect([await menuOpen(page), await shown(page)]).toEqual([true, null]);
      await page.keyboard.press("Escape");
      expect(await menuOpen(page)).toBe(false);
      await pointAt(page, row("r4"), 0.3);
      await page.clock.runFor(200);
      expect(await shown(page)).toBe("r4");
    } finally {
      await close(page);
    }
  });

  test("focus in a row keeps no card open that the mouse opened, and a Space pin stays with its row", async () => {
    const page = await load();
    try {
      // After a click or a closed row menu, focus often stays in the row.
      await focusLink(page, "r3");
      await pointAt(page, row("r3"));
      await page.clock.runFor(200);
      expect(await shown(page)).toBe("r3");
      await pointAt(page, "#reader", 0.9);
      await page.clock.runFor(181);
      expect(await shown(page)).toBeNull();

      await focusLink(page, "r6");
      await page.keyboard.press("Space");
      expect([await shown(page), await expanded(page, "r6")]).toEqual(["r6", "true"]);
      // Passing over another row without swapping keeps the pin.
      await pointAt(page, row("r8"));
      await page.clock.runFor(50);
      await pointAt(page, "#reader", 0.9);
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBe("r6");
      // Swapping to the hovered row drops the pin: that card closes like any hover.
      await pointAt(page, row("r8"));
      await page.clock.runFor(90);
      expect([await shown(page), await expanded(page, "r6"), await expanded(page, "r8")]).toEqual(["r8", "false", "true"]);
      await pointAt(page, "#reader", 0.9);
      await page.clock.runFor(181);
      expect([await shown(page), await expanded(page, "r8")]).toEqual([null, "false"]);
    } finally {
      await close(page);
    }
  });

  test("Space toggles once per press and leaves Shift+Space to scrolling", async () => {
    const page = await load();
    try {
      await focusLink(page, "r0");
      await page.keyboard.press("Shift+Space");
      expect(await shown(page)).toBeNull();

      // Held down: the repeats change nothing and do not scroll the list.
      await page.keyboard.down(" ");
      await page.keyboard.down(" ");
      await page.keyboard.down(" ");
      await page.keyboard.up(" ");
      expect(await shown(page)).toBe("r0");
      expect(await page.evaluate(() => document.getElementById("list")!.scrollTop)).toBe(0);
    } finally {
      await close(page);
    }
  });

  test("never opens for a disabled row, on touch, or without room beside the list", async () => {
    const page = await load();
    try {
      await pointAt(page, row("r1"));
      await page.clock.runFor(1_000);
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }

    const tablet = await load({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    try {
      const target = (await box(tablet, row("r3")))!;
      await tablet.touchscreen.tap(target.left + 120, target.top + 30);
      await tablet.clock.runFor(1_000);
      expect(await shown(tablet)).toBeNull();
      // A finger resting on the row, which a tap cannot hold: still no card.
      await tablet.evaluate(() =>
        document.querySelector('.row[data-id="r4"]')?.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" })),
      );
      await tablet.clock.runFor(1_000);
      expect(await shown(tablet)).toBeNull();
    } finally {
      await close(tablet);
    }

    // 760 px leave 168 px right of the list: less than the card and its gaps.
    const narrow = await load({ viewport: { width: 760, height: 900 } });
    try {
      await pointAt(narrow, row("r3"));
      await narrow.clock.runFor(1_000);
      expect(await shown(narrow)).toBeNull();
      await narrow.evaluate(() => document.querySelector<HTMLElement>('.row[data-id="r3"] a')?.focus());
      await narrow.keyboard.press("Space");
      expect(await shown(narrow)).toBeNull();
    } finally {
      await close(narrow);
    }
  });

  test("a card near the bottom moves up into the frame and keeps the list free", async () => {
    const page = await load();
    try {
      const frame = (await box(page, "#frame"))!;
      const last = await page.evaluate((bottom) => {
        const rows = [...document.querySelectorAll<HTMLElement>(".row")];
        return rows.filter((row) => row.getBoundingClientRect().bottom <= bottom).at(-1)?.dataset.id;
      }, frame.top + frame.height);
      await pointAt(page, row(last!));
      await page.clock.runFor(200);
      expect(await shown(page)).toBe(last!);
      const surface = (await box(page, card))!;
      const anchor = (await box(page, row(last!)))!;
      const list = (await box(page, "#list"))!;
      expect(surface.top + surface.height).toBe(frame.top + frame.height - 8);
      expect(surface.top).toBeLessThan(anchor.top);
      expect(surface.left).toBeGreaterThan(list.left + list.width);
    } finally {
      await close(page);
    }
  });

  for (const [theme, background] of [
    ["light", "rgb(255, 255, 255)"],
    ["dark", "rgb(24, 29, 36)"],
  ] as const) {
    test(`in the ${theme} theme the card is a plain surface with inner depth only`, async () => {
      const page = await load(desktop, theme);
      try {
        const before = await layout(page);
        await pointAt(page, row("r3"));
        await page.clock.runFor(200);
        const style = await page.evaluate(() => {
          const { backgroundColor, boxShadow, borderTopWidth } = getComputedStyle(document.querySelector(".k2b-hover-preview")!);
          return { backgroundColor, boxShadow, borderTopWidth };
        });
        expect(style.backgroundColor).toBe(background);
        expect(style.borderTopWidth).toBe("1px");
        const shadows = style.boxShadow.match(/rgba?\(/g)?.length ?? 0;
        expect(shadows).toBeGreaterThan(0);
        expect(style.boxShadow.match(/inset/g)?.length).toBe(shadows);
        expect(await layout(page)).toEqual(before);
      } finally {
        await close(page);
      }
    });
  }
});
