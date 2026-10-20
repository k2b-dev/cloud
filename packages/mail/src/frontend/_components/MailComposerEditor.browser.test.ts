import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { ComposeFormattingWarning } from "../../contracts";
import { renderComposeContent } from "../../service/compose-renderer";
import type { MailComposerEditorHarnessOptions, MailComposerHarnessOptions } from "./MailComposerEditor.browser-harness";

// Whether the hint about removed HTML leaves the previewed message in place and stays on screen on a phone is a
// layout question, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailComposerEditor.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-composer-editor-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Composer editor harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
// As a Cloud page loads them: the layer order first, then the app's utilities, then the shared styles, whose
// responsive variants win over the app's plain utilities.
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
// The icon font gives icon-only buttons their real width.
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const load = async (options: { context: BrowserContextOptions; theme: "light" | "dark"; locale: "en" | "de" }) => {
  const page = await (await browser.newContext(options.context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailComposerEditorHarnessOptions) => window.mountComposerEditor(harnessOptions), {
    locale: options.locale,
  } satisfies MailComposerEditorHarnessOptions);
  return Object.assign(page, { errors });
};

const loadComposer = async (context: BrowserContextOptions, locale: "en" | "de") => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.evaluate((options: MailComposerHarnessOptions) => window.mountComposer(options), {
    locale,
    intent: "reply_all",
    signatureTemplateId: "Sign02",
  } satisfies MailComposerHarnessOptions);
  await page.waitForSelector("button.mail-composer-signature:not(:disabled)");
  await page.evaluate(() => document.fonts.ready);
  return Object.assign(page, { errors });
};

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} is not visible`);
  return rect;
};
/** Where the first paragraph of the previewed message sits on the page. */
const messageStart = async (page: Page) => {
  const rect = await page.frameLocator('iframe[sandbox=""]').locator("p").first().boundingBox();
  if (!rect) throw new Error("The previewed message is not visible");
  return rect;
};

const warnings: ComposeFormattingWarning[] = [
  { code: "ignored_mailbox_css", property: "font-family" },
  { code: "unsupported_element", element: "small" },
  { code: "unsupported_attribute", element: "span", attribute: "class" },
];
const manyWarnings: ComposeFormattingWarning[] = Array.from({ length: 20 }, (_, index) => ({
  code: "unsupported_element",
  element: `x-tag${index}`,
}));

describe("Mail composer preview", () => {
  for (const [label, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`lists removed HTML below the message without moving it on ${label} in ${theme} mode`, async () => {
        const locale = theme === "dark" ? "de" : "en";
        const page = await load({ context, theme, locale });
        try {
          await page.waitForSelector('iframe[sandbox=""]');
          const frame = await box(page, 'iframe[sandbox=""]');
          const start = await messageStart(page);

          await page.evaluate((list) => window.setFormattingWarnings(list), warnings);
          const title =
            locale === "de"
              ? "Ein Teil der Formatierung dieser Nachricht wird in der E-Mail weggelassen."
              : "Email leaves out some formatting of this message.";
          const hint = page.locator(".k2b-inline-guidance", { hasText: title });
          await hint.waitFor();

          // The message keeps its place; the hint takes room below it and stays on screen.
          expect(await messageStart(page)).toEqual(start);
          const shown = await box(page, 'iframe[sandbox=""]');
          expect({ x: shown.x, y: shown.y, width: shown.width }).toEqual({ x: frame.x, y: frame.y, width: frame.width });
          const hintBox = await box(page, ".k2b-inline-guidance");
          expect(hintBox.y).toBeGreaterThanOrEqual(shown.y + shown.height - 0.5);
          expect(hintBox.y + hintBox.height).toBeLessThanOrEqual((context.viewport?.height ?? 0) + 0.5);
          expect(hintBox.x + hintBox.width).toBeLessThanOrEqual((context.viewport?.width ?? 0) + 0.5);
          expect(await hint.locator("li").count()).toBe(3);

          // A long list scrolls inside a bounded hint instead of pushing the message away.
          await page.evaluate((list) => window.setFormattingWarnings(list), manyWarnings);
          await page.waitForFunction(() => document.querySelectorAll(".k2b-inline-guidance li").length === 20);
          const bounded = await box(page, ".k2b-inline-guidance");
          expect(bounded.height).toBeLessThanOrEqual(112.5);
          expect(await page.locator(".k2b-inline-guidance").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
          expect((await box(page, 'iframe[sandbox=""]')).y).toBe(frame.y);
          expect(await messageStart(page)).toEqual(start);

          await page.evaluate(() => window.setFormattingWarnings([]));
          await hint.waitFor({ state: "detached" });
          expect(await box(page, 'iframe[sandbox=""]')).toEqual(frame);
          expect(page.errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});

describe("Mail composer action bar", () => {
  for (const [device, context] of [
    ["desktop", { viewport: { width: 1366, height: 900 } }],
    // The narrowest width at which the neighbors show their labels.
    ["tablet", { viewport: { width: 640, height: 900 }, isMobile: true, hasTouch: true }],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ] as const) {
    for (const locale of ["en", "de"] as const) {
      test(`keeps the signature choice in one action row on ${device} in ${locale}`, async () => {
        const page = await loadComposer(context, locale);
        try {
          const prefix = locale === "de" ? "Signatur" : "Signature";
          const trigger = page.getByRole("button", { name: `${prefix}: Personal signature`, exact: true });
          expect(await trigger.count()).toBe(1);
          const footer = page.locator("footer");
          const measure = () =>
            footer.evaluate((element) => ({
              width: element.clientWidth,
              scrollWidth: element.scrollWidth,
              height: element.getBoundingClientRect().height,
              children: Array.from(element.children)
                .filter((child) => child.getBoundingClientRect().width > 0 && child.getBoundingClientRect().height > 0)
                .map((child) => {
                  const rect = child.getBoundingClientRect();
                  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                }),
            }));
          const before = await measure();
          // One row: controls of different heights share a vertical center.
          const centers = before.children.map((child) => child.y + child.height / 2);
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
          expect(before.height).toBeLessThan(64);
          expect(before.scrollWidth).toBeLessThanOrEqual(before.width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const ai = footer.getByRole("button", { name: locale === "de" ? "Mit KI schreiben" : "Write with AI", exact: true });
          const options = footer.getByRole("button", { name: locale === "de" ? "Nachrichtenoptionen" : "Message options", exact: true });
          const aiBox = await ai.boundingBox();
          const signatureBox = await box(page, "button.mail-composer-signature");
          const optionsBox = await options.boundingBox();
          expect(aiBox!.x).toBeLessThan(signatureBox.x);
          expect(signatureBox.x).toBeLessThan(optionsBox!.x);
          expect(await trigger.locator(".k2b-button__label > span").isVisible()).toBe(device === "desktop");
          expect(await trigger.locator(".k2b-button__label > span").textContent()).toBe("Personal signature");
          expect(await trigger.locator(".ti-chevron-down").isVisible()).toBe(device === "desktop");
          if (device !== "desktop") expect(signatureBox.width).toBeLessThanOrEqual(44);
          expect(await page.locator(".mail-composer-signature").count()).toBe(1);
          expect(await footer.locator(".mail-composer-signature").count()).toBe(1);
          const editor = await box(page, ".k2b-panes");
          const footerBox = await box(page, "footer");
          expect(editor.y + editor.height).toBeLessThanOrEqual(footerBox.y + 0.5);

          await trigger.focus();
          await page.keyboard.press("Enter");
          const items = page.getByRole("menuitemradio");
          await items.first().waitFor({ state: "visible" });
          expect(await items.count()).toBe(4);
          for (const item of await items.all()) {
            expect(await item.isVisible()).toBe(true);
            const rect = await item.boundingBox();
            expect(rect!.x).toBeGreaterThanOrEqual(0);
            expect(rect!.y).toBeGreaterThanOrEqual(0);
            expect(rect!.x + rect!.width).toBeLessThanOrEqual(context.viewport.width + 0.5);
            expect(rect!.y + rect!.height).toBeLessThanOrEqual(context.viewport.height + 0.5);
            expect(await item.getAttribute("aria-checked")).toBe(String((await item.textContent())?.includes("Personal signature")));
          }
          const menu = await box(page, '[role="menu"]:visible');
          expect(menu.y + menu.height).toBeLessThanOrEqual(signatureBox.y);
          await page.keyboard.press("Home");
          const none = page.getByRole("menuitemradio", { name: locale === "de" ? "Keine Signatur" : "No signature", exact: true });
          expect(await none.evaluate((element) => document.activeElement === element)).toBe(true);
          await page.keyboard.press("Enter");
          const cleared = page.getByRole("button", { name: `${prefix}: ${locale === "de" ? "Keine" : "None"}`, exact: true });
          await cleared.waitFor({ state: "visible" });
          expect(await cleared.evaluate((element) => document.activeElement === element)).toBe(true);
          if (device !== "desktop") {
            const after = await measure();
            expect(after.children.map((child) => child.x)).toEqual(before.children.map((child) => child.x));
            expect((await box(page, "button.mail-composer-signature")).width).toBe(signatureBox.width);
          }
          expect(page.errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);
    }
  }
});

describe("Mail composer preview with the mailbox logo", () => {
  /** The server's preview HTML for a signature with the mailbox logo, from Mail's own renderer. */
  const previewWithLogo = (logo: { dataUrl: string; byteLength: number }, src = logo.dataUrl) => {
    const rendered = renderComposeContent({
      body: "First paragraph of the message.",
      format: "markdown",
      customCss: "",
      renderLiquid: true,
      signature: "Kind regards\n\n{{ mailbox.logo }}\n\nExample Team",
      context: {
        actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
        mailbox: { name: "Example Team", description: "" },
        sender: { display_name: "Example Team", email: "team@example.test", reply_to: "" },
        message: { subject: "Offer", to: ["reader@example.test"], cc: [] },
      },
      logo: { src, altText: "Example Team", displayWidth: 200, pixelWidth: 600, pixelHeight: 200, byteLength: logo.byteLength },
    });
    if (!rendered.ok || !rendered.data.html) throw new Error("The preview did not render");
    return rendered.data.html;
  };
  const drawLogo = (page: Page) =>
    page.evaluate(async () => {
      const canvas = new OffscreenCanvas(600, 200);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#0f766e";
      context.beginPath();
      context.arc(100, 100, 72, 0, Math.PI * 2);
      context.fill();
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { dataUrl: `data:image/png;base64,${btoa(binary)}`, byteLength: bytes.byteLength };
    });
  const preview = (page: Page) => page.frameLocator('iframe[sandbox=""]');
  const logoBox = async (page: Page) => {
    const rect = await preview(page).locator('img[alt="Example Team"]').boundingBox();
    if (!rect) throw new Error("The previewed logo is not visible");
    return rect;
  };
  const closingBox = async (page: Page) => {
    const rect = await preview(page).getByText("Example Team", { exact: true }).last().boundingBox();
    if (!rect) throw new Error("The text below the logo is not visible");
    return rect;
  };

  for (const [label, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`shows the logo from a data URL in the box the server reserves on ${label}`, async () => {
      const page = await load({ context, theme: "dark", locale: "en" });
      try {
        await page.waitForSelector('iframe[sandbox=""]');
        const logo = await drawLogo(page);

        // An image whose size is not known yet takes the box the server's width and height attributes reserve. An image
        // without a size of its own stands in for one still loading: the preview allows only data: URLs, which load at
        // once, and a broken image ignores the attributes in WebKit.
        const sizeless = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
        await page.evaluate((html) => window.setPreviewHtml(html), previewWithLogo(logo, sizeless));
        await preview(page).locator('img[alt="Example Team"]').waitFor();
        const pending = await logoBox(page);
        const pendingClosing = await closingBox(page);

        await page.evaluate((html) => window.setPreviewHtml(html), previewWithLogo(logo));
        const image = preview(page).locator('img[alt="Example Team"]');
        await image.evaluate((element: HTMLImageElement) => element.decode());
        expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(600);
        expect(await image.getAttribute("src")).toBe(logo.dataUrl);
        expect(await image.getAttribute("width")).toBe("200");
        expect(await image.getAttribute("height")).toBe("67");
        const sources = await preview(page)
          .locator("img")
          .evaluateAll((images) => images.map((element) => element.getAttribute("src") ?? ""));
        expect(sources.every((source) => source.startsWith("data:image/"))).toBe(true);

        const loaded = await logoBox(page);
        expect(loaded.width).toBe(200);
        // The attribute height is rounded; the loaded image keeps its exact 3:1 ratio.
        expect(Math.abs(loaded.height - pending.height)).toBeLessThan(0.5);
        expect(Math.abs((await closingBox(page)).y - pendingClosing.y)).toBeLessThan(0.5);
        // The preview is the recipient's white paper, also in dark mode.
        expect(await page.locator('iframe[sandbox=""]').evaluate((frame) => getComputedStyle(frame).backgroundColor)).toBe(
          "rgb(255, 255, 255)",
        );
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});

describe("Mail composer preview with extra blank lines", () => {
  const previewWithBlankLines = () => {
    const rendered = renderComposeContent({
      body: "Hello Grace,\n\nthe garden plan is ready.\n\n\nWe meet on Friday.\n\n\n\nSee you soon,\nAda",
      format: "markdown",
      customCss: "",
      renderLiquid: false,
      context: {
        actor: { display_name: "Ada Lovelace", email: "ada@example.test" },
        mailbox: { name: "Example Team", description: "" },
        sender: { display_name: "Example Team", email: "team@example.test", reply_to: "" },
        message: { subject: "Garden", to: ["grace@example.test"], cc: [] },
      },
    });
    if (!rendered.ok || !rendered.data.html) throw new Error("The preview did not render");
    return rendered.data.html;
  };

  for (const [label, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`adds one text line of space for each extra blank line on ${label}`, async () => {
      const page = await load({ context, theme: "light", locale: "en" });
      try {
        await page.waitForSelector('iframe[sandbox=""]');
        await page.evaluate((html) => window.setPreviewHtml(html), previewWithBlankLines());
        const frame = page.frameLocator('iframe[sandbox=""]');
        await frame.getByText("We meet on Friday.").waitFor();
        const paragraphs = await frame.locator("p:not(.mail-blank-line)").evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
        const spacers = await frame
          .locator("p.mail-blank-line")
          .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
        expect(paragraphs).toHaveLength(4);
        expect(spacers).toHaveLength(3);
        const line = paragraphs[0]!.bottom - paragraphs[0]!.top;
        // Each empty line is as tall as one line of text and adds no paragraph margin of its own.
        for (const height of spacers) expect(Math.abs(height - line)).toBeLessThan(0.5);
        const gap = (index: number) => paragraphs[index + 1]!.top - paragraphs[index]!.bottom;
        expect(Math.abs(gap(1) - gap(0) - line)).toBeLessThan(0.5);
        expect(Math.abs(gap(2) - gap(0) - 2 * line)).toBeLessThan(0.5);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});
