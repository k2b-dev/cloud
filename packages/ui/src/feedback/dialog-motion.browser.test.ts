import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// A dialog rises 8 px and fades in over the base time, and on closing its state and focus change at once while the
// frame sinks 4 px and fades out over the fast time. Transitions, the top layer and `@starting-style` need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-motion.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { onCleanup } from "solid-js";
import { dialogCore, Lightbox, panelDialogWorkspaceOptions } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.results = [];
window.disposed = 0;
const content = (label) => () => {
  const body = document.createElement("div");
  body.innerHTML = "<h2>" + label + "</h2><input aria-label='Name'><button type='button'>Done</button>";
  onCleanup(() => { window.disposed++; });
  return body;
};
window.openDialog = (label = "Rename", options = {}) =>
  void dialogCore.open(content(label), options).then((value) => window.results.push(value === undefined ? "undefined" : value));
window.openWorkspace = () => window.openDialog("Workspace", panelDialogWorkspaceOptions);
window.closeDialog = (value) => dialogCore.close(value);
const picture = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='100%' height='100%' fill='#a8a29e'/></svg>");
window.lightboxClosed = 0;
window.openLightbox = () => {
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(() => createComponent(Lightbox, {
    items: [{ name: "Kommode.svg", meta: "SVG", src: picture }],
    index: 0,
    onIndexChange: () => {},
    onClose: () => { window.lightboxClosed++; dispose(); host.remove(); },
  }), host);
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog motion fixture for the browser.");
const script = await build.outputs[0]!.text();

type MotionWindow = Window & {
  results: string[];
  disposed: number;
  lightboxClosed: number;
  openDialog: (label?: string, options?: Record<string, unknown>) => void;
  openWorkspace: () => void;
  closeDialog: (value?: string) => void;
  openLightbox: () => void;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

const load = async (options: BrowserContextOptions = desktop, reducedAttribute = false): Promise<Page> => {
  const page = await (await browser.newContext(options)).newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(
    `<!doctype html><html${reducedAttribute ? ' data-k2b-motion="reduced"' : ""}><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><button id="opener" type="button">Open</button></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};

/** Opens from the opener button, as a click would, and reports what the first frame sees. */
const openFromButton = (page: Page, kind: "dialog" | "workspace" = "dialog") =>
  page.evaluate(
    (kind) =>
      new Promise<{ focusInDialog: boolean; transitions: { property: string; duration: number }[] }>((resolve) => {
        const motion = window as unknown as MotionWindow;
        const opener = document.querySelector<HTMLButtonElement>("#opener")!;
        opener.focus();
        if (kind === "workspace") motion.openWorkspace();
        else motion.openDialog();
        const dialog = document.querySelector("dialog")!;
        const transitions = dialog
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => ({
            property: (animation as CSSTransition).transitionProperty,
            duration: Number(animation.effect?.getComputedTiming().duration),
          }));
        // After the core's own frame callback, which places focus before the first paint.
        requestAnimationFrame(() => resolve({ focusInDialog: dialog.contains(document.activeElement), transitions }));
      }),
    kind,
  );

const transitionsDone = (page: Page) =>
  page.waitForFunction(() =>
    // animation-settle: all timelines - The fixture has no scroll-driven animations.
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );

describe(`${browserName} dialog entrance and exit`, () => {
  test("a dialog rises 8 px over the base time and has focus in its first frame", async () => {
    const page = await load();
    try {
      const opened = await openFromButton(page);
      expect(opened.focusInDialog).toBe(true);
      const byProperty = Object.fromEntries(opened.transitions.map((transition) => [transition.property, transition.duration]));
      expect(byProperty.opacity).toBe(180);
      expect(byProperty.translate).toBe(180);
      await transitionsDone(page);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector("dialog")!).translate)).toMatch(/^(?:none|0px)$/);
    } finally {
      await page.context().close();
    }
  });

  test("closing resolves and returns focus at once while the frame sinks 4 px over the fast time", async () => {
    const page = await load();
    try {
      await openFromButton(page);
      await transitionsDone(page);
      const closing = await page.evaluate(
        () =>
          new Promise<{
            resolved: string[];
            open: boolean;
            inert: boolean;
            present: boolean;
            disposed: number;
            transitions: { property: string; duration: number }[];
            focusOnOpener: boolean;
          }>((resolve) => {
            const motion = window as unknown as MotionWindow;
            const dialog = document.querySelector("dialog")!;
            motion.closeDialog("saved");
            const transitions = dialog
              .getAnimations()
              .filter((animation) => animation instanceof CSSTransition)
              .map((animation) => ({
                property: (animation as CSSTransition).transitionProperty,
                duration: Number(animation.effect?.getComputedTiming().duration),
              }));
            const state = { open: dialog.open, inert: dialog.inert, present: dialog.isConnected, disposed: motion.disposed, transitions };
            void Promise.resolve().then(() =>
              requestAnimationFrame(() =>
                resolve({
                  ...state,
                  resolved: [...motion.results],
                  focusOnOpener: document.activeElement === document.querySelector("#opener"),
                }),
              ),
            );
          }),
      );
      expect(closing.open).toBe(false);
      expect(closing.inert).toBe(true);
      // The picture stays while it fades; its content is disposed afterwards.
      expect(closing.present).toBe(true);
      expect(closing.disposed).toBe(0);
      expect(closing.resolved).toEqual(["saved"]);
      expect(closing.focusOnOpener).toBe(true);
      const byProperty = Object.fromEntries(closing.transitions.map((transition) => [transition.property, transition.duration]));
      expect(byProperty.opacity).toBe(120);
      expect(byProperty.translate).toBe(120);
      await page.waitForFunction(() => document.querySelector("dialog") === null);
      expect(await page.evaluate(() => (window as unknown as MotionWindow).disposed)).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("closing during the entrance turns around from where the dialog is", async () => {
    const page = await load();
    try {
      // settled: turning around in the middle of the entrance is the subject.
      const turn = await page.evaluate(
        () =>
          new Promise<{ before: number; after: number; peak: number }>((resolve) => {
            const motion = window as unknown as MotionWindow;
            motion.openDialog();
            const dialog = document.querySelector("dialog")!;
            // Halfway through the 180 ms entrance, set on the transitions themselves so a slow machine cannot miss it.
            for (const animation of dialog.getAnimations()) animation.currentTime = 90;
            const before = Number(getComputedStyle(dialog).opacity);
            motion.closeDialog();
            const after = Number(getComputedStyle(dialog).opacity);
            let peak = after;
            const sample = () => {
              if (!dialog.isConnected) return resolve({ before, after, peak });
              peak = Math.max(peak, Number(getComputedStyle(dialog).opacity));
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          }),
      );
      expect(turn.before).toBeGreaterThan(0);
      expect(turn.before).toBeLessThan(1);
      // No jump to fully open or fully gone: the exit starts at the value the entrance reached and only goes down.
      expect(Math.abs(turn.after - turn.before)).toBeLessThan(0.15);
      expect(turn.peak).toBeLessThanOrEqual(turn.before + 0.05);
    } finally {
      await page.context().close();
    }
  });

  test("a dialog that opens while the last one fades out ends that one at once", async () => {
    const page = await load();
    try {
      await openFromButton(page);
      await transitionsDone(page);
      const frames = await page.evaluate(() => {
        const motion = window as unknown as MotionWindow;
        motion.closeDialog();
        motion.openDialog("Details");
        return { dialogs: document.querySelectorAll("dialog").length, disposed: motion.disposed };
      });
      expect(frames).toEqual({ dialogs: 1, disposed: 1 });
    } finally {
      await page.context().close();
    }
  });

  test("a workspace dialog only fades", async () => {
    const page = await load();
    try {
      const opened = await openFromButton(page, "workspace");
      expect(opened.transitions.some((transition) => transition.property === "opacity")).toBe(true);
      // It travels 0 px, so no translate transition starts at all.
      expect(opened.transitions.some((transition) => transition.property === "translate")).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  test("a dialog that a reload brings back has no entrance", async () => {
    const page = await load();
    try {
      const resumed = await page.evaluate(() => {
        // The entry a reload left behind: a dialog marker in the current history state, and a dialog that names this URL.
        history.replaceState({ k2bDialog: 99 }, "");
        (window as unknown as MotionWindow).openDialog("Resumed", { history: true, historyUrl: location.href });
        const dialog = document.querySelector("dialog")!;
        return {
          marked: dialog.hasAttribute("data-no-enter"),
          transitions: dialog.getAnimations().filter((animation) => animation instanceof CSSTransition).length,
        };
      });
      expect(resumed).toEqual({ marked: true, transitions: 0 });
      await page.waitForFunction(() => !document.querySelector("dialog")!.hasAttribute("data-no-enter"));
    } finally {
      await page.context().close();
    }
  });

  test.skipIf(browserName === "webkit")("the motion lays nothing out", async () => {
    const page = await load();
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const layoutCount = async () =>
        (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "LayoutCount")!.value;
      await openFromButton(page);
      const afterOpen = await layoutCount();
      await transitionsDone(page);
      expect(await layoutCount()).toBe(afterOpen);
    } finally {
      await page.context().close();
    }
  });

  test("the Lightbox fades in and out, and calls onClose after the fade", async () => {
    const page = await load();
    try {
      await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>("#opener")!.focus();
        (window as unknown as MotionWindow).openLightbox();
      });
      const opening = await page.evaluate(() => {
        const lightbox = document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox")!;
        return {
          properties: lightbox.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty),
        };
      });
      expect(opening.properties).toContain("opacity");
      expect(opening.properties).not.toContain("translate");
      await transitionsDone(page);
      await page.keyboard.press("Escape");
      const closing = await page.evaluate(() => ({
        closed: (window as unknown as MotionWindow).lightboxClosed,
        open: document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox")?.open,
        focusOnOpener: document.activeElement === document.querySelector("#opener"),
      }));
      expect(closing).toEqual({ closed: 0, open: false, focusOnOpener: true });
      await page.waitForFunction(() => (window as unknown as MotionWindow).lightboxClosed === 1);
      expect(await page.evaluate(() => document.querySelector("dialog.k2b-lightbox"))).toBeNull();
    } finally {
      await page.context().close();
    }
  });
});

for (const [name, options, attribute] of [
  ["system setting", { ...desktop, reducedMotion: "reduce" }, false],
  ["host attribute", desktop, true],
] as const) {
  test(`${browserName} reduced motion (${name}): a dialog opens and closes in the same frame`, async () => {
    const page = await load(options, attribute);
    try {
      const frames = await page.evaluate(() => {
        const motion = window as unknown as MotionWindow;
        motion.openDialog();
        const dialog = document.querySelector("dialog")!;
        const opened = {
          transitions: dialog.getAnimations().filter((animation) => animation instanceof CSSTransition).length,
        };
        motion.closeDialog();
        return { opened, presentAfterClose: dialog.isConnected, disposed: motion.disposed };
      });
      expect(frames).toEqual({ opened: { transitions: 0 }, presentAfterClose: false, disposed: 1 });
    } finally {
      await page.context().close();
    }
  });
}
