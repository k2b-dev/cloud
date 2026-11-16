import { afterAll, beforeAll, setDefaultTimeout, spyOn } from "bun:test";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  installSsrTransform,
  type Page,
  type PageSwapApp,
  type PageSwapEnvironment,
  pageSwapContract,
  startPageSwapApp,
} from "../../../../scripts/fixtures/page-swap-app";

setDefaultTimeout(60_000);
const appRoot = resolve(import.meta.dir, "../..");
// Page modules render island wrappers with the ids the harness builds.
installSsrTransform(appRoot);
const { createToolsPageRoutes } = await import("./index");
const { app: tools } = await import("../config");
// The speed test page reads its server from the app's settings; the harness has no database.
const settings = spyOn(tools.settings, "get").mockImplementation((async (key: string) =>
  key === "tools.speedtest_enabled" ? true : "https://speed.example.test") as typeof tools.settings.get);
const failurePath = "/tools/page-swap-failure";
let app: PageSwapApp;

beforeAll(async () => {
  app = await startPageSwapApp({
    appRoot,
    componentRoots: [resolve(appRoot, "src")],
    stylesheet: resolve(appRoot, "src/styles/app.css"),
    app: {
      id: "tools",
      name: "Tools",
      icon: "ti ti-tools",
      description: "Tools",
      routes: ["/tools", "/public/tools"],
      nav: { href: "/tools", section: "more" },
    },
    routes: new Hono<PageSwapEnvironment>().route("/tools", createToolsPageRoutes()),
    failurePath,
  });
}, 180_000);
afterAll(async () => {
  settings.mockRestore();
  await app?.close();
});

const ready = async (page: Page, path: string) => {
  const url = new URL(path, "http://tools.test");
  if (url.pathname === "/tools") {
    await page.getByRole("searchbox").waitFor();
    // Back must bring the search the URL names, not an empty one.
    await page.waitForFunction(
      (query) => document.querySelector<HTMLInputElement>("[data-nav-root] input[type=search]")?.value === query,
      url.searchParams.get("q") ?? "",
    );
  } else await page.locator(`[data-nav-root] a[aria-current="page"][href="${url.pathname}"]`).first().waitFor({ state: "attached" });
};

pageSwapContract(
  "Tools",
  () => app,
  {
    first: "/tools",
    second: "/tools/hash",
    toSecond: '[data-nav-root] a[href="/tools/hash"]',
    toFirst: '[data-nav-root] a[href="/tools"]',
    ready,
    withState: "/tools?q=hash",
    // The tools that hold listeners, intervals, workers, sockets and object URLs while they show.
    tour: ["/tools", "/tools/speedtest", "/tools/image", "/tools/webhooks", "/tools/image-converter", "/tools/markdown-pdf", "/tools/hash"],
    regions: [".tools-tool-header"],
  },
  failurePath,
);
