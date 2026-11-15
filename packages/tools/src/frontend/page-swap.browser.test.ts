import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  installSsrTransform,
  type Page,
  type PageSwapApp,
  type PageSwapEnvironment,
  pageSwapContract,
  startPageSwapApp,
} from "../../../cloud/test/page-swap-app";

setDefaultTimeout(60_000);
const appRoot = resolve(import.meta.dir, "../..");
// Page modules render island wrappers with the ids the harness builds.
installSsrTransform(appRoot);
const { createToolsPageRoutes } = await import("./index");
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
  await app?.close();
});

const ready = async (page: Page, path: string) => {
  if (path === "/tools") await page.getByRole("searchbox").waitFor();
  else await page.locator("[data-nav-root] .tools-tool-header h1", { hasText: "Checksum" }).waitFor();
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
  },
  failurePath,
);
