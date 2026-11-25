import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { resolve } from "node:path";
import type {} from "@k2b/cloud/ssr/workspace-navigation";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { MAIL_V2_NOW } from "./mail-v2.browser-clock";

// On the phone a v2 workspace puts its sidebar away, so Mail's mailboxes and folders live in the shell's menu
// ("Mail ⌄"), as on v1. The page sends the menu's entries with its first render (the phone bar shows the menu before
// the island loads), the island registers the same entries, and a folder chosen in the real menu opens in place: the
// address and the list follow.
setSystemTime(new Date(MAIL_V2_NOW));
const { startMailV2Server, MAIL_V2_PATH } = await import("./mail-v2.browser-server");

type Entry = { id: string; label: string; href?: string; active?: boolean; children?: Entry[] };

const ui = resolve(import.meta.dir, "../../../ui");
let server: Awaited<ReturnType<typeof startMailV2Server>>;
let browser: Browser;
let menu: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "mail-v2-phone-menu.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "mail-v2-phone-menu",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build the phone menu harness");
  menu = await build.outputs[0]!.text();
  server = await startMailV2Server({ now: () => Date.parse(MAIL_V2_NOW) });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

/** The entries the server sent for the menu: links and names, nested as the menu shows them. */
const sent = (html: string): Entry[] => {
  const script = /<script type="application\/json" data-cloud-workspace-navigation[^>]*>([^<]*)<\/script>/.exec(html);
  if (!script) throw new Error("the page sent no workspace navigation");
  return (JSON.parse(script[1]!) as { items: Entry[] }).items;
};

/** Names, links and the open entry, in order: what a person sees in the menu. */
const shape = (items: readonly Entry[]): unknown[] =>
  items.map((item) => [item.label, item.href ?? null, item.active ?? false, item.children ? shape(item.children) : null]);

const flat = (items: readonly Entry[]): Entry[] => items.flatMap((item) => [item, ...flat(item.children ?? [])]);

test("390 px: the shell's menu lists the mailboxes and folders, and a folder chosen there opens in place", async () => {
  // The first render, as the server sends it: the menu's entries come with the page.
  const html = await (await fetch(`${server.url}${MAIL_V2_PATH}`)).text();
  const first = sent(html);
  const entries = flat(first);
  const sentFolder = entries.find((entry) => entry.href?.includes("folder=Sent1"));
  const filed = entries.find((entry) => entry.href?.includes("folder=Filed1"));
  expect(sentFolder?.label).toBeTruthy();
  expect(filed?.label).toBe("Lieferanten");
  expect(entries.find((entry) => entry.active)?.label).toBe("Kontakt");

  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const errors = pageErrors(page);
    const lists: string[] = [];
    page.on("request", (request) => {
      if (/\/workspace-(route|list)/.test(request.url())) lists.push(new URL(request.url()).searchParams.get("href") ?? "");
    });
    await page.goto(`${server.url}${MAIL_V2_PATH}`);
    await page.waitForFunction(() => document.documentElement.dataset.mailV2Ready === "true", undefined, { timeout: 30_000 });
    // The island registers the same entries the server sent.
    const live = await page.evaluate(() => JSON.stringify(window.__cloudWorkspaceNavigation?.navigation.items() ?? null));
    expect(shape(JSON.parse(live))).toEqual(shape(first));
    expect(await page.evaluate(() => window.__cloudWorkspaceNavigation?.label)).toBe("Kontakt");

    // The phone bar's title opens the real menu.
    await page.addScriptTag({ content: menu });
    await page.locator("[data-mail-v2-phone-menu]").dispatchEvent("click");
    const sheet = page.locator("dialog .k2b-navigation");
    await sheet.waitFor({ state: "visible" });
    await settled(page);
    expect(await sheet.locator('[aria-current="page"]').textContent()).toContain("Kontakt");
    // a page that loads anew forgets this mark; one that opens in place keeps it
    await page.evaluate(() => document.documentElement.setAttribute("data-same-page", ""));
    await sheet.getByRole("link", { name: "Lieferanten" }).tap();
    // the menu closes as a chosen entry opens
    await page.locator("dialog[open]").waitFor({ state: "detached" });

    // The address and the list follow, in place, and the folder is the open one.
    await page.waitForURL((url) => url.searchParams.get("folder") === "Filed1");
    await page.waitForFunction(() =>
      window.__cloudWorkspaceNavigation?.navigation
        .items()
        .flatMap(function all(item): { label: string; active?: boolean }[] {
          return [item, ...(item.children ?? []).flatMap(all)];
        })
        .some((item) => item.label === "Lieferanten" && item.active),
    );
    expect(lists.some((href) => href.includes("folder=Filed1"))).toBe(true);
    expect(await page.locator('[data-k2-part="Nav.Item"][aria-current="page"]').textContent()).toContain("Lieferanten");
    await page.locator('[data-k2-part="List"] > [data-k2-part="Row"]').first().waitFor();
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-same-page"))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 90_000);
