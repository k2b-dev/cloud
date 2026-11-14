import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A sheet with a handle (Cloud's side panel on phones, the map dialog's list) moves by transform only, like
// `BottomSheet`: its layout height stays fixed while it follows the pointer and while it glides between detents, so
// the content inside does not lay out again on every frame. Only a real engine paints those frames.
const ui = resolve(import.meta.dir, "../..");
const entry = resolve(import.meta.dir, "sheet-handle.fixture.ts");
const fixture = `
import { attachSheetHandle } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.dismissed = 0;
window.attach = (dismissible) => {
  const sheet = document.querySelector("#sheet");
  attachSheetHandle(document.querySelector("#handle"), {
    sheet,
    detents: ["half", "full"],
    initial: "half",
    onDismiss: dismissible ? () => { window.dismissed += 1; sheet.hidden = true; } : undefined,
  });
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sheet handle fixture.");
const script = await build.outputs[0]!.text();

// The stylesheet owns the resting heights, as in Cloud's panel: 300 px at half, 700 px at full.
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body { margin: 0; }
  #sheet { position: fixed; left: 0; right: 0; bottom: 0; height: 300px; display: flex; flex-direction: column; background: #fff; }
  #sheet[data-sheet-detent="full"] { height: 700px; }
  #sheet[hidden] { display: none; }
  #handle { flex: none; height: 32px; }
  #list { flex: 1; overflow: auto; }
</style></head><body><div id="sheet"><button id="handle" type="button">Resize</button><div id="list">${"<p>Row</p>".repeat(40)}</div></div></body></html>`;

const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 } };
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, dismissible = false): Promise<Page> => {
  const tab = await (await browser.newContext({ ...phone, ...options })).newPage();
  tab.setDefaultTimeout(10_000);
  await tab.setContent(page);
  await tab.addScriptTag({ content: script });
  await tab.evaluate((value) => (window as unknown as { attach: (dismissible: boolean) => void }).attach(value), dismissible);
  return tab;
};

/** The sheet's layout height and the height painted above the bottom edge. */
const place = (tab: Page) =>
  tab.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>("#sheet")!;
    return {
      layout: sheet.offsetHeight,
      visible: Math.round(innerHeight - sheet.getBoundingClientRect().top),
      detent: sheet.dataset.sheetDetent,
      inline: sheet.style.height + sheet.style.transform,
    };
  });

// settled: callers read before a gesture starts, after `settled` or the page's first frame.
const handleCenter = async (tab: Page) => {
  const box = (await tab.locator("#handle").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("a drag follows the pointer by transform: the layout height stays fixed, and the sheet rests on a detent", async () => {
  const tab = await open({ reducedMotion: "reduce" });
  try {
    await settled(tab);
    const start = await handleCenter(tab);
    await tab.mouse.move(start.x, start.y);
    await tab.mouse.down();
    const layouts = new Set<number>();
    for (const step of [20, 60, 100, 140]) {
      await tab.mouse.move(start.x, start.y - step);
      // settled: the sheet under the held pointer is the subject.
      const now = await place(tab);
      layouts.add(now.layout);
      expect(now.visible).toBe(300 + step);
    }
    // One layout height for the whole drag: the content does not lay out again on every move.
    expect(layouts.size).toBe(1);
    // A slow release well above half height rests at full height.
    await tab.mouse.move(start.x, start.y - 260, { steps: 4 });
    await tab.waitForTimeout(120);
    await tab.mouse.up();
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 700, visible: 700, detent: "full", inline: "" });
  } finally {
    await tab.context().close();
  }
});

test("a press glides to the other detent with one layout height, frame by frame", async () => {
  const tab = await open({ reducedMotion: "no-preference" });
  try {
    // settled: every frame of the glide is the subject.
    await tab.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("#sheet")!;
      const samples: { layout: number; visible: number }[] = [];
      Object.assign(window, { samples });
      const sample = () => {
        samples.push({ layout: sheet.offsetHeight, visible: Math.round(innerHeight - sheet.getBoundingClientRect().top) });
        if (samples.length < 40) requestAnimationFrame(sample);
      };
      document.querySelector<HTMLElement>("#handle")!.click();
      requestAnimationFrame(sample);
    });
    await tab.waitForFunction(() => (window as unknown as { samples: unknown[] }).samples.length >= 40);
    const samples = await tab.evaluate(() => (window as unknown as { samples: { layout: number; visible: number }[] }).samples);
    const moving = samples.filter((sample) => sample.visible > 300 && sample.visible < 700);
    // It glides: the eye sees heights between the detents, rising and never past full height.
    expect(moving.length).toBeGreaterThanOrEqual(3);
    for (const [index, sample] of samples.entries())
      if (index > 0) expect(sample.visible).toBeGreaterThanOrEqual(samples[index - 1]!.visible);
    // While it glides the layout height does not change.
    expect(new Set(moving.map((sample) => sample.layout)).size).toBe(1);
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 700, visible: 700, detent: "full", inline: "" });
  } finally {
    await tab.context().close();
  }
});

test("with reduced motion a press switches at once", async () => {
  const tab = await open({ reducedMotion: "reduce" });
  try {
    await tab.click("#handle");
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 700, visible: 700, detent: "full", inline: "" });
    await tab.keyboard.press("Enter");
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 300, visible: 300, detent: "half", inline: "" });
  } finally {
    await tab.context().close();
  }
});

test("a drag far down slides the sheet out before it asks to close", async () => {
  const tab = await open({ reducedMotion: "no-preference" }, true);
  try {
    await settled(tab);
    const start = await handleCenter(tab);
    await tab.mouse.move(start.x, start.y);
    await tab.mouse.down();
    await tab.mouse.move(start.x, start.y + 120, { steps: 6 });
    // settled: the sheet under the held pointer is the subject.
    expect((await place(tab)).visible).toBe(180);
    await tab.mouse.move(start.x, start.y + 260, { steps: 6 });
    // The owner is asked only after the slide: right after the release, the sheet is still on screen and moving down.
    await tab.mouse.up();
    // settled: the moment right after the release, while the sheet slides out, is the subject.
    const right = await tab.evaluate(() => ({
      dismissed: (window as unknown as { dismissed: number }).dismissed,
      visible: Math.round(innerHeight - document.querySelector("#sheet")!.getBoundingClientRect().top),
    }));
    expect(right.dismissed).toBe(0);
    expect(right.visible).toBeGreaterThan(0);
    await tab.waitForFunction(() => (window as unknown as { dismissed: number }).dismissed === 1);
  } finally {
    await tab.context().close();
  }
});

test("an owner that hides the sheet during a glide ends the glide: the next opening starts clean", async () => {
  const tab = await open({ reducedMotion: "no-preference" });
  try {
    await tab.evaluate(() => {
      const sheet = document.querySelector<HTMLElement>("#sheet")!;
      document.querySelector<HTMLElement>("#handle")!.click();
      // The owner closes the sheet mid-glide and forgets its detent, then opens it again soon after.
      requestAnimationFrame(() => {
        sheet.hidden = true;
        delete sheet.dataset.sheetDetent;
        setTimeout(() => {
          sheet.hidden = false;
        }, 60);
      });
    });
    // fixed wait: longer than the 280 ms glide that was cut short.
    await tab.waitForTimeout(500);
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 300, visible: 300, detent: undefined, inline: "" });
  } finally {
    await tab.context().close();
  }
});

test("a tap that catches a glide at its end switches once, like every press, and lands", async () => {
  const tab = await open({ reducedMotion: "no-preference" });
  try {
    await tab.evaluate(() => {
      document.querySelector<HTMLElement>("#handle")!.click();
      // Hold the sheet's own glide a hair before its end, where the catch lands it at once.
      const glides = document
        .querySelector<HTMLElement>("#sheet")!
        .getAnimations()
        .filter((animation) => animation.timeline === document.timeline);
      for (const animation of glides) {
        animation.pause();
        animation.currentTime = 279.9;
      }
    });
    // The glide to full is caught; the tap's click sends the sheet back to half, once, and it lands there.
    await tab.click("#handle");
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 300, visible: 300, detent: "half", inline: "" });
  } finally {
    await tab.context().close();
  }
});

test("a press that catches a glide and lifts off the handle without a click lets the glide land", async () => {
  const tab = await open({ reducedMotion: "no-preference" });
  try {
    await settled(tab);
    const start = await handleCenter(tab);
    await tab.evaluate(() => document.querySelector<HTMLElement>("#handle")!.click());
    await tab.mouse.move(start.x, start.y);
    await tab.mouse.down();
    // Lifting outside the handle sends no click on it.
    await tab.mouse.move(start.x, start.y - 3);
    await tab.evaluate(() => document.querySelector<HTMLElement>("#handle")!.releasePointerCapture?.(1));
    await tab.mouse.move(start.x + 300, start.y - 400);
    await tab.mouse.up();
    await settled(tab);
    expect(await place(tab)).toEqual({ layout: 700, visible: 700, detent: "full", inline: "" });
  } finally {
    await tab.context().close();
  }
});
