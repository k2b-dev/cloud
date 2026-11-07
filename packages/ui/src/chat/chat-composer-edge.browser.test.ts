import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The assistant prompt carries the AI colour: a light plum edge at rest, the full plum edge with a soft glow outside on
// focus, red with an error and a quiet grey edge when disabled. The edge stays 2 px in every state and the glow lies
// outside the box, so neither the card nor its text moves. The conversation composer between people stays neutral.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
const TEST_TIMEOUT = 30_000;
// Set K2B_UI_SHOTS to a directory to keep a screenshot of every state for review.
const shots = process.env.K2B_UI_SHOTS;
const entry = resolve(import.meta.dir, "chat-composer-edge.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Chat } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [error, setError] = createSignal(undefined);
const [disabled, setDisabled] = createSignal(false);
document.addEventListener("composer-state", ({ detail }) => { setError(detail.error); setDisabled(detail.disabled ?? false); });
const cell = (name, variant) => {
  const node = document.createElement("div");
  node.dataset.composer = name;
  render(() => createComponent(Chat.Composer, {
    variant,
    value: "Kannst du die Antwort an Jana entwerfen?",
    onValueChange: () => {},
    onSubmit: () => {},
    // The assistant footer as in the product: the add menu and the model.
    menuActions: variant === "conversation" ? undefined : [{ id: "files", label: "Dateien", icon: "ti ti-paperclip", onSelect: () => {} }],
    models: variant === "conversation" ? undefined : [{ id: "orion", label: "Orion 2" }],
    selectedModelId: "orion",
    onModelChange: () => {},
    get error() { return variant === "conversation" ? undefined : error(); },
    get disabled() { return variant === "conversation" ? false : disabled(); },
  }), node);
  return node;
};
document.getElementById("app").append(cell("assistant", undefined), cell("conversation", "conversation"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the composer edge fixture.");
const script = await build.outputs[0]!.text();

const FIELD = "textarea:not(.k2b-chat-composer__measure)";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (theme: "light" | "dark", width: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(`<!doctype html><html lang="de"><head><style>${css}</style><style>${fonts}</style>
    <style>*,*::before,*::after{transition:none!important;animation:none!important}
    #app{display:grid;gap:56px;padding:40px 16px;max-width:760px;margin:0 auto}</style></head>
    <body class="k2b-ui" data-theme="${theme}" style="margin:0;background:var(--k2b-surface-canvas)"><div id="app"></div></body></html>`);
  await page.evaluate(async () => {
    await Promise.all(["400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
  });
  await page.addScriptTag({ content: script });
  await page.locator(`[data-composer="conversation"] ${FIELD}`).waitFor();
  await page.mouse.move(2, 898);
  await settled(page);
  return page;
};

// Every colour as rgba() through a canvas, so tokens, computed styles and shadow colours compare equally.
const measure = (page: Page, name: string) =>
  page.evaluate(
    ({ name, field }) => {
      const context = document.createElement("canvas").getContext("2d")!;
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!, a! / 255] as const;
      };
      const card = document.querySelector(`[data-composer="${name}"] .k2b-chat-composer`)!;
      const edge = name === "conversation" ? card.querySelector(".k2b-chat-composer__field")! : card;
      const text = card.querySelector(field)!;
      const style = getComputedStyle(edge);
      const shadows = style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/).map((part) => part.trim());
      const inset = shadows.filter((part) => part.includes("inset"));
      const box = (node: Element) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height };
      };
      return {
        box: box(edge),
        text: box(text),
        width: Number.parseFloat(style.borderTopWidth) + Number(inset[0]?.match(/(-?[\d.]+)px\s+inset/)?.[1] ?? 0),
        border: rgba(style.borderTopColor),
        drop: shadows.filter((part) => !part.includes("inset")).length,
        // The glow is a layer around the card that only fades in.
        glow: (() => {
          const layer = getComputedStyle(edge, "::after");
          return layer.content !== "none" && layer.boxShadow !== "none" && layer.opacity === "1";
        })(),
        fill: rgba(style.backgroundColor),
      };
    },
    { name, field: FIELD },
  );

const tokens = (page: Page) =>
  page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (value: string) => {
      probe.style.color = value;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255] as const;
    };
    const result = {
      rest: read("var(--k2b-ai-edge-rest)"),
      focus: read("var(--k2b-ai-accent)"),
      danger: read("var(--k2b-edge-danger)"),
      off: read("var(--k2b-border)"),
      edge: read("var(--k2b-edge)"),
      neutralFocus: read("var(--k2b-edge-focus)"),
      surface: read("var(--k2b-surface)"),
      muted: read("var(--k2b-surface-muted)"),
      hover: read("var(--k2b-edge-hover-bg)"),
    };
    probe.remove();
    return result;
  });

type Rgba = Awaited<ReturnType<typeof tokens>>["rest"];

const luminance = ([r, g, b]: readonly number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

type State = { error?: string; disabled?: boolean; focus?: boolean; hover?: boolean };
const STATES: Record<string, State> = {
  rest: {},
  hover: { hover: true },
  focus: { focus: true },
  "focus-hover": { focus: true, hover: true },
  error: { error: "Die Nachricht konnte nicht gesendet werden." },
  "error-hover": { error: "Die Nachricht konnte nicht gesendet werden.", hover: true },
  "error-focus": { error: "Die Nachricht konnte nicht gesendet werden.", focus: true },
  disabled: { disabled: true },
  "disabled-hover": { disabled: true, hover: true },
};

const enter = async (page: Page, name: string, state: State) => {
  await page.mouse.move(2, 898);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (name === "assistant") await page.evaluate((detail) => document.dispatchEvent(new CustomEvent("composer-state", { detail })), state);
  await settled(page);
  const cell = page.locator(`[data-composer="${name}"]`);
  if (state.focus) await cell.locator(FIELD).evaluate((node: HTMLElement) => node.focus({ focusVisible: true } as FocusOptions));
  if (state.hover) await cell.locator(".k2b-chat-composer").hover({ position: { x: 4, y: 4 } });
  await settled(page);
};

const shoot = async (page: Page, file: string, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const { box } = await measure(page, name);
  const pad = 32;
  await page.screenshot({
    path: resolve(shots, file),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
};

describe("assistant composer edge in the browser", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      test(
        `${theme} ${width}px: plum edge, glow only on focus, box and text never move`,
        async () => {
          const page = await open(theme, width);
          try {
            const token = await tokens(page);
            // Focus is a clear step from rest: at least 3:1 between the two edge colours.
            expect(contrast(token.focus, token.rest), `${theme} focus vs rest edge`).toBeGreaterThanOrEqual(3);

            const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
            for (const [state, setup] of Object.entries(STATES)) {
              await enter(page, "assistant", setup);
              seen[state] = await measure(page, "assistant");
              await shoot(page, `${theme}-${width}-assistant-${state}.png`, "assistant");
            }
            const rest = seen.rest!;
            const label = `${theme} ${width}`;
            // Measured from the painted edge, not the token: the test fails when a rule stops applying.
            expect(contrast(seen.focus!.border, rest.border), `${label} painted focus vs rest`).toBeGreaterThanOrEqual(3);

            for (const [state, actual] of Object.entries(seen)) {
              expect(actual.width, `${label} ${state} edge width`).toBe(2);
              // The error adds its message line inside the card, as v3 shows; every other state keeps the box exactly.
              const base = state.startsWith("error") ? seen.error! : rest;
              expect(actual.box, `${label} ${state} box`).toEqual(base.box);
              expect(actual.text, `${label} ${state} text`).toEqual(rest.text);
              expect(actual.box.width, `${label} ${state} width`).toBe(rest.box.width);
              expect(actual.drop, `${label} ${state} shadow on the card`).toBe(0);
              expect(actual.glow, `${label} ${state} glow`).toBe(state.includes("focus"));
            }
            const expected: Record<string, [Rgba, Rgba]> = {
              rest: [token.rest, token.surface],
              hover: [token.rest, token.hover],
              focus: [token.focus, token.surface],
              "focus-hover": [token.focus, token.surface],
              error: [token.danger, token.surface],
              "error-hover": [token.danger, token.hover],
              "error-focus": [token.focus, token.surface],
              disabled: [token.off, token.muted],
              "disabled-hover": [token.off, token.muted],
            };
            for (const [state, [edge, fill]] of Object.entries(expected)) {
              expect(seen[state]!.border, `${label} ${state} edge colour`).toEqual(edge);
              expect(seen[state]!.fill, `${label} ${state} fill`).toEqual(fill);
            }

            // The conversation composer between people keeps the neutral field edge and no glow.
            for (const state of ["rest", "focus"] as const) {
              await enter(page, "conversation", state === "focus" ? { focus: true } : {});
              const actual = await measure(page, "conversation");
              await shoot(page, `${theme}-${width}-conversation-${state}.png`, "conversation");
              expect(actual.border, `${label} conversation ${state} edge`).toEqual(state === "focus" ? token.neutralFocus : token.edge);
              expect(actual.drop, `${label} conversation ${state} shadow`).toBe(0);
              expect(actual.glow, `${label} conversation ${state} glow`).toBe(false);
              expect(actual.width, `${label} conversation ${state} edge width`).toBe(2);
            }
          } finally {
            await page.close();
          }
        },
        TEST_TIMEOUT * 2,
      );
    }
  }
});
