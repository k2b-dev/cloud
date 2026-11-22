import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cloud from "@k2b/cloud";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import * as services from "@k2b/cloud/services";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { buildIslands } from "../../../../ssr/src/build";
import { layoutProblems } from "../../../../ui/src/layout-check";
import { launchBrowser } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// The first page every person sees: sign-in, a failed sign-in, and the password recovery. The pages run with their
// real islands, so a failed sign-in shows the error the form itself renders for the server's answer, and the layout
// check reads what a person sees once the islands have rendered.
const rootDir = resolve(import.meta.dir, "../../..");
// The same root as buildIslands below; discovery is explicit there, so importing a page starts no second build.
registerSsrTestPlugin({ dev: true, rootDir, componentRoots: [] });

const { default: signIn } = await import("./page");
const { default: passwordReset } = await import("./password-reset/page");
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");

// The page tests of every app use these widths: a phone, a tablet, a laptop with an open detail column, a desktop.
const layoutWidths = [390, 768, 1100, 1440] as const;
// Classic, visible scrollbars, as on most desktops: only then does a scrollbar take its width, so a column a few
// pixels too wide shows up as a sideways scroller.
const classicScrollbars = { ignoreDefaultArgs: ["--hide-scrollbars"] };

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) => (key === "freeipa.enable" ? true : key === "app.contact_email" ? "help@cloud.example.test" : undefined) as never,
    ),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    // All three legal pages, as Core lists them, the longest footer a phone shows.
    spyOn(cloud, "listLegalLinks").mockImplementation(async (locale) =>
      (locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"]).map((label, index) => ({
        label,
        href: ["/impressum", "/legal/privacy", "/legal/terms"][index]!,
      })),
    ),
    spyOn(services.appApproval, "config").mockResolvedValue({
      issuer: "https://cloud.example.test",
      appOrigin: "https://auth.example.test",
      enabled: true,
      adminPairing: false,
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const pages = new Hono().get("/auth/login", ...signIn).get("/auth/password-reset", ...passwordReset);

let browser: Browser;
let served: ReturnType<typeof Bun.serve>;
let output: string;
let origin: string;
beforeAll(async () => {
  output = mkdtempSync(join(tmpdir(), "core-sign-in-layout-"));
  await buildIslands({
    pattern: "**/*.{island,client}.tsx",
    cwd: rootDir,
    componentRoots: [import.meta.dir],
    outdir: join(output, "islands"),
    dev: false,
    verbose: false,
  });
  // As the page template does: the layer order first, then Core's stylesheet, then the global one.
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  // Text and icon widths decide where rows wrap, so the pages get their real fonts.
  const publicDir = join(output, "public");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.css") return new Response(css, { headers: { "content-type": "text/css" } });
      // The shipped loader asks for <prefix>/<entry>.js; every prefix serves this one build.
      if (url.pathname.startsWith("/_ssr/")) {
        const file = Bun.file(join(output, "islands", url.pathname.split("/").at(-1)!));
        return (await file.exists())
          ? new Response(file, { headers: { "content-type": "text/javascript" } })
          : new Response("missing", { status: 404 });
      }
      if (url.pathname === "/public/fonts.css" || url.pathname === "/public/tabler-icons.css" || url.pathname.startsWith("/public/fonts/"))
        return new Response(Bun.file(join(output, url.pathname)));
      if (url.pathname === "/branding/logo") return new Response(Bun.file(resolve(import.meta.dir, "../../../../cloud/public/logo.svg")));
      // The answer FreeIPA gives for a wrong password (auth-flows/ipa.ts).
      if (url.pathname === "/api/auth/login" && request.method === "POST")
        return Response.json({ message: "Invalid username or password" }, { status: 401 });
      if (url.pathname === "/auth/login" || url.pathname === "/auth/password-reset") {
        const response = await pages.fetch(request);
        // Keep the shipped island loader; drop the other module scripts and link the compiled styles once.
        const html = (await response.text())
          .replace(/<script type="module"(?![^>]*data-ssr-assets)[^>]*>[\s\S]*?<\/script>/g, "")
          .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, "")
          .replace(
            "</head>",
            '<link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><link rel="stylesheet" href="/fixture.css"></head>',
          );
        return new Response(html, { status: response.status, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${served.port}`;
  browser = await launchBrowser(classicScrollbars);
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await served?.stop(true);
    if (output) rmSync(output, { recursive: true, force: true });
  }
});

/** A tab with the page after its islands rendered, in its own context; the caller closes that context. */
const open = async (width: number, path: string, locale: "en" | "de"): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, reducedMotion: "reduce" });
  await context.addCookies([{ name: "cloud.locale", value: locale, url: origin }]);
  const tab = await context.newPage();
  await tab.goto(`${origin}${path}`);
  // The form is an island: its submit button reacts once the browser rendered it again over the server markup.
  // @k2b/ssr keeps its mounted wrappers in a shared registry (mount.ts); every island of the page is in it.
  await tab.waitForFunction(() => {
    const islands = (globalThis as { [key: symbol]: { mounted: WeakMap<Element, unknown> } | undefined })[Symbol.for("@k2b/ssr/islands")];
    const wrappers = [...document.querySelectorAll("solid-island,solid-client")];
    return islands !== undefined && wrappers.length > 0 && wrappers.every((element) => islands.mounted.has(element));
  });
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

const problems = async (tab: Page) => (await tab.evaluate(layoutProblems, { root: "body" })).problems;

describe("sign-in pages in a browser", () => {
  test("sign-in lays out without overlap, cut text or sideways scroll at every width", async () => {
    const found: Record<string, string[]> = {};
    for (const locale of ["en", "de"] as const) {
      for (const width of layoutWidths) {
        const tab = await open(width, "/auth/login?method=ipa", locale);
        try {
          const list = await problems(tab);
          if (list.length > 0) found[`${locale} ${width}`] = list;
        } finally {
          await tab.context().close();
        }
      }
    }
    expect(found).toEqual({});
  }, 120_000);

  test("a failed sign-in shows its error in the form and still lays out at every width", async () => {
    const found: Record<string, string[]> = {};
    for (const locale of ["en", "de"] as const) {
      for (const width of layoutWidths) {
        const tab = await open(width, "/auth/login?method=ipa", locale);
        try {
          await tab.getByRole("textbox").first().fill("jbeispiel");
          await tab.locator("input[type=password]").fill("wrong password");
          await tab.locator("main button[type=submit]").click();
          await tab.getByText("Invalid username or password").waitFor();
          const list = await problems(tab);
          if (list.length > 0) found[`${locale} ${width}`] = list;
        } finally {
          await tab.context().close();
        }
      }
    }
    expect(found).toEqual({});
  }, 120_000);

  test("password recovery lays out without overlap, cut text or sideways scroll at every width", async () => {
    const found: Record<string, string[]> = {};
    for (const locale of ["en", "de"] as const) {
      for (const width of layoutWidths) {
        const tab = await open(width, "/auth/password-reset", locale);
        try {
          const list = await problems(tab);
          if (list.length > 0) found[`${locale} ${width}`] = list;
        } finally {
          await tab.context().close();
        }
      }
    }
    expect(found).toEqual({});
  }, 120_000);
});
