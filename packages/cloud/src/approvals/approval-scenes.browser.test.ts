import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { FIXTURE_AT } from "../ai/chat/action-question.fixtures";

// The approval in each of its states and places, painted by a real layout engine at desktop and phone width.
const ui = resolve(import.meta.dir, "../../../ui");
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "approval-scenes.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-approval-scenes-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Approval scenes harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness = "";
let css = "";
let icons: { css: string; font: string };
beforeAll(async () => {
  const [bundle, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  css = await styles.outputs[0]!.text();
  harness = bundle;
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("The Tabler preset references no WOFF2 file.");
  icons = { css: source.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const SCENE_CSS = `
  body { margin: 0; background: var(--k2b-surface); }
  .scene { box-sizing: border-box; width: min(100%, 796px); margin: 0 auto; padding: 24px 16px; }
  .scene-label { margin: 18px 0 0; font: 600 13px/1.4 var(--font-sans, sans-serif); color: var(--k2b-text-secondary); }
  .scene--everywhere { width: min(100%, 1400px); }
  .scene-places { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 24px 28px; align-items: start; }
  .scene-places [data-place="page"] { grid-column: 1 / -1; }
  .scene-places [data-place="panel"] { max-width: 420px; }
  @media (max-width: 720px) { .scene-places { grid-template-columns: 1fr; } }
`;

const open = async (scene: string, width: number, theme: "light" | "dark" = "light"): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [at]);
      },
      get(target, key, receiver) {
        return key === "now" ? () => at : Reflect.get(target, key, receiver);
      },
    });
  }, Date.parse(FIXTURE_AT));
  const origin = "https://cloud.example.test";
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (path === "/tabler.woff2") return route.fulfill({ path: icons.font });
    if (path === "/api/approvals/counts") return route.fulfill({ json: { total: 1, apps: { spaces: 1 } } });
    if (path !== "/") return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark dark" : ""}"><script type="module" src="/harness.js"></script></body></html>`,
    });
  });
  await page.goto(`${origin}/?scene=${scene}`);
  await page.locator(".k2b-chat-decision").first().waitFor();
  await settled(page);
  return page;
};

const shot = async (page: Page, name: string) => {
  const dir = process.env.CAPBLOCKS_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
};

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe("Approval scenes", () => {
  for (const width of [1440, 390])
    test(`every state at ${width} px keeps its tinted ground and head, and says its state`, async () => {
      const page = await open("states", width);
      try {
        expect(await noOverflow(page)).toBe(0);
        const cards = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => ({
            ground: getComputedStyle(node).backgroundColor,
            head: node.querySelector(".k2b-chat-decision__kind")?.textContent,
            status: node.querySelector(".k2b-chat-decision__status")?.textContent ?? null,
          })),
        );
        expect(cards.map((card) => card.status)).toEqual([
          null,
          "Läuft",
          "Erledigt",
          "Abgelehnt",
          "Abgelaufen",
          "Fehlgeschlagen",
          "Unklar",
        ]);
        expect(new Set(cards.map((card) => card.ground)).size).toBe(1);
        expect(new Set(cards.map((card) => card.head))).toEqual(new Set(["Freigabe"]));
        await shot(page, `08-zustaende-alle-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const width of [1440, 390])
    test(`a mail draft at ${width} px turns into its approval in place`, async () => {
      const page = await open("mail", width);
      try {
        const card = page.locator(".k2b-chat-decision").first();
        expect(await card.getAttribute("data-mode")).toBe("edit");
        expect(await card.locator(".k2b-chat-decision__kind").textContent()).toBe("Entwurf");
        await shot(page, `05-mail-entwurf-light-${width}`);
        await card.locator(".k2b-chat-decision__answer").last().click();
        await page.waitForFunction(() => document.querySelector(".k2b-chat-decision")?.getAttribute("data-mode") === "approve");
        await settled(page);
        expect(await card.locator(".k2b-chat-decision__kind").textContent()).toBe("Freigabe");
        expect(await card.locator("textarea").evaluate((field) => (field as HTMLTextAreaElement).readOnly)).toBe(true);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `06-mail-freigabe-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const width of [1440, 390])
    test(`drafts of three apps at ${width} px share one form with labels above the fields`, async () => {
      const page = await open("drafts", width);
      try {
        const labels = await page.locator(".cloud-blocks__field").evaluateAll((fields) =>
          fields.map((field) => {
            const label = field.querySelector("label")?.getBoundingClientRect();
            const input = field.querySelector("input, textarea")?.getBoundingClientRect();
            return label && input ? label.bottom <= input.top + 1 : false;
          }),
        );
        expect(labels.length).toBe(7);
        expect(labels.every(Boolean)).toBe(true);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `21-entwuerfe-light-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);

  for (const [width, theme] of [
    [1440, "light"],
    [390, "light"],
    [1440, "dark"],
  ] as const)
    test(`one approval looks the same in the chat, a flat panel and the approvals page (${width} px, ${theme})`, async () => {
      const page = await open("everywhere", width, theme);
      try {
        const looks = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => {
            const css = getComputedStyle(node);
            const approve = node.querySelector<HTMLElement>('.k2b-chat-decision__answer[data-variant="ai"]');
            return [
              css.backgroundColor,
              css.borderRadius,
              css.paddingTop,
              css.boxShadow,
              approve ? getComputedStyle(approve).backgroundColor : "",
            ].join(" ");
          }),
        );
        expect(looks.length).toBe(3);
        expect(new Set(looks).size).toBe(1);
        expect(await noOverflow(page)).toBe(0);
        await shot(page, `24-freigabe-ueberall-${theme}-${width}`);
      } finally {
        await page.context().close();
      }
    }, 60_000);
});
