import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";
import type { WorkflowAiHarnessOptions } from "./MailAdminWorkflowAi.browser-harness";

// Admin › Mail: the body limit of AI workflow steps, its save, a refused save and an unreadable stored value.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailAdminWorkflowAi.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-workflow-ai-admin-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Workflow AI admin harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const writes: unknown[] = [];
let refuseNext = false;
const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    if (url.pathname === "/api/mail/admin/workflow-ai" && request.method === "PUT") {
      const body = (await request.json()) as { bodyMaxChars: number };
      writes.push(body);
      if (refuseNext) {
        refuseNext = false;
        return Response.json({ message: "Workflow AI body limit (characters) must be at most 100000" }, { status: 400 });
      }
      return Response.json({ bodyMaxChars: body.bodyMaxChars });
    }
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
let page: Page;
let errors: string[];
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
beforeEach(() => {
  writes.length = 0;
  refuseNext = false;
});
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const open = async (context: BrowserContextOptions, options: Partial<WorkflowAiHarnessOptions> = {}) => {
  page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(8000);
  errors = pageErrors(page);
  await page.goto(server.url.href);
  await page.evaluate((mount) => window.mountWorkflowAi(mount), {
    locale: "en" as const,
    bodyMaxChars: 20_000,
    unreadable: false,
    ...options,
  });
  const field = page.getByRole("spinbutton", { name: /^Workflow AI body limit/ });
  await field.waitFor();
  return field;
};
const save = () => page.getByRole("button", { name: "Save", exact: true });

test("the limit saves from the Mail admin page, and a refused value keeps its reason at the field", async () => {
  const shots = process.env.ADMIN_SETTINGS_SHOTS;
  for (const [name, context] of [
    ["1440", desktop],
    ["390", phone],
  ] as const) {
    const field = await open(context);
    expect(await field.inputValue()).toBe("20000");
    expect(await page.getByText("Changes apply to new work").isVisible()).toBe(true);
    expect(await save().isDisabled()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/mail-workflow-ai-${name}.png`, animations: "disabled" });
    await page.context().close();
  }

  const field = await open(desktop);
  refuseNext = true;
  await field.fill("60000");
  await save().click();
  await page.getByText("must be at most 100000").waitFor();
  expect(await field.getAttribute("aria-invalid")).toBe("true");
  expect(await field.inputValue()).toBe("60000");
  if (shots) await page.screenshot({ path: `${shots}/mail-workflow-ai-refused-1440.png`, animations: "disabled" });

  await field.fill("50000");
  expect(await field.getAttribute("aria-invalid")).toBeNull();
  await save().click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Save" && button.disabled),
  );
  expect(writes).toEqual([{ bodyMaxChars: 60_000 }, { bodyMaxChars: 50_000 }]);
  expect(errors).toEqual([]);
  await page.context().close();
}, 60_000);

test("an unreadable stored limit says what applies and is replaced only after confirming", async () => {
  const field = await open(desktop, { unreadable: true });
  expect(await page.getByText("The stored limit cannot be read.").isVisible()).toBe(true);
  expect(await field.isDisabled()).toBe(true);
  expect(await save().isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value" }).check();
  // The displayed fallback can be saved as it is once the replacement is confirmed.
  await save().click();
  await page.getByText("The stored limit cannot be read.").waitFor({ state: "hidden" });
  expect(writes).toEqual([{ bodyMaxChars: 20_000, replaceUnreadable: true }]);
  expect(errors).toEqual([]);
  await page.context().close();
}, 60_000);
