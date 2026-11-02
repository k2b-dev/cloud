import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A dialog tone is a 2 px edge drawn inside the frame. The frame, its title and
// its actions sit exactly where they sit without a tone, and the edge stays in
// every state: a focused frame, a stacked level above it, a phone sheet.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const TEST_TIMEOUT = 30_000;
const entry = resolve(import.meta.dir, "dialog-tone.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { BottomSheet, bottomSheetAdaptiveOptions, Button, dialogCore, PanelDialog, panelDialogOptions, prompts, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const content = (tone, close) => [
  createComponent(PanelDialog.Header, { title: "Invoice RE-2026-0142 created", subtitle: "Mueller Antik GmbH", icon: "ti ti-file-invoice", close }),
  createComponent(PanelDialog.Body, { get children() { return createComponent(TextInput, { label: "Send to", value: "office@example.com" }); } }),
  createComponent(PanelDialog.Footer, { get children() { return [
    createComponent(Button, { variant: "secondary", children: "Print" }),
    createComponent(Button, { variant: "secondary", children: "Send by email" }),
    createComponent(Button, { onClick: close, children: "Done" }),
  ]; } }),
];
window.openVariant = {
  panel: (tone) => void dialogCore.open((close) => createComponent(PanelDialog, { tone, get children() { return content(tone, () => close()); } }), panelDialogOptions),
  sheet: (tone) => void dialogCore.open((close, context) => createComponent(BottomSheet, { tone, onDismiss: () => context.requestDismiss(), get children() { return content(tone, () => close()); } }), bottomSheetAdaptiveOptions),
  confirm: (tone) => void prompts.confirm("The invoice becomes void.", { title: "Cancel invoice?", icon: "ti ti-receipt-off", variant: tone ? "danger" : "primary", confirmText: "Cancel invoice" }),
  success: (tone) => void (tone ? prompts.success("Saved.", { title: "Done" }) : prompts.alert("Saved.", { title: "Done", icon: "ti ti-info-circle" })),
  error: (tone) => void (tone ? prompts.error("Saving failed.", { title: "Not saved" }) : prompts.alert("Saving failed.", { title: "Not saved", icon: "ti ti-info-circle", confirmText: "Close" })),
};
window.stackConfirm = () => void prompts.confirm("Leave?", { title: "Leave" });
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog tone fixture.");
const script = await build.outputs[0]!.text();

type Variant = "panel" | "sheet" | "confirm" | "success" | "error";
const tones: Record<Variant, string> = { panel: "success", sheet: "warning", confirm: "danger", success: "success", error: "danger" };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (variant: Variant, tone: string | undefined, theme: "light" | "dark", width: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
    <style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
    <body class="k2b-ui" data-theme="${theme}" style="margin:0"></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ([name, value]) => (window as unknown as { openVariant: Record<string, (tone?: string) => void> }).openVariant[name!]!(value),
    [variant, tone] as const,
  );
  await page.locator("dialog[open] h2").waitFor();
  await settled(page);
  return page;
};

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });

const layout = async (page: Page) => ({
  frame: await box(page, "dialog[open]"),
  title: await box(page, "dialog[open] h2"),
  action: await box(page, "dialog[open] :is(.k2b-panel-dialog__footer, .k2b-dialog__actions) button:last-child"),
});

/** The colours of the four pixels from the frame's left edge inward, at its vertical middle. */
const leftEdge = async (page: Page): Promise<number[][]> => {
  const frame = await box(page, "dialog[open]");
  const shot = await page.screenshot({ clip: { x: frame.x, y: Math.round(frame.y + frame.height / 2), width: 4, height: 1 } });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, 4, 1).data;
    return [0, 1, 2, 3].map((index) => [pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!]);
  }, shot.toString("base64"));
};

const rgb = (color: string) =>
  color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);
const near = (pixel: number[], color: number[]) => pixel.every((channel, index) => Math.abs(channel - color[index]!) <= 6);
const luminance = (color: number[]) => {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

const toneOf = (page: Page) =>
  page.locator("dialog[open]").evaluate((dialog) => {
    const style = getComputedStyle(dialog);
    return { style: style.outlineStyle, color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset };
  });

describe("@k2b/ui dialog tones", () => {
  const cases: [Variant, number][] = [
    ["panel", 1280],
    ["sheet", 1280],
    ["sheet", 390],
    ["confirm", 1280],
    ["success", 1280],
    ["error", 1280],
  ];
  for (const theme of ["light", "dark"] as const) {
    for (const [variant, width] of cases) {
      test(
        `${variant} at ${width} px (${theme}) keeps its geometry and draws a 2 px ${tones[variant]} edge`,
        async () => {
          const plain = await open(variant, undefined, theme, width);
          const toned = await open(variant, tones[variant], theme, width);
          try {
            expect(await layout(toned)).toEqual(await layout(plain));
            expect((await toneOf(plain)).style).toBe("none");
            const edge = await toneOf(toned);
            expect(edge).toMatchObject({ style: "solid", width: "2px", offset: "-2px" });

            const tone = rgb(edge.color);
            const [first, second, third] = await leftEdge(toned);
            expect(near(first!, tone)).toBe(true);
            expect(near(second!, tone)).toBe(true);
            expect(near(third!, tone)).toBe(false);
            // The edge separates the dialog from its own surface.
            expect(contrast(tone, third!)).toBeGreaterThanOrEqual(3);

            // The header shows the tone's icon; for screen readers its word describes the dialog, and the
            // heading keeps exactly the title, so a lookup by heading name finds it as before.
            const header = toned.locator("dialog[open] :is(.k2b-panel-dialog__header, .k2b-dialog__header)");
            expect(await header.locator(`[data-tone="${tones[variant]}"]`).count()).toBe(1);
            const title = await plain.locator("dialog[open] h2").textContent();
            expect(await toned.locator("dialog[open] h2").textContent()).toBe(title);
            await toned.getByRole("heading", { name: title!, exact: true }).waitFor();
            expect(
              await toned.locator("dialog[open]").evaluate((dialog) =>
                (dialog.getAttribute("aria-describedby") ?? "")
                  .split(" ")
                  .map((id) => document.getElementById(id)?.textContent)
                  .join(" "),
              ),
            ).toMatch(/^(Success|Warning|Caution)$/);

            // A focused frame keeps its edge.
            await toned.locator("dialog[open]").evaluate((dialog: HTMLDialogElement) => {
              dialog.tabIndex = -1;
              dialog.focus();
            });
            await settled(toned);
            expect(await toneOf(toned)).toEqual(edge);
            expect(near((await leftEdge(toned))[1]!, tone)).toBe(true);
          } finally {
            await plain.close();
            await toned.close();
          }
        },
        TEST_TIMEOUT,
      );
    }
  }

  test(
    "an untoned level stacked above a toned one has no edge, and the edge returns when it closes",
    async () => {
      const page = await open("panel", "success", "light", 1280);
      try {
        const edge = await toneOf(page);
        await page.evaluate(() => (window as unknown as { stackConfirm: () => void }).stackConfirm());
        await page.locator("dialog[open] h2", { hasText: "Leave" }).waitFor();
        await settled(page);
        expect((await toneOf(page)).style).toBe("none");
        await page.keyboard.press("Escape");
        await page.locator("dialog[open] h2", { hasText: "Invoice" }).waitFor();
        await settled(page);
        expect(await toneOf(page)).toEqual(edge);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
