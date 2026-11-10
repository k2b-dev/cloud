import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The rail moves into the top layer again for every new toast. Only a real engine resets scroll offsets and drops
// focus when nodes move, which is what a custom slot with a list and a focused control must survive. The stack's
// motion, hover, focus, and gestures need a real engine too.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "toast.fixture.ts");
const fixture = `
import { isPointInsideToast, toast } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.toast = toast;
window.isPointInsideToast = isPointInsideToast;
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the toast fixture for the browser.");
const script = await build.outputs[0]!.text();

type ToastWindow = Window & {
  toast: typeof import("./toast").toast;
  isPointInsideToast: typeof import("./toast").isPointInsideToast;
  slot?: { dismiss: () => void };
  job?: ReturnType<typeof import("./toast").toast>;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions = {}): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ...options })).newPage();
  page.setDefaultTimeout(5_000);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><button id="opener">Opener</button></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};

/** Waits until every toast has arrived in the stack. */
const arrived = (page: Page) =>
  page.waitForFunction(() => [...document.querySelectorAll(".k2b-toast")].every((card) => card.getAttribute("data-open") === "true"));

/** Each slot's place: its distance from the rail's edge and whether it is folded behind the front toast. */
const places = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] > .k2b-toast-slot:not([data-state='closing'])")].map((slot) => ({
      text: slot.querySelector(".k2b-toast__description")?.textContent ?? slot.textContent,
      bottom: Math.round(slot.getBoundingClientRect().bottom),
      top: Math.round(slot.getBoundingClientRect().top),
      behind: slot.hasAttribute("data-behind"),
    })),
  );

test("a new toast keeps the scroll offset and the focus inside a custom slot", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const panel = document.createElement("section");
      const list = document.createElement("div");
      list.id = "list";
      list.style.cssText = "height:120px;overflow:auto";
      list.innerHTML = Array.from(
        { length: 30 },
        (_, i) => '<div style="height:40px">Row ' + i + ' <button type="button">Retry ' + i + "</button></div>",
      ).join("");
      panel.append(list);
      (window as unknown as ToastWindow).slot = (window as unknown as ToastWindow).toast.custom(panel);
      list.scrollTop = 200;
      list.querySelectorAll("button")[6]!.focus({ preventScroll: true });
    });
    const state = () =>
      page.evaluate(() => ({
        scrollTop: document.getElementById("list")!.scrollTop,
        focused: document.activeElement?.textContent,
        open: document.getElementById("list")!.closest("[data-k2b-toast-container]")!.matches(":popover-open"),
      }));
    expect(await state()).toEqual({ scrollTop: 200, focused: "Retry 6", open: true });
    await page.evaluate(() => (window as unknown as ToastWindow).toast("Link copied"));
    expect(await state()).toEqual({ scrollTop: 200, focused: "Retry 6", open: true });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("the folded stack fans out under the pointer and every timer waits until it folds again", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const { toast } = window as unknown as ToastWindow;
      toast.success("Saved", { duration: 400 });
      toast("Link copied", { duration: 400 });
      toast("3 notes moved to the trash", { duration: 400, action: { label: "Undo", onClick: () => {}, variant: "ghost" } });
    });
    await arrived(page);
    await settled(page);
    // Folded: the newest in front, the two older ones show 10 px of their edge each.
    const folded = await places(page);
    expect(folded.map((place) => place.behind)).toEqual([true, true, false]);
    expect(folded.map((place) => folded[2]!.top - place.top)).toEqual([20, 10, 0]);
    const front = (await page.locator(".k2b-toast-slot").last().boundingBox())!;
    await page.mouse.move(front.x + front.width / 2, front.y + front.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-k2b-toast-container]")?.getAttribute("data-expanded") === "true");
    await settled(page);
    const fanned = await places(page);
    expect(fanned.map((place) => place.behind)).toEqual([false, false, false]);
    // Fanned out, every toast shows whole, 10 px apart, and the close buttons show.
    expect(fanned[0]!.bottom + 10).toBe(fanned[1]!.top);
    expect(fanned[1]!.bottom + 10).toBe(fanned[2]!.top);
    expect(
      await page.evaluate(() => [...document.querySelectorAll(".k2b-toast__close")].map((close) => getComputedStyle(close).opacity)),
    ).toEqual(["1", "1", "1"]);
    // fixed wait: twice the toasts' 400 ms on screen, which the open stack must outlast.
    await page.waitForTimeout(800);
    expect(await page.locator(".k2b-toast:not([data-closing])").count()).toBe(3);
    // The pointer crosses the gap between two toasts without folding the stack.
    await page.mouse.move(front.x + front.width / 2, fanned[1]!.bottom + 5);
    await settled(page);
    expect(await page.evaluate(() => document.querySelector("[data-k2b-toast-container]")?.getAttribute("data-expanded"))).toBe("true");
    await page.mouse.move(10, 10);
    await page.waitForFunction(() => document.querySelectorAll(".k2b-toast").length === 0);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("Alt+T focuses the stack, Tab reaches each round close button by name, and Escape returns focus", async () => {
  const page = await open();
  try {
    await page.focus("#opener");
    await page.evaluate(() => {
      const { toast } = window as unknown as ToastWindow;
      toast.success("Budget 2027.xlsx", { title: "Export finished", duration: 300 });
      toast.error("No connection to the server.", { title: "Could not save", duration: 0 });
    });
    await arrived(page);
    await page.keyboard.press("Alt+t");
    await page.waitForFunction(() => document.activeElement?.matches("[data-k2b-toast-container]"));
    // fixed wait: longer than the success toast's 300 ms, which waits while the stack holds focus.
    await page.waitForTimeout(500);
    expect(await page.locator(".k2b-toast:not([data-closing])").count()).toBe(2);
    await page.keyboard.press("Tab");
    await settled(page);
    const focused = await page.evaluate(() => {
      const close = document.activeElement as HTMLElement;
      const box = close.getBoundingClientRect();
      const card = close.closest(".k2b-toast")!.getBoundingClientRect();
      return {
        label: close.getAttribute("aria-label"),
        size: [box.width, box.height],
        opacity: getComputedStyle(close).opacity,
        overCorner: box.left < card.left && box.top < card.top,
      };
    });
    expect(focused).toEqual({ label: "Close: Export finished", size: [24, 24], opacity: "1", overCorner: true });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".k2b-toast").length === 1);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Close: Could not save");
    // Escape on the stack itself folds it and returns focus to where it was.
    await page.keyboard.press("Alt+t");
    await page.waitForFunction(() => document.activeElement?.matches("[data-k2b-toast-container]"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "opener");
    expect(await page.evaluate(() => document.querySelector("[data-k2b-toast-container]")?.getAttribute("aria-keyshortcuts"))).toBe(
      "Alt+T",
    );
  } finally {
    await page.context().close();
  }
}, 30_000);

test("a toast that arrives while the stack holds focus keeps it open and focused, and the close button counts as the toast", async () => {
  const page = await open();
  try {
    await page.evaluate(() => (window as unknown as ToastWindow).toast("Link copied", { duration: 0 }));
    await arrived(page);
    await page.keyboard.press("Alt+t");
    await page.waitForFunction(() => document.activeElement?.matches("[data-k2b-toast-container]"));
    // The rail returns to the top layer as a new element for every toast.
    await page.evaluate(() => (window as unknown as ToastWindow).toast("Saved", { duration: 300 }));
    await arrived(page);
    await settled(page);
    expect(
      await page.evaluate(() => ({
        focused: document.activeElement?.matches("[data-k2b-toast-container]"),
        expanded: document.querySelector("[data-k2b-toast-container]")?.getAttribute("data-expanded"),
      })),
    ).toEqual({ focused: true, expanded: "true" });
    // A dialog's outside click must not close it through the part of the close button over the card's corner.
    const corner = await page.evaluate(() => {
      const close = document.querySelector(".k2b-toast__close")!.getBoundingClientRect();
      const card = document.querySelector(".k2b-toast")!.getBoundingClientRect();
      const x = close.left + 2;
      const y = close.top + 2;
      return { outsideCard: x < card.left && y < card.top, inside: (window as unknown as ToastWindow).isPointInsideToast(x, y) };
    });
    expect(corner).toEqual({ outsideCard: true, inside: true });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("a loading toast turns into its result in place, without changing its size", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const { toast } = window as unknown as ToastWindow;
      (window as unknown as ToastWindow).job = toast("Budget 2027.grid", {
        title: "Saving …",
        progress: "indeterminate",
        action: { label: "Cancel", onClick: () => {} },
      });
    });
    await arrived(page);
    await settled(page);
    const box = () =>
      page.evaluate(() => {
        const card = document.querySelector(".k2b-toast")!.getBoundingClientRect();
        return [Math.round(card.top), Math.round(card.height)];
      });
    const before = await box();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".k2b-toast__progress")!).display)).toBe("none");
    await page.evaluate(() =>
      (window as unknown as ToastWindow).job!.update("Budget 2027.grid", {
        variant: "success",
        title: "Saved",
        progress: null,
        action: { label: "Open", href: "#open" },
      }),
    );
    await settled(page);
    expect(await box()).toEqual(before);
    expect(await page.evaluate(() => document.querySelector(".k2b-toast__icon i")?.className)).toBe("ti ti-check");
  } finally {
    await page.context().close();
  }
}, 30_000);

test("a custom slot stays pinned at the edge, outside the limit of three, with toasts stacked in front of it", async () => {
  const page = await open();
  try {
    await page.evaluate(() => {
      const { toast } = window as unknown as ToastWindow;
      const panel = document.createElement("section");
      panel.style.height = "120px";
      panel.textContent = "Uploads";
      toast.custom(panel);
      for (const name of ["One", "Two", "Three", "Four"]) toast(name, { duration: 0 });
    });
    await arrived(page);
    await settled(page);
    const rail = await page.evaluate(() =>
      Math.round(document.querySelector("[data-k2b-toast-container]")!.getBoundingClientRect().bottom),
    );
    const stack = await places(page);
    expect(stack.map((place) => place.text)).toEqual(["Uploads", "Two", "Three", "Four"]);
    // The slot rests on the rail's edge padding; the front toast sits 10 px above it.
    expect(rail - stack[0]!.bottom).toBe(16);
    expect(stack[0]!.top - stack[3]!.bottom).toBe(10);
    expect(stack[0]!.behind).toBe(false);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("the stack moves in 400 ms, and not at all with reduced motion", async () => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const page = await open({ reducedMotion });
    try {
      await page.evaluate(() => (window as unknown as ToastWindow).toast("Link copied", { duration: 0 }));
      await arrived(page);
      await settled(page);
      const durations = await page.evaluate(() => getComputedStyle(document.querySelector(".k2b-toast-slot")!).transitionDuration);
      expect(durations).toBe(reducedMotion === "reduce" ? "0s" : "0.4s, 0.4s");
    } finally {
      await page.context().close();
    }
  }
}, 30_000);

test("a swipe towards the edge dismisses, the other way the toast springs back", async () => {
  const page = await open();
  try {
    await page.evaluate(() => (window as unknown as ToastWindow).toast("Link copied", { duration: 0 }));
    await arrived(page);
    await settled(page);
    const tile = (await page.locator(".k2b-toast__icon").boundingBox())!;
    const x = tile.x + tile.width / 2;
    const y = tile.y + tile.height / 2;
    // Up is away from the bottom edge: it resists and springs back.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 8 });
    await page.mouse.up();
    await settled(page);
    expect(await page.locator(".k2b-toast:not([data-closing])").count()).toBe(1);
    // Right dismisses.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".k2b-toast").length === 0);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("on a phone the stack sits at the top, shows three toasts, a tap fans it out, and the close buttons stay visible", async () => {
  const page = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await page.evaluate(() => {
      const { toast } = window as unknown as ToastWindow;
      for (const name of ["One", "Two", "Three"]) toast(name, { duration: 0 });
    });
    await arrived(page);
    await settled(page);
    const folded = await places(page);
    expect(folded.map((place) => place.behind)).toEqual([true, true, false]);
    // At the top edge the older toasts show below the front one.
    expect(folded.map((place) => place.bottom - folded[2]!.bottom)).toEqual([20, 10, 0]);
    const front = (await page.locator(".k2b-toast__description").last().boundingBox())!;
    await page.touchscreen.tap(front.x + 10, front.y + front.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-k2b-toast-container]")?.getAttribute("data-expanded") === "true");
    await settled(page);
    const hit = await page.evaluate(() => {
      const close = document.querySelector<HTMLElement>(".k2b-toast-slot:last-child .k2b-toast__close")!;
      const box = close.getBoundingClientRect();
      const reaches = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("button") === close;
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      // 21 px from the centre: only the 44 px hit area reaches that far.
      return { opacity: getComputedStyle(close).opacity, reaches: [reaches(midX + 21, midY), reaches(midX, midY + 21)] };
    });
    expect(hit).toEqual({ opacity: "1", reaches: [true, true] });
    // A tap beside the stack folds it.
    await page.touchscreen.tap(200, 700);
    await page.waitForFunction(() => document.querySelector("[data-k2b-toast-container]")?.getAttribute("data-expanded") === "false");
  } finally {
    await page.context().close();
  }
}, 30_000);
