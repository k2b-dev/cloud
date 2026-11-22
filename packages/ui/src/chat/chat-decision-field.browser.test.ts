import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type { FieldState } from "../../test/chat-decision-field.browser-harness";

// Geometry of a question that asks for one value: no state moves anything, the eye is 44 px on touch, and on a phone
// both answers share one row with one-line labels and no icons.
// `running` comes last: its answer never settles, so the question stays held.
const fieldStates: readonly FieldState[] = [
  "open",
  "typed",
  "saving",
  "empty",
  "chars",
  "failed",
  "unknown",
  "held",
  "conflict",
  "running",
];
let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chat-decision-field.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chat-decision-field-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Chat decision field harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const open = async (context: BrowserContextOptions) => {
  const page = await browser.newPage(context);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
      html { font-size:16px; } body { margin:0; font-family:Arial,sans-serif; }
      main { max-width:764px; margin:24px auto; padding:0 14px; }
    </style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".k2b-chat-decision__entry");
  return page;
};

const set = async (page: Page, state: FieldState) => {
  await page.evaluate((state) => window.__set(state), state);
  await settled(page);
};

/** Every box of the question that a state could move. */
const geometry = (page: Page) =>
  page.evaluate(() =>
    [
      ".k2b-chat-decision",
      ".k2b-chat-decision__details",
      ".k2b-chat-decision__field .k2b-input-shell",
      ".k2b-chat-decision__confirm",
      ".k2b-chat-decision__line-cell",
      ".k2b-chat-decision__decline",
      "#sentinel",
    ].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, x, y, width, height };
    }),
  );

for (const [name, context] of [
  ["1440 px", desktop],
  ["390 px", phone],
] as const)
  test(`${name}: open, typed, saving, error, locked, conflict and a running answer share one geometry (0 px)`, async () => {
    const page = await open(context);
    try {
      await settled(page);
      const baseline = await geometry(page);
      for (const state of fieldStates) {
        await set(page, state);
        expect({ state, boxes: await geometry(page) }).toEqual({ state, boxes: baseline });
      }
      // The focus ring sits outside the field and moves nothing either.
      await page.locator(".k2b-chat-decision__field input").focus();
      await settled(page);
      expect(await geometry(page)).toEqual(baseline);
    } finally {
      await page.close();
    }
  });

test("1440 px: the field and the main answer share a row, the line and the quiet answer the next", async () => {
  const page = await open(desktop);
  try {
    await settled(page);
    const [, , field, confirm, line, decline] = await geometry(page);
    expect(Math.abs(field!.y + field!.height / 2 - (confirm!.y + confirm!.height / 2))).toBeLessThan(1);
    expect(decline!.y).toBeGreaterThan(field!.y + field!.height);
    expect(Math.abs(line!.y - decline!.y)).toBeLessThan(decline!.height);
    // Wide, the answers keep their icons (the test page loads no icon font, so the icon has no size of its own).
    expect(await page.locator(".k2b-chat-decision__confirm i.ti-lock").evaluate((icon) => getComputedStyle(icon).display)).not.toBe("none");
  } finally {
    await page.close();
  }
});

test("390 px: both answers in one row, each label on one line, without icons", async () => {
  const page = await open(phone);
  try {
    for (const state of fieldStates) {
      await set(page, state);
      const facts = await page.evaluate(() => {
        const confirm = document.querySelector(".k2b-chat-decision__confirm")!;
        const decline = document.querySelector(".k2b-chat-decision__decline")!;
        const current = (button: Element) => button.querySelector('.k2b-chat-decision__face[data-current="true"]')!;
        const lineHeight = (element: Element) => Number.parseFloat(getComputedStyle(element).lineHeight);
        return {
          sameRow: confirm.getBoundingClientRect().top === decline.getBoundingClientRect().top,
          declineFirst: decline.getBoundingClientRect().right <= confirm.getBoundingClientRect().left,
          oneLine: [confirm, decline].every((button) => current(button).getBoundingClientRect().height <= lineHeight(current(button)) + 1),
          icons: [...document.querySelectorAll(".k2b-chat-decision__entry .k2b-chat-decision__face i")].filter(
            (icon) => getComputedStyle(icon).display !== "none",
          ).length,
        };
      });
      expect({ state, ...facts }).toEqual({ state, sameRow: true, declineFirst: true, oneLine: true, icons: 0 });
    }
  } finally {
    await page.close();
  }
});

test("touch: the eye's box is 44 px wide and its hit area 44 px high, without reaching into the text", async () => {
  const page = await open(phone);
  try {
    await settled(page);
    const hits = await page.evaluate(() => {
      const eye = document.querySelector<HTMLButtonElement>(".k2b-input-shell__reveal")!;
      const input = document.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
      const box = eye.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const middle = box.top + box.height / 2;
      const at = (px: number, py: number) => document.elementFromPoint(px, py);
      return {
        width: box.width,
        top: at(x, middle - 21) === eye,
        bottom: at(x, middle + 21) === eye,
        left: at(box.left + 1, middle) === eye,
        text: at(box.left - 2, middle) === input,
      };
    });
    expect(hits).toEqual({ width: 44, top: true, bottom: true, left: true, text: true });
    // The shell lets the hit area out, so the input takes its corners for the fill autofill paints on it.
    const corners = await page.evaluate(() => {
      const shell = getComputedStyle(document.querySelector(".k2b-chat-decision__field .k2b-input-shell")!);
      const input = getComputedStyle(document.querySelector(".k2b-chat-decision__field input")!);
      return {
        overflow: shell.overflow,
        start: [input.borderStartStartRadius, input.borderEndStartRadius],
        shell: [shell.borderStartStartRadius, shell.borderEndStartRadius],
      };
    });
    expect(corners.overflow).toBe("visible");
    expect(corners.start).toEqual(corners.shell);
    expect(corners.start[0]).not.toBe("0px");
    // The eye keeps its name while it shows the value.
    const eye = page.getByRole("button", { name: "Show value", exact: true });
    await eye.tap();
    expect(await eye.getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator(".k2b-chat-decision__field input").getAttribute("type")).toBe("text");
  } finally {
    await page.close();
  }
});

test("closed, the question keeps its head and one outcome line, and the field with its value is gone", async () => {
  const page = await open(desktop);
  try {
    await set(page, "typed");
    await page.evaluate(() => window.__close());
    await settled(page);
    expect(await page.locator(".k2b-chat-decision input").count()).toBe(0);
    expect(await page.locator(".k2b-chat-decision").evaluate((e) => e.outerHTML.includes("FICTIONAL"))).toBe(false);
    expect(await page.locator('.k2b-chat-outcome__text[data-current="true"]').textContent()).toBe("Secret Parcel_API saved19:42");
  } finally {
    await page.close();
  }
});
