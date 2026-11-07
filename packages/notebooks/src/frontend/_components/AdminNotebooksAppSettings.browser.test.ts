import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateNetworkAllowlist } from "@k2b/cloud/services/settings/validation";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

// The settings dialog needs real layout for its phone and desktop states, so it runs in a browser with the shipped
// stylesheets against a served settings API.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./AdminNotebooksAppSettings.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-notebooks-admin-settings-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Notebooks admin settings harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const entry = (key: string, kind: string, label: string, description: string, value: unknown) => ({
  key,
  label,
  kind,
  description,
  default: value,
  value,
  isCustom: false,
  unreadable: false,
});
/** Invented settings in the shape of `GET /api/notebooks/admin/settings`. */
const settings = [
  entry(
    "notebooks.snapshot_allowed_targets",
    "string_list",
    "Snapshot allowed targets",
    "Exact internal S3 hosts, IPs or CIDRs. Changes apply to new snapshot requests.",
    ["minio.internal", "10.20.0.0/16"],
  ),
  entry(
    "notebooks.reindex_cron",
    "cron",
    "Reindex Cron",
    "Five-field cron schedule for the periodic note-refs reindex job.",
    "0 */12 * * *",
  ),
  entry("notebooks.max_attachment_size_mb", "number", "Max attachment size", "Maximum upload size in MB.", 50),
];

const harness = await buildHarness();
const css = await buildCss(resolve(import.meta.dir, "../../../../../styles.css"));
const writes: { key: string; body: unknown }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/api/notebooks/admin/settings") return Response.json(settings);
    const key = /^\/api\/notebooks\/admin\/settings\/(.+)$/u.exec(url.pathname)?.[1];
    if (key && request.method === "PUT") {
      const body = (await request.json()) as { value: unknown };
      writes.push({ key, body });
      // The same check the setting declaration runs on the server.
      const refused = key === "notebooks.snapshot_allowed_targets" ? validateNetworkAllowlist(body.value) : undefined;
      return refused ? Response.json({ message: refused, code: "bad_input" }, { status: 400 }) : Response.json({ message: "Updated" });
    }
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="root" style="padding:16px"></div>' +
        '<script src="/harness.js"></script></body></html>',
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
});
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const open = async (context: BrowserContextOptions) => {
  page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(8000);
  errors = pageErrors(page);
  await page.goto(server.url.href);
  await page.evaluate(() => window.mountSettings("en"));
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /^Snapshot allowed targets/ }).waitFor();
  return dialog;
};

test("snapshot targets are edited as a list, and a target the server refuses keeps its reason at the field", async () => {
  const shots = process.env.ADMIN_SETTINGS_SHOTS;
  for (const [name, context] of [
    ["1440", desktop],
    ["390", phone],
  ] as const) {
    const dialog = await open(context);
    expect(await dialog.getByText("Changes apply to new snapshot requests.").isVisible()).toBe(true);
    expect(await dialog.getByRole("textbox", { name: /^Snapshot allowed targets/ }).inputValue()).toBe("minio.internal, 10.20.0.0/16");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/notebooks-settings-${name}.png`, animations: "disabled" });
    await page.context().close();
  }

  const dialog = await open(desktop);
  const targets = dialog.getByRole("textbox", { name: /^Snapshot allowed targets/ });
  await targets.fill("minio.internal, 10.20.0.0/16, ::/0");
  await targets.blur();
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.getByText(/\/0 is forbidden/).waitFor();
  expect(writes).toEqual([{ key: "notebooks.snapshot_allowed_targets", body: { value: ["minio.internal", "10.20.0.0/16", "::/0"] } }]);
  expect(await targets.getAttribute("aria-invalid")).toBe("true");
  expect(await dialog.getByText("Check the marked field.").isVisible()).toBe(true);
  // The dialog rereads the stored values after a refused save before it takes the next one.
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLButtonElement>("dialog button")].some(
      (button) => button.textContent?.trim() === "Save" && !button.disabled,
    ),
  );
  if (shots) await page.screenshot({ path: `${shots}/notebooks-settings-refused-1440.png`, animations: "disabled" });

  await targets.fill("minio.internal, 10.20.0.0/16");
  await targets.blur();
  expect(await dialog.getByText(/\/0 is forbidden/).count()).toBe(0);
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "hidden" });
  expect(writes.at(-1)).toEqual({ key: "notebooks.snapshot_allowed_targets", body: { value: ["minio.internal", "10.20.0.0/16"] } });
  // A save refreshes the page through SSR navigation, which this bare harness page does not opt into.
  expect(errors.filter((error) => !error.includes("ViewTransition opt-in disabled"))).toEqual([]);
  await page.context().close();
}, 60_000);
