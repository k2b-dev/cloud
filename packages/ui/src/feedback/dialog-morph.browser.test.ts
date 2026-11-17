import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// A dialog opened from a dialog replaces it in the same frame: the size morphs, the contents cross-fade, nothing stacks.
// Sizes over time, the top layer and focus need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dialog-morph.fixture.ts");
const fixture = `
import { onCleanup } from "solid-js";
import { dialogCore, panelDialogWideOptions } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.disposed = [];
window.results = [];
const editor = () => {
  const body = document.createElement("div");
  body.dataset.level = "editor";
  body.style.padding = "24px";
  body.innerHTML = "<h2>Edit project</h2><p>Long enough to set a wide frame that must not rewrap while it changes.</p>" +
    "<input aria-label='Name' value='Summer fest'><button type='button' data-ask>Cancel</button>" +
    "<div data-scroll style='height:60px;overflow:auto'><div style='height:400px'>Long list</div></div>";
  body.querySelector("[data-ask]").onclick = () => window.ask();
  onCleanup(() => window.disposed.push("editor"));
  return body;
};
const question = (close) => {
  const body = document.createElement("div");
  body.dataset.level = "question";
  body.style.padding = "16px";
  body.innerHTML = "<h2>Discard changes?</h2><p id='discard-sentence'>Your change to the name is lost.</p>" +
    "<button type='button' data-keep>Keep editing</button>";
  body.querySelector("[data-keep]").onclick = () => close("keep");
  onCleanup(() => window.disposed.push("question"));
  return body;
};
/** Unstructured content that the frame itself scrolls. */
const plain = () => {
  const body = document.createElement("div");
  body.dataset.level = "plain";
  // Its button stands below the first screen, where the test scrolls to: focus that returns to it does not scroll.
  body.innerHTML = "<div style='height:320px'>Long text</div><button type='button' data-plain-ask>Cancel</button><div style='height:2000px'>More text</div>";
  body.querySelector("[data-plain-ask]").onclick = () => window.ask();
  onCleanup(() => window.disposed.push("plain"));
  return body;
};
window.openEditor = () => void dialogCore.open(editor, panelDialogWideOptions);
window.openPlain = () => void dialogCore.open(plain);
window.closeAll = () => dialogCore.close();
window.ask = () =>
  void dialogCore.open(question, { role: "alertdialog", ariaDescribedBy: "discard-sentence" }).then((value) => window.results.push(value));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog morph fixture for the browser.");
const script = await build.outputs[0]!.text();

type MorphWindow = Window & {
  disposed: string[];
  results: string[];
  openEditor: () => void;
  openPlain: () => void;
  ask: () => void;
  closeAll: () => void;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

const load = async (options: BrowserContextOptions = desktop): Promise<Page> => {
  const page = await (await browser.newContext(options)).newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><button id="opener" type="button">Edit</button></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.timeline === document.timeline)
      .every((animation) => animation.playState !== "running"),
  );

/** The editor, open and still, with a changed name. */
const openEditor = async (page: Page) => {
  await page.evaluate(() => (window as unknown as MorphWindow).openEditor());
  await settle(page);
  await page.fill("[data-level='editor'] input", "Summer fest 2027");
};

describe(`${browserName} one dialog replaces another`, () => {
  test("a question replaces the editor in the same frame and the size morphs", async () => {
    const page = await load();
    try {
      await openEditor(page);
      const morph = await page.evaluate(
        () =>
          new Promise<{
            dialogs: number;
            from: { width: number; height: number };
            start: { width: number; height: number };
            frameMotion: { duration: number; properties: string[] } | null;
            focusInQuestion: boolean;
          }>((resolve) => {
            const dialog = document.querySelector("dialog")!;
            const from = { width: dialog.offsetWidth, height: dialog.offsetHeight };
            document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
            const start = { width: dialog.offsetWidth, height: dialog.offsetHeight };
            const animation = dialog.getAnimations().find((candidate) => !(candidate instanceof CSSTransition));
            const keyframes = (animation?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
            requestAnimationFrame(() =>
              resolve({
                dialogs: document.querySelectorAll("dialog").length,
                from,
                start,
                frameMotion: animation
                  ? { duration: Number(animation.effect?.getComputedTiming().duration), properties: Object.keys(keyframes[0] ?? {}) }
                  : null,
                focusInQuestion: document.activeElement?.closest("[data-level='question']") !== null,
              }),
            );
          }),
      );
      expect(morph.dialogs).toBe(1);
      // The first frame still shows the editor's size; the frame moves from there.
      expect(morph.start).toEqual(morph.from);
      expect(morph.frameMotion?.duration).toBe(280);
      expect(morph.frameMotion?.properties).toEqual(expect.arrayContaining(["width", "height"]));
      expect(morph.focusInQuestion).toBe(true);

      await settle(page);
      const after = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        const question = dialog.querySelector<HTMLElement>("[data-level='question']")!;
        const editor = dialog.querySelector<HTMLElement>("[data-level='editor']")!.parentElement!;
        return {
          width: dialog.offsetWidth,
          questionWidth: question.parentElement!.offsetWidth,
          editorHidden: getComputedStyle(editor).display === "none",
          editorMounted: editor.isConnected,
          announced: dialog.querySelector("[data-k2b-dialog-live]")?.textContent,
        };
      });
      expect(after.editorHidden).toBe(true);
      expect(after.editorMounted).toBe(true);
      expect(after.width).toBeLessThan(morph.from.width);
      // A question that needs an answer says its title and its sentence.
      expect(after.announced).toBe("Discard changes? Your change to the name is lost.");
    } finally {
      await page.context().close();
    }
  });

  test("the new content keeps its final width while the frame moves", async () => {
    const page = await load();
    try {
      await openEditor(page);
      // settled: the new content's width while the frame still moves is the subject (Bauplan §3: the content never rewraps).
      const widths = await page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const dialog = document.querySelector("dialog")!;
            document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
            const question = dialog.querySelector<HTMLElement>("[data-level='question']")!;
            const seen: number[] = [];
            const sample = () => {
              seen.push(question.getBoundingClientRect().width);
              if (dialog.getAnimations().some((animation) => animation.timeline === document.timeline && animation.playState === "running"))
                requestAnimationFrame(sample);
              else resolve(seen);
            };
            sample();
          }),
      );
      expect(widths.length).toBeGreaterThan(2);
      expect(new Set(widths.map(Math.round)).size).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("going back morphs back, and the editor is as it was", async () => {
    const page = await load();
    try {
      await openEditor(page);
      const editorSize = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        return { width: dialog.offsetWidth, height: dialog.offsetHeight };
      });
      await page.click("[data-ask]");
      await settle(page);
      await page.click("[data-keep]");
      const leaving = await page.evaluate(() => ({
        results: (window as unknown as MorphWindow).results,
        disposed: [...(window as unknown as MorphWindow).disposed],
        frameMoving: document
          .querySelector("dialog")!
          .getAnimations()
          .some((animation) => !(animation instanceof CSSTransition)),
      }));
      // The answer is there at once; the question's content is disposed only after it faded.
      expect(leaving.results).toEqual(["keep"]);
      expect(leaving.disposed).toEqual([]);
      expect(leaving.frameMoving).toBe(true);
      await settle(page);
      const back = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        return {
          width: dialog.offsetWidth,
          height: dialog.offsetHeight,
          name: dialog.querySelector<HTMLInputElement>("[data-level='editor'] input")!.value,
          focus: (document.activeElement as HTMLElement | null)?.dataset.ask !== undefined,
          disposed: (window as unknown as MorphWindow).disposed,
          lastLevel: dialog.lastElementChild?.querySelector("[data-level]")?.getAttribute("data-level"),
        };
      });
      expect({ width: back.width, height: back.height }).toEqual(editorSize);
      expect(back.name).toBe("Summer fest 2027");
      expect(back.focus).toBe(true);
      expect(back.disposed).toEqual(["question"]);
      expect(back.lastLevel).toBe("editor");
    } finally {
      await page.context().close();
    }
  });

  test("going back during the morph turns around from where the frame is", async () => {
    const page = await load();
    try {
      await openEditor(page);
      const turn = await page.evaluate(
        () =>
          new Promise<{ before: number; after: number; widths: number[]; editorWidth: number }>((resolve) => {
            const dialog = document.querySelector("dialog")!;
            const editorWidth = dialog.offsetWidth;
            document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
            // Halfway, set on the animations themselves so a slow machine cannot miss it.
            // animation-settle: all timelines - Sets or counts the dialog's own animations; the fixture has no scroll-driven ones.
            for (const animation of dialog.getAnimations({ subtree: true })) animation.currentTime = 140;
            const before = dialog.offsetWidth;
            document.querySelector<HTMLButtonElement>("[data-keep]")!.click();
            const after = dialog.offsetWidth;
            const widths: number[] = [];
            const sample = () => {
              widths.push(dialog.offsetWidth);
              if (
                dialog
                  .getAnimations({ subtree: true })
                  .some((animation) => animation.timeline === document.timeline && animation.playState === "running")
              )
                requestAnimationFrame(sample);
              else resolve({ before, after, widths, editorWidth });
            };
            requestAnimationFrame(sample);
          }),
      );
      expect(turn.before).toBeLessThan(turn.editorWidth);
      expect(turn.after).toBe(turn.before);
      // Only growing back to the editor, never first down to the question's size.
      for (const [index, width] of turn.widths.entries()) expect(width).toBeGreaterThanOrEqual(turn.widths[index - 1] ?? turn.before);
      expect(turn.widths.at(-1)).toBe(turn.editorWidth);
      expect(await page.evaluate(() => (window as unknown as MorphWindow).disposed)).toEqual(["question"]);
    } finally {
      await page.context().close();
    }
  });

  test("a new change while a closed level still fades out leaves only the two contents of that change", async () => {
    const page = await load();
    try {
      await openEditor(page);
      const contents = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
        document.querySelector<HTMLButtonElement>("[data-keep]")!.click();
        document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
        return {
          questions: dialog.querySelectorAll("[data-level='question']").length,
          disposed: [...(window as unknown as MorphWindow).disposed],
        };
      });
      expect(contents).toEqual({ questions: 1, disposed: ["question"] });
      await settle(page);
      expect(await page.evaluate(() => document.querySelectorAll("dialog [data-level='question']").length)).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("the new level's size limits do not cut the frame's old size at the first frame", async () => {
    const page = await load();
    try {
      await openEditor(page);
      // settled: the first frame of the morph is the subject.
      const sizes = await page.evaluate(() => {
        const limit = document.createElement("style");
        limit.textContent = ".k2b-ui .k2b-dialog:has([data-level='question']) { max-height: 60px; max-width: 200px; }";
        document.head.append(limit);
        const dialog = document.querySelector("dialog")!;
        const from = { width: dialog.offsetWidth, height: dialog.offsetHeight };
        document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
        return { from, first: { width: dialog.offsetWidth, height: dialog.offsetHeight } };
      });
      expect(sizes.from.height).toBeGreaterThan(60);
      expect(sizes.first).toEqual(sizes.from);
      await settle(page);
      expect(await page.evaluate(() => document.querySelector("dialog")!.offsetHeight)).toBeLessThan(sizes.from.height);
    } finally {
      await page.context().close();
    }
  });

  test("a frame that scrolls its content itself swaps at once and keeps that level's scroll place", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as MorphWindow).openPlain());
      await settle(page);
      const scrolled = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        dialog.scrollTop = 300;
        return dialog.scrollTop;
      });
      expect(scrolled).toBe(300);
      await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-plain-ask]")!.click());
      expect(await page.evaluate(() => document.querySelector<HTMLElement>("dialog")!.dataset.k2bFrameMotion)).toBeUndefined();
      await settle(page);
      await page.click("[data-keep]");
      await settle(page);
      expect(await page.evaluate(() => document.querySelector("dialog")!.scrollTop)).toBe(300);
    } finally {
      await page.context().close();
    }
  });

  test("closing everything just after a change keeps the old content's picture until the frame has left", async () => {
    const page = await load();
    try {
      await openEditor(page);
      const during = await page.evaluate(() => {
        const motion = window as unknown as MorphWindow;
        document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
        motion.closeAll();
        return { editor: document.querySelector("[data-level='editor']") !== null, disposed: [...motion.disposed] };
      });
      expect(during).toEqual({ editor: true, disposed: [] });
      await page.waitForFunction(() => !document.querySelector("dialog"));
      expect((await page.evaluate(() => (window as unknown as MorphWindow).disposed)).sort()).toEqual(["editor", "question"]);
    } finally {
      await page.context().close();
    }
  });

  test("closing everything returns focus to where the dialog was opened from", async () => {
    const page = await load();
    try {
      await page.focus("#opener");
      await openEditor(page);
      await page.focus("[data-ask]");
      await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-ask]")!.click());
      await settle(page);
      await page.evaluate(() => (window as unknown as MorphWindow).closeAll());
      await page.waitForFunction(() => document.activeElement?.id === "opener");
    } finally {
      await page.context().close();
    }
  });

  test("closing everything during a morph fades out from what the eye sees, without a jump", async () => {
    const page = await load();
    try {
      await openEditor(page);
      await page.click("[data-ask]");
      await settle(page);
      // settled: the frames right after closing during the morph back are the subject.
      const sizes = await page.evaluate(
        () =>
          new Promise<{ before: number; after: number[]; editor: number; disposed: string[] }>((resolve) => {
            const motion = window as unknown as MorphWindow;
            const dialog = document.querySelector("dialog")!;
            document.querySelector<HTMLButtonElement>("[data-keep]")!.click();
            // animation-settle: all timelines - Sets or counts the dialog's own animations; the fixture has no scroll-driven ones.
            for (const animation of dialog.getAnimations({ subtree: true })) animation.currentTime = 70;
            const before = dialog.offsetWidth;
            // A guard that confirms and then closes its own dialog closes both levels in one task.
            motion.closeAll();
            const after: number[] = [];
            const sample = () => {
              if (!dialog.isConnected) return resolve({ before, after, editor: 0, disposed: [...motion.disposed] });
              after.push(dialog.offsetWidth);
              requestAnimationFrame(sample);
            };
            sample();
          }),
      );
      for (const width of sizes.after) expect(Math.abs(width - sizes.before)).toBeLessThan(1);
      expect([...sizes.disposed].sort()).toEqual(["editor", "question"]);
    } finally {
      await page.context().close();
    }
  });

  test("a level change before the level-change module has loaded still announces and keeps scroll places", async () => {
    const page = await load();
    try {
      // The module starts loading with the first open; a second level in the same task comes before it has arrived.
      await page.evaluate(() => {
        const motion = window as unknown as MorphWindow;
        motion.openEditor();
        document.querySelector<HTMLElement>("[data-scroll]")!.scrollTop = 120;
        motion.ask();
      });
      await settle(page);
      await page.waitForFunction(() => Boolean(document.querySelector("[data-k2b-dialog-live]")?.textContent));
      const forward = await page.evaluate(() => ({
        dialogs: document.querySelectorAll("dialog").length,
        question: document.querySelector("[data-level='question']") !== null,
        announced: document.querySelector("[data-k2b-dialog-live]")?.textContent,
      }));
      expect(forward).toEqual({ dialogs: 1, question: true, announced: "Discard changes? Your change to the name is lost." });
      await page.click("[data-keep]");
      await settle(page);
      await page.waitForFunction(() => document.querySelector("[data-k2b-dialog-live]")?.textContent === "Edit project");
      const back = await page.evaluate(() => ({
        scrollTop: document.querySelector<HTMLElement>("[data-scroll]")!.scrollTop,
        announced: document.querySelector("[data-k2b-dialog-live]")?.textContent,
      }));
      expect(back).toEqual({ scrollTop: 120, announced: "Edit project" });
    } finally {
      await page.context().close();
    }
  });

  test("with reduced motion the level changes in one frame", async () => {
    const page = await load({ ...desktop, reducedMotion: "reduce" });
    try {
      await page.evaluate(() => (window as unknown as MorphWindow).openEditor());
      // settled: the swap within the same frame under reduced motion is the subject.
      const swap = await page.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        document.querySelector<HTMLButtonElement>("[data-ask]")!.click();
        const editor = dialog.querySelector<HTMLElement>("[data-level='editor']")!.parentElement!;
        // animation-settle: all timelines - Sets or counts the dialog's own animations; the fixture has no scroll-driven ones.
        return {
          moving: dialog.getAnimations({ subtree: true }).length,
          editorHidden: getComputedStyle(editor).display === "none",
        };
      });
      expect(swap).toEqual({ moving: 0, editorHidden: true });
    } finally {
      await page.context().close();
    }
  });
});
