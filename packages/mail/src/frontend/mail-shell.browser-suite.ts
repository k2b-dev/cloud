import { afterAll, beforeAll, test as bunTest, describe, expect, setDefaultTimeout, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { createConfig } from "@k2b/ssr";

import type { Browser, Locator, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, pageErrors as collectPageErrors, launchBrowser, settled, storedCookie } from "../../../ui/test/browser";
import type { MailSearchExpression } from "../contracts";
import { resolveMailSearchRoute, simpleMailSearchExpression } from "../search-state";
import { mailTagSearch } from "../search-url";
import { readMailHeadFilters } from "./_components/mail-head-filters";

setDefaultTimeout(20_000);
/**
 * Each case logs its start and its time. Bun lists passing cases only on a terminal, and a file timeout discards the
 * rest, so these lines name the case that ran and the slowest cases (#1966).
 */
const test = (name: string, run: () => Promise<void> | void, timeout?: number) =>
  bunTest(
    name,
    async () => {
      const started = performance.now();
      console.info(`[mail-shell] start ${name}`);
      try {
        await run();
      } finally {
        console.info(`[mail-shell] end ${((performance.now() - started) / 1000).toFixed(1)} s ${name}`);
      }
    },
    timeout,
  );

const cache = resolve(import.meta.dir, "../../node_modules/.cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "mail-shell-browser-"));
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const {
  default: Fixture,
  MAIL_SHELL_NOW,
  viewCounts,
  mailboxData,
  mailboxList,
  olderFixtureEvents,
  sidebar: sidebarData,
} = await import("./mail-shell.browser-fixture");
const { chooseLandingMailbox, readMailLandingLink } = await import("./mail-landing");
const { readMailWorkspacePreferences } = await import("./_components/mail-workspace-preferences");
/** The fixture server keeps the person's click on "Got it" in this cookie, as Mail keeps it for the person. */
const NOTICE_COOKIE = "mail_fixture_focus_notice";
const ui = resolve(import.meta.dir, "../../../ui/dist");
// Like Cloud's page head (`FONT_PRELOAD_LINKS`): the Latin Plex faces of the first frame load next to the stylesheets,
// so the server frame shows Plex, not the fallback font. WebKit keeps text in `content-visibility: auto` rows, such as
// the list rows, shaped with the fallback font after a late face arrives, until something restyles them.
const fontPreloads = ["400", "500", "600"]
  .map((weight) => {
    const file = new RegExp(`url\\(\\./fonts/(ibm-plex-sans-latin-${weight}-normal-[0-9a-f]+\\.woff2)\\)`).exec(
      readFileSync(join(ui, "plex.css"), "utf8"),
    )?.[1];
    if (!file) throw new Error(`The @k2b/ui Plex preset has no Latin IBM Plex Sans ${weight} face`);
    return `<link rel="preload" href="/ui/fonts/${file}" as="font" type="font/woff2" crossorigin>`;
  })
  .join("");
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
const boxPath = "/app/mail/Box001";
const tabsSelector = ".k2b-app-workspace__head-views";
const sidebarSelector = ".mail-sidebar .k2b-app-workspace__sidebar-desktop";
const measurements = [
  ".mail-sidebar",
  ".k2b-app-workspace__head",
  tabsSelector,
  ".k2b-app-workspace__head-filters",
  ".k2b-app-workspace__head-actions",
  ".k2b-app-workspace__head-actions button",
  "[data-workspace-primary]",
  ".k2b-app-workspace__main",
  ".k2b-view-tabs__item",
  ".k2b-filter-chip",
  ".mail-sidebar-mailbox",
  ".mail-list-entry",
  ".mail-row-draft-tag",
  "[data-mail-queue-count]",
  ".k2b-app-workspace__main-pane",
  ".k2b-app-workspace__main-primary",
  ".mail-reader-toolbar",
  "[data-mail-details-trigger]",
  "[data-app-workspace-detail-toggle]",
  ".mail-reading-column",
  ".k2b-app-workspace__detail",
].join(",");
// Rows below the fold render lazily (content-visibility); only what the person sees must hold still.
const geometrySource = `() => Array.from(document.querySelectorAll(${JSON.stringify(measurements)})).map((e,i)=>{const r=e.getBoundingClientRect();const part=String(e.className).split(" ").filter(Boolean).join(" ");return r.bottom<=0||r.top>=innerHeight?{part,index:i,x:0,y:-1,width:0,height:0}:{part,index:i,x:r.x,y:r.y,width:r.width,height:r.height}})`;
type Frame = { part: string; index: number; x: number; y: number; width: number; height: number }[];
// The head's view strip as a person sees it: every rendered label at its full width, the current tab inside the strip.
const stripSource = `() => {const list=document.querySelector(${JSON.stringify(`${tabsSelector} .k2b-view-tabs__list`)});if(!list)return null;const b=list.getBoundingClientRect();const fade=list.getAttribute("data-scroll-fade");const current=list.querySelector('.k2b-view-tabs__tab[aria-current="page"]');const c=current&&current.getClientRects().length>0?current.getBoundingClientRect():null;return {overflow:list.scrollWidth-list.clientWidth,current:current?.getAttribute("href")??null,left:c?c.left-b.left:null,right:c?b.right-c.right:null,leftInset:fade==="top"||fade==="both"?parseFloat(getComputedStyle(list).scrollPaddingLeft)||0:0,rightInset:fade==="bottom"||fade==="both"?parseFloat(getComputedStyle(list).scrollPaddingRight)||0:0,labels:Array.from(list.querySelectorAll(".k2b-view-tabs__tab .k2b-view-tabs__label")).filter(l=>l.getClientRects().length>0).map(l=>({text:l.textContent,scroll:l.scrollWidth,width:l.clientWidth}))}}`;
type Strip = {
  overflow: number;
  current: string | null;
  left: number | null;
  right: number | null;
  leftInset: number;
  rightInset: number;
  labels: { text: string | null; scroll: number; width: number }[];
};
let css = "";
let controller = "";
let navigation = "";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const pageErrors = new WeakMap<Page, string[]>();
const assetFailures = new WeakMap<Page, string[]>();
/**
 * `?shell=1` lays the page out like Cloud's signed-in shell from 1024 px: a 56 px rail, the card spacing, and the
 * window as the app host. `&panel=416` adds Cloud's panel column, which makes the app area beside it the host.
 * Without `shell`, the window is the app area and the workspace, as before.
 */
const shell = (url: URL, html: string) => {
  if (url.searchParams.get("shell") !== "1")
    return `<main style="container-type:inline-size;container-name:k2b-app-area;display:flex;flex-direction:column;height:100dvh">${html}</main>`;
  const panel = Number(url.searchParams.get("panel")) || 0;
  // A sidebar width the person stored, as Cloud's layout cookie restores it on the workspace.
  const sidebar = Number(url.searchParams.get("sidebar")) || 0;
  const stored = sidebar ? `<style>.k2b-app-workspace{--k2b-workspace-sidebar-width:${sidebar}px}</style>` : "";
  const inset = "round(clamp(0.25rem, calc(0.25rem + (100vw - 64rem) / 104), 0.5rem), 1px)";
  return `${stored}<div style="display:flex;box-sizing:border-box;height:100dvh;padding:${inset} ${inset} ${inset} 0"><div style="flex:none;width:3.5rem"></div><div data-fixture-app-area style="display:flex;flex:1;min-width:0;flex-direction:column;${panel ? "container:k2b-app-area / inline-size" : ""}"><main style="display:flex;flex:1;min-height:0;flex-direction:column">${html}</main></div>${panel ? `<aside data-fixture-panel style="flex:none;width:${panel}px;margin-inline-start:${inset}"></aside>` : ""}</div>`;
};
const pageHtml = (url: URL, cookieHeader: string | null = null) => {
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const locale = url.searchParams.get("locale") === "de" ? "de" : "en";
  const html = renderToString(() =>
    createComponent(Fixture, {
      source: `${url.pathname}${url.search}`,
      locale,
      theme,
      // This opt-in exercises the same request-cookie reader as Mail's SSR page
      // without putting an artificial preference into its navigation URL.
      workspaceCookieHeader: url.searchParams.has("persist-details") ? cookieHeader : undefined,
      focusNoticeOpen: url.searchParams.get("notice") === "1" && !cookieHeader?.includes(`${NOTICE_COOKIE}=closed`),
    }),
  );
  // As in Cloud, the page owns the one workspace controller (its body marker), so workspaces do not install their own.
  return `<!doctype html><html lang="${locale}" class="${theme}" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fontPreloads}<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><link rel="stylesheet" href="/mail-shell.css"><style>solid-client,solid-island{display:contents}</style><style>/* Like the Cloud shell on phones: the primary action is the round button beside the bottom bar, out of the head row. */@media not all and (min-width:48rem){.k2b-app-workspace__head-primary{position:fixed;z-index:11;right:12px;bottom:12px}}</style></head><body class="k2b-ui app-accent-scope" data-theme="${theme}" data-k2b-app-workspace-controller="global" style="margin:0;${appAccentStyle("#0f766e")}">${shell(url, html)}<script src="/mail-shell-controller.js"></script>${url.searchParams.has("navigation") ? '<button id="mailbox-navigation-test" style="position:fixed;bottom:12px;left:12px;z-index:12">Open mailbox navigation</button><script src="/mail-shell-navigation.js"></script>' : ""}<script type="module">
    const geometry=${geometrySource};
    const strip=${stripSource};
    const step=(name)=>{document.documentElement.dataset.mailShellStep=name;performance.mark('mail-shell:'+name)};
    step('fonts');
    await document.fonts.ready;
    step('first frame');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    step('server geometry');
    document.documentElement.dataset.serverGeometry=JSON.stringify(geometry());
    document.documentElement.dataset.serverStrip=JSON.stringify(strip());
    document.documentElement.dataset.serverCurrent=document.querySelector('${tabsSelector} [aria-current="page"]')?.getAttribute('href')??'';
    step('islands');
    await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));
    step('hydrated frame');
    // The first frame the browser paints after hydration, as a person sees it.
    await new Promise(resolve=>requestAnimationFrame(resolve));
    step('hydrated geometry');
    document.documentElement.dataset.hydratedGeometry=JSON.stringify(geometry());
    step('hydrated strip');
    document.documentElement.dataset.hydratedStrip=JSON.stringify(strip());
    step('ready');
    document.documentElement.dataset.mailShellReady='true';
    </script></body></html>`;
};

beforeAll(async () => {
  setSystemTime(new Date(MAIL_SHELL_NOW));
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Mail shell CSS failed");
  css = (await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))).join("\n");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const bundle = async (name: string, source: string) => {
    const entry = join(root, `${name}.ts`);
    const built = await Bun.build({
      entrypoints: [entry],
      files: { [entry]: source },
      target: "browser",
      format: "iife",
      conditions: ["browser"],
      plugins: [
        {
          name: "mail-shell-mobile-navigation",
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
    if (!built.success) throw new AggregateError(built.logs, `Mail shell ${name} failed`);
    return built.outputs[0]!.text();
  };
  // The synthetic shell uses Cloud's real phone sheet and its history handling, outside the Mail island bundle.
  // The sheet is 1.6 MB of script, so only pages with its test button (`?navigation`) load it (#1966).
  [controller, navigation] = await Promise.all([
    bundle(
      "controller",
      `import {installAppWorkspaceController} from ${JSON.stringify(join(ui, "browser/index.js"))};import {installPageSwap} from "@k2b/ssr/nav";if(new URL(location.href).searchParams.has("history"))sessionStorage.setItem("mail-shell-history","1");if(sessionStorage.getItem("mail-shell-history")==="1")installPageSwap();installAppWorkspaceController();`,
    ),
    bundle(
      "navigation",
      `import {openCloudMobileMenu} from "@k2b/cloud/ssr/MobileNavigation";document.getElementById("mailbox-navigation-test")?.addEventListener("click",()=>void openCloudMobileMenu({apps:[],legalLinks:[]}));`,
    ),
  ]);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, host) {
      const url = new URL(request.url);
      if (url.pathname === "/api/mail/live" && host.upgrade(request, { data: undefined })) return;
      // Assets do not change during a run, so a page's reloads and history steps take them from its cache (#1966).
      const cached = { "cache-control": "public, max-age=3600, immutable" };
      const asset = new Map<string, [type: string, body: string]>([
        ["/mail-shell.css", ["text/css", css]],
        ["/mail-shell-controller.js", ["text/javascript", controller]],
        ["/mail-shell-navigation.js", ["text/javascript", navigation]],
      ]).get(url.pathname);
      if (asset) return new Response(asset[1], { headers: { "content-type": asset[0], ...cached } });
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)), { headers: cached });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))), { headers: cached });
      if (url.pathname.endsWith("/workspace-route") || url.pathname.endsWith("/workspace-list")) {
        const target = new URL(url.searchParams.get("href") ?? boxPath, server.url);
        return Response.json(url.pathname.endsWith("/workspace-list") ? mailboxList(target) : mailboxData(target));
      }
      // Mail's landing as its page decides it: an old Focus link first, then the mailbox to open.
      if (url.pathname === "/app/mail") {
        const link = readMailLandingLink((name) => url.searchParams.get(name) ?? undefined);
        if ("href" in link) return Response.redirect(new URL(link.href, server.url).href, 302);
        const mailboxId = chooseLandingMailbox({
          mailboxIds: sidebarData.mailboxes.map((mailbox) => mailbox.id),
          pinnedMailboxIds: sidebarData.pinnedMailboxIds,
          hiddenMailboxIds: sidebarData.hiddenMailboxIds,
          lastMailboxId: readMailWorkspacePreferences(request.headers.get("cookie")).lastMailboxId,
        });
        return Response.redirect(new URL(`/app/mail/${mailboxId}${link.view ? `?view=${link.view}` : ""}`, server.url).href, 302);
      }
      if (url.pathname === "/api/mail/mailboxes/preferences/focus-notice" && request.method === "PUT") {
        return Response.json({ dismissed: true }, { headers: { "set-cookie": `${NOTICE_COOKIE}=closed; Path=/` } });
      }
      if (url.pathname.endsWith("/actions") && request.method === "POST") return Response.json({ commands: [] });
      if (url.pathname.endsWith("/preference") && request.method === "PATCH") return Response.json(await request.json());
      // The Events tab's older page; a conversation's own activity stays empty.
      if (url.pathname.endsWith("/activity"))
        return Response.json(
          url.searchParams.has("cursor") ? { items: olderFixtureEvents, nextCursor: null } : { items: [], nextCursor: null },
        );
      // Every invented photo of `photos=N` is the same small gradient; it answers late, so rows load visibly.
      if (/\/messages\/Msg001\/attachments\/Att\d+$/.test(url.pathname) && url.searchParams.get("inline") === "true") {
        await Bun.sleep(300);
        return new Response(Buffer.from(photoPng, "base64"), { headers: { "content-type": "image/png" } });
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "Outside synthetic fixture" }, { status: 404 });
      return new Response(pageHtml(url, request.headers.get("cookie")), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message));
        if (frame.t === "sub") socket.send(JSON.stringify({ t: "ready", id: frame.id, cursor: "s6t.mail.4" }));
      },
    },
  });
  browser = await launchBrowser();
  // A cold engine needs about eight seconds for its first styled, hydrated page; pay it here, not in the first case.
  await close(await open(boxPath));
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    setSystemTime();
    rmSync(root, { recursive: true, force: true });
  }
});
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: distance from the pinned fixture instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the fixture instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset;
    } // real clock: keeps native timers and performance
  }
  globalThis.Date = PinnedDate as DateConstructor;
};
const ready = async (page: Page) => {
  try {
    // The page sets this only after its required SSR/hydrated frames and measurements.
    // Cold WebKit takes about eight seconds to prepare its first styled/hydrated page.
    // Bootstrap shares the existing 20s functional-test budget; actions still have their 6s deadline.
    await page.locator('html[data-mail-shell-ready="true"]').waitFor({ state: "attached", timeout: 20_000 });
  } catch (error) {
    const evidence = await page
      .evaluate(() => ({
        step: document.documentElement.dataset.mailShellStep ?? "page script not started",
        ready: document.documentElement.dataset.mailShellReady,
        visibility: document.visibilityState,
        now: performance.now(),
        phases: performance
          .getEntriesByType("mark")
          .filter((entry) => entry.name.startsWith("mail-shell:"))
          .map((entry) => ({ name: entry.name, at: entry.startTime })),
      }))
      .catch(() => "unreadable");
    throw new Error(
      `Mail shell page never got ready: ${JSON.stringify({ evidence, errors: pageErrors.get(page), assets: assetFailures.get(page) })}`,
      { cause: error },
    );
  }
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll(".k2b-app-workspace__main")).some((main) => main.getAttribute("aria-busy") === "true"),
  );
  await settled(page);
};
/** An invented 48 × 36 gradient that stands in for every attachment photo. */
const photoPng =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAIAAABAJy5dAAABhklEQVR42s3OaSsDAAAG4Pe7M4ZcYeTKzdAcYeTKfTemGXKllGxj7GTMGLMZY5JSSkopKSWllJRSUkpJKSWllO/+xvv8ggd/e16/Hu8fj8/3ru/Xrt/njv/HTsC7O/DNLXjdDnrZDn7eCnnaCn10hT24wu83I+42I2+dUTfO6GtHzJVDeOmIvdiIO9+IP7MnnNoTT9aTjteTj9ZSDtdSD2xp+7Z0z2qGezXTtZLtXMmxW0U2a651Oc+ynG+2iE2WAoOlULtUpFkqVi+WKBdLJ81loNpMmCWg2owvlINqM7ZQAarN8HwlqDaD81Wg2ihM1aDayE01oNrIjLWg2kiNdaDadBrqQbVpNzSAatOibwTVplHfBKpNna4ZVJtaXSuoNlW6NlBtKrTtoNpItB2g2pTMdYJqUzTXBaqNeFYKqk3+bDeoNiJND6g2WRoZqDbpM72g2qTOyEG1SZ7uA9UmYVoBqk2cuh9UG6F6AFSbKNUgqDYRqiFQbUKVw6DahChHQLURTI3+A8OZrdHqu5LXAAAAAElFTkSuQmCC";
const sizes = [
  [1920, 1080],
  [1440, 900],
  [1194, 834],
  [834, 1194],
  [390, 844],
] as const;
const open = async (
  path: string,
  width = 1440,
  height: number = sizes.find(([w]) => w === width)?.[1] ?? 900,
  motion: "reduce" | "no-preference" = "reduce",
  /** Runs before the first navigation, for example to delay some responses. */
  prepare?: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: width === 390,
    hasTouch: width === 390,
    timezoneId: "UTC",
    reducedMotion: motion,
  });
  await context.addInitScript(pinPageClock, Date.parse(MAIL_SHELL_NOW));
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  pageErrors.set(page, collectPageErrors(page));
  const assets: string[] = [];
  assetFailures.set(page, assets);
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "script") assets.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "script" && response.status() >= 400)
      assets.push(`${response.url()}: HTTP ${response.status()}`);
  });
  try {
    await prepare?.(page);
    await page.goto(new URL(path, server.url).href);
    await ready(page);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const close = async (page: Page) => {
  try {
    expect(pageErrors.get(page), "No page errors, including live connections").toEqual([]);
    expect(await page.locator(".k2b-moved-hint").count(), "Mail never renders a MovedHint").toBe(0);
  } finally {
    await page.context().close();
  }
};
const tabs = (page: Page) => page.locator(tabsSelector);
const sidebar = (page: Page) => page.locator(sidebarSelector);
const currentHref = (page: Page) => tabs(page).locator('a[aria-current="page"]').getAttribute("href");
const geometry = (page: Page): Promise<Frame> =>
  page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector)).map((e, index) => {
        const r = e.getBoundingClientRect();
        const part = String(e.className).split(" ").filter(Boolean).join(" ");
        // Rows below the fold render lazily (content-visibility); only what the person sees must hold still.
        if (r.bottom <= 0 || r.top >= innerHeight) return { part, index, x: 0, y: -1, width: 0, height: 0 };
        return { part, index, x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    measurements,
  );
const assertFrame = (before: Frame, after: Frame, label: string) => {
  expect(after.length, `${label}: measured part count`).toBe(before.length);
  for (const [index, actual] of after.entries()) {
    const original = before[index]!;
    expect(actual.part, label).toBe(original.part);
    for (const dimension of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(actual[dimension] - original[dimension]),
        `${label}: ${actual.part}[${index}].${dimension}: ${original[dimension]} → ${actual[dimension]}`,
      ).toBeLessThanOrEqual(0.5);
  }
};
const recordedFrame = async (page: Page, name: "server" | "hydrated"): Promise<Frame> => {
  const value = await page.locator("html").getAttribute(`data-${name}-geometry`);
  if (!value) throw new Error(`Missing ${name} geometry`);
  return JSON.parse(value);
};
const clickTab = async (page: Page, href: string) => {
  let link = tabs(page).locator(`a[href="${href}"]`);
  if (!(await link.isVisible())) {
    await tabs(page).getByRole("button", { name: /More/ }).click();
    link = page.locator(`[role="menuitem"][href="${href}"]`);
  }
  const response = page.waitForResponse(
    (response) => response.url().includes("/workspace-") || response.url().includes("/overview/conversations"),
  );
  await link.click();
  await response;
  await page.waitForURL(new URL(href, server.url).href);
  await page.waitForFunction(
    ({ selector, href }) => document.querySelector(`${selector} a[aria-current="page"]`)?.getAttribute("href") === href,
    { selector: tabsSelector, href },
  );
  await settled(page);
};

/**
 * Presses Escape for the workspace. A hint that the resting pointer opened takes the first Escape, as it should: after
 * a resize, the pointer that clicked the Details toggle can rest on the column's "Close details" button. So the pointer
 * first moves to the empty shell rail at the window's corner, and no hint stays open.
 */
const pressEscapeForWorkspace = async (page: Page) => {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector("[role='tooltip']:popover-open"));
  await page.keyboard.press("Escape");
};

/** One test file per part, so the runner spreads the cases over shards and each file stays inside its budget (#1966). */
export type MailShellPart = "head" | "mailboxes" | "layout" | "wide" | "reader" | "events" | "drafts";

/** The shell tests of one part. `screenshots` is a directory for optional synthetic review screenshots. */
export const defineMailShellTests = (part: MailShellPart, screenshots: string | undefined) =>
  describe(`Mail SSR and hydration shell in ${browserName}`, () => {
    const section = (name: MailShellPart, define: () => void) => {
      if (name === part) define();
    };
    // These cases check behavior and placement, which the theme does not change: Mail's dark rules set only colors
    // and shadows, and the geometry matrix below compares every size in both themes. Dark copies run only for the
    // review screenshots (#1966).
    const reviewThemes = screenshots ? (["light", "dark"] as const) : (["light"] as const);
    section("head", () => {
      for (const locale of ["en", "de"] as const)
        for (const width of [1440, 834])
          test(`compact tag action ${locale} ${width}: icon order, selection, reload and clear`, async () => {
            const page = await open(`${boxPath}?locale=${locale}`, width);
            const actions = page.locator(".k2b-app-workspace__head-actions");
            const tag = actions.locator(".mail-head-tag");
            const query = () => {
              const url = new URL(page.url());
              return readMailHeadFilters(url, resolveMailSearchRoute(url), mailboxData(url).folderId);
            };
            try {
              expect(await tag.getAttribute("aria-label")).toBe("Tag");
              expect(await tag.getAttribute("data-icon-only")).toBe("true");
              expect((await tag.textContent())?.trim()).toBe("");
              const search = (await actions.locator("[data-mail-search-trigger]").boundingBox())!;
              const box = (await tag.boundingBox())!;
              const select = (await actions.locator("[data-mail-selection-trigger]").boundingBox())!;
              expect(box.x).toBeGreaterThanOrEqual(search.x + search.width);
              expect(box.x + box.width).toBeLessThanOrEqual(select.x);
              expect(Math.abs(box.y - search.y)).toBeLessThanOrEqual(1);
              expect(await page.locator(".k2b-app-workspace__head-filters").isVisible()).toBe(false);
              await tag.focus();
              await page.keyboard.press("Enter");
              await page.getByRole("menu").waitFor({ state: "visible" });
              const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
              await page.getByRole("menuitemradio", { name: "Priority", exact: true }).click();
              await response;
              await ready(page);
              expect(query()?.tagId).toBe("Tag001");
              expect(await tag.getAttribute("aria-label")).toBe("Tag: Priority");
              await page.keyboard.press("Escape");
              await page.getByRole("menu").waitFor({ state: "hidden" });
              expect(await tag.evaluate((element) => document.activeElement === element)).toBe(true);
              await page.reload();
              await ready(page);
              expect(await tag.getAttribute("data-active")).toBe("true");
              await tag.click();
              await page.getByRole("menuitemradio", { name: "Priority", exact: true }).waitFor({ state: "visible" });
              expect(await page.getByRole("menuitemradio", { name: "Priority", exact: true }).getAttribute("aria-checked")).toBe("true");
              const cleared = page.waitForResponse((response) => response.url().includes("/workspace-list"));
              await page.getByRole("menuitem", { name: locale === "de" ? "Leeren" : "Clear", exact: true }).click();
              await cleared;
              await ready(page);
              expect(query()?.tagId).toBeNull();
              expect(await tag.getAttribute("data-active")).toBeNull();
            } finally {
              await close(page);
            }
          });

      // One case per summary state, each on its own page; a last case compares the heights they measured (#1966).
      const summaryHeights = new Map<number, Record<string, number>>();
      for (const width of [1440, 390]) {
        for (const state of ["ai", "stale", "writing", "failed", "limited", "person"] as const)
          test(`automation: AI summary ${state} at ${width}: one place, plum only for AI`, async () => {
            const heights = summaryHeights.get(width) ?? {};
            summaryHeights.set(width, heights);
            const page = await open(`${boxPath}?conversation=Conv01&locale=de&summary=${state}`, width, width === 390 ? 844 : 900);
            try {
              const card = page.locator("[data-mail-conversation-summary]");
              await card.waitFor();
              const box = (await card.boundingBox())!;
              heights[state] = box.height;
              const ai = (await card.getAttribute("data-mail-summary-ai")) !== null;
              expect(ai, `${state}: AI surface only for AI`).toBe(state !== "person");
              const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
              if (state === "person") expect(background).not.toBe("rgb(252, 243, 248)");
              else expect(background).toBe("rgb(252, 243, 248)");
              if (state === "writing") expect(await card.getAttribute("aria-busy")).toBe("true");
              if (state === "stale") await page.getByText("1 neue Nachricht seit dieser Fassung").waitFor();
              if (state === "failed") await card.getByRole("button", { name: "Erneut versuchen" }).waitFor();
              if (state === "limited") await card.getByRole("button", { name: "Diese eine jetzt zusammenfassen" }).waitFor();
              if (screenshots) {
                await card.scrollIntoViewIfNeeded();
                await page.screenshot({ path: join(screenshots, `summary-${state}-light-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });
        // Reads the heights that the six state cases above measured, so it runs after them in the same file.
        test(`automation: AI summary at ${width}: writing, failure and limit keep one height`, () => {
          const heights = summaryHeights.get(width) ?? {};
          expect(Object.keys(heights).length, "the six state cases above ran first").toBe(6);
          // Writing, failure and limit share the reserved height, so the messages below stay where they are.
          expect(heights.writing).toBeGreaterThanOrEqual(196);
          expect(Math.abs(heights.failed! - heights.writing!)).toBeLessThanOrEqual(width === 390 ? 60 : 0.5);
          expect(Math.abs(heights.limited! - heights.writing!)).toBeLessThanOrEqual(width === 390 ? 80 : 0.5);
        });
      }

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`compact reader short subject ${theme} ${width}: count beside the title, hidden on phones`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&theme=${theme}`, width, 900);
            try {
              const title = page.locator(".mail-reader-title");
              const count = page.locator(".mail-reader-count");
              await title.waitFor({ state: "visible" });
              const titleBox = (await title.boundingBox())!;
              const marksBox = (await page.locator(".mail-reader-marks").boundingBox())!;
              if (width >= 768) {
                const countBox = (await count.boundingBox())!;
                expect(countBox.x - (marksBox.x + marksBox.width)).toBeGreaterThanOrEqual(0);
                expect(countBox.x - (marksBox.x + marksBox.width)).toBeLessThanOrEqual(8.5);
              } else {
                expect(await count.isVisible()).toBe(false);
                const back = (await page.locator(".mail-reader-back").boundingBox())!;
                const details = (await page.locator("[data-mail-details-trigger]").boundingBox())!;
                const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
                expect(Math.abs(middle(titleBox) - middle(back))).toBeLessThanOrEqual(1);
                expect(Math.abs(middle(marksBox) - middle(details))).toBeLessThanOrEqual(1);
              }
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `reader-short-${theme}-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`compact reader ${theme} ${width}: fixed subject, count and the way back to the list`, async () => {
            const page = await open(`${boxPath}?conversation=Conv02&long-subject=1&theme=${theme}`, width, 900);
            try {
              const toolbar = page.locator("[data-mail-reader-toolbar]");
              const heading = toolbar.locator("[data-mail-reader-heading]");
              await heading.waitFor({ state: "visible" });
              expect(await toolbar.locator(".mail-reader-count").isVisible()).toBe(width >= 768);
              expect(await page.locator(".mail-reader-scroll [data-mail-reader-heading]").count()).toBe(0);
              const metrics = await heading.evaluate((element) => {
                const css = getComputedStyle(element);
                return {
                  font: css.fontSize,
                  lines: css.webkitLineClamp,
                  height: element.getBoundingClientRect().height,
                  line: parseFloat(css.lineHeight),
                };
              });
              expect(metrics.font).toBe("17px");
              expect(metrics.lines).toBe(width < 768 ? "3" : "2");
              expect(metrics.height).toBeLessThanOrEqual(metrics.line * (width < 768 ? 3 : 2) + 0.5);
              if (width < 768) {
                const titleBox = await heading.boundingBox();
                const back = (await toolbar.locator(".mail-reader-back").boundingBox())!;
                expect(Math.abs(titleBox!.y + metrics.line / 2 - (back.y + back.height / 2))).toBeLessThanOrEqual(1);
              }
              const before = await toolbar.boundingBox();
              await page.locator(".mail-reader-scroll").evaluate((element) => {
                element.scrollTop = 300;
              });
              await settled(page);
              expect(await page.locator(".mail-reader-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
              expect(await toolbar.boundingBox()).toEqual(before);
              expect(await page.locator(".mail-workspace > .k2b-app-workspace__head").isVisible()).toBe(width >= 768);
              expect(await toolbar.locator("[data-mail-details-trigger]").isVisible()).toBe(width < 768);
              expect(await page.locator("[data-app-workspace-detail-toggle]").isVisible()).toBe(width >= 768);
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `compact-reader-${theme}-${width}.png`) });
              }
              if (width >= 768) {
                // Beside the list the reader has no list control of its own; with the list hidden it ends with ×.
                expect(await toolbar.locator("[data-mail-reader-close]").count()).toBe(0);
                await page.locator("[data-mail-view-menu]").click();
                await page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ }).click();
                const close = toolbar.getByRole("link", { name: "Close conversation", exact: true });
                await close.waitFor({ state: "visible" });
                expect(await page.locator("[data-mail-conversation-list]").isVisible()).toBe(false);
                await close.click();
                await page.locator("[data-mail-conversation-list]").waitFor({ state: "visible" });
                expect(new URL(page.url()).searchParams.has("conversation")).toBe(false);
              }
            } finally {
              await close(page);
            }
          });

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`compact folder filters ${theme} ${width}: scoped toggles, dates and tags`, async () => {
            const captureStarted = performance.now();
            const captureStep = (step: string) => {
              if (screenshots)
                console.info(`Mail chips ${browserName} ${theme} ${width} ${step}: ${Math.round(performance.now() - captureStarted)}ms`);
            };
            const page = await open(`${boxPath}?folder=Filed1&theme=${theme}&history=1`, width);
            captureStep("ready");
            const head = page.locator(".k2b-app-workspace__head-filters");
            const filters = () => {
              const url = new URL(page.url());
              return readMailHeadFilters(url, resolveMailSearchRoute(url), mailboxData(url).folderId);
            };
            const activate = async (control: Locator) => {
              const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
              await control.click();
              await response;
              await ready(page);
            };
            try {
              // The same public controls exist in the SSR frame and after hydration.
              expect(await head.getByRole("button", { name: /Unread/ }).getAttribute("aria-pressed")).toBe("false");
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                captureStep("before initial screenshot");
                await page.screenshot({ path: join(screenshots, browserName, `folder-filters-${theme}-${width}.png`) });
                captureStep("after initial screenshot");
              }
              await head.getByRole("button", { name: /Unread/ }).focus();
              const unreadResponse = page.waitForResponse((response) => response.url().includes("/workspace-list"));
              await page.keyboard.press("Enter");
              await unreadResponse;
              await ready(page);
              expect(filters()?.folderId).toBe("Filed1");
              expect(filters()?.unread).toBe(true);
              await activate(head.getByRole("button", { name: "Flagged", exact: true }));
              await activate(head.getByRole("button", { name: "With attachment", exact: true }));
              expect(filters()?.flagged).toBe(true);
              expect(filters()?.attachment).toBe(true);
              await head.getByRole("button", { name: "Date range", exact: true }).click();
              await activate(page.getByRole("menuitemradio", { name: "Last 7 days", exact: true }));
              expect(filters()?.dates.length).toBe(2);
              await page.locator(".k2b-app-workspace__head-actions").getByRole("button", { name: "Tag", exact: true }).click();
              await activate(page.getByRole("menuitemradio", { name: "Priority", exact: true }));
              // FilterChip intentionally stays open; close it before testing the next route.
              await page.keyboard.press("Escape");
              const taggedUrl = page.url();
              expect(filters()?.tagId).toBe("Tag001");
              expect(filters()?.folderId).toBe("Filed1");
              expect(filters()?.unread).toBe(true);
              expect(new URL(taggedUrl).searchParams.has("folder")).toBe(false);
              expect(await currentHref(page)).toBe(boxPath);
              expect(await head.locator("[data-mail-filter-folder]").textContent()).toBe("Only in Filed");
              if (screenshots) {
                captureStep("before tag screenshot");
                await page.screenshot({ path: join(screenshots, browserName, `folder-tag-${theme}-${width}.png`) });
                captureStep("after tag screenshot");
              }
              await activate(head.locator(".k2b-app-workspace__head-reset"));
              expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
              expect(new URL(page.url()).searchParams.has("search")).toBe(false);
              captureStep("assertions complete");
            } finally {
              captureStep("before close");
              await page.context().close();
              captureStep("after close");
            }
          });

      for (const theme of reviewThemes)
        for (const width of [1440, 390] as const)
          test(`compact search head ${theme} ${width}: replaces the lead and returns focus without moving the list`, async () => {
            const page = await open(`${boxPath}?folder=Filed1&theme=${theme}`, width);
            try {
              const head = page.locator(".k2b-app-workspace__head");
              await settled(page);
              const before = await head.boundingBox();
              await page.locator("[data-mail-search-trigger]").click();
              await settled(page);
              const input = page.locator('input[name="q"]');
              expect(await input.count()).toBe(1);
              expect(await page.locator("[data-mail-conversation-list] input").count()).toBe(0);
              expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
              const during = await head.boundingBox();
              expect(during?.height).toBe(before?.height);
              expect(await page.getByRole("button", { name: "Options for Example support", exact: true }).isVisible()).toBe(width !== 390);
              expect(await page.getByRole("button", { name: "Cancel", exact: true }).isVisible()).toBe(true);
              if (screenshots) {
                const directory = join(screenshots, browserName);
                mkdirSync(directory, { recursive: true });
                await page.screenshot({ path: join(directory, `search-head-${theme}-${width}.png`) });
              }
              // A phone combines Search in, Place and More filters in one menu.
              const fields =
                width === 390
                  ? page.getByRole("button", { name: "Search options: Everything · Whole mailbox", exact: true })
                  : page.getByRole("button", { name: "Search in: Everything", exact: true });
              await fields.focus();
              await fields.press("/");
              expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
              await fields.click();
              await page.getByRole("menu").waitFor({ state: "visible" });
              await page.keyboard.press("Escape");
              await page.getByRole("menu").waitFor({ state: "hidden" });
              expect(await input.count()).toBe(1);
              await fields.focus();
              await fields.press("Escape");
              await settled(page);
              expect(await input.count()).toBe(0);
              expect((await head.boundingBox())?.height).toBe(before?.height);
              expect(await page.locator("[data-mail-search-trigger]").evaluate((element) => document.activeElement === element)).toBe(true);
              expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
            } finally {
              await close(page);
            }
          });

      // S3: wide, the search names its three options as equal chips; a phone combines them in one menu.
      test("S3 search at 1680: Search in, Place and More filters stand as labelled chips in one row", async () => {
        const page = await open(`${boxPath}?layout=auto`, 1680, 1050);
        try {
          await page.locator("[data-mail-search-trigger]").click();
          await page.locator('input[name="q"]').waitFor({ state: "visible" });
          await settled(page);
          const chips = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-mail-head-search-options] .k2b-filter-chip"))
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => ({
                text: element.textContent?.trim(),
                y: element.getBoundingClientRect().y,
                height: element.getBoundingClientRect().height,
              })),
          );
          expect(chips.map((chip) => chip.text)).toEqual(["Search in: Everything", "Place: Whole mailbox", "More filters"]);
          expect(new Set(chips.map((chip) => chip.y)).size).toBe(1);
          expect(new Set(chips.map((chip) => chip.height)).size).toBe(1);
          expect(await page.locator("[data-mail-search-phone-options]").isVisible()).toBe(false);
          await page.getByRole("button", { name: "More filters", exact: true }).click();
          await page.getByRole("dialog").waitFor({ state: "visible" });
        } finally {
          await close(page);
        }
      });

      test("S3 search at 390: one menu holds Search in, Place and More filters, and its button names the choice", async () => {
        const page = await open(`${boxPath}?folder=Filed1`, 390, 844);
        try {
          await page.locator("[data-mail-search-trigger]").click();
          await page.locator('input[name="q"]').waitFor({ state: "visible" });
          await settled(page);
          const trigger = page.locator("[data-mail-search-phone-options]");
          expect((await trigger.textContent())?.trim()).toBe("Everything · Whole mailbox");
          expect(await page.locator("[data-mail-head-search-options] .mail-search-wide-option:visible").count()).toBe(0);
          const before = await page.locator('input[name="q"]').boundingBox();
          await trigger.click();
          // A phone opens the menu as a sheet.
          await page.getByRole("group", { name: "Search in" }).waitFor({ state: "visible" });
          await page.getByRole("group", { name: "Place" }).waitFor({ state: "visible" });
          await page.getByRole("menuitemcheckbox", { name: "Subject" }).click();
          // A choice keeps the menu open and the button names it at once.
          await page.getByRole("menuitemradio", { name: /Only Filed/ }).click();
          await page.keyboard.press("Escape");
          await settled(page);
          expect((await trigger.textContent())?.trim()).toBe("Everything, Subject · Only Filed");
          expect(await page.locator('input[name="q"]').boundingBox()).toEqual(before);
          await trigger.click();
          await page.getByRole("menuitem", { name: "More filters …" }).click();
          await page
            .getByRole("dialog")
            .filter({ hasText: /filter/i })
            .first()
            .waitFor({ state: "visible" });
        } finally {
          await close(page);
        }
      });

      test("compact search head: Escape from a result returns to the source folder and magnifier", async () => {
        const page = await open(`${boxPath}?folder=Filed1`);
        try {
          await page.locator("[data-mail-search-trigger]").click();
          await page.locator('input[name="q"]').fill("invoice");
          await page.waitForURL((url) => url.searchParams.get("q") === "invoice");
          const row = page.locator("[data-mail-conversation-list] [data-conversation-id] a.mail-list-row").first();
          await row.focus();
          await row.press("Escape");
          await page.waitForURL((url) => !url.searchParams.has("q") && url.searchParams.get("folder") === "Filed1");
          expect(await page.locator('input[name="q"]').count()).toBe(0);
          expect(await page.locator("[data-mail-search-trigger]").evaluate((element) => document.activeElement === element)).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("compact search head: a narrow desktop app area keeps desktop controls and a reachable input", async () => {
        const page = await open(`${boxPath}?folder=Filed1&shell=1&panel=560`, 1280);
        try {
          await page.locator("[data-mail-search-trigger]").click();
          const input = page.locator('input[name="q"]');
          await settled(page);
          expect(await page.locator(".mail-head-search-close-phone").isVisible()).toBe(false);
          expect(await page.locator(".mail-head-search-close-desktop").isVisible()).toBe(true);
          expect(
            await input.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
            }),
          ).toBe(true);
          await input.press("Escape");
          expect(await input.count()).toBe(0);
        } finally {
          await close(page);
        }
      });

      for (const theme of reviewThemes)
        for (const width of [1440, 390] as const)
          test(`compact selection head ${theme} ${width}: count, exit and labeled actions keep their order`, async () => {
            const page = await open(`${boxPath}?folder=Filed1&theme=${theme}`, width);
            try {
              const head = page.locator(".k2b-app-workspace__head");
              await settled(page);
              const beforeHeight = (await head.boundingBox())!.height;
              const entry = page.getByRole("button", { name: "Select conversations", exact: true });
              await entry.focus();
              await entry.press("Enter");
              expect(await page.locator("[data-mail-selection-exit]").evaluate((element) => document.activeElement === element)).toBe(true);
              await page.getByRole("checkbox", { name: "Select Example request 1", exact: true }).check();
              const toolbar = page.getByRole("toolbar", { name: "Selected conversation actions", exact: true });
              await toolbar.waitFor({ state: "visible" });
              await settled(page);
              expect(await toolbar.locator("button").allTextContents()).toContain("Archive");
              expect((await head.boundingBox())!.height).toBe(beforeHeight);
              const summary = await page.locator(".mail-bulk-summary").boundingBox();
              const actions = await page.locator(".mail-bulk-actions").boundingBox();
              expect(
                Boolean(
                  summary && actions && (width === 390 ? actions.y >= summary.y + summary.height : actions.y < summary.y + summary.height),
                ),
              ).toBe(true);
              expect(await page.getByRole("button", { name: "Options for Example support", exact: true }).isVisible()).toBe(width !== 390);
              if (screenshots) {
                const directory = join(screenshots, browserName);
                mkdirSync(directory, { recursive: true });
                await page.screenshot({ path: join(directory, `selection-head-${theme}-${width}.png`) });
              }
              await page.getByRole("button", { name: "More selected conversation actions", exact: true }).click();
              await page.getByRole("menu").waitFor({ state: "visible" });
              expect(await page.getByRole("menuitem", { name: "Move to Trash", exact: true }).isVisible()).toBe(true);
              await page.keyboard.press("Escape");
              await page.getByRole("button", { name: "Exit selection", exact: true }).click();
              expect(await page.getByRole("checkbox").count()).toBe(0);
              expect(await page.locator("[data-mail-search-trigger]").isVisible()).toBe(true);
              const selectionTrigger = page.locator("[data-mail-selection-trigger]");
              expect(await selectionTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
              await selectionTrigger.click();
              const checkbox = page.getByRole("checkbox", { name: "Select Example request 1", exact: true });
              await checkbox.focus();
              await checkbox.press("Escape");
              expect(await page.getByRole("checkbox").count()).toBe(0);
              expect(await selectionTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
            } finally {
              await close(page);
            }
          });

      test("compact folder filters: reload and traversal preserve the same scoped search", async () => {
        const expression: MailSearchExpression = {
          type: "and",
          expressions: [
            { type: "folder_id", folderId: "Filed1" },
            { type: "unread", folderId: "Filed1" },
            { type: "local_tag_id", tagId: "Tag001" },
            { type: "date", field: "internal_date", operator: "on_or_after", value: "2026-10-07T10:00:00.000Z" },
            { type: "date", field: "internal_date", operator: "before", value: MAIL_SHELL_NOW },
          ],
        };
        const route = `${boxPath}?${new URLSearchParams({ history: "1", searchFrom: "folder=Filed1", search: JSON.stringify({ expression, sort: "newest" }) })}`;
        const page = await open(route);
        const assertSearch = async () => {
          const url = new URL(page.url());
          expect(resolveMailSearchRoute(url).expression).toEqual(expression);
          expect(await currentHref(page)).toBe(boxPath);
          expect(await page.locator("[data-mail-filter-folder]").textContent()).toBe("Only in Filed");
        };
        try {
          await assertSearch();
          const initial = page.url();
          await page.reload();
          await ready(page);
          await assertSearch();
          const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
          await page.locator(".k2b-app-workspace__head-reset").click();
          await response;
          await ready(page);
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          await page.goBack();
          await ready(page);
          expect(page.url()).toBe(initial);
          await assertSearch();
          await page.goForward();
          await ready(page);
          expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
        } finally {
          await page.context().close();
        }
      });

      test("compact folder filters: custom range uses the existing editor and Sent keeps its subset", async () => {
        const page = await open(`${boxPath}?folder=Filed1`);
        const head = page.locator(".k2b-app-workspace__head-filters");
        try {
          await page.route("**/api/mail/mailboxes/Box001/folders", (route) =>
            route.fulfill({ json: { folders: mailboxData(new URL(page.url())).folders } }),
          );
          await head.getByRole("button", { name: "Date range", exact: true }).click();
          await page.getByRole("menuitem", { name: "Custom date range…", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor({ state: "visible" });
          expect(await dialog.getByText(/on or after/i, { exact: true }).count()).toBeGreaterThan(0);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          // Sent retains the approved attachment/date/tag subset, without unread or flagged buttons.
          await page.goto(new URL(`${boxPath}?folder=Sent1`, server.url).href);
          await ready(page);
          expect(await head.getByRole("button", { name: /Unread|Flagged/ }).count()).toBe(0);
          expect(await head.getByRole("button", { name: "With attachment", exact: true }).isVisible()).toBe(true);
        } finally {
          await page.context().close();
        }
      });

      test("compact folder filters: custom Apply on a direct link keeps a clean return target", async () => {
        const expression = {
          type: "and",
          expressions: [
            { type: "folder_id", folderId: "Filed1" },
            { type: "unread", folderId: "Filed1" },
          ],
        };
        const direct = `${boxPath}?${new URLSearchParams({ folder: "Filed1", search: JSON.stringify({ expression, sort: "newest" }) })}`;
        const page = await open(direct);
        const head = page.locator(".k2b-app-workspace__head-filters");
        try {
          await page.route("**/api/mail/mailboxes/Box001/folders", (route) =>
            route.fulfill({ json: { folders: mailboxData(new URL(page.url())).folders } }),
          );
          await head.getByRole("button", { name: "Date range", exact: true }).click();
          await page.getByRole("menuitem", { name: "Custom date range…", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor({ state: "visible" });
          const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
          await dialog.getByRole("button", { name: "Search", exact: true }).click();
          await response;
          await ready(page);
          const url = new URL(page.url());
          const starting = new URLSearchParams(url.searchParams.get("searchFrom") ?? "");
          expect(starting.has("search")).toBe(false);
          expect(starting.get("folder")).toBe("Filed1");
          expect(await head.locator("[data-mail-filter-folder]").textContent()).toBe("Only in Filed");
          await head.getByRole("button", { name: "Last 7 days", exact: true }).click();
          const clearDate = page.waitForResponse((response) => response.url().includes("/workspace-list"));
          await page.getByRole("menuitem", { name: "Clear date range", exact: true }).click();
          await clearDate;
          await ready(page);
          const clearUnread = page.waitForResponse((response) => response.url().includes("/workspace-list"));
          await head.getByRole("button", { name: /Unread/ }).click();
          await clearUnread;
          await ready(page);
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
        } finally {
          await page.context().close();
        }
      });

      test("compact folder filters: direct links clear sequentially and mixed routes keep the service precedence", async () => {
        const expression = {
          type: "and",
          expressions: [
            { type: "folder_id", folderId: "Filed1" },
            { type: "unread", folderId: "Filed1" },
            { type: "flagged", folderId: "Filed1" },
          ],
        };
        const direct = `${boxPath}?${new URLSearchParams({ folder: "Filed1", search: JSON.stringify({ expression, sort: "newest" }) })}`;
        const page = await open(direct);
        const head = page.locator(".k2b-app-workspace__head-filters");
        try {
          for (const name of ["Flagged", /Unread/]) {
            const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
            await head.getByRole("button", { name }).click();
            await response;
            await ready(page);
          }
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
          await page.goto(new URL(`${boxPath}?view=mine&folder=Filed1`, server.url).href);
          await ready(page);
          expect(await currentHref(page)).toBe(`${boxPath}?view=mine`);
          expect(await head.getByRole("button", { name: /Unread/ }).count()).toBe(0);
          await page.goto(new URL(`${boxPath}?view=unknown&folder=Filed1`, server.url).href);
          await ready(page);
          expect(await head.getByRole("button", { name: /Unread/ }).isVisible()).toBe(true);
        } finally {
          await page.context().close();
        }
      });

      for (const theme of ["light", "dark"] as const)
        for (const width of [1440, 390])
          test(`mailbox context contrast ${theme} ${width}: folder selection and keyboard switch stay independent`, async () => {
            const page = await open(
              `${boxPath}?folder=Inbox1&navigation=1&theme=${theme}&locale=${theme === "light" ? "de" : "en"}`,
              width,
            );
            const appearance = (locator: Locator) =>
              locator.evaluate((element) => {
                const style = getComputedStyle(element);
                const probe = document.createElement("span");
                probe.style.color = element.closest(".mail-sidebar") ? "var(--mail-other-mailbox-ink)" : "var(--k2b-text-muted)";
                probe.style.backgroundColor = "var(--k2b-surface)";
                element.append(probe);
                const muted = getComputedStyle(probe).color;
                const background = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return { color: style.color, muted, background, weight: style.fontWeight };
              });
            try {
              for (const part of ["sender", "subject"]) {
                const read = page.locator(`.mail-list-entry:not(.mail-list-entry-unread) .mail-row-${part}`).first();
                const unread = page.locator(`.mail-list-entry-unread .mail-row-${part}`).first();
                expect((await appearance(read)).weight).toBe("400");
                expect((await appearance(unread)).weight).toBe("600");
              }
              const phone = width === 390;
              if (phone) await page.getByRole("button", { name: "Open mailbox navigation", exact: true }).tap();
              const navigation = phone ? page.locator("dialog .k2b-navigation") : sidebar(page);
              await navigation.waitFor({ state: "visible" });
              const current = phone ? navigation.locator(`a[href="${boxPath}"]`) : navigation.locator('[data-mailbox="Box001"] a').first();
              const other = phone
                ? navigation.locator('a[href="/app/mail/Box002"]')
                : navigation.locator('[data-mailbox="Box002"] a').first();
              const label = phone ? ".k2b-navigation__copy > span" : ".k2b-app-workspace__sidebar-item-label";
              const currentInk = await appearance(current.locator(label));
              const otherInk = await appearance(other.locator(label));
              expect(currentInk.weight).toBe("600");
              expect(otherInk.weight).toBe("400");
              expect(otherInk.color).toBe(otherInk.muted);
              expect(otherInk.color).not.toBe(currentInk.color);
              const luminance = (color: string) => {
                const [red, green, blue] = color
                  .match(/[\d.]+/g)!
                  .slice(0, 3)
                  .map((value) => {
                    const channel = Number(value) / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                  });
                return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
              };
              const ink = luminance(otherInk.color);
              const background = luminance(otherInk.background);
              // Other mailboxes stay readable and selectable even with their quieter app-owned presentation.
              expect((Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05)).toBeGreaterThanOrEqual(phone ? 7 : 4.5);
              expect(await current.getAttribute("aria-current")).toBeNull();
              expect(await other.getAttribute("aria-disabled")).toBeNull();
              const folder = navigation.locator(`a[href="${boxPath}?folder=Inbox1"]`);
              expect(await folder.getAttribute("aria-current")).toBe("page");
              if (!phone) {
                const group = navigation.locator(".mail-sidebar-mailbox-group.is-open");
                expect(await group.count()).toBe(1);
                expect(await group.locator('[data-mailbox="Box001"]').count()).toBe(1);
                expect(await group.locator(".mail-sidebar-folders").count()).toBe(1);
                expect(await group.locator('[data-mailbox="Box002"]').count()).toBe(0);
                const colors = await group.evaluate((element) => {
                  const probe = document.createElement("span");
                  probe.style.background = "var(--ui-app-selected)";
                  element.append(probe);
                  const fill = getComputedStyle(element).backgroundColor;
                  const expected = getComputedStyle(probe).backgroundColor;
                  probe.remove();
                  return { fill, expected };
                });
                expect(colors.fill).toBe(colors.expected);
              }
              // The real Cloud appearance scope supplies the approved 10% navigation fill.
              const selectedColors = await folder.evaluate((element) => {
                const row = element.closest(".k2b-app-workspace__sidebar-item") ?? element;
                const probe = document.createElement("span");
                probe.style.background = "var(--ui-app-selected-nav)";
                row.append(probe);
                const expected = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return { fill: getComputedStyle(row).backgroundColor, ink: getComputedStyle(element).color, expected };
              });
              expect(selectedColors.fill).toBe(selectedColors.expected);
              if (theme === "light") expect(selectedColors.fill).toBe("rgb(231, 241, 241)");
              const fg = luminance(selectedColors.ink);
              const bg = luminance(selectedColors.fill);
              expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
              if (!phone) {
                await folder.hover();
                await folder.focus();
              }
              await settled(page);
              if (!phone) {
                expect(await folder.evaluate((element) => document.activeElement === element)).toBe(true);
                expect(
                  await folder.evaluate(
                    (element) => getComputedStyle(element.closest(".k2b-app-workspace__sidebar-item")!).backgroundColor,
                  ),
                ).toBe(selectedColors.fill);
              }
              const compose = page.locator("[data-workspace-primary]");
              const composeColors = await compose.evaluate((element) => {
                const style = getComputedStyle(element);
                return { ink: style.color, fill: style.backgroundColor };
              });
              expect(composeColors.fill).toBe("rgb(15, 118, 110)");
              const composeInk = luminance(composeColors.ink);
              const composeFill = luminance(composeColors.fill);
              expect((Math.max(composeInk, composeFill) + 0.05) / (Math.min(composeInk, composeFill) + 0.05)).toBeGreaterThanOrEqual(4.5);
              if (phone) {
                expect(await current.locator("..").getAttribute("data-context")).toBe("true");
                expect(await other.locator("..").getAttribute("data-context")).toBe("false");
                // Focus is gone: the sheet starts with the mailboxes.
                expect(await navigation.locator('a[href="/app/mail"]').count()).toBe(0);
              }
              if (screenshots) {
                mkdirSync(resolve(screenshots), { recursive: true });
                await page.screenshot({ path: join(resolve(screenshots), `mailbox-context-${theme}-${width}.png`) });
                writeFileSync(
                  join(resolve(screenshots), `mailbox-context-${theme}-${width}.json`),
                  JSON.stringify(
                    {
                      currentInk,
                      otherInk,
                      selectedColors,
                      composeColors,
                      phases: await page.evaluate(() =>
                        performance
                          .getEntriesByType("mark")
                          .filter((entry) => entry.name.startsWith("mail-shell:"))
                          .map((entry) => ({ name: entry.name, at: entry.startTime })),
                      ),
                    },
                    null,
                    2,
                  ),
                );
              }
              // A quieter selectable mailbox keeps native keyboard activation, also in the real phone sheet.
              await other.focus();
              await page.keyboard.press("Enter");
              await page.waitForURL(new URL("/app/mail/Box002", server.url).href);
              await ready(page);
              await page.getByText("Example dispatch: Example request 1", { exact: true }).waitFor({ state: "visible" });
              if (phone) await navigation.waitFor({ state: "hidden" });
              else expect(await sidebar(page).locator('[data-mailbox="Box002"]').getAttribute("data-open")).toBe("true");
            } finally {
              await close(page);
            }
          });
    });

    section("mailboxes", () => {
      test("the mailbox sidebar lists the mailboxes without Focus; switching mailbox takes one link", async () => {
        const page = await open(boxPath);
        try {
          expect(await page.locator(".mail-sidebar").getAttribute("aria-label")).toBe("Mailboxes");
          const ids = await sidebar(page)
            .locator('.mail-sidebar-mailbox:not([data-hidden="true"])')
            .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-mailbox")!));
          expect(ids).toEqual(["Box002", "Box001", "Box003", "Box004"]);
          expect(await sidebar(page).locator('a[href="/app/mail"]').count()).toBe(0);
          expect(await sidebar(page).locator(`a[href="${boxPath}"][aria-current="page"]`).count()).toBe(1);
          const groups = sidebar(page).getByRole("group", { name: /^Folders of / });
          expect(await groups.count()).toBe(1);
          expect(await groups.getAttribute("aria-label")).toBe("Folders of Example support");
          expect(await page.locator(".k2b-app-workspace__sidebar-switcher").count()).toBe(0);
          expect(await page.getByRole("button", { name: "Switch mailbox" }).count()).toBe(0);
          const other = sidebar(page).locator('[data-mailbox="Box002"] a').first();
          expect(await other.getAttribute("href")).toBe("/app/mail/Box002");
          expect(await other.evaluate((e) => e.tagName)).toBe("A");
          const countSlot = other.locator(".mail-sidebar-needs-action");
          expect(await countSlot.count()).toBe(1);
          expect(await countSlot.textContent()).toBe("");
          expect(await other.locator(".mail-sidebar-unread-dot").count()).toBe(0);
        } finally {
          await close(page);
        }
      });

      test("Mail opens the last mailbox; Back leaves Mail and reload stays in the mailbox", async () => {
        const page = await open("/app/mail/Box003");
        try {
          // Opening a mailbox records it; Mail then opens it again instead of a page of its own.
          await page.goto(new URL("/app/mail", server.url).href);
          await ready(page);
          expect(new URL(page.url()).pathname).toBe("/app/mail/Box003");
          expect(await sidebar(page).locator('[data-mailbox="Box003"]').getAttribute("data-open")).toBe("true");
          await page.reload();
          await ready(page);
          expect(new URL(page.url()).pathname).toBe("/app/mail/Box003");
          // The redirect adds no entry of its own: the blank start, the first visit, and the mailbox Mail opened.
          expect(await page.evaluate(() => history.length)).toBe(3);
          await page.goBack();
          await ready(page);
          expect(new URL(page.url()).pathname).toBe("/app/mail/Box003");
        } finally {
          await close(page);
        }
      });

      test("an old Focus link opens its conversation or view in the mailbox", async () => {
        for (const [source, target] of [
          ["/app/mail?mailbox=Box002&conversation=Conv01", "/app/mail/Box002?conversation=Conv01"],
          // Without a last mailbox, the first pinned one opens.
          ["/app/mail?view=waiting", "/app/mail/Box002?view=waiting"],
        ] as const) {
          const page = await open(source);
          try {
            expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(target);
          } finally {
            await close(page);
          }
        }
      });

      test("the notice that Focus is gone stays closed after a reload", async () => {
        const page = await open(`${boxPath}?notice=1`);
        try {
          const notice = sidebar(page).getByRole("status").filter({ hasText: "Focus is gone" });
          await notice.waitFor({ state: "visible" });
          const before = await page.locator(".mail-sidebar-mailbox").first().boundingBox();
          const saved = page.waitForRequest(
            (request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/mail/mailboxes/preferences/focus-notice",
          );
          await notice.getByRole("button", { name: "Got it" }).click();
          await saved;
          await notice.waitFor({ state: "detached" });
          // The mailboxes move up by the notice's height, once, on the person's own click.
          expect((await page.locator(".mail-sidebar-mailbox").first().boundingBox())!.y).toBeLessThan(before!.y);
          await page.reload();
          await ready(page);
          expect(await sidebar(page).getByText("Focus is gone").count()).toBe(0);
        } finally {
          await close(page);
        }
      });

      // These two cases belong to the existing behavior child (their names deliberately omit the geometry-matrix pattern).
      test("mailbox switch preserves the document, sidebar and head through Back, Forward and reload", async () => {
        const page = await open(boxPath);
        const destination = "/app/mail/Box002";
        let navigations = 0;
        // Same-document history changes also emit framenavigated; count actual document requests.
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) ++navigations;
        });
        const marked = async () =>
          expect(
            await page.evaluate(() => [
              Reflect.get(window, "mailboxSwitchMarker"),
              Reflect.get(document.querySelector(".mail-sidebar")!, "mailboxSwitchMarker"),
              Reflect.get(document.querySelector(".k2b-app-workspace__main")!, "mailboxSwitchMarker"),
              Reflect.get(document.querySelector("[data-mail-conversation-list]")!, "mailboxSwitchMarker"),
              Reflect.get(document.querySelector(".mail-reader")!, "mailboxSwitchMarker"),
            ]),
          ).toEqual(["kept", "kept", "kept", "kept", "kept"]);
        const frame = async () =>
          (await geometry(page)).filter(({ part }) =>
            part.split(" ").some((name) => name === "mail-sidebar" || name === "k2b-app-workspace__head"),
          );
        try {
          await page.evaluate(() => {
            Reflect.set(window, "mailboxSwitchMarker", "kept");
            Reflect.set(document.querySelector(".mail-sidebar")!, "mailboxSwitchMarker", "kept");
            Reflect.set(document.querySelector(".k2b-app-workspace__main")!, "mailboxSwitchMarker", "kept");
            Reflect.set(document.querySelector("[data-mail-conversation-list]")!, "mailboxSwitchMarker", "kept");
            Reflect.set(document.querySelector(".mail-reader")!, "mailboxSwitchMarker", "kept");
          });
          const before = await frame();
          await sidebar(page).locator(`a[href="${destination}"]`).first().click();
          await page.waitForURL(new URL(destination, server.url).href);
          await page.getByText("Example dispatch: Example request 1", { exact: true }).waitFor({ state: "visible" });
          await ready(page);
          await marked();
          assertFrame(before, await frame(), "mailbox switch frame");
          const switched = await geometry(page);
          await page.goBack();
          await page.waitForURL(new URL(boxPath, server.url).href);
          await page.getByText("Example request 1", { exact: true }).first().waitFor({ state: "visible" });
          await ready(page);
          await marked();
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await page.getByText("Example dispatch: Example request 1", { exact: true }).waitFor({ state: "visible" });
          await ready(page);
          await marked();
          expect(navigations).toBe(0);
          await page.reload();
          await ready(page);
          expect(new URL(page.url()).pathname).toBe(destination);
          const serverFrame = await recordedFrame(page, "server");
          assertFrame(switched, serverFrame, "B reload server");
          assertFrame(serverFrame, await recordedFrame(page, "hydrated"), "B reload hydrated");
          assertFrame(serverFrame, await geometry(page), "B reload settled");
        } finally {
          await close(page);
        }
      });

      test("mailbox switch clears search, filters, reader and scroll while retaining the panes", async () => {
        const search = JSON.stringify({
          expression: { type: "and", expressions: [{ type: "folder_id", folderId: "Filed1" }, simpleMailSearchExpression("invoice")] },
          sort: "newest",
        });
        const source = `${boxPath}?${new URLSearchParams({ conversation: "Conv01", q: "invoice", search })}`;
        const page = await open(source, 1440, 600);
        try {
          expect(await page.locator('input[name="q"]').inputValue()).toBe("invoice");
          expect(await page.locator("[data-mail-reader-heading]").count()).toBe(1);
          expect(await page.locator("[data-mail-head-search-options]").textContent()).toContain("Filed");
          await page.locator('[data-scroll-preserve="mail-list-Box001"]').evaluate((element) => {
            element.scrollTop = 120;
            Reflect.set(element, "mailboxListMarker", "kept");
          });
          await settled(page);
          expect(await page.locator('[data-scroll-preserve="mail-list-Box001"]').evaluate((element) => element.scrollTop)).toBe(120);
          await sidebar(page).locator('a[href="/app/mail/Box002"]').first().click();
          await page.waitForURL(new URL("/app/mail/Box002", server.url).href);
          await ready(page);
          const scroller = page.locator('[data-scroll-preserve="mail-list-Box002"]');
          expect(await scroller.evaluate((element) => [Reflect.get(element, "mailboxListMarker"), element.scrollTop])).toEqual(["kept", 0]);
          expect(new URL(page.url()).search).toBe("");
          expect(await page.locator("[data-mail-reader-heading]").count()).toBe(0);
          expect(await page.locator("[data-mail-filter-folder]").count()).toBe(0);
          expect(await page.locator('input[name="q"]').count()).toBe(0);
          await page.locator("[data-mail-search-trigger]").focus();
          await page.keyboard.press("/");
          await page.locator('input[name="q"]').waitFor({ state: "visible" });
          await page.waitForFunction(() => document.activeElement?.matches('input[name="q"]'));
          expect(await page.locator('input[name="q"]').inputValue()).toBe("");
          await page.keyboard.press("Escape");
          await page.locator('input[name="q"]').waitFor({ state: "hidden" });
          await page.waitForFunction(() => document.activeElement?.matches("[data-mail-search-trigger]"));
        } finally {
          await close(page);
        }
      });

      test("mailbox history restores nonzero list scroll after async content commits, reversal and reload", async () => {
        // Install the same shared history owner as Cloud before mounting the island. The two mailboxes use
        // distinct scroll keys on the retained list element; restoration waits for the destination content.
        const source = `${boxPath}?history=1`;
        const destination = "/app/mail/Box002";
        const page = await open(source, 1440, 600);
        const releaseBack = Promise.withResolvers<void>();
        const list = (id: string) => page.locator(`[data-scroll-preserve="mail-list-${id}"]`);
        const position = (id: string) => list(id).evaluate((element) => element.scrollTop);
        const setPosition = async (id: string, y: number) => {
          await list(id).evaluate((element, y) => {
            element.scrollTop = y;
          }, y);
          await settled(page);
          expect(await position(id), `${id} fixture must really scroll`).toBe(y);
        };
        try {
          await setPosition("Box001", 240);
          await sidebar(page).locator(`a[href="${destination}"]`).first().click();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "a newly opened mailbox starts at its list's top").toBe(0);
          await setPosition("Box002", 400);
          await page.goBack();
          await page.waitForURL(new URL(source, server.url).href);
          await list("Box001").waitFor();
          await ready(page);
          expect(await position("Box001"), "Back restores A after the asynchronous list replacement").toBe(240);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "Forward restores B's own list position").toBe(400);

          // Reverse a traversal while B is still shown. Its DOM must not become A's saved scroll snapshot.
          const backRequested = Promise.withResolvers<void>();
          const backReleased = Promise.withResolvers<void>();
          const backRoute = "**/api/mail/mailboxes/Box001/workspace-route?*";
          await page.route(backRoute, async (route) => {
            try {
              const response = await route.fetch();
              backRequested.resolve();
              await releaseBack.promise;
              // Forward aborts this client's old fetch; releasing its response must not commit A late.
              await route.fulfill({ response }).catch(() => undefined);
            } catch (error) {
              backRequested.reject(error);
            } finally {
              backReleased.resolve();
            }
          });
          await page.goBack();
          await backRequested.promise;
          expect(new URL(page.url()).pathname).toBe(boxPath);
          expect(await position("Box002"), "pending Back still shows the scrolled B list").toBe(400);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await ready(page);
          releaseBack.resolve();
          await backReleased.promise;
          await page.unroute(backRoute);
          await ready(page);
          expect(await position("Box002"), "Forward supersedes the pending A response").toBe(400);
          await page.goBack();
          await page.waitForURL(new URL(source, server.url).href);
          await list("Box001").waitFor();
          await ready(page);
          expect(await position("Box001"), "the pending reversal preserved A's own snapshot").toBe(240);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "B keeps its own snapshot after the reversal").toBe(400);
          const beforeReload = await geometry(page);
          await page.reload();
          await ready(page);
          expect(await position("Box002"), "reload keeps the shown entry's list position").toBe(400);
          const serverFrame = await recordedFrame(page, "server");
          assertFrame(beforeReload, serverFrame, "scrolled B reload server");
          assertFrame(serverFrame, await recordedFrame(page, "hydrated"), "scrolled B reload hydrated");
          assertFrame(serverFrame, await geometry(page), "scrolled B reload settled");
        } finally {
          releaseBack.resolve();
          await close(page);
        }
      });

      test("phone mailbox navigation sheet switches in place, closes, and Back returns to A", async () => {
        const source = `${boxPath}?navigation=1`;
        const page = await open(source, 390);
        let navigations = 0;
        // Same-document history changes also emit framenavigated; count actual document requests.
        page.on("request", (request) => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) ++navigations;
        });
        try {
          await page.evaluate(() => Reflect.set(window, "mailboxSwitchMarker", "kept"));
          await page.getByRole("button", { name: "Open mailbox navigation", exact: true }).tap();
          const menu = page.locator("dialog .k2b-navigation");
          await menu.waitFor({ state: "visible" });
          await menu.locator('a[href="/app/mail/Box002"]').tap();
          await page.waitForURL(new URL("/app/mail/Box002", server.url).href);
          await page.getByText("Example dispatch: Example request 1", { exact: true }).waitFor({ state: "visible" });
          await menu.waitFor({ state: "hidden" });
          await ready(page);
          expect(await page.evaluate(() => Reflect.get(window, "mailboxSwitchMarker"))).toBe("kept");
          await page.goBack();
          await page.waitForURL(new URL(source, server.url).href);
          await page.getByText("Example request 1", { exact: true }).first().waitFor({ state: "visible" });
          await ready(page);
          expect(await page.evaluate(() => Reflect.get(window, "mailboxSwitchMarker"))).toBe("kept");
          expect(navigations).toBe(0);
        } finally {
          await close(page);
        }
      });

      for (const path of [boxPath]) {
        test(`${path}: default first tab, exact fixture counts, no Paper`, async () => {
          const page = await open(path);
          try {
            const first = tabs(page).locator("a").first();
            expect(await first.getAttribute("href")).toBe(path);
            expect(await first.getAttribute("aria-current")).toBe("page");
            expect(await first.textContent()).toBe("All");
            const entries = Object.entries(viewCounts).filter(([id]) => id !== "send_problems");
            for (const [id, count] of entries) {
              const href = `${path}?view=${id}`;
              let link = tabs(page).locator(`a[href="${href}"]`);
              if (!(await link.count())) {
                await tabs(page).getByRole("button", { name: /More/ }).click();
                // Dropdown document links carry the menuitem role themselves.
                link = page.locator(`[role="menuitem"][href="${href}"]`);
                expect(await link.textContent()).toMatch(new RegExp(`${count}$`));
                await page.keyboard.press("Escape");
              } else expect(await link.textContent()).toMatch(new RegExp(`${count}$`));
            }
            expect(await page.locator(".k2b-app-workspace .k2b-paper").count()).toBe(0);
          } finally {
            await close(page);
          }
        });
      }

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`compact draft queue ${theme} ${width}: count stays in the head and draft links retain context`, async () => {
            const page = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&theme=${theme}`, width);
            try {
              const serverFrame = await recordedFrame(page, "server");
              assertFrame(serverFrame, await recordedFrame(page, "hydrated"), "draft queue hydrated");
              assertFrame(serverFrame, await geometry(page), "draft queue settled");
              expect(await page.locator(".k2b-app-workspace__head [data-mail-queue-count]").textContent()).toBe("2 drafts");
              expect(await page.locator("[data-mail-drafts-list] header").count()).toBe(0);
              const rows = page.locator("[data-mail-drafts-list] > [data-draft-id]");
              expect(await rows.count()).toBe(2);
              // A draft is a conversation row of the person's view: three lines with the reader beside the list, at the
              // conversations' fixed height (4.8125rem), so nothing moves between the lists.
              expect(await rows.first().getAttribute("data-lines")).toBe("3");
              for (const box of [await rows.first().boundingBox(), await rows.nth(1).boundingBox()])
                expect(Math.abs(box!.height - 77)).toBeLessThanOrEqual(1);
              const draft = rows.first().locator("a.mail-list-row");
              const tag = draft.locator(".mail-row-draft-tag");
              const subject = await draft.locator(".mail-row-subject").boundingBox();
              const recipients = await draft.locator(".mail-row-sender").boundingBox();
              const tagBox = await tag.boundingBox();
              expect(await tag.textContent()).toBe("Draft");
              // Recipients stand where the sender does; the tag leads the subject on the line below.
              expect(await draft.locator(".mail-row-sender").textContent()).toBe("Ada Example");
              expect(await rows.nth(1).locator(".mail-row-from .mail-row-more").textContent()).toBe("+1");
              expect(await rows.nth(1).locator('[aria-label="1 attachment"]').count()).toBe(1);
              expect(Math.abs(tagBox!.y + tagBox!.height / 2 - (subject!.y + subject!.height / 2))).toBeLessThanOrEqual(1);
              expect(tagBox!.x + tagBox!.width).toBeLessThanOrEqual(subject!.x);
              expect(subject!.y).toBeGreaterThanOrEqual(recipients!.y + recipients!.height - 1);
              expect(await draft.getAttribute("href")).toContain("/compose/Draft1?return=");
              expect(await draft.getAttribute("href")).toContain("folder%3DDrafts1");
              const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
              expect(overflow).toBe(false);
              if (screenshots) {
                mkdirSync(screenshots, { recursive: true });
                await page.screenshot({ path: join(screenshots, `compact-drafts-${theme}-${width}.png`) });
              }
              await draft.focus();
              expect(await draft.evaluate((element) => document.activeElement === element)).toBe(true);
              if (screenshots && width === 390 && theme === "light")
                await page.screenshot({ path: join(screenshots, `compact-drafts-focus-${theme}-${width}.png`) });
              await page.reload();
              await ready(page);
              expect(await page.locator("[data-mail-queue-count]").textContent()).toBe("2 drafts");
              expect(await page.locator("[data-draft-id]").count()).toBe(2);
            } finally {
              await close(page);
            }
            // The columns view draws one line per draft on a wide screen and two on a phone, as for conversations.
            const columns = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&layout=auto&theme=${theme}`, width);
            try {
              assertFrame(await recordedFrame(columns, "server"), await geometry(columns), "draft columns settled");
              const rows = columns.locator("[data-mail-drafts-list] > [data-draft-id]");
              expect(await rows.first().getAttribute("data-lines")).toBe("1");
              for (const box of [await rows.first().boundingBox(), await rows.nth(1).boundingBox()])
                expect(Math.abs(box!.height - (width < 768 ? 65 : 44))).toBeLessThanOrEqual(1);
              expect(await rows.first().locator(".mail-row-subject-cell > .mail-row-draft-tag").textContent()).toBe("Draft");
              expect(await rows.nth(1).locator(".mail-row-sender-cell").textContent()).toBe("Ada Example+1");
              expect(await columns.locator(".mail-columns-head").isVisible()).toBe(width >= 768);
              if (screenshots) await columns.screenshot({ path: join(screenshots, `compact-drafts-columns-${theme}-${width}.png`) });
            } finally {
              await close(columns);
            }
            const readOnly = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&permission=read&theme=${theme}`, width);
            try {
              expect(await readOnly.locator("[data-draft-id]").count()).toBe(2);
              expect(await readOnly.locator("[data-draft-id] a").count()).toBe(0);
              expect(await readOnly.locator("[data-draft-id] .k2b-dropdown__trigger").count()).toBe(0);
            } finally {
              await close(readOnly);
            }
            const scheduled = await open(`${boxPath}?scheduled=1&theme=${theme}`, width);
            try {
              expect(await scheduled.locator(".k2b-app-workspace__head [data-mail-queue-count]").count()).toBe(1);
              expect(await scheduled.locator(".k2b-app-workspace__main h1.sr-only").textContent()).toBe("Outbox");
            } finally {
              await close(scheduled);
            }
          });

      for (const width of [1440, 390])
        test(`a draft is deleted from its row at ${width}: right-click or …, confirmation, and a refused delete keeps it`, async () => {
          const page = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1`, width);
          const discards: unknown[] = [];
          let answer: { status: number; body: Record<string, string> } = {
            status: 409,
            body: { code: "DRAFT_LEASE_HELD", message: "This draft is being edited by Ben" },
          };
          await page.route("**/api/mail/mailboxes/Box001/drafts/*/discard", async (route) => {
            discards.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
            await route.fulfill({ status: answer.status, json: answer.body });
          });
          // Bounded by the case's own timeout.
          const until = async (condition: () => boolean) => {
            while (!condition()) await Bun.sleep(30);
          };
          try {
            const rows = page.locator("[data-mail-drafts-list] > [data-draft-id]");
            const first = rows.first();
            // Touch has no right-click; its "…" button opens the same menu. A mouse right-clicks the row.
            if (width === 390) await first.locator(".k2b-dropdown__trigger").click();
            else await first.locator("a.mail-list-row").click({ button: "right" });
            const menu = page.getByRole("menu");
            await menu.getByRole("menuitem", { name: "Delete draft" }).waitFor({ state: "visible" });
            expect((await menu.getByRole("menuitem").allTextContents()).map((label) => label.trim())).toEqual([
              "Continue editing",
              "Delete draft",
            ]);
            if (screenshots) {
              mkdirSync(screenshots, { recursive: true });
              await page.screenshot({ path: join(screenshots, `drafts-delete-menu-light-${width}.png`) });
            }
            await menu.getByRole("menuitem", { name: "Delete draft" }).click();
            const dialog = page.getByRole("dialog");
            await dialog.getByText("Delete draft?").waitFor({ state: "visible" });
            if (screenshots) await page.screenshot({ path: join(screenshots, `drafts-delete-confirm-light-${width}.png`) });
            await dialog.getByRole("button", { name: "Delete draft" }).click();
            await until(() => discards.length === 1);
            expect(discards[0]).toEqual({ url: "/api/mail/mailboxes/Box001/drafts/Draft1/discard", body: { expectedRevision: 3 } });
            // The composer elsewhere holds the draft: the error says so and the row keeps its place.
            await page.getByText("Someone is editing this draft right now", { exact: false }).waitFor({ state: "visible" });
            expect(await rows.count()).toBe(2);
            expect(await first.getAttribute("data-leaving")).toBeNull();
            answer = { status: 200, body: {} };
            await first.locator("a.mail-list-row").focus();
            await page.keyboard.press("Delete");
            await page.getByRole("dialog").getByRole("button", { name: "Delete draft" }).click();
            await until(() => discards.length === 2);
            await page.locator('[data-draft-id="Draft1"]').waitFor({ state: "detached" });
            expect(await rows.count()).toBe(1);
            await page.getByText("Draft deleted", { exact: true }).first().waitFor({ state: "visible" });
          } finally {
            await close(page);
          }
        });

      test("compact draft pagination stays centered and retains the folder", async () => {
        for (const width of [1440, 390]) {
          const page = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&drafts-cursor=1`, width);
          try {
            const list = page.locator("[data-mail-drafts-list]");
            const next = page.getByRole("link", { name: "Load more", exact: true });
            const bounds = await list.boundingBox();
            const button = await next.boundingBox();
            expect(bounds).not.toBeNull();
            expect(button).not.toBeNull();
            expect(Math.abs(button!.x + button!.width / 2 - bounds!.x - bounds!.width / 2)).toBeLessThanOrEqual(0.5);
            const href = new URL((await next.getAttribute("href"))!, page.url());
            expect(href.searchParams.get("folder")).toBe("Drafts1");
            expect(href.searchParams.get("cursor")).toBe("next");
          } finally {
            await close(page);
          }
        }
      });

      const tag = mailTagSearch("Tag001");
      if (!tag.ok) throw new Error("Invalid synthetic tag ID");
      const routes = [
        { query: "view=needs_action", selected: `${boxPath}?view=needs_action` },
        { query: "view=snoozed", selected: `${boxPath}?view=snoozed` },
        { query: "folder=Filed1", selected: null },
        { query: "savedView=Saved1", selected: `${boxPath}?savedView=Saved1` },
        { query: new URLSearchParams({ search: tag.value }).toString(), selected: boxPath },
        { query: "scheduled=1", selected: null },
      ];
      for (const route of routes)
        test(`${route.query}: SSR, in-place switch, Back, Forward and reload keep URL state`, async () => {
          const start = `${boxPath}?${route.query}`;
          const page = await open(start);
          const assertRoute = async () => {
            expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(start);
            if (route.selected) expect(await currentHref(page)).toBe(route.selected);
            else expect(await tabs(page).locator("a").count()).toBe(0);
            if (route.query.startsWith("folder="))
              expect(await sidebar(page).locator('a[href$="folder=Filed1"]').getAttribute("aria-current")).toBe("page");
            if (route.query.startsWith("search=")) {
              const tag = page.locator(".k2b-app-workspace__head-actions .mail-head-tag");
              expect(await tag.getAttribute("aria-label")).toBe("Tag: Priority");
              expect(await tag.getAttribute("data-active")).toBe("true");
            }
            if (route.query === "view=snoozed") {
              expect(await tabs(page).getByRole("button", { name: /More/ }).isVisible()).toBe(true);
              expect(await tabs(page).locator('a[aria-current="page"]').isVisible()).toBe(true);
            }
          };
          try {
            expect(await page.locator("html").getAttribute("data-server-current")).toBe(route.selected ?? "");
            await assertRoute();
            await page.reload();
            await ready(page);
            await assertRoute();
            // Places have no tabs; use the mailbox root link to get back to the strip first.
            if (!route.selected) {
              await sidebar(page).locator(`[data-mailbox="Box001"] a[href="${boxPath}"]`).click();
              await page.waitForURL(new URL(boxPath, server.url).href);
              await ready(page);
            }
            await clickTab(page, `${boxPath}?view=waiting`);
            expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
            await page.goBack();
            await ready(page);
            if (!route.selected) {
              await page.goBack();
              await ready(page);
            }
            await assertRoute();
            await page.goForward();
            await ready(page);
            if (!route.selected) {
              await page.goForward();
              await ready(page);
            }
            expect(new URL(page.url()).search).toBe("?view=waiting");
            expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
            await page.reload();
            await ready(page);
            expect(await currentHref(page)).toBe(`${boxPath}?view=waiting`);
          } finally {
            await close(page);
          }
        });
    });

    section("layout", () => {
      // #2507: on a phone the list always has its head, in every layout; the reader hides it and Back brings it back.
      for (const layout of ["auto", "columns", "split"] as const)
        for (const selected of [false, true])
          test(`390 ${layout}${selected ? " with a conversation" : ""}: the list shows its head with tabs and Compose`, async () => {
            const page = await open(`${boxPath}?layout=${layout}${selected ? "&conversation=Conv01" : ""}`, 390, 844);
            try {
              const head = page.locator(".mail-workspace > .k2b-app-workspace__head");
              const headShown = async () => {
                expect(await head.isVisible()).toBe(true);
                expect(await tabs(page).getByRole("link", { name: /^All/ }).isVisible()).toBe(true);
                expect(await page.locator("[data-workspace-primary]").isVisible()).toBe(true);
              };
              const recordedHead = async (name: "server" | "hydrated") =>
                (JSON.parse((await page.locator("html").getAttribute(`data-${name}-geometry`))!) as Frame).find(
                  (part) => part.part === "k2b-app-workspace__head",
                );
              const serverHead = await recordedHead("server");
              if (!selected) {
                // The server's first frame and the first hydrated one already have the head, so it never appears late.
                expect(serverHead?.height).toBeGreaterThan(0);
                expect((await recordedHead("hydrated"))?.height).toBe(serverHead?.height);
                await headShown();
                return;
              }
              expect(serverHead?.height).toBe(0);
              expect(await head.isVisible()).toBe(false);
              await page.locator(".mail-reader-back").click();
              await page.waitForFunction(() => !new URL(location.href).searchParams.has("conversation"));
              await settled(page);
              await headShown();
            } finally {
              await close(page);
            }
          });

      // F2: "Automatisch" shows columns until a conversation opens; one case per page (#1966).
      for (const width of [1440, 390])
        test(`views: automatic shows columns without a selection at ${width}, from the server on`, async () => {
          const page = await open(`${boxPath}?layout=auto`, width, width === 390 ? 844 : 900);
          try {
            const firstRow = page.locator('.mail-list-entry[data-lines="1"]').first();
            await firstRow.waitFor({ state: "visible" });
            // The server already drew the columns: the first row does not move once the page is interactive.
            const before = (await firstRow.boundingBox())!;
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            expect((await firstRow.boundingBox())!.y).toBe(before.y);
            expect(await page.locator(".mail-reader-title").count()).toBe(0);
            expect(await page.locator("[data-mail-day-group]").count()).toBeGreaterThan(0);
            if (width >= 768) {
              await page.locator(".mail-columns-head").waitFor({ state: "visible" });
              expect(before.height).toBeCloseTo(44, 0);
              await page.locator("[data-mail-view-menu]").waitFor({ state: "visible" });
            } else {
              // Phones: compact two-line rows without the column header.
              expect(await page.locator(".mail-columns-head").isVisible()).toBe(false);
              expect(before.height).toBeCloseTo(65, 0);
            }
            if (screenshots) await page.screenshot({ path: join(screenshots, `views-columns-light-${width}.png`) });
          } finally {
            await close(page);
          }
        });
      // S2: hiding the list is a View menu switch with [; × and Escape lead back to the unchanged list.
      test("views: the View menu hides the list beside the reader, and [ shows it again", async () => {
        const page = await open(`${boxPath}?conversation=Conv02`, 1440, 900);
        try {
          const list = page.locator("[data-mail-conversation-list]");
          const toolbar = page.locator("[data-mail-reader-toolbar]");
          const toggle = page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ });
          await list.waitFor({ state: "visible" });
          await page.locator("[data-mail-view-menu]").click();
          expect(await toggle.getAttribute("aria-checked")).toBe("false");
          expect(await toggle.isDisabled()).toBe(false);
          expect(await toggle.textContent()).toContain("The reader uses the full width.");
          expect(await toggle.locator(".k2b-kbd").isVisible()).toBe(true);
          await toggle.click();
          await toolbar.locator("[data-mail-reader-close]").waitFor({ state: "visible" });
          expect(await list.isVisible()).toBe(false);
          // The menu shows the switch on, and [ brings the list back without closing the conversation.
          await page.locator("[data-mail-view-menu]").click();
          expect(await toggle.getAttribute("aria-checked")).toBe("true");
          await page.keyboard.press("Escape");
          await page.locator("[data-mail-reader-heading]").focus();
          await page.keyboard.press("[");
          await list.waitFor({ state: "visible" });
          expect(await toolbar.locator("[data-mail-reader-close]").count()).toBe(0);
          expect(new URL(page.url()).searchParams.get("conversation")).toBe("Conv02");
          await page.keyboard.press("[");
          await toolbar.locator("[data-mail-reader-close]").waitFor({ state: "visible" });
          expect(await list.isVisible()).toBe(false);
        } finally {
          await close(page);
        }
      });

      test("views: without a reader beside the list, the switch is off and names the reason", async () => {
        for (const path of [boxPath, `${boxPath}?layout=auto&list=hidden`, `${boxPath}?layout=columns&conversation=Conv02`]) {
          const page = await open(path, 1440, 900);
          try {
            await page.locator("[data-mail-view-menu]").click();
            const toggle = page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ });
            await toggle.waitFor({ state: "visible" });
            expect(await toggle.isDisabled(), path).toBe(true);
            expect(await toggle.getAttribute("aria-checked"), path).toBe("false");
            expect(await toggle.textContent()).toContain("Only while reading beside the list.");
            await page.keyboard.press("Escape");
            await page.keyboard.press("[");
            await settled(page);
            expect(await page.locator("[data-mail-reader-close]").isVisible()).toBe(path.includes("conversation="));
          } finally {
            await close(page);
          }
        }
      });

      for (const [layout, leave, motion] of [
        ["columns", "close", "reduce"],
        ["columns", "Escape", "reduce"],
        ["hidden", "close", "reduce"],
        ["hidden", "Escape", "reduce"],
        // With motion, a view transition must not commit the list's first position over the restored one.
        ["hidden", "close", "no-preference"],
        ["columns", "Escape", "no-preference"],
      ] as const)
        test(`views: ${leave === "close" ? "×" : "Escape"} returns from a reader without the list (${layout}, ${motion} motion) to the same list`, async () => {
          const page = await open(
            layout === "columns" ? `${boxPath}?layout=columns` : `${boxPath}?layout=auto&list=hidden`,
            1440,
            560,
            motion,
          );
          try {
            const scroller = page.locator('[data-scroll-preserve="mail-list-Box001"]');
            const row = page.locator('[data-conversation-id="Conv09"] .mail-list-row').first();
            await row.waitFor({ state: "visible" });
            await scroller.evaluate((element) => {
              element.scrollTop = 160;
            });
            await settled(page);
            const scrolled = await scroller.evaluate((element) => element.scrollTop);
            expect(scrolled).toBeGreaterThan(0);
            await row.click();
            await page.waitForURL(/conversation=Conv09/);
            const toolbar = page.locator("[data-mail-reader-toolbar]");
            await toolbar.locator("[data-mail-reader-close]").waitFor({ state: "visible" });
            expect(await page.locator("[data-mail-conversation-list]").isVisible()).toBe(false);
            if (leave === "close") await toolbar.locator("[data-mail-reader-close]").click();
            else await pressEscapeForWorkspace(page);
            await page.waitForURL((url) => !url.searchParams.has("conversation"));
            await page.locator("[data-mail-conversation-list]").waitFor({ state: "visible" });
            await settled(page);
            // The same list, at the same place, with the row that was open in focus.
            expect(Math.abs((await scroller.evaluate((element) => element.scrollTop)) - scrolled)).toBeLessThanOrEqual(1);
            expect(
              await page.evaluate(() => document.activeElement?.closest("[data-conversation-id]")?.getAttribute("data-conversation-id")),
            ).toBe("Conv09");
            // Escape in a list without a reader changes nothing.
            await pressEscapeForWorkspace(page);
            await settled(page);
            expect(new URL(page.url()).searchParams.has("conversation")).toBe(false);
          } finally {
            await close(page);
          }
        });

      if (screenshots)
        test("optional View menu review screenshots", async () => {
          const directory = join(resolve(screenshots), "view-menu");
          mkdirSync(directory, { recursive: true });
          for (const [width, height] of [
            [1440, 900],
            [1024, 768],
            [390, 844],
          ] as const) {
            const page = await open(`${boxPath}?layout=auto&conversation=Conv02&theme=light`, width, height);
            try {
              await settled(page);
              await page.screenshot({ path: join(directory, `${width}-reader.png`) });
              if (width === 390) continue;
              await page.locator("[data-mail-view-menu]").click();
              await page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ }).waitFor({ state: "visible" });
              await page.waitForTimeout(150);
              await page.screenshot({ path: join(directory, `${width}-view-menu.png`) });
              await page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ }).click();
              await page.locator("[data-mail-reader-close]").waitFor({ state: "visible" });
              await page.mouse.move(0, 0);
              await page.waitForTimeout(150);
              await page.screenshot({ path: join(directory, `${width}-list-hidden.png`) });
              await pressEscapeForWorkspace(page);
              await page.waitForURL((url) => !url.searchParams.has("conversation"));
              await page.locator("[data-mail-view-menu]").click();
              await page.getByRole("menuitemcheckbox", { name: /Hide conversation list/ }).waitFor({ state: "visible" });
              await page.waitForTimeout(150);
              await page.screenshot({ path: join(directory, `${width}-view-menu-unavailable.png`) });
            } finally {
              await close(page);
            }
          }
        });

      test("views: the day's done line above the list", async () => {
        const page = await open(`${boxPath}?layout=auto&done=19,14`, 1440, 900);
        try {
          const line = page.locator("[data-mail-done-line]");
          await line.getByText("Heute 19 erledigt").or(line.getByText("19 done today")).waitFor();
          await line.getByRole("progressbar").waitFor({ state: "attached" });
          expect((await line.boundingBox())!.height).toBeCloseTo(28, 0);
          if (screenshots) await page.screenshot({ path: join(screenshots, "views-done-line-light-1440.png") });
        } finally {
          await close(page);
        }
      });
      test("views: All done with the way to the log", async () => {
        const page = await open(`${boxPath}?layout=auto&done=26,17&inbox=empty`, 1440, 900);
        try {
          const done = page.locator("[data-mail-all-done]");
          await done.waitFor({ state: "visible" });
          expect(await done.getByRole("link").getAttribute("href")).toBe("/app/mail/Box001/automations/log");
          expect(await page.locator("[data-mail-list-count]").count()).toBe(0);
          if (screenshots) await page.screenshot({ path: join(screenshots, "views-all-done-light-1440.png") });
        } finally {
          await close(page);
        }
      });

      for (const width of [1440, 390])
        test(`views ${width}: a work list names its hidden done conversations at its end and shows them in place`, async () => {
          const page = await open(`${boxPath}?folder=Inbox1&hidden=1207&locale=de`, width);
          try {
            const footer = page.locator("[data-mail-hidden-done]");
            await footer.waitFor({ state: "visible" });
            expect(await footer.textContent()).toBe("1.207 erledigte Unterhaltungen·Erledigt anzeigen");
            // One fixed line after the rows: it never moves what is above it.
            expect((await footer.boundingBox())!.height).toBeCloseTo(32, 0);
            const rows = page.locator("[data-mail-conversation-list] [role='list']");
            expect((await footer.boundingBox())!.y).toBeGreaterThanOrEqual(
              (await rows.boundingBox())!.y + (await rows.boundingBox())!.height,
            );
            if (screenshots) {
              await footer.evaluate((element) => element.scrollIntoView({ block: "end" }));
              await settled(page);
              await page.screenshot({ path: join(screenshots, `views-hidden-done-light-${width}.png`) });
            }
            const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
            await footer.getByRole("link", { name: "Erledigt anzeigen", exact: true }).click();
            await response;
            await ready(page);
            const url = new URL(page.url());
            expect(url.searchParams.get("folder")).toBe("Inbox1");
            expect(JSON.parse(url.searchParams.get("search")!).expression).toEqual({
              type: "and",
              expressions: [
                { type: "folder_id", folderId: "Inbox1" },
                { type: "work_status", value: "done" },
              ],
            });
            if (screenshots) await page.screenshot({ path: join(screenshots, `views-show-done-light-${width}.png`) });
            await page.goBack();
            await ready(page);
            expect(new URL(page.url()).searchParams.has("search")).toBe(false);
            await footer.waitFor({ state: "visible" });
          } finally {
            await close(page);
          }
        });
      test("views: an empty work list and All done still offer the done conversations", async () => {
        for (const [path, name] of [
          [`${boxPath}?folder=Inbox1&inbox=empty&hidden=3&locale=de`, "empty"],
          [`${boxPath}?layout=auto&done=26,17&inbox=empty&hidden=1207&locale=de`, "all-done"],
          [`${boxPath}?layout=auto&hidden=unknown&locale=de`, "uncounted"],
        ] as const) {
          const page = await open(path, 1440);
          try {
            const footer = page.locator("[data-mail-hidden-done]");
            await footer.waitFor({ state: "visible" });
            expect(await footer.getByRole("link").getAttribute("href")).toContain("/app/mail/Box001");
            if (screenshots) {
              await footer.evaluate((element) => element.scrollIntoView({ block: "end" }));
              await settled(page);
              await page.screenshot({ path: join(screenshots, `views-hidden-done-${name}-light-1440.png`) });
            }
          } finally {
            await close(page);
          }
        }
      });

      for (const permission of ["write", "read", "admin", "assigned-only"])
        test(`${permission}: head and sidebar share the authorized mailbox menu`, async () => {
          const page = await open(`${boxPath}?permission=${permission}`);
          try {
            const head = page.locator(".k2b-app-workspace__head-actions").getByRole("button", { name: "Options for Example support" });
            const row = sidebar(page).getByRole("button", { name: "Options for Example support" });
            // The open row's "…" also holds its own pin and hide, which need no mailbox-wide access. The fixture pins it.
            const rowOnly = ["Unpin Example support", "Hide Example support"];
            const expected =
              permission === "assigned-only"
                ? []
                : [
                    permission === "read" ? "About this mailbox" : "Mailbox details",
                    "Automations",
                    "Mailing lists",
                    "Remote images",
                    "Email link setup",
                    "Settings",
                    ...(permission === "admin" ? ["Sync mailbox", "Mailbox health", "Shared links"] : []),
                  ];
            expect(await head.count()).toBe(1);
            if (permission === "assigned-only") expect(await page.getByRole("link", { name: "Compose", exact: true }).count()).toBe(0);
            expect(await page.getByRole("button", { name: "Select conversations", exact: true }).count()).toBe(
              permission === "read" ? 0 : 1,
            );
            expect(await row.count()).toBe(1);
            for (const [trigger, items] of [
              [head, ["Conversation view", "Message view", ...expected]] as const,
              [row, [...expected, ...rowOnly]] as const,
            ]) {
              await trigger.click();
              await page.getByRole("menu").waitFor();
              expect((await page.getByRole("menuitem").allTextContents()).map((text) => text.trim()).sort()).toEqual([...items].sort());
              await page.keyboard.press("Escape");
              await page.getByRole("menu").waitFor({ state: "hidden" });
            }
          } finally {
            await close(page);
          }
        });

      test("dragging a list row to a custom folder submits its move; unread counts and More persist", async () => {
        const page = await open(boxPath);
        try {
          const destination = sidebar(page).locator('a[href$="folder=Filed1"]');
          expect(await destination.textContent()).toContain("7 unread");
          const action = page.waitForRequest(
            (request) => request.method() === "POST" && request.url().endsWith("/conversations/Conv01/actions"),
          );
          await page.locator('[data-conversation-id="Conv01"] [draggable="true"]').dragTo(destination);
          const request = await action;
          expect(request.postDataJSON()).toMatchObject({ kind: "move_to_folder", sourceFolderId: "Inbox1", destinationFolderId: "Filed1" });
          await sidebar(page).getByRole("button", { name: "More", exact: true }).click();
          for (const id of ["Archive1", "Trash1", "Junk1"])
            expect(await sidebar(page).locator(`a[href$="folder=${id}"]`).isVisible()).toBe(true);
          await sidebar(page).locator('a[href$="folder=Archive1"]').click();
          await page.waitForURL(new URL(`${boxPath}?folder=Archive1`, server.url).href);
          await settled(page);
          await sidebar(page).getByRole("button", { name: "More", exact: true }).click();
          expect(await sidebar(page).locator('a[href$="folder=Archive1"]').isVisible()).toBe(true);
          await page.reload();
          await ready(page);
          expect(await sidebar(page).locator('a[href$="folder=Archive1"]').getAttribute("aria-current")).toBe("page");
          expect(await sidebar(page).locator('a[href$="folder=Junk1"]').isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("hidden mailboxes have a link and a working Show action", async () => {
        const page = await open(boxPath);
        try {
          const section = sidebar(page).locator(".mail-sidebar-hidden-mailboxes");
          await section.getByRole("button", { name: /^Hidden/ }).click();
          const hidden = section.locator('[data-mailbox="Box005"]');
          expect(await hidden.locator("a").getAttribute("href")).toBe("/app/mail/Box005");
          const saved = page.waitForRequest((request) => request.method() === "PATCH" && request.url().endsWith("/Box005/preference"));
          await hidden.hover();
          await hidden.getByRole("button", { name: /Show/ }).click();
          expect((await saved).postDataJSON()).toEqual({ hidden: false });
          await sidebar(page).locator('[data-mailbox="Box005"]:not([data-hidden="true"])').waitFor();
        } finally {
          await close(page);
        }
      });

      for (const path of [boxPath]) {
        test(`${path}: sidebar resizes with pointer and ArrowLeft/ArrowRight/Home`, async () => {
          const page = await open(path);
          try {
            const handle = page.getByRole("separator", { name: "Resize navigation", exact: true });
            const before = Number(await handle.getAttribute("aria-valuenow"));
            const box = await handle.boundingBox();
            if (!box) throw new Error("Missing navigation resize handle");
            await page.mouse.move(box.x + box.width / 2, box.y + 60);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 48, box.y + 60, { steps: 5 });
            await page.mouse.up();
            await page.waitForFunction(
              (before) => Number(document.querySelector('[data-app-workspace-resize="sidebar"]')?.getAttribute("aria-valuenow")) > before,
              before,
            );
            await settled(page);
            expect((await page.locator(".mail-sidebar").boundingBox())!.width).toBeGreaterThan(before);
            for (const key of ["ArrowLeft", "ArrowRight", "Home"]) {
              const previous = Number(await handle.getAttribute("aria-valuenow"));
              await handle.focus();
              await page.keyboard.press(key);
              await page.waitForFunction(
                ({ key, previous }) => {
                  const handle = document.querySelector('[data-app-workspace-resize="sidebar"]')!;
                  const value = Number(handle.getAttribute("aria-valuenow"));
                  return key === "Home"
                    ? value === Number(handle.getAttribute("aria-valuemin"))
                    : key === "ArrowLeft"
                      ? value < previous
                      : value > previous;
                },
                { key, previous },
              );
              await settled(page);
              expect((await page.locator(".mail-sidebar").boundingBox())!.width).toBeCloseTo(
                Number(await handle.getAttribute("aria-valuenow")),
                0,
              );
            }
          } finally {
            await close(page);
          }
        });
        test(`${path}: phone tabs are the card's first row`, async () => {
          const page = await open(path, 390);
          try {
            const views = await tabs(page).boundingBox();
            const workspace = await page.locator(".k2b-app-workspace").boundingBox();
            expect(views).not.toBeNull();
            expect(workspace).not.toBeNull();
            if (!views || !workspace) throw new Error("Missing phone frame");
            const filters =
              (await page.locator(".k2b-app-workspace__head-filters").count()) > 0
                ? await page.locator(".k2b-app-workspace__head-filters").boundingBox()
                : null;
            if (filters) expect(views.y + views.height).toBeLessThanOrEqual(filters.y + 0.5);
            const rows = await page.locator(".mail-list-entry").first().boundingBox();
            expect(views.y + views.height).toBeLessThanOrEqual(rows!.y);
            const firstRowY = await page.locator(".k2b-app-workspace__head").evaluate((head) => {
              const style = getComputedStyle(head);
              return head.getBoundingClientRect().y + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.borderTopWidth);
            });
            // The tabs share the head's first row with the actions, which may be taller and center the row.
            expect(views.y - firstRowY, "Tabs occupy the head's first content row").toBeLessThan(8);
          } finally {
            await close(page);
          }
        });
        test(`${path}: selecting a tab moves no neighboring tab, chip or head action`, async () => {
          const page = await open(path);
          try {
            const neighbors = page.locator(
              `${tabsSelector} [data-view-tab],.k2b-app-workspace__head-filters,.k2b-filter-chip,.k2b-app-workspace__head-actions,.k2b-app-workspace__head-actions button,[data-workspace-primary]`,
            );
            const boxes = () =>
              neighbors.evaluateAll((elements) =>
                elements.map((e) => {
                  const r = e.getBoundingClientRect();
                  return { part: e.getAttribute("data-view-tab") ?? e.className, x: r.x, y: r.y, width: r.width, height: r.height };
                }),
              );
            const before = await boxes();
            expect(before.length).toBeGreaterThan(3);
            await clickTab(page, `${path}?view=waiting`);
            await settled(page);
            expect(await boxes()).toEqual(before);
          } finally {
            await close(page);
          }
        });
      }

      for (const locale of ["en", "de"] as const)
        for (const path of [boxPath, `${boxPath}?view=snoozed`])
          test(`390 ${locale} ${path}: tabs keep full labels, and the current tab is in the strip before and after hydration`, async () => {
            const page = await open(`${path}${path.includes("?") ? "&" : "?"}locale=${locale}`, 390);
            try {
              for (const name of ["server", "hydrated", "settled"] as const) {
                const label = `${path} ${locale} ${name}`;
                const strip: Strip | null =
                  name === "settled"
                    ? await page.evaluate(`(${stripSource})()`)
                    : JSON.parse((await page.locator("html").getAttribute(`data-${name}-strip`)) ?? "null");
                if (!strip) throw new Error(`${label}: missing view strip`);
                expect(strip.labels.length, `${label}: visible tab labels`).toBeGreaterThanOrEqual(3);
                for (const tab of strip.labels) expect(tab.scroll, `${label}: "${tab.text}" is clipped`).toBeLessThanOrEqual(tab.width);
                expect(strip.current, label).toBe(path);
                expect(strip.left, `${label}: current tab's left edge`).toBeGreaterThanOrEqual(strip.leftInset - 0.5);
                expect(strip.right, `${label}: current tab's right edge`).toBeGreaterThanOrEqual(strip.rightInset - 0.5);
              }
            } finally {
              await close(page);
            }
          });

      for (const width of [1440, 834, 390] as const)
        test(`${width}: a folder is named where the person sees it`, async () => {
          const page = await open(`${boxPath}?folder=Filed1`, width);
          try {
            const heading = page.locator("[data-mail-head-title]");
            expect(await heading.textContent()).toBe("Filed");
            const box = await heading.boundingBox();
            if (width === 1440) {
              // Beside the sidebar its marked row names the folder; the heading stays for assistive technology.
              expect(await sidebar(page).locator('a[href$="folder=Filed1"]').getAttribute("aria-current")).toBe("page");
              expect(box?.width ?? 0).toBeLessThanOrEqual(1);
            } else {
              // Below 64 rem the sidebar is out of view and folders have no tab: the list heading names the folder.
              expect(await sidebar(page).isVisible()).toBe(false);
              expect(box?.width ?? 0).toBeGreaterThan(20);
              expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            }
          } finally {
            await close(page);
          }
        });

      test("1440: a folder is named where the person sees it even without a sidebar row", async () => {
        const page = await open(`${boxPath}?folder=Quiet1`, 1440);
        try {
          expect(await sidebar(page).locator('a[href$="folder=Quiet1"]').count()).toBe(0);
          const heading = page.locator("[data-mail-head-title]");
          expect(await heading.textContent()).toBe("Quiet");
          expect((await heading.boundingBox())?.width ?? 0).toBeGreaterThan(20);
          expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("1440: collapsing the open folder's parent leaves its name in the list heading", async () => {
        const page = await open(`${boxPath}?folder=Child1`, 1440);
        try {
          const heading = page.locator("[data-mail-head-title]");
          const childRow = sidebar(page).locator('a[href$="folder=Child1"]');
          const toggle = sidebar(page).locator(
            '[role="treeitem"][data-k2b-nav-tree-id="Filed1"] > .k2b-app-workspace__nav-tree-row [data-k2b-nav-tree-toggle]',
          );
          await settled(page);
          expect(await childRow.count()).toBe(1);
          expect((await heading.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);

          await toggle.click();
          await settled(page);
          expect(await childRow.count()).toBe(0);
          expect(await heading.textContent()).toBe("Nested");
          expect((await heading.boundingBox())?.width ?? 0).toBeGreaterThan(20);

          await toggle.click();
          await settled(page);
          expect(await childRow.count()).toBe(1);
          expect((await heading.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
        } finally {
          await close(page);
        }
      });

      test("the open mailbox's name stays readable beside its row actions at the default width", async () => {
        const page = await open(boxPath);
        try {
          const row = sidebar(page).locator('.mail-sidebar-mailbox[data-mailbox="Box001"]');
          // The open row shows its actions without hover; only "…" stays there, with pin and hide inside it.
          // The menu renders inside the actions; its items are not row buttons.
          const buttons = row.locator('.k2b-app-workspace__sidebar-item-actions button:not([role="menuitem"])');
          expect(await buttons.count()).toBe(1);
          expect(await buttons.getAttribute("aria-label")).toBe("Options for Example support");
          const fit = await row.evaluate((element) => {
            const label = element.querySelector(".k2b-app-workspace__sidebar-item-label")!;
            const range = document.createRange();
            range.selectNodeContents(label);
            // The leftmost row action: the name may run into its padding, where the label fades, but not past its middle.
            const actions = Array.from(
              element.querySelectorAll('.k2b-app-workspace__sidebar-item-actions button:not([role="menuitem"])'),
              (button) => button.getBoundingClientRect(),
            ).filter((box) => box.width > 0);
            const first = actions.reduce((left, box) => (box.x < left.x ? box : left));
            return { textEnd: range.getBoundingClientRect().right, actionMiddle: first.x + first.width / 2 };
          });
          expect(fit.textEnd).toBeLessThanOrEqual(fit.actionMiddle);
        } finally {
          await close(page);
        }
      });

      for (const path of [boxPath])
        test(`${path}: a mailbox row's count keeps the same inset from the group's right edge as its icon from the left`, async () => {
          const page = await open(path);
          try {
            const insets = await page.evaluate(() =>
              [
                ...document.querySelectorAll<HTMLElement>(".mail-sidebar .k2b-app-workspace__sidebar-desktop .mail-sidebar-mailbox"),
              ].flatMap((row) => {
                const count = row.querySelector(".mail-sidebar-needs-action");
                const icon = row.querySelector(".k2b-app-workspace__sidebar-item-icon");
                const card = row.closest(".mail-sidebar-mailbox-group") ?? row;
                if (!count?.textContent || !icon || icon.getBoundingClientRect().width === 0) return [];
                const range = document.createRange();
                range.selectNodeContents(count);
                const frame = card.getBoundingClientRect();
                return [
                  {
                    mailbox: row.dataset.mailbox ?? "",
                    left: icon.getBoundingClientRect().left - frame.left,
                    right: frame.right - range.getBoundingClientRect().right,
                  },
                ];
              }),
            );
            expect(insets.length).toBeGreaterThan(0);
            for (const inset of insets) expect(Math.abs(inset.right - inset.left), inset.mailbox).toBeLessThanOrEqual(0.5);
          } finally {
            await close(page);
          }
        });

      // Each URL opens in its own page (testing.md: an in-place goto can stall in WebKit, #1367); reload is the subject.
      for (const theme of ["light", "dark"] as const)
        for (const [width, height] of sizes)
          for (const path of [boxPath])
            test(`${theme} ${width}x${height} ${path}: server = hydrated = settled = reload within 0.5px`, async () => {
              const differences: string[] = [];
              const page = await open(`${path}?theme=${theme}`, width, height);
              try {
                const serverFrame = await recordedFrame(page, "server");
                expect(serverFrame.some((part) => part.part.includes("head"))).toBe(true);
                expect(serverFrame.filter((part) => part.part.includes("mail-list-entry")).length).toBeGreaterThan(0);
                const compare = async (label: string, expected: Frame, actual: Frame) => {
                  try {
                    assertFrame(expected, actual, `${path} ${label}`);
                  } catch (error) {
                    differences.push(String(error));
                  }
                };
                // Rows keep their height in the first hydrated frame too (#1545).
                await compare("hydrated", serverFrame, await recordedFrame(page, "hydrated"));
                await compare("settled", serverFrame, await geometry(page));
                await page.reload();
                await ready(page);
                await compare("reload SSR", serverFrame, await recordedFrame(page, "server"));
                await compare("reload hydrated", serverFrame, await recordedFrame(page, "hydrated"));
                await compare("reload settled", serverFrame, await geometry(page));
              } finally {
                await close(page);
              }
              expect(differences).toEqual([]);
            });

      test("German locale uses the same hydrated sidebar and head", async () => {
        for (const path of [boxPath]) {
          const page = await open(`${path}?locale=de`);
          try {
            expect(await page.locator("html").getAttribute("lang")).toBe("de");
            expect(await tabs(page).locator('a[aria-current="page"]').textContent()).toBe("Alle");
            expect(await page.locator(".mail-sidebar").getAttribute("aria-label")).toBe("Postfächer");
          } finally {
            await close(page);
          }
        }
      });
    });

    describe("Mail wide windows", () => {
      /** Cloud's card with the mockup's 240 px sidebar, a conversation open and its details on. */
      const widePath = (options: { panel?: number; path?: string; extra?: string } = {}) =>
        `${options.path ?? `${boxPath}?conversation=Conv01&details=1`}${(options.path ?? "?").includes("?") ? "&" : "?"}shell=1&sidebar=240${options.panel ? `&panel=${options.panel}` : ""}${options.extra ?? ""}`;
      type Box = { x: number; y: number; width: number; height: number };
      type Wide = {
        list: number;
        pane: Box | null;
        reader: Box | null;
        column: Box | null;
        toolbar: Box | null;
        sidebar: Box | null;
        head: Box | null;
        detail: "column" | "waiting" | "drawer" | "closed";
        detailWidth: number;
        headDetails: boolean;
      };
      const wide = (page: Page): Promise<Wide> =>
        page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element || element.getClientRects().length === 0) return null;
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const aside = document.querySelector<HTMLElement>(".mail-workspace .k2b-app-workspace__detail");
          const toggle = document.querySelector<HTMLElement>(".mail-workspace .k2b-app-workspace__detail-toggle");
          const pane = box(".mail-workspace .k2b-app-workspace__main-pane");
          return {
            // The list pane holds the list and the shared 12 px gap to the reader.
            list: pane ? pane.width - 12 : 0,
            pane,
            reader: box(".mail-workspace .k2b-app-workspace__main-primary"),
            column: box(".mail-reading-column"),
            toolbar: box(".mail-reader-toolbar"),
            sidebar: box(".mail-workspace .k2b-app-workspace__sidebar"),
            head: box(".mail-workspace .k2b-app-workspace__head"),
            detail:
              !aside || aside.hidden
                ? "closed"
                : getComputedStyle(aside).display === "none"
                  ? "waiting"
                  : aside.dataset.workspaceDetailDrawer === "open"
                    ? "drawer"
                    : "column",
            detailWidth: aside?.getBoundingClientRect().width ?? 0,
            headDetails: Boolean(toggle && getComputedStyle(toggle).display !== "none"),
          };
        });
      const sameBox = (actual: Box | null, expected: Box | null, label: string) => {
        expect(Boolean(actual), label).toBe(Boolean(expected));
        if (!actual || !expected) return;
        for (const key of ["x", "y", "width", "height"] as const)
          expect(Math.abs(actual[key] - expected[key]), `${label}.${key}: ${expected[key]} → ${actual[key]}`).toBeLessThanOrEqual(0.5);
      };
      // Where the shared frame differs from the mockup's: a Detail column keeps an 8 px inset and the card a 1 px edge,
      // while the list's gap to the reader is 12 px instead of 16 px, so a reader beside a column is 6 px narrower.
      const COLUMN_EDGES = 6;
      const table = [
        { width: 1440, height: 900, panel: 0, list: 320, reader: 800, detail: "waiting" },
        // The mockup drew the sidebar as a column in a 952 px card. Below a 64 rem host the shared sidebar is the
        // overlay (#1380), so the reader also gets the 240 px: 952 - 2 - 332.
        { width: 1440, height: 900, panel: 416, list: 320, reader: 618, detail: "waiting" },
        { width: 1920, height: 1080, panel: 0, list: 440, reader: 680 - COLUMN_EDGES, detail: "column" },
        { width: 1920, height: 1080, panel: 416, list: 334, reader: 842, detail: "waiting" },
        { width: 2560, height: 1080, panel: 0, list: 440, reader: 1320 - COLUMN_EDGES, detail: "column" },
        { width: 2560, height: 1080, panel: 416, list: 440, reader: 896 - COLUMN_EDGES, detail: "column" },
      ] as const;

      section("wide", () => {
        /** The head's view strip: which tabs show, what More counts, and whether the shown ones fit its room. */
        const headTabs = (page: Page) =>
          page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(".mail-workspace .k2b-view-tabs__list")!;
            const shown = (element: Element) => element.getClientRects().length > 0;
            const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > .k2b-view-tabs__item"));
            const more = list.querySelector<HTMLElement>(":scope > .k2b-view-tabs__more");
            const count =
              more && shown(more) ? Array.from(more.querySelectorAll(".k2b-view-tabs__more-count")).find(shown)?.textContent : null;
            const boxes = Array.from(list.children)
              .filter(shown)
              .map((child) => child.getBoundingClientRect());
            const style = getComputedStyle(list);
            const room = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const bounds = list.getBoundingClientRect();
            const events = list.querySelector('[data-view-tab="events"]')!.getBoundingClientRect();
            return {
              shown: items.filter((item) => shown(item) && !item.hasAttribute("data-pinned")).map((item) => item.dataset.viewTab!),
              flowing: items.filter((item) => !item.hasAttribute("data-pinned")).length,
              more: count ? Number(count.replace("+", "")) : 0,
              overflow: Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left)) - room,
              eventsWhole: events.width > 0 && events.left >= bounds.left - 0.5 && events.right <= bounds.right + 0.5,
            };
          });

        // S3: on wide screens the number of tabs follows the head's room instead of five and More.
        for (const [width, height, reading, least, most] of [
          [1680, 1050, false, 8, 99],
          [1680, 1050, true, 6, 99],
          [1280, 800, false, 4, 99],
          [1280, 800, true, 2, 5],
          [1024, 768, true, 1, 3],
        ] as const)
          test(`S3 head at ${width}${reading ? " while reading" : ""}: the tabs fill the head's room, More counts the rest, Events stays whole`, async () => {
            const page = await open(`${boxPath}?layout=auto${reading ? "&conversation=Conv01" : ""}`, width, height);
            try {
              await settled(page);
              const tabs = await headTabs(page);
              expect(tabs.overflow, JSON.stringify(tabs)).toBeLessThanOrEqual(1);
              expect(tabs.eventsWhole).toBe(true);
              expect(tabs.shown).toContain("all");
              expect(tabs.shown.length + tabs.more).toBe(tabs.flowing);
              expect(tabs.shown.length).toBeGreaterThanOrEqual(least);
              expect(tabs.shown.length).toBeLessThanOrEqual(most);
              // An open view beyond the room keeps its place in the strip.
              await page.goto(new URL(`${boxPath}?layout=auto&view=kept${reading ? "&conversation=Conv01" : ""}`, server.url).href);
              await ready(page);
              await settled(page);
              const kept = await headTabs(page);
              expect(kept.shown).toContain("kept");
              expect(kept.overflow).toBeLessThanOrEqual(1);
              expect(kept.shown.length + kept.more).toBe(kept.flowing);
            } finally {
              await close(page);
            }
          });

        // The fit converges: a bounded number of passes on load and per resize, then none while nothing changes.
        // A pass clears every view's fit mark first, so the calls on the "All" view count the passes. WebKit reports a
        // ResizeObserver loop as a page error, which close() checks; the window listener covers Chromium.
        for (const reading of [false, true])
          test(`S3 head${reading ? " while reading" : ""}: the tab fit settles in a bounded number of passes and then stays still`, async () => {
            const page = await open(`${boxPath}?layout=auto${reading ? "&conversation=Conv01" : ""}`, 834, 1194);
            try {
              await page.addInitScript(() => {
                const state = { passes: 0, loops: [] as string[] };
                Reflect.set(window, "fitState", state);
                const remove = Element.prototype.removeAttribute;
                Element.prototype.removeAttribute = function (this: Element, name: string) {
                  if (name === "data-fit-hidden" && this.matches('.mail-workspace .k2b-view-tabs__item[data-view-tab="all"]'))
                    state.passes += 1;
                  return remove.call(this, name);
                };
                window.addEventListener("error", (event) => {
                  if (String(event.message).includes("ResizeObserver")) state.loops.push(event.message);
                });
              });
              await page.reload();
              await ready(page);
              await settled(page);
              const frames = (count: number) =>
                page.evaluate(
                  (count) =>
                    new Promise<void>((done) => {
                      let left = count;
                      const step = () => (--left <= 0 ? done() : requestAnimationFrame(step));
                      requestAnimationFrame(step);
                    }),
                  count,
                );
              const fit = () => page.evaluate(() => Reflect.get(window, "fitState") as { passes: number; loops: string[] });
              await frames(10);
              const loaded = (await fit()).passes;
              // The server frame and its next frame, the client render, its mount and next frame; 6 in Chromium.
              expect(loaded).toBeLessThanOrEqual(8);
              await frames(10);
              expect((await fit()).passes, "no passes while nothing changes").toBe(loaded);
              let before = loaded;
              for (const width of [1680, 900, 1440, 834]) {
                await page.setViewportSize({ width, height: 1194 });
                await frames(10);
                const after = (await fit()).passes;
                expect(after - before, `passes for ${width}`).toBeLessThanOrEqual(2);
                await frames(10);
                expect((await fit()).passes, `still at ${width}`).toBe(after);
                before = after;
              }
              expect((await fit()).loops).toEqual([]);
            } finally {
              await close(page);
            }
          });

        // A first visit can paint before the web fonts load (font-display: swap): the fit must then follow the fonts, so
        // the server frame, measured once they are ready, and the client render show the same tabs.
        for (const [width, height] of [
          [1440, 900],
          [834, 1194],
        ] as const)
          test(`S3 head at ${width}: web fonts that load late fit the server frame like the client render`, async () => {
            const page = await open(`${boxPath}?layout=auto`, width, height, "reduce", async (page) => {
              await page.route(/\.woff2(\?|$)/, async (route) => {
                // The text font late, the icon font later: the Events tab's icon then widens after the head settled.
                await new Promise((done) => setTimeout(done, route.request().url().includes("ibm-plex") ? 300 : 700));
                await route.continue();
              });
            });
            try {
              // Visible tab labels and the strip's right edge, before and after the client render.
              const strip = async (name: "server" | "hydrated") => {
                const value: { right: number; labels: { text: string }[] } = JSON.parse(
                  (await page.locator("html").getAttribute(`data-${name}-strip`))!,
                );
                return { right: value.right, labels: value.labels.map((label) => label.text) };
              };
              const server = await strip("server");
              const hydrated = await strip("hydrated");
              expect(hydrated.labels).toEqual(server.labels);
              expect(Math.abs(hydrated.right - server.right)).toBeLessThanOrEqual(0.5);
              assertFrame(await recordedFrame(page, "server"), await recordedFrame(page, "hydrated"), "server → hydrated");
              await settled(page);
              expect((await headTabs(page)).overflow).toBeLessThanOrEqual(1);
            } finally {
              await close(page);
            }
          });

        test("S3 head on a phone: the view strip keeps scrolling with its first views and More", async () => {
          const page = await open(`${boxPath}?layout=auto`, 390, 844);
          try {
            await settled(page);
            expect(await page.locator(".mail-workspace .k2b-view-tabs__item[data-fit-hidden]").count()).toBe(0);
            expect((await headTabs(page)).shown).toEqual(["all", "needs_action", "mine"]);
          } finally {
            await close(page);
          }
        });

        test("S3 head: widening and narrowing the window brings tabs back and lets them go, without overflow", async () => {
          const page = await open(`${boxPath}?layout=auto`, 1280, 800);
          try {
            await settled(page);
            const narrow = await headTabs(page);
            await page.setViewportSize({ width: 1680, height: 1050 });
            await settled(page);
            const wide = await headTabs(page);
            expect(wide.shown.length).toBeGreaterThan(narrow.shown.length);
            expect(wide.overflow).toBeLessThanOrEqual(1);
            await page.setViewportSize({ width: 1280, height: 800 });
            await settled(page);
            expect(await headTabs(page)).toEqual(narrow);
          } finally {
            await close(page);
          }
        });

        // S3: the reader's actions take their own row above the subject; a wide bar names them, a laptop shows icons.
        for (const [width, height, labels] of [
          [1680, 1050, true],
          [1440, 900, true],
          [1280, 800, false],
        ] as const)
          test(`S3 reader bar at ${width}: actions above the subject, ${labels ? "with their names" : "as icons"}`, async () => {
            const page = await open(`${boxPath}?layout=auto&conversation=Conv01`, width, height);
            try {
              const toolbar = page.locator("[data-mail-reader-toolbar]");
              await toolbar.locator("[data-mail-reader-heading]").waitFor({ state: "visible" });
              await settled(page);
              const geometry = await toolbar.evaluate((element) => {
                const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
                const label = (id: string) => element.querySelector(`[data-mail-toolbar-action="${id}"] .mail-reader-action-label`);
                return {
                  controlsBottom: box(".mail-reader-controls").bottom,
                  titleTop: box("[data-mail-reader-heading]").top,
                  titleLeft: box("[data-mail-reader-heading]").left,
                  controlsLeft: box(".mail-reader-controls").left,
                  named: ["spam", "trash"].map((id) => label(id)?.getClientRects().length ?? 0),
                  // The pill's actions live above the newest message, never in the head too (F12).
                  pillActionsInHead: ["reply", "reply_all", "forward", "done"].filter((id) =>
                    element.querySelector(`[data-mail-toolbar-action="${id}"]`),
                  ),
                };
              });
              expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.titleTop + 0.5);
              expect(Math.abs(geometry.controlsLeft - geometry.titleLeft)).toBeLessThanOrEqual(8);
              expect(geometry.named.map((count) => count > 0)).toEqual(geometry.named.map(() => labels));
              expect(geometry.pillActionsInHead).toEqual([]);
              if (labels) {
                // The short name is part of the accessible name, which still names the whole action.
                expect(await toolbar.locator('[data-mail-toolbar-action="trash"]').getAttribute("aria-label")).toBe("Move to Trash");
              }
              // The named bar still fits the reader.
              expect(await toolbar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            } finally {
              await close(page);
            }
          });

        // The longest German names of three other actions still fit the widest bar beside the named replies.
        for (const toolbar of ["reply,reply_all,forward,move,read,print", "reply,reply_all,forward,flag,tags,merge"])
          test(`S3 reader bar at 1440 in German with ${toolbar}: every name fits`, async () => {
            const page = await open(`${boxPath}?layout=auto&conversation=Conv01&locale=de&toolbar=${toolbar}`, 1440, 900);
            try {
              const toolbarElement = page.locator("[data-mail-reader-toolbar]");
              await toolbarElement.locator("[data-mail-reader-heading]").waitFor({ state: "visible" });
              await settled(page);
              const result = await toolbarElement.evaluate((element) => ({
                overflow: element.scrollWidth - element.clientWidth,
                controls:
                  element.querySelector(".mail-reader-controls")!.scrollWidth - element.querySelector(".mail-reader-controls")!.clientWidth,
                names: Array.from(element.querySelectorAll(".mail-reader-action-label")).filter(
                  (label) => label.getClientRects().length > 0,
                ).length,
              }));
              expect(result.names).toBe(3);
              expect(result.overflow).toBeLessThanOrEqual(1);
              expect(result.controls).toBeLessThanOrEqual(1);
            } finally {
              await close(page);
            }
          });

        test("S3 reader bar on a phone: the subject stays between the way back and the controls", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 390, 844);
          try {
            const toolbar = page.locator("[data-mail-reader-toolbar]");
            await toolbar.locator("[data-mail-reader-heading]").waitFor({ state: "visible" });
            await settled(page);
            const boxes = await toolbar.evaluate((element) =>
              [".mail-reader-back", "[data-mail-reader-heading]", ".mail-reader-controls"].map((selector) => {
                const { left, top } = element.querySelector(selector)!.getBoundingClientRect();
                return { left, top };
              }),
            );
            expect(boxes[0]!.left).toBeLessThan(boxes[1]!.left);
            expect(boxes[1]!.left).toBeLessThan(boxes[2]!.left);
            expect(Math.abs(boxes[0]!.top - boxes[2]!.top)).toBeLessThanOrEqual(2);
          } finally {
            await close(page);
          }
        });

        // S3: opening and closing the reader moves nothing in the head (layout-shift entries with a source there).
        for (const [layout, width, height] of [
          ["columns", 1680, 1050],
          ["columns", 1280, 800],
          ["split", 1680, 1050],
          ["auto", 1280, 800],
        ] as const)
          test(`S3: opening ${layout === "columns" ? "and closing " : ""}the reader (${layout}) at ${width} moves nothing in the head`, async () => {
            const page = await open(`${boxPath}?layout=${layout}`, width, height);
            try {
              await settled(page);
              const head = () =>
                page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll(".mail-workspace .k2b-app-workspace__head :is(.k2b-view-tabs__item, .k2b-view-tabs__more)"),
                  )
                    .filter((element) => element.getClientRects().length > 0)
                    .map((element) => {
                      const { x, y, width, height } = element.getBoundingClientRect();
                      return { x, y, width, height };
                    }),
                );
              await page.evaluate(() => {
                const shifts: string[] = [];
                Reflect.set(window, "headShifts", shifts);
                new PerformanceObserver((list) => {
                  for (const entry of list.getEntries())
                    for (const source of (entry as PerformanceEntry & { sources?: { node?: Node }[] }).sources ?? [])
                      if (source.node instanceof Element && source.node.closest(".k2b-app-workspace__head"))
                        shifts.push(source.node.className || source.node.tagName);
                }).observe({ type: "layout-shift", buffered: false });
              });
              const before = await head();
              await page.locator('[data-conversation-id="Conv03"] .mail-list-row').first().click();
              await page.waitForURL(/conversation=Conv03/);
              await page.locator("[data-mail-reader-heading]").waitFor({ state: "visible" });
              await settled(page);
              if (layout !== "auto") expect(await head()).toEqual(before);
              if (layout === "columns") {
                await page.locator("[data-mail-reader-close]").click();
                await page.waitForURL((url) => !url.searchParams.has("conversation"));
                await settled(page);
                expect(await head()).toEqual(before);
              }
              await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
              expect(await page.evaluate(() => Reflect.get(window, "headShifts"))).toEqual([]);
            } finally {
              await close(page);
            }
          });

        if (screenshots)
          test("optional wide head review screenshots", async () => {
            const directory = join(resolve(screenshots), "wide-head");
            mkdirSync(directory, { recursive: true });
            for (const [width, height] of [
              [1680, 1050],
              [1440, 900],
              [1280, 800],
              [1024, 768],
              [390, 844],
            ] as const)
              for (const [name, path] of [
                ["list", `${boxPath}?layout=auto&theme=light`],
                ["reader", `${boxPath}?layout=auto&conversation=Conv01&theme=light`],
              ] as const) {
                const page = await open(path, width, height);
                try {
                  await settled(page);
                  await page.screenshot({ path: join(directory, `${width}-${name}.png`) });
                  if (name === "list") {
                    await page.locator("[data-mail-search-trigger]").first().click();
                    await page.locator("[data-mail-head-search] input").waitFor({ state: "visible" });
                    await settled(page);
                    await page.screenshot({ path: join(directory, `${width}-search.png`) });
                    if (width === 390) {
                      await page.locator("[data-mail-search-phone-options]").click();
                      await page.getByRole("group", { name: "Place" }).waitFor({ state: "visible" });
                      await page.waitForTimeout(300);
                      await page.screenshot({ path: join(directory, `${width}-search-menu.png`) });
                    }
                  }
                } finally {
                  await close(page);
                }
              }
          });
        for (const row of table) {
          const label = `${row.width}${row.panel ? ` with a ${row.panel} px panel` : ""}`;
          test(`F2 at ${label}: list, reader, reading column and Detail follow the 1920/2560 table, server = hydrated = settled`, async () => {
            const page = await open(widePath({ panel: row.panel }), row.width, row.height as 900);
            try {
              const frame = await wide(page);
              expect(Math.abs(frame.list - row.list), `${label}: list ${frame.list}`).toBeLessThanOrEqual(4);
              expect(Math.abs(frame.reader!.width - row.reader), `${label}: reader ${frame.reader!.width}`).toBeLessThanOrEqual(4);
              expect(frame.detail, `${label}: Detail`).toBe(row.detail);
              expect(frame.headDetails, `${label}: head Details`).toBe(true);
              if (row.detail === "column") expect(Math.abs(frame.detailWidth - 480), `${label}: Detail width`).toBeLessThanOrEqual(0.5);
              // At most 760 px, centred in the reader; the toolbar is centred at at most 800 px.
              expect(frame.column!.width, `${label}: reading column`).toBeLessThanOrEqual(760.5);
              const readerCentre = frame.reader!.x + frame.reader!.width / 2;
              expect(Math.abs(frame.column!.x + frame.column!.width / 2 - readerCentre), `${label}: column centre`).toBeLessThanOrEqual(1);
              expect(frame.toolbar!.width, `${label}: toolbar width`).toBeLessThanOrEqual(800.5);
              expect(Math.abs(frame.toolbar!.x + frame.toolbar!.width / 2 - readerCentre), `${label}: toolbar centre`).toBeLessThanOrEqual(
                0.5,
              );
              // Opening the conversation marks it read after hydration; that changes no geometry.
              const read = (parts: Frame) => parts.map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
              const server = read(await recordedFrame(page, "server"));
              assertFrame(server, read(await recordedFrame(page, "hydrated")), `${label} hydrated`);
              assertFrame(server, read(await geometry(page)), `${label} settled`);
            } finally {
              await close(page);
            }
          });
        }

        test("F2: inside the band where the list grows, a 1520 px card keeps the Detail waiting", async () => {
          // A fixed 776 px minimum (320 + 16 + 440) would make a column here, with a reader below 440 px.
          const page = await open(widePath(), 1584, 900);
          try {
            const frame = await wide(page);
            expect(Math.abs(frame.list - (1520 * 0.25 - 24))).toBeLessThanOrEqual(0.5);
            expect(frame.detail).toBe("waiting");
            expect(frame.headDetails).toBe(true);
          } finally {
            await close(page);
          }
        });

        for (const [width, height, detail] of [
          [1440, 900, "column"],
          [1194, 834, "waiting"],
        ] as const)
          test(`F2: at ${width}, Hide list makes the Detail a ${detail === "column" ? "column" : "Detail that still waits"}`, async () => {
            const page = await open(widePath(), width, height);
            try {
              expect((await wide(page)).detail).toBe("waiting");
              await page
                .locator(".k2b-app-workspace__head")
                .getByRole("button", { name: "Options for Example support", exact: true })
                .click();
              await page.getByRole("menuitem", { name: "Hide conversation list" }).click();
              await settled(page);
              const frame = await wide(page);
              expect(frame.pane).toBeNull();
              expect(frame.detail).toBe(detail);
              if (detail === "column") expect(frame.reader!.width).toBeGreaterThanOrEqual(440);
            } finally {
              await close(page);
            }
          });

        for (const item of [
          { path: widePath(), width: 2560, height: 1080 },
          { path: widePath(), width: 1920, height: 1080 },
          { path: `${boxPath}?conversation=Conv01`, width: 834, height: 1194 },
        ] as const)
          test(`reader at ${item.width}: Reply all and Forward live in the pill, not the head, and stay in …`, async () => {
            const page = await open(item.path, item.width, item.height);
            try {
              const label = `${item.width}`;
              await page.waitForFunction(
                () => !document.querySelector("[data-mail-reply-pill] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
              );
              for (const name of ["Reply all", "Forward"]) {
                expect(
                  await page.locator(".mail-reader-toolbar").getByRole("button", { name, exact: true }).count(),
                  `${label}: ${name} in head`,
                ).toBe(0);
                const inPill = await page.locator("[data-mail-reply-pill]").getByRole("button", { name, exact: true }).isVisible();
                const inPillMore = await page.locator("[data-mail-reply-pill]").getByRole("button", { name: "More actions" }).isVisible();
                expect(inPill || inPillMore, `${label}: ${name} reachable in the pill`).toBe(true);
              }
              expect(await page.locator(".mail-reader-toolbar [data-mail-details-trigger]").isVisible(), `${label}: reader Details`).toBe(
                false,
              );
              expect(await page.locator("[data-app-workspace-detail-toggle]").isVisible(), `${label}: shared Details`).toBe(true);
              // Nothing in the bar spills out of the reader.
              const bar = await page.locator(".mail-reader-toolbar").evaluate((element) => element.scrollWidth - element.clientWidth);
              expect(bar, `${label}: toolbar overflow`).toBeLessThanOrEqual(0);
              // The head's "…" still lists every reply, so the keyboard path stays.
              const more = page.getByRole("button", { name: "More conversation actions" });
              await more.focus();
              await page.keyboard.press("Enter");
              for (const name of ["Reply all", "Forward"])
                expect(await page.getByRole("menuitem", { name }).count(), `${label}: ${name} in …`).toBe(1);
              await page.keyboard.press("Escape");
            } finally {
              await close(page);
            }
          });

        // Each toolbar, locale, and layout is its own case; together they sweep every reader tier (#1966).
        const sweptReaders = new Map<string, number[]>();
        for (const toolbar of ["reply,reply_all,forward,archive,spam,trash,move,read", "reply,archive,spam,trash,move,read,flag,tags"])
          for (const locale of ["en", "de"] as const) {
            for (const [extra, widths] of [
              ["", [768, 800, 834, 900, 980, 1024, 1100, 1194, 1280, 1366, 1440]],
              ["&list=hidden", [834, 900]],
              ["&shell=1&sidebar=240&panel=416", [1024, 1100, 1194, 1280, 1366]],
              ["&list=hidden&shell=1&sidebar=240&panel=416", [900, 924, 960, 1024, 1100, 1194]],
            ] as const)
              test(`reader toolbar: largest own toolbar ${toolbar} ${locale}${extra} fits every reader width`, async () => {
                const misfits: string[] = [];
                const readers = sweptReaders.get(`${toolbar} ${locale}`) ?? [];
                sweptReaders.set(`${toolbar} ${locale}`, readers);
                // One page, resized through its widths.
                const page = await open(`${boxPath}?conversation=Conv01&toolbar=${toolbar}&locale=${locale}${extra}`, widths[0], 900);
                try {
                  for (const width of widths) {
                    await page.setViewportSize({ width, height: 900 });
                    await settled(page);
                    const result = await page.evaluate(() => {
                      const reader = document.querySelector(".mail-reader")!.getBoundingClientRect();
                      const bar = document.querySelector(".mail-reader-toolbar")!;
                      const outside = [...bar.querySelectorAll<HTMLElement>("button, a")]
                        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
                        .filter((element) => {
                          const box = element.getBoundingClientRect();
                          return box.left < reader.left - 0.5 || box.right > reader.right + 0.5;
                        })
                        .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?");
                      const details = [
                        ...document.querySelectorAll<HTMLElement>("[data-mail-details-trigger], [data-app-workspace-detail-toggle]"),
                      ].filter((element) => element.getClientRects().length > 0);
                      const soleSharedDetails = details.length === 1 && details[0]!.hasAttribute("data-app-workspace-detail-toggle");
                      return { reader: Math.round(reader.width), outside, details: soleSharedDetails };
                    });
                    readers.push(result.reader);
                    if (result.outside.length || !result.details)
                      misfits.push(
                        `${toolbar} ${locale} ${width}${extra} (reader ${result.reader}): ${result.outside.join(", ") || "no Details"}`,
                      );
                  }
                } finally {
                  await close(page);
                }
                expect(misfits).toEqual([]);
              });
            // Reads the reader widths that the four layout cases above measured, so it runs after them in the same file.
            test(`reader toolbar: the sweep of ${toolbar} ${locale} covers every reader tier`, () => {
              const readers = sweptReaders.get(`${toolbar} ${locale}`) ?? [];
              expect(readers.length, "the four layout cases above ran first and measured 24 reader widths").toBe(24);
              // Under 380, 380–440, 440–480, 480–520, 520–720 and from 720 px of reader.
              for (const [from, to] of [
                [0, 380],
                [380, 440],
                [440, 480],
                [480, 520],
                [520, 720],
                [720, 2000],
              ] as const)
                expect(
                  readers.some((width) => width >= from && width < to),
                  `a reader width in ${from}–${to} (${[...new Set(readers)].join(", ")})`,
                ).toBe(true);
            });
          }

        test("reader toolbar: a person's own actions stay, and those that do not fit are in …", async () => {
          const toolbar = "reply,forward,archive,trash,move,read,flag,tags";
          const page = await open(`${boxPath}?conversation=Conv01&toolbar=${toolbar}`, 834, 1194);
          try {
            expect(await page.locator('.mail-reader-toolbar [data-mail-toolbar-action="reply_all"]').count()).toBe(0);
            const visible = await page
              .locator(".mail-reader-toolbar [data-mail-toolbar-action]")
              .evaluateAll((elements) =>
                elements
                  .filter((element) => element.getClientRects().length > 0)
                  .map((element) => element.getAttribute("data-mail-toolbar-action")),
              );
            // Reply and Forward are the pill's; the head keeps the person's other actions (F12).
            expect(visible).not.toContain("reply");
            expect(visible).not.toContain("forward");
            expect(visible.every((id) => toolbar.split(",").includes(id!))).toBe(true);
            expect(
              await page.locator(".mail-reader-toolbar").evaluate((element) => element.scrollWidth - element.clientWidth),
            ).toBeLessThanOrEqual(0);
            await page.getByRole("button", { name: "More conversation actions" }).click();
            for (const name of ["Forward", "Move to folder", "Manage tags"])
              expect(await page.getByRole("menuitem", { name, exact: true }).count(), `${name} in …`).toBeGreaterThan(0);
          } finally {
            await close(page);
          }
        });
      });

      section("reader", () => {
        // A message with a PDF and 59 photos shows them before its text: the count, the first three, and "Show all".
        for (const width of [1440, 390])
          test(`attachments at ${width}: listed above the body, previews hold still, show all opens image tiles`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&photos=59`, width, width === 390 ? 844 : 900);
            try {
              const list = page.locator("[data-mail-message-attachments]");
              await list.waitFor();
              expect(await list.locator(".mail-message-attachments__count").textContent()).toBe("60 attachments");
              const box = (await list.boundingBox())!;
              const body = (await page.locator(".mail-message-body").first().boundingBox())!;
              expect(box.y + box.height).toBeLessThanOrEqual(body.y);
              expect(box.y + box.height, "the list shows without scrolling").toBeLessThanOrEqual(width === 390 ? 844 : 900);
              const items = list.locator(".k2b-file-grid__item");
              expect(await items.count()).toBe(3);
              expect(await list.getByText("application/pdf").count()).toBe(0);
              const before = await items.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
              await page.waitForFunction(() =>
                [...document.querySelectorAll<HTMLImageElement>("[data-mail-message-attachments] img")].every(
                  (image) => image.complete && image.naturalWidth > 0,
                ),
              );
              await settled(page);
              expect(await items.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()))).toEqual(before);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              await list.getByRole("button", { name: "Show all 60" }).click();
              await list.locator('.k2b-file-grid[data-layout="tiles"]').waitFor();
              expect(await list.locator('.k2b-file-grid[data-layout="tiles"] .k2b-file-grid__item').count()).toBe(59);
              await list.getByRole("button", { name: "Show less" }).click();
              await settled(page);
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `attachments-light-${width}.png`) });
                await list.getByRole("button", { name: "Show all 60" }).click();
                await settled(page);
                await page.screenshot({ path: join(screenshots, browserName, `attachments-all-light-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });

        // One case per trace, each on its own page (#1966): the current AI assignment leads, every effect stays below.
        for (const width of [1440, 390])
          for (const kind of ["name", "uncertain", "manual", "normal"] as const)
            test(`automation: rule trace ${kind} at ${width}`, async () => {
              const page = await open(`${boxPath}?conversation=Conv01&locale=de&trace=${kind}`, width, width === 390 ? 844 : 900);
              try {
                if (kind === "name") await page.getByText("„Mails nach Art verteilen“ hat Nora Albrecht zugewiesen.").waitFor();
                if (kind === "uncertain") {
                  await page
                    .getByText("Die KI war unsicher. „Mails nach Art verteilen“ hat die Mail an „Eingang prüfen“ gegeben.")
                    .waitFor();
                  await page.getByRole("button", { name: "Mir zuweisen" }).waitFor();
                }
                if (kind === "manual") {
                  await page.getByText("Nora Albrecht hat um 06:40 Lisa Brandt zugewiesen.").waitFor();
                  expect(await page.locator("[data-mail-automation-note]").count()).toBe(0);
                }
                if (kind === "normal") {
                  await page.getByText("„Großkunden an Can“ hat Zuweisen übersprungen:").waitFor();
                  await page.locator('[data-mail-automation-note="assigned"]').waitFor();
                }
                if (screenshots) await page.screenshot({ path: join(screenshots, `trace-${kind}-light-${width}.png`) });
              } finally {
                await close(page);
              }
            });

        test("Details access transfers focus across the phone breakpoint", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 767, 900);
          try {
            const reader = page.locator("[data-mail-details-trigger]");
            const shared = page.locator("[data-app-workspace-detail-toggle]");
            await reader.focus();
            await page.setViewportSize({ width: 768, height: 900 });
            await settled(page);
            expect(await shared.evaluate((element) => document.activeElement === element)).toBe(true);
            await page.setViewportSize({ width: 767, height: 900 });
            await settled(page);
            expect(await reader.evaluate((element) => document.activeElement === element)).toBe(true);
          } finally {
            await close(page);
          }
        });

        for (const width of [767, 768]) {
          test(`one Details access: SSR, hydration and keyboard at ${width}`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01`, width, 900);
            try {
              const reader = page.locator("[data-mail-details-trigger]");
              const shared = page.locator("[data-app-workspace-detail-toggle]");
              for (const phase of ["server", "hydrated"]) {
                const frame: Frame = JSON.parse((await page.locator("html").getAttribute(`data-${phase}-geometry`))!);
                expect(frame.find((part) => part.part.includes("mail-reader-details"))!.height > 0).toBe(width < 768);
                expect(frame.find((part) => part.part.includes("k2b-app-workspace__detail-toggle"))!.height > 0).toBe(width >= 768);
              }
              expect(await reader.isVisible()).toBe(width < 768);
              expect(await shared.isVisible()).toBe(width >= 768);
              const button = width < 768 ? reader : shared;
              await button.focus();
              await page.keyboard.press("Enter");
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              await page.keyboard.press("Escape");
              await settled(page);
              expect(await button.evaluate((element) => document.activeElement === element)).toBe(true);
              expect(await button.getAttribute("aria-expanded")).toBe("false");
              await page.getByRole("button", { name: "More conversation actions", exact: true }).focus();
              await page.keyboard.press("Tab");
              expect(await reader.evaluate((element) => document.activeElement === element)).toBe(width < 768);
            } finally {
              await close(page);
            }
          });
        }

        const persistentDetails = `${boxPath}?conversation=Conv01&shell=1&persist-details=1`;
        const storedDetails = (page: Page, open: boolean) =>
          page.waitForFunction((open) => {
            const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
            return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === open;
          }, open);
        // One phase per case, each on its own page, so every case stays far inside its budget (#1966).
        for (const width of [1920, 1440, 834]) {
          test(`persistent Details at ${width}: default, close and resize keep the toggle and the Detail in step`, async () => {
            const page = await open(persistentDetails, width, 900);
            try {
              const button = page.locator("[data-app-workspace-detail-toggle]");
              const aside = page.locator(".k2b-app-workspace__detail");
              expect(await button.isVisible()).toBe(true);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
              await button.focus();
              await page.keyboard.press("Enter");
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              expect(await button.getAttribute("aria-expanded")).toBe("true");
              if (width === 1920) {
                // Pointer focus stays on a persistent control even when a resize
                // leaves the Detail in its column instead of hiding that control.
                await button.click();
                await button.click();
                await page.setViewportSize({ width: 1900, height: 900 });
                await settled(page);
                expect(await button.getAttribute("aria-expanded")).toBe("true");
                expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
              }
              // Escape closes the wide column; the shared head control remains the way back.
              if (width >= 1024) await pressEscapeForWorkspace(page);
              else await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
              await settled(page);
              expect(await button.isVisible()).toBe(true);
              expect(await button.getAttribute("aria-expanded")).toBe("false");
              expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
              await page.setViewportSize({ width: width === 1920 ? 834 : 1920, height: 900 });
              await settled(page);
              expect(await button.isVisible()).toBe(true);
              // Parking retained the available app detail; widening restores its column.
              if (width === 1440) {
                expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
                await button.click();
                await settled(page);
                expect(await aside.getAttribute("hidden")).not.toBeNull();
              }
              await button.click();
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              expect(await page.evaluate(() => document.activeElement?.matches("[data-app-workspace-detail-toggle]"))).toBe(true);
            } finally {
              await close(page);
            }
          });
        }

        // A window that the Detail cannot take as a column closes it with its own button, a wide one with Escape.
        for (const width of [834, 1920]) {
          test(`persistent Details at ${width}: a closed preference survives reload`, async () => {
            const page = await open(persistentDetails, width, 900);
            try {
              const button = page.locator("[data-app-workspace-detail-toggle]");
              const aside = page.locator(".k2b-app-workspace__detail");
              await button.click();
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              if (width < 1024) await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
              else await pressEscapeForWorkspace(page);
              await storedDetails(page, false);
              await page.reload();
              await page.locator("html[data-mail-shell-ready=true]").waitFor();
              expect(await button.isVisible()).toBe(true);
              expect(await button.isEnabled()).toBe(true);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
              await button.click();
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            } finally {
              await close(page);
            }
          });

          test(`persistent Details at ${width}: an open preference survives reload`, async () => {
            const page = await open(persistentDetails, width, 900);
            try {
              const button = page.locator("[data-app-workspace-detail-toggle]");
              const aside = page.locator(".k2b-app-workspace__detail");
              await button.click();
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              await storedDetails(page, true);
              await page.reload();
              await ready(page);
              // An initially open waiting drawer parks; the app preference still
              // restores true, while responsive presentation remains separate.
              expect(await aside.getAttribute("hidden")).toBeNull();
              if (width < 1024) {
                expect(await button.getAttribute("aria-expanded")).toBe("false");
                await button.click();
                await settled(page);
              }
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
            } finally {
              await close(page);
            }
          });
        }
        for (const theme of reviewThemes) {
          test(`phone pane head: reader Details, persistence and Back in ${theme}`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&persist-details=1&theme=${theme}`, 390, 844);
            const releaseBack = Promise.withResolvers<void>();
            try {
              const head = page.locator(".mail-workspace > .k2b-app-workspace__head");
              const shared = page.locator(".mail-workspace [data-app-workspace-detail-toggle]");
              const reader = page.locator(".mail-reader-toolbar [data-mail-details-trigger]");
              const aside = page.locator(".k2b-app-workspace__detail");
              expect(await head.isVisible()).toBe(false);
              expect(await shared.isVisible()).toBe(false);
              const serverFrame: Frame = JSON.parse((await page.locator("html").getAttribute("data-server-geometry"))!);
              const hydratedFrame: Frame = JSON.parse((await page.locator("html").getAttribute("data-hydrated-geometry"))!);
              for (const frame of [serverFrame, hydratedFrame])
                expect(frame.find((part) => part.part === "k2b-app-workspace__head")?.height).toBe(0);
              expect(
                await page.locator(".mail-workspace").evaluate((root) => {
                  const content = root.querySelector(":scope > .k2b-app-workspace__content")!;
                  return content.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop;
                }),
              ).toBe(0);
              expect(await reader.isVisible()).toBe(true);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
              const shots = screenshots;
              if (shots) {
                mkdirSync(resolve(shots, browserName), { recursive: true });
                await page.screenshot({ path: resolve(shots, browserName, `f6-reader-${theme}-390.png`) });
              }
              await reader.focus();
              await page.keyboard.press("Enter");
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              expect(await reader.getAttribute("aria-expanded")).toBe("true");
              await aside.getByRole("button", { name: "Close conversation details", exact: true }).click();
              await settled(page);
              expect(await reader.evaluate((element) => element === document.activeElement)).toBe(true);
              expect(await reader.getAttribute("aria-expanded")).toBe("false");
              expect(await shared.isVisible()).toBe(false);
              await page.waitForFunction((expected) => {
                const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
                return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === expected;
              }, false);
              const closedCookie = await storedCookie(page, "cloud_mail_workspace");
              expect(JSON.parse(decodeURIComponent(closedCookie!.value)).detailsOpen).toBe(false);
              await page.reload();
              await ready(page);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
              await reader.click();
              await settled(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              await page.waitForFunction((expected) => {
                const cookie = document.cookie.split("; ").find((part) => part.startsWith("cloud_mail_workspace="));
                return cookie && JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).detailsOpen === expected;
              }, true);
              const openCookie = await storedCookie(page, "cloud_mail_workspace");
              expect(JSON.parse(decodeURIComponent(openCookie!.value)).detailsOpen).toBe(true);
              await page.reload();
              await ready(page);
              expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
              await page.keyboard.press("Escape");
              await settled(page);
              expect(await reader.evaluate((element) => element === document.activeElement)).toBe(true);
              expect(await aside.getAttribute("hidden")).not.toBeNull();
              await page.locator(".mail-reader-back").click();
              await page.waitForFunction(() => !new URL(location.href).searchParams.has("conversation"));
              await settled(page);
              expect(await head.isVisible()).toBe(true);
              // The phone list head carries no Details; the reader owns that control.
              expect(await shared.isVisible()).toBe(false);
              if (shots) await page.screenshot({ path: resolve(shots, browserName, `f6-list-${theme}-390.png`) });
              const backRoute = "**/api/mail/mailboxes/Box001/workspace-route?*";
              await page.route(
                backRoute,
                async (route) => {
                  await releaseBack.promise;
                  await route.continue();
                },
                { times: 1 },
              );
              await Promise.all([page.waitForRequest(backRoute), page.goBack()]);
              await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
              await settled(page);
              // History moves the URL before Mail commits its asynchronous selection.
              // While the response is held, the still-shown list must keep its head.
              const main = page.locator(".mail-workspace .k2b-app-workspace__main");
              expect(await main.getAttribute("aria-busy")).toBe("true");
              expect(await main.getAttribute("data-mobile-pane")).toBe("conversations");
              expect(await head.isVisible()).toBe(true);
              releaseBack.resolve();
              await ready(page);
              expect(await main.getAttribute("data-mobile-pane")).toBe("main");
              expect(await head.isVisible()).toBe(false);
              expect(await reader.isVisible()).toBe(true);
              await page.setViewportSize({ width: 834, height: 1194 });
              await settled(page);
              expect(await head.isVisible()).toBe(true);
              expect(await shared.isVisible()).toBe(true);
              expect(await reader.isVisible()).toBe(false);
              await page.setViewportSize({ width: 390, height: 844 });
              await settled(page);
              expect(await shared.isVisible()).toBe(false);
              expect(await reader.isVisible()).toBe(true);
            } finally {
              releaseBack.resolve();
              try {
                await page.unrouteAll({ behavior: "wait" });
              } finally {
                await close(page);
              }
            }
          });
        }

        test("persistent Details: conversation Back keeps the same closed preference", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&shell=1&persist-details=1`, 834, 900);
          try {
            const button = page.locator("[data-app-workspace-detail-toggle]");
            const aside = page.locator(".k2b-app-workspace__detail");
            await page.locator('[data-conversation-id="Conv02"] a.mail-list-row').click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
            await settled(page);
            expect(await button.isVisible()).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await page.goBack();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            await settled(page);
            expect(await button.isVisible()).toBe(true);
            expect(await button.isEnabled()).toBe(true);
            expect(await aside.getAttribute("hidden")).not.toBeNull();
            await button.click();
            await settled(page);
            expect(await page.locator("[data-mail-details-heading]").isVisible()).toBe(true);
          } finally {
            await close(page);
          }
        });

        test("persistent Details: no selection keeps the head control disabled", async () => {
          const page = await open(`${boxPath}?shell=1`, 834, 900);
          try {
            const button = page.locator("[data-app-workspace-detail-toggle]");
            expect(await button.isVisible()).toBe(true);
            expect(await button.isDisabled()).toBe(true);
            expect(await page.locator(".k2b-app-workspace__detail").isVisible()).toBe(false);
          } finally {
            await close(page);
          }
        });

        test("#1467: while the details wait, the sole shared Details button opens and parks the drawer", async () => {
          const page = await open(widePath(), 1440, 900);
          try {
            const button = page.locator("[data-app-workspace-detail-toggle]");
            expect(await page.locator("[data-mail-details-trigger]").isVisible()).toBe(false);
            expect((await wide(page)).detail).toBe("waiting");
            await button.click();
            await settled(page);
            expect((await wide(page)).detail).toBe("drawer");
            expect(await button.getAttribute("aria-expanded")).toBe("true");
            // The open drawer covers the reader's end; Escape parks it again.
            await page.keyboard.press("Escape");
            await settled(page);
            expect((await wide(page)).detail).toBe("waiting");
            expect(await button.getAttribute("aria-expanded")).toBe("false");
            // Keyboard: Enter opens it again and moves into the details.
            await button.focus();
            await page.keyboard.press("Enter");
            await settled(page);
            expect((await wide(page)).detail).toBe("drawer");
            expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".k2b-app-workspace__detail")))).toBe(true);
          } finally {
            await close(page);
          }
        });

        test("the reply pill never reaches past itself or the reader: labels give way to icons, then actions move into More", async () => {
          for (const [width, height] of [
            [1920, 1080],
            [1440, 900],
            [1194, 834],
            [900, 900],
            [834, 1194],
            [390, 844],
            [320, 640],
          ] as const) {
            const page = await open(`${boxPath}?conversation=Conv01&theme=dark`, width, height);
            try {
              await page.waitForFunction(
                () => !document.querySelector("[data-mail-reply-pill] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
              );
              const fit = await page.evaluate(() => {
                const pill = document.querySelector<HTMLElement>("[data-mail-reply-pill] .k2b-toolbar")!;
                const reader = document.querySelector<HTMLElement>(".mail-reader-scroll")!.getBoundingClientRect();
                const box = pill.getBoundingClientRect();
                const controls = Array.from(pill.querySelectorAll<HTMLElement>("button")).filter(
                  (button) => button.getClientRects().length > 0 && !button.closest("[data-overflow]"),
                );
                const outside = controls
                  .map((button) => ({
                    name: button.getAttribute("aria-label") ?? button.textContent?.trim(),
                    box: button.getBoundingClientRect(),
                  }))
                  .filter(({ box: control }) => control.left < box.left - 0.5 || control.right > box.right + 0.5)
                  .map(({ name }) => name);
                const labels = Array.from(pill.querySelectorAll<HTMLElement>(".k2b-toolbar__text")).filter(
                  (label) => label.getClientRects().length > 0,
                ).length;
                return {
                  inReader: box.left >= reader.left - 0.5 && box.right <= reader.right + 0.5,
                  outside,
                  reply: controls.find((button) => button.classList.contains("mail-reader-pill-reply"))?.textContent?.trim(),
                  labels,
                  labelled: pill.querySelectorAll(".k2b-toolbar__action[data-text]:not([data-overflow])").length,
                  compact: pill.hasAttribute("data-compact"),
                  more: controls.some((button) => button.closest(".k2b-toolbar__more")),
                };
              });
              expect(fit.inReader, `${width} pill inside the reader`).toBe(true);
              expect(fit.outside, `${width} controls inside the pill`).toEqual([]);
              // Reply always keeps its word.
              expect(fit.reply, `${width} Reply`).toBe("Reply");
              // Labels show only while there is room; a compact pill shows none, and More comes only after labels went.
              if (fit.compact) expect(fit.labels, `${width} labels`).toBe(0);
              else expect(fit.labels, `${width} labels`).toBe(fit.labelled);
              if (fit.more) expect(fit.compact, `${width} More after labels`).toBe(true);
              // The widest reader has room for every label; the narrowest phone has not.
              if (width === 1920) expect(fit.compact, "1920 shows the labels").toBe(false);
              if (width === 320) expect(fit.compact, "320 is compact").toBe(true);
            } finally {
              await close(page);
            }
          }
        });

        test("a team mailbox's pill row from 760 to 240 px: never clipped, Reply stays, More fills by priority", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&team=1`, 1440, 900);
          try {
            const pending = () =>
              page.waitForFunction(
                () => !document.querySelector("[data-mail-reply-pill] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
              );
            await pending();
            const order = ["Assign", "Forward", "Reply all", "Mark as done"];
            for (let width = 760; width >= 240; width -= 10) {
              await page.evaluate((width) => {
                document.querySelector<HTMLElement>("[data-mail-reading-column]")!.style.width = `${width}px`;
              }, width);
              await pending();
              await page.evaluate(
                () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
              );
              const state = await page.evaluate(() => {
                const strip = document.querySelector<HTMLElement>("[data-mail-reply-pill] .k2b-toolbar-float")!;
                const pill = strip.querySelector<HTMLElement>(".k2b-toolbar")!;
                const row = strip.getBoundingClientRect();
                const box = pill.getBoundingClientRect();
                const present = Array.from(pill.querySelectorAll<HTMLElement>(".k2b-toolbar__action")).map((action) => ({
                  name: action.getAttribute("aria-label")!,
                  moved: action.hasAttribute("data-overflow"),
                }));
                return {
                  inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
                  fits: pill.scrollWidth <= Math.ceil(row.width) + 0.5,
                  reply: pill.querySelector(".mail-reader-pill-reply")?.getClientRects().length ?? 0,
                  present: present.map((action) => action.name),
                  moved: present.filter((action) => action.moved).map((action) => action.name),
                };
              });
              expect(state.inside, `${width} inside`).toBe(true);
              expect(state.fits, `${width} fits`).toBe(true);
              expect(state.reply, `${width} Reply`).toBe(1);
              // What moved into More is always the first actions of the priority order that this pill has.
              const expected = order.filter((name) => state.present.includes(name)).slice(0, state.moved.length);
              expect(new Set(state.moved), `${width} More order`).toEqual(new Set(expected));
            }
          } finally {
            await close(page);
          }
        });

        test("phone: the reply pill above the newest message offers Reply, Reply all, Forward and Done by touch and keyboard", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 390, 844);
          try {
            const bar = page.locator("[data-mail-reply-pill] .k2b-toolbar");
            await page.waitForFunction(
              () => !document.querySelector("[data-mail-reply-pill] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
            );
            expect(await bar.isVisible()).toBe(true);
            const names = await bar
              .locator("button")
              .evaluateAll((elements) =>
                elements
                  .filter((element) => element.getClientRects().length > 0 && !element.closest("[data-overflow]"))
                  .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim()),
              );
            // Reply leads and keeps its word; every action is reachable in the pill or, when the phone is too narrow
            // for its engine's metrics, under More, which then is the last control.
            expect(names[0]).toBe("Reply");
            const inMore = names.includes("More actions")
              ? await (async () => {
                  await bar.getByRole("button", { name: "More actions" }).click();
                  const rows = await page.getByRole("menuitem").allTextContents();
                  await page.keyboard.press("Escape");
                  return rows.map((row) => row.trim());
                })()
              : [];
            // F10 c: Reply, Reply all, Forward | Done, and Assign only where people can be assigned; Archive is in the head's ….
            const reachable = new Set([...names.filter((name) => name !== "More actions"), ...inMore]);
            for (const name of ["Reply", "Reply all", "Forward", "Mark as done"]) expect(reachable.has(name), name).toBe(true);
            expect([...reachable].every((name) => ["Reply", "Reply all", "Forward", "Mark as done", "Assign"].includes(name))).toBe(true);
            // The pill sits inside the reader, above the newest message, and never below the screen.
            const scroller = (await page.locator(".mail-reader-scroll").boundingBox())!;
            const strip = (await bar.boundingBox())!;
            const newest = (await page.locator("[data-mail-conversation-messages] [data-mail-message-id]").first().boundingBox())!;
            expect(strip.y).toBeGreaterThanOrEqual(scroller.y - 0.5);
            expect(strip.y + strip.height).toBeLessThanOrEqual(newest.y + 0.5);
            // A floating pill on layer 3 carries the toolbar shadow.
            expect(await bar.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
            // The top row keeps the way back, … and the details; the actions live below.
            expect(
              await page
                .locator(".mail-reader-toolbar [data-mail-toolbar-action]")
                .evaluateAll((elements) => elements.filter((element) => element.getClientRects().length > 0).length),
            ).toBe(0);
            expect(await page.locator(".mail-reader-toolbar [data-mail-details-trigger]").isVisible()).toBe(true);
            // Keyboard: the pill is one tab stop with arrow keys inside.
            await bar.getByRole("button", { name: "Reply", exact: true }).focus();
            await page.keyboard.press("ArrowRight");
            expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(names[1]!);
            // Touch: Done marks the conversation done.
            await page.route("**/api/mail/mailboxes/Box001/conversations/completion", (route) =>
              route.fulfill({
                json: { completion: "done", results: [{ conversationId: "Conv01", status: "ok", workStatus: "done", revision: 2 }] },
              }),
            );
            const completed = page.waitForRequest((request) => request.url().endsWith("/conversations/completion"));
            if (names.includes("Mark as done")) await bar.getByRole("button", { name: "Mark as done" }).tap();
            else {
              await bar.getByRole("button", { name: "More actions" }).tap();
              await page.getByRole("menuitem", { name: "Mark as done" }).tap();
            }
            expect((await completed).postDataJSON()).toEqual({ conversationIds: ["Conv01"], completion: "done" });
          } finally {
            await close(page);
          }
        });

        test("reader: a long conversation shows its newest three messages and n older messages for the rest", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 900);
          try {
            const cards = page.locator("[data-mail-conversation-messages] [data-mail-message-id]");
            expect(await cards.count()).toBe(3);
            const older = page.locator("[data-mail-older-messages]");
            expect(await older.textContent()).toBe("3 older messages");
            await older.focus();
            await page.keyboard.press("Enter");
            await settled(page);
            expect(await cards.count()).toBe(6);
            expect(await older.count()).toBe(0);
            // Focus moves to the first message the button showed.
            expect(
              await page.evaluate(() => document.activeElement?.closest("[data-mail-message-id]")?.getAttribute("data-mail-message-id")),
            ).toBe("Long03");
            // Another conversation and back: the older messages stay shown with the reading position.
            await page.locator('.mail-workspace [data-conversation-id="Conv01"] a.mail-list-row').click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            await settled(page);
            await page.locator('.mail-workspace [data-conversation-id="Conv02"] a.mail-list-row').click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
            await settled(page);
            expect(await cards.count()).toBe(6);
          } finally {
            await close(page);
          }
        });

        test("reader: a link to an older message shows the whole conversation, also after collapsing that message", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02&message=Long02` }), 1440, 900);
          try {
            const cards = page.locator("[data-mail-conversation-messages] [data-mail-message-id]");
            expect(await cards.count()).toBe(6);
            expect(await page.locator("[data-mail-older-messages]").count()).toBe(0);
            const header = page.locator('[data-mail-message-id="Long02"] [data-mail-message-header]');
            await header.focus();
            await page.keyboard.press("Enter");
            await settled(page);
            expect(await cards.count()).toBe(6);
            expect(await header.evaluate((element) => element === document.activeElement)).toBe(true);
            // Another conversation and Back to the same link: the conversation stays unfolded.
            await page.locator('.mail-workspace [data-conversation-id="Conv01"] a.mail-list-row').click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            await settled(page);
            await page.goBack();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("message") === "Long02");
            await settled(page);
            expect(await cards.count()).toBe(6);
          } finally {
            await close(page);
          }
        });

        test("reader: a conversation taller than the reader opens at its start, with the subject in view", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 480 as 900);
          try {
            const scroller = page.locator(".mail-reader-scroll");
            expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
            expect(await page.locator("[data-mail-reader-heading]").isVisible()).toBe(true);
            const server = await recordedFrame(page, "server");
            const read = (parts: Frame) => parts.map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
            assertFrame(read(server), read(await geometry(page)), "tall conversation settled");
          } finally {
            await close(page);
          }
        });

        test("rows: three-line rows share one height, a fourth line only for tags, Waiting, or others who wrote", async () => {
          const page = await open(widePath(), 1440, 900);
          try {
            const rows = await page.locator(".mail-workspace .mail-list-entry").evaluateAll((elements) =>
              elements
                .filter((element) => element.getBoundingClientRect().bottom < innerHeight)
                .map((element) => ({
                  lines: element.getAttribute("data-lines"),
                  height: element.getBoundingClientRect().height,
                })),
            );
            expect(rows.length).toBeGreaterThan(4);
            for (const row of rows)
              expect(Math.abs(row.height - (row.lines === "4" ? 102 : 77)), JSON.stringify(row)).toBeLessThanOrEqual(0.5);
            expect(rows.filter((row) => row.lines === "3").length).toBeGreaterThan(3);
          } finally {
            await close(page);
          }
        });

        test("opening the waiting Detail moves nothing; closing a column gives only the reader its room", async () => {
          const waiting = await open(widePath(), 1440, 900);
          try {
            const before = await wide(waiting);
            await waiting.locator(".mail-workspace .k2b-app-workspace__detail-toggle").click();
            await settled(waiting);
            const after = await wide(waiting);
            expect(after.detail).toBe("drawer");
            for (const part of ["pane", "reader", "toolbar", "sidebar", "head"] as const)
              sameBox(after[part], before[part], `1440 ${part}`);
            // Reduced motion: the drawer opened without a transition.
            expect(
              await waiting.locator(".mail-workspace .k2b-app-workspace__detail").evaluate((element) =>
                getComputedStyle(element)
                  .transitionDuration.split(",")
                  .every((value) => Number.parseFloat(value) === 0),
              ),
            ).toBe(true);
          } finally {
            await close(waiting);
          }
          const column = await open(widePath(), 1920, 1080);
          try {
            const before = await wide(column);
            expect(before.detail).toBe("column");
            await column.locator("[data-app-workspace-detail-toggle]").click();
            await settled(column);
            const after = await wide(column);
            expect(after.detail).toBe("closed");
            for (const part of ["pane", "sidebar"] as const) sameBox(after[part], before[part], `1920 ${part}`);
            // The head row shares its track with Main, so only its end follows the column away.
            sameBox({ ...after.head!, width: 0 }, { ...before.head!, width: 0 }, "1920 head start");
            sameBox({ ...after.reader!, width: 0 }, { ...before.reader!, width: 0 }, "1920 reader start");
            expect(after.reader!.width).toBeGreaterThan(before.reader!.width);
          } finally {
            await close(column);
          }
        });

        test("dark at 1920: the Detail column shares the reader's surface, with no seam", async () => {
          const page = await open(`${widePath()}&theme=dark`, 1920, 1080);
          try {
            const seam = await page.evaluate(() => {
              const surface = (element: Element | null): string => {
                for (let current = element; current; current = current.parentElement) {
                  const color = getComputedStyle(current).backgroundColor;
                  if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
                }
                return "none";
              };
              const aside = document.querySelector(".mail-workspace .k2b-app-workspace__detail")!;
              const style = getComputedStyle(aside);
              return {
                detail: surface(aside),
                reader: surface(document.querySelector(".mail-reader")),
                list: surface(document.querySelector(".mail-workspace .k2b-app-workspace__main-pane")),
                borders: [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth],
                shadow: style.boxShadow,
              };
            });
            // One surface: the list, the reader and the Detail column (the reader drew a raised dark fill before).
            expect(seam.detail).toBe(seam.list);
            expect(seam.reader).toBe(seam.detail);
            expect(seam.borders).toEqual(["0px", "0px", "0px", "0px"]);
            expect(seam.shadow).toBe("none");
            if (screenshots) await page.screenshot({ path: join(resolve(screenshots), "wide-dark-1920.png") });
          } finally {
            await close(page);
          }
        });
      });
    });

    section("mailboxes", () => {
      describe("Mail Cloud ID and context menu", () => {
        const cloudUrl = "https://cloud.example";
        type Copied = { text: string; custom?: string };
        // Records what Mail writes, in both the structured and the plain-text clipboard path, without browser permissions.
        const recordClipboard = (page: Page) =>
          page.evaluate(() => {
            const copied: { text: string; custom?: string }[] = [];
            (window as unknown as { copied: typeof copied }).copied = copied;
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: async (text: string) => void copied.push({ text }),
                write: async (items: ClipboardItem[]) => {
                  for (const item of items) {
                    const custom = item.types.find((type) => type.startsWith("web "));
                    copied.push({
                      text: await (await item.getType("text/plain")).text(),
                      ...(custom ? { custom: await (await item.getType(custom)).text() } : {}),
                    });
                  }
                },
              },
            });
          });
        const copiedEntries = (page: Page) => page.evaluate(() => (window as unknown as { copied: Copied[] }).copied);
        const menuEntries = async (page: Page, selector: string) => {
          const menu = page.locator(selector);
          await menu.waitFor({ state: "visible" });
          return (await menu.getByRole("menuitem").allTextContents()).map((entry) => entry.trim());
        };
        const dismiss = async (page: Page, selector: string) => {
          await page.keyboard.press("Escape");
          await page.locator(selector).waitFor({ state: "hidden" });
        };
        const dropdown = ".k2b-dropdown__menu:popover-open";
        const contextMenu = ".k2b-context-menu";

        test("right-click opens the same menus as the conversation's and the message's …", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`);
          try {
            await page.getByRole("button", { name: "More conversation actions" }).click();
            const conversationItems = await menuEntries(page, dropdown);
            expect(conversationItems).toContain("Copy conversation Cloud ID");
            await dismiss(page, dropdown);
            await page.locator("[data-mail-reader-heading]").click({ button: "right" });
            expect(await menuEntries(page, contextMenu)).toEqual(conversationItems);
            await dismiss(page, contextMenu);

            const message = page.locator('[data-mail-message-id="Msg001"]');
            await message.getByRole("button", { name: "Message actions" }).click();
            const messageItems = await menuEntries(page, dropdown);
            expect(messageItems.slice(-2)).toEqual(["Copy message Cloud ID", "Copy conversation Cloud ID"]);
            await dismiss(page, dropdown);
            await message.locator("[data-mail-message-header]").click({ button: "right" });
            expect(await menuEntries(page, contextMenu)).toEqual(messageItems);
            await dismiss(page, contextMenu);

            // Keyboard: Shift+F10 on the focused message opens the same menu, and Escape returns focus.
            await message.locator("[data-mail-message-header]").focus();
            await page.keyboard.press("Shift+F10");
            expect(await menuEntries(page, contextMenu)).toEqual(messageItems);
            await dismiss(page, contextMenu);
            expect(await message.locator("[data-mail-message-header]").evaluate((element) => element === document.activeElement)).toBe(
              true,
            );

            // A right-click on the body without a selection opens the message menu, and Escape leaves focus in the message.
            const body = message.locator(".mail-message-body pre").first();
            await page.locator("[data-mail-reader-heading]").focus();
            await body.click({ button: "right" });
            expect(await menuEntries(page, contextMenu)).toEqual(messageItems);
            await dismiss(page, contextMenu);
            expect(await message.evaluate((element) => element.contains(document.activeElement))).toBe(true);

            // Selected text in the body keeps the browser's own menu.
            await body.selectText();
            await body.click({ button: "right" });
            await page.waitForTimeout(100);
            expect(await page.locator(contextMenu).count()).toBe(0);
          } finally {
            await close(page);
          }
        });

        test("a list row opens its … menu on right-click and with the context-menu key or Shift+F10", async () => {
          const page = await open(`${boxPath}?team=1`);
          try {
            const row = page.locator('.mail-workspace [data-conversation-id="Conv01"]');
            const link = row.locator("a.mail-list-row");
            await row.hover();
            await row.getByRole("button", { name: "Actions for Example request 1" }).click();
            const rowItems = await menuEntries(page, dropdown);
            // An open menu keeps the row's hover tone and drops its tooltip, which would cover the menu.
            const menuState = () =>
              row.evaluate((element) => ({
                open: element.classList.contains("mail-list-entry-menu-open"),
                title: element.querySelector("a.mail-list-row")?.hasAttribute("title"),
              }));
            // The row restores its state after the menu's open or close settles, so wait for it before reading.
            const settledMenuState = async (expected: { open: boolean; title: boolean }) => {
              const element = await row.elementHandle();
              await page.waitForFunction(
                ({ node, want }) =>
                  node?.classList.contains("mail-list-entry-menu-open") === want.open &&
                  node?.querySelector("a.mail-list-row")?.hasAttribute("title") === want.title,
                { node: element, want: expected },
              );
              return menuState();
            };
            expect(await settledMenuState({ open: true, title: false })).toEqual({ open: true, title: false });
            // Answers lead; taking the conversation follows, high and visible, then Done.
            expect(rowItems.slice(0, 3)).toEqual(["Reply", "Reply in new window", "Forward"]);
            expect(rowItems[3]).toBe("Assign to meNora Example stays responsible");
            expect(rowItems[4]).toBe("Mark as done");
            expect(rowItems).toContain("Archive");
            expect(rowItems.at(-1)).toBe("Copy conversation Cloud ID");
            await dismiss(page, dropdown);
            expect(await settledMenuState({ open: false, title: true })).toEqual({ open: false, title: true });

            await link.click({ button: "right" });
            expect(await menuEntries(page, contextMenu)).toEqual(rowItems);
            expect(await settledMenuState({ open: true, title: false })).toEqual({ open: true, title: false });
            if (screenshots) await page.screenshot({ path: join(screenshots, "row-context-menu-light-1440.png") });
            await dismiss(page, contextMenu);
            expect(await page.locator(".mail-reader [data-mail-reader-heading]").count(), "a right-click opens no conversation").toBe(0);

            await link.focus();
            await page.keyboard.press("Shift+F10");
            expect(await menuEntries(page, contextMenu)).toEqual(rowItems);
            await dismiss(page, contextMenu);
            expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
            await page.keyboard.press("ContextMenu");
            expect(await menuEntries(page, contextMenu)).toEqual(rowItems);

            // Assign to me adds you; Nora Example stays responsible.
            await page.route("**/api/mail/mailboxes/Box001/conversations/assign", (route) => route.fulfill({ json: { results: [] } }));
            const assigned = page.waitForRequest((request) => request.url().endsWith("/conversations/assign"));
            await page
              .locator(contextMenu)
              .getByRole("menuitem", { name: /^Assign to me/ })
              .click();
            expect((await assigned).postDataJSON()).toEqual({ conversationIds: ["Conv01"], assigneeUserIds: ["user-1"], mode: "add" });
          } finally {
            await close(page);
          }
        });

        test("Reply from a row's menu opens the conversation and starts the reply there", async () => {
          const page = await open(boxPath);
          try {
            const row = page.locator('.mail-workspace [data-conversation-id="Conv01"]');
            const drafts = page.waitForRequest((request) => request.url().includes("/conversations/Conv01/drafts"));
            await row.locator("a.mail-list-row").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Reply", exact: true }).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            await drafts;
          } finally {
            await close(page);
          }
        });

        test("only the pill shows Reply; a message's right-click and … still reply to that message", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`);
          try {
            await page.waitForFunction(
              () => !document.querySelector("[data-mail-reply-pill] .k2b-toolbar")?.hasAttribute("data-overflow-pending"),
            );
            // Never two Replies side by side: the reader shows Reply, Reply all, and Forward only in the pill.
            const visible = await page.locator(".mail-reader").evaluate((reader) =>
              Array.from(reader.querySelectorAll<HTMLElement>("button, a"))
                .filter((element) => element.getClientRects().length > 0 && !element.closest("[data-mail-reply-pill]"))
                .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "")
                .filter((name) => /^(Reply|Reply all|Forward)(,|$)/.test(name)),
            );
            expect(visible).toEqual([]);
            const message = page.locator('[data-mail-message-id="Msg001"]');
            await message.getByRole("button", { name: "Message actions" }).click();
            for (const name of ["Reply", "Forward"])
              expect(await page.locator(dropdown).getByRole("menuitem", { name, exact: true }).count(), `${name} in …`).toBe(1);
            await dismiss(page, dropdown);
            // Right-click on the message: Reply starts the reply flow from this message's own menu.
            const drafts = page.waitForRequest((request) => request.url().includes("/conversations/Conv01/drafts"));
            await message.locator("[data-mail-message-header]").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Reply", exact: true }).click();
            await drafts;
          } finally {
            await close(page);
          }
        });

        test("the pill marks done; Archive stays in the head's …", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`);
          try {
            const toolbar = page.locator(".mail-reader-toolbar");
            expect(await toolbar.locator('[data-mail-toolbar-action="archive"]').count()).toBe(0);
            expect(await toolbar.locator('[data-mail-toolbar-action="done"]').count()).toBe(0);
            const done = page.locator("[data-mail-reply-pill]").getByRole("button", { name: "Mark as done", exact: true });
            expect(await done.isVisible()).toBe(true);
            await page.route("**/api/mail/mailboxes/Box001/conversations/completion", (route) =>
              route.fulfill({
                json: { completion: "done", results: [{ conversationId: "Conv01", status: "ok", workStatus: "done", revision: 2 }] },
              }),
            );
            const completed = page.waitForRequest((request) => request.url().endsWith("/conversations/completion"));
            await done.click();
            expect((await completed).postDataJSON()).toEqual({ conversationIds: ["Conv01"], completion: "done" });

            // The reader's … menu has the row's order, and Archive keeps its path there.
            await page.getByRole("button", { name: "More conversation actions" }).click();
            const items = await menuEntries(page, dropdown);
            expect(items.slice(0, 4)).toEqual(["Reply", "Reply in new window", "Reply all", "Forward"]);
            const archived = page.waitForRequest((request) => request.url().endsWith("/actions") && request.method() === "POST");
            await page.locator(dropdown).getByRole("menuitem", { name: "Archive", exact: true }).click();
            expect(JSON.stringify((await archived).postDataJSON())).toContain("archive");
          } finally {
            await close(page);
          }
        });

        test("a done conversation offers Reopen in the pill and in its menus", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&work=done&locale=de`);
          try {
            expect(
              await page.locator("[data-mail-reply-pill]").getByRole("button", { name: "Wieder öffnen", exact: true }).isVisible(),
            ).toBe(true);
            await page.locator("[data-mail-reader-heading]").click({ button: "right" });
            const items = await menuEntries(page, contextMenu);
            expect(items).toContain("Wieder öffnen");
            expect(items).not.toContain("Als erledigt markieren");
          } finally {
            await close(page);
          }
        });

        for (const [locale, turn, waiting, doneText] of [
          ["en", "Your turn · 3", "Waiting for reply · 2", "Done conversations that were assigned to you"],
          ["de", "Du bist dran · 3", "Wartet auf Antwort · 2", "Erledigtes, das dir zugewiesen war"],
        ] as const)
          for (const width of [1440, 390] as const)
            test(`assigned to me groups whose turn it is above what waits (${locale}, ${width})`, async () => {
              const page = await open(`${boxPath}?view=mine&team=1&locale=${locale}`, width);
              try {
                const list = page.locator(".mail-workspace [role='list']").first();
                const entries = await list
                  .locator(":scope > [role='listitem']")
                  .evaluateAll((items) =>
                    items.map((item) => item.getAttribute("data-mail-assigned-group") ?? item.getAttribute("data-conversation-id")),
                  );
                expect(entries).toEqual(["needsAction", "Conv01", "Conv02", "Conv03", "waiting", "Conv04", "Conv05"]);
                expect(await list.locator("[data-mail-assigned-group='needsAction'] h3").textContent()).toBe(turn);
                expect(await list.locator("[data-mail-assigned-group='waiting'] h3").textContent()).toBe(waiting);
                expect(await page.locator(".mail-workspace [data-mail-day-group]").count()).toBe(0);
                const footer = page.locator(".mail-workspace [data-mail-hidden-done]");
                expect(await footer.textContent()).toContain(doneText);
                const href = new URL((await footer.locator("[data-mail-show-done]").getAttribute("href"))!, "https://cloud.example");
                expect(JSON.parse(href.searchParams.get("search")!).expression).toEqual({
                  type: "and",
                  expressions: [{ type: "assigned_to_me" }, { type: "work_status", value: "done" }],
                });
                // Headings keep the height of day headings, so the rows do not move after hydration.
                const heights = await list
                  .locator("[data-mail-assigned-group]")
                  .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
                for (const height of heights) expect(height).toBe(32);
                if (screenshots && locale === "de") {
                  mkdirSync(join(screenshots, browserName), { recursive: true });
                  await page.screenshot({ path: join(screenshots, browserName, `assigned-groups-light-${width}.png`) });
                }
              } finally {
                await close(page);
              }
            });

        test("assigned to me with nothing open says so and still leads to the done conversations", async () => {
          const page = await open(`${boxPath}?view=mine&inbox=empty&locale=de`);
          try {
            await page.getByText("Dir ist nichts Offenes zugewiesen").waitFor();
            await page.getByText("Neue Zuweisungen erscheinen hier und in deinen Mitteilungen.").waitFor();
            expect(await page.locator(".mail-workspace [data-mail-show-done]").count()).toBe(1);
            if (screenshots) {
              mkdirSync(join(screenshots, browserName), { recursive: true });
              await page.screenshot({ path: join(screenshots, browserName, "assigned-groups-empty-light-1440.png") });
            }
          } finally {
            await close(page);
          }
        });

        for (const [locale, one, two] of [
          ["en", "1 attachment", "2 attachments"],
          ["de", "1 Anhang", "2 Anhänge"],
        ] as const)
          test(`the paperclip names how many attachments a row has (${locale})`, async () => {
            const page = await open(`${boxPath}?locale=${locale}`);
            try {
              const mark = (id: string) => page.locator(`.mail-workspace [data-conversation-id="${id}"] .mail-row-mark:has(.ti-paperclip)`);
              expect(await mark("Conv01").getAttribute("aria-label")).toBe(one);
              expect(await mark("Conv05").getAttribute("aria-label")).toBe(two);
              await mark("Conv05").hover();
              await page.getByRole("tooltip").filter({ hasText: two }).waitFor();
            } finally {
              await close(page);
            }
          });

        for (const [locale, summary] of [
          [
            "en",
            "17 participants · External: Sender 5 · Team: Lea Brandt, Tom Keller, Anna Roth, Ben Fischer, Clara Hoff, David Lang, Eva Pohl, Finn Braun, Greta Vogel and 7 more",
          ],
          [
            "de",
            "17 Beteiligte · Extern: Sender 5 · Team: Lea Brandt, Tom Keller, Anna Roth, Ben Fischer, Clara Hoff, David Lang, Eva Pohl, Finn Braun, Greta Vogel und 7 weitere",
          ],
        ] as const)
          test(`the wide list shows who wrote, three faces and +n, and names them in a tooltip (${locale})`, async () => {
            const page = await open(`${boxPath}?layout=columns&team=1&locale=${locale}`);
            try {
              const stack = (id: string) => page.locator(`.mail-workspace [data-conversation-id="${id}"] [data-mail-participants]`);
              expect(await stack("Conv05").getAttribute("aria-label")).toBe(summary);
              expect(await stack("Conv05").locator(".k2b-avatar").count()).toBe(3);
              expect(await stack("Conv05").locator(".k2b-avatar-stack__more").textContent()).toBe("+14");
              // A row where only its sender wrote shows that sender alone.
              expect(await stack("Conv01").locator(".k2b-avatar").count()).toBe(1);
              expect(await stack("Conv01").locator(".k2b-avatar-stack__more").count()).toBe(0);
              // Every stack starts at the same place and has the same width, so no row moves its columns.
              const boxes = await page.locator(".mail-workspace .mail-row-participants-cell").evaluateAll((cells) =>
                cells.map((cell) => {
                  const { left, width } = cell.getBoundingClientRect();
                  return { left, width };
                }),
              );
              expect(boxes.length).toBe(12);
              for (const box of boxes) expect(box).toEqual(boxes[0]!);
              await stack("Conv05").hover();
              await page.getByRole("tooltip").filter({ hasText: summary }).waitFor();
              if (screenshots && locale === "de") {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, "participants-light-1440.png") });
                // Phones keep their two-line rows; who wrote waits in the reader.
                const phone = await open(`${boxPath}?layout=columns&team=1&locale=${locale}`, 390);
                try {
                  expect(await phone.locator(".mail-workspace .mail-row-participants-cell:visible").count()).toBe(0);
                  await phone.screenshot({ path: join(screenshots, browserName, "participants-light-390.png") });
                } finally {
                  await close(phone);
                }
              }
            } finally {
              await close(page);
            }
          });

        for (const [locale, you, nobody, both] of [
          ["en", "You", "Nobody", "Responsible: You, Nora Example"],
          ["de", "Du", "Niemand", "Zuständig: Du, Nora Example"],
        ] as const)
          test(`the Responsible column shows the first face and name, you first, then +n (${locale})`, async () => {
            const page = await open(`${boxPath}?layout=columns&team=1&locale=${locale}`);
            try {
              const cell = (id: string) => page.locator(`.mail-workspace [data-conversation-id="${id}"] .mail-row-assignee-cell`);
              const faces = (id: string) => cell(id).locator("[data-mail-assignees]");
              expect(await faces("Conv01").locator(".k2b-avatar").count()).toBe(1);
              expect(await faces("Conv01").locator(".mail-row-assignee-name").textContent()).toBe("Nora Example");
              expect(await faces("Conv01").locator(".mail-row-count").count()).toBe(0);
              expect(await faces("Conv02").locator(".k2b-avatar").count()).toBe(1);
              expect(await faces("Conv02").locator(".mail-row-assignee-name").textContent()).toBe(you);
              expect(await faces("Conv02").locator(".mail-row-count").textContent()).toBe("+1");
              expect(await faces("Conv02").getAttribute("aria-label")).toBe(both);
              expect(await cell("Conv03").textContent()).toBe(nobody);
              // Every cell starts at the same place and has the same width, so no row moves its columns.
              const boxes = await page.locator(".mail-workspace .mail-row-assignee-cell").evaluateAll((cells) =>
                cells.map((cell) => {
                  const { left, width } = cell.getBoundingClientRect();
                  return { left, width };
                }),
              );
              expect(boxes.length).toBe(12);
              for (const box of boxes) expect(box).toEqual(boxes[0]!);
              await faces("Conv02").hover();
              await page.getByRole("tooltip").filter({ hasText: both }).waitFor();
              if (screenshots && locale === "de") {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, "assignees-light-1440.png") });
              }
            } finally {
              await close(page);
            }
          });

        test("a narrow Responsible column shortens the name and keeps +n inside the column", async () => {
          const page = await open(`${boxPath}?layout=columns&team=1`, 1024);
          try {
            const cell = page.locator('.mail-workspace [data-conversation-id="Conv01"] .mail-row-assignee-cell');
            await cell.locator("[data-mail-assignees]").waitFor();
            const fit = await page.locator(".mail-workspace .mail-row-assignee-cell:has(.mail-row-count)").evaluateAll((cells) =>
              cells.map((element) => {
                const right = element.getBoundingClientRect().right;
                return element.querySelector(".mail-row-count")!.getBoundingClientRect().right <= right + 0.5;
              }),
            );
            expect(fit).toEqual([true]);
            expect(await cell.locator(".mail-row-assignee-name").evaluate((element) => getComputedStyle(element).textOverflow)).toBe(
              "ellipsis",
            );
          } finally {
            await close(page);
          }
        });

        test("the three-line list ends a row's fourth line with who wrote, three faces and +n", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&team=1`);
          try {
            const row = (id: string) => page.locator(`.mail-workspace [data-conversation-id="${id}"]`);
            expect(await row("Conv05").getAttribute("data-lines")).toBe("4");
            const stack = row("Conv05").locator(".mail-row-extra [data-mail-participants]");
            expect(await stack.locator(".k2b-avatar").count()).toBe(3);
            expect(await stack.locator(".k2b-avatar-stack__more").textContent()).toBe("+14");
            // The faces sit at the line's end.
            const ends = await row("Conv05").evaluate((element) => {
              const line = element.querySelector(".mail-row-extra")!.getBoundingClientRect();
              const faces = element.querySelector(".mail-row-extra-participants")!.getBoundingClientRect();
              return { line: Math.round(line.right), faces: Math.round(faces.right) };
            });
            expect(ends.faces).toBe(ends.line);
            // Only the sender wrote: the row keeps its three lines and shows no faces.
            expect(await row("Conv04").getAttribute("data-lines")).toBe("3");
            expect(await row("Conv04").locator("[data-mail-participants]").count()).toBe(0);
            await stack.hover();
            await page.getByRole("tooltip").filter({ hasText: "17 participants · External: Sender 5" }).waitFor();
            if (screenshots) {
              mkdirSync(join(screenshots, browserName), { recursive: true });
              await page.screenshot({ path: join(screenshots, browserName, "participants-three-line-light-1440.png") });
            }
          } finally {
            await close(page);
          }
        });

        test("Copy Cloud ID writes the permalink and the structured reference from every menu and the details", async () => {
          const { parseCloudResourceClipboard, parseCloudResourceUrl } = await import("@k2b/cloud/contracts");
          const page = await open(`${boxPath}?conversation=Conv01&details=1`);
          try {
            await recordClipboard(page);
            const message = page.locator('[data-mail-message-id="Msg001"]');
            await message.locator("[data-mail-message-header]").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Copy message Cloud ID" }).click();
            await page.getByText("Message Cloud ID copied").waitFor();

            await page.getByRole("button", { name: "More conversation actions" }).click();
            await page.locator(dropdown).getByRole("menuitem", { name: "Copy conversation Cloud ID" }).click();

            const row = page.locator(".mail-list-entry").filter({ has: page.locator('a[href*="conversation=Conv02"]') });
            await row.hover();
            await row.getByRole("button", { name: /^Actions for/ }).click();
            await page.locator(dropdown).getByRole("menuitem", { name: "Copy conversation Cloud ID" }).click();

            // In the details panel the conversation's Cloud ID sits in its "…" menu, after its main action.
            const detailsMenu = page.locator("[data-mail-details-heading]").getByRole("button", { name: "More actions", exact: true });
            if (!(await detailsMenu.isVisible())) await page.locator("[data-app-workspace-detail-toggle]").first().click();
            await detailsMenu.click();
            await page.locator(dropdown).getByRole("menuitem", { name: "Copy conversation Cloud ID" }).click();

            await page.waitForFunction(() => (window as unknown as { copied: unknown[] }).copied.length === 4);
            const copied = await copiedEntries(page);
            const expected = [
              { type: "mail.message", id: "Msg001" },
              { type: "mail.conversation", id: "Conv01" },
              { type: "mail.conversation", id: "Conv02" },
              { type: "mail.conversation", id: "Conv01" },
            ];
            expect(copied.map((entry) => entry.text)).toEqual(expected.map((ref) => `${cloudUrl}/open/${ref.type}/~${ref.id}`));
            expect(copied.map((entry) => parseCloudResourceUrl(entry.text, cloudUrl))).toEqual(expected);
            // Chromium writes the web custom format too; WebKit has only the plain-text permalink.
            for (const [index, entry] of copied.entries())
              if (entry.custom !== undefined) expect(parseCloudResourceClipboard(entry.custom, cloudUrl)).toEqual(expected[index]!);
            if (browserName === "chromium") expect(copied.every((entry) => entry.custom !== undefined)).toBe(true);
          } finally {
            await close(page);
          }
        });
      });

      if (screenshots)
        test("optional Cloud ID review screenshots", async () => {
          const directory = join(resolve(screenshots), "cloud-id");
          mkdirSync(directory, { recursive: true });
          const shot = async (page: Page, name: string) => {
            await page.waitForTimeout(150);
            await page.screenshot({ path: join(directory, `${name}.png`) });
          };
          const escape = async (page: Page) => {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(100);
          };
          for (const width of [1920, 390] as const) {
            const page = await open(`${boxPath}?conversation=Conv01&theme=light${width === 1920 ? "&details=1" : ""}`, width);
            try {
              if (width === 1920) {
                const detailsHeading = page.locator("[data-mail-details-heading]");
                if (!(await detailsHeading.isVisible())) await page.locator("[data-app-workspace-detail-toggle]").first().click();
                await detailsHeading.waitFor({ state: "visible" });
                await shot(page, `${width}-details`);
                await page.getByRole("button", { name: "More conversation actions" }).click();
                await shot(page, `${width}-conversation-menu`);
                await escape(page);
                await page.locator("[data-mail-reader-heading]").click({ button: "right" });
                await shot(page, `${width}-conversation-right-click`);
                await escape(page);
                const row = page.locator(".mail-list-entry").first();
                await row.hover();
                await row.getByRole("button", { name: /^Actions for/ }).click();
                await shot(page, `${width}-row-menu`);
                await escape(page);
              }
              const message = page.locator('[data-mail-message-id="Msg001"]');
              await message.getByRole("button", { name: "Message actions" }).click();
              await shot(page, `${width}-message-menu`);
              await escape(page);
              if (width === 1920) {
                await message.locator("[data-mail-message-header]").click({ button: "right", position: { x: 200, y: 20 } });
                await shot(page, `${width}-message-right-click`);
              }
            } finally {
              await page.context().close();
            }
          }
        }, 120_000);
    });

    section("events", () => {
      const events = `${boxPath}?view=events&layout=auto&locale=de`;
      const rows = (page: Page) => page.locator("[data-mail-event]");
      for (const width of [1440, 390])
        test(`events tab ${width}: the feed renders without moving, groups days, and opens a conversation beside it`, async () => {
          const page = await open(events, width, width === 390 ? 844 : 900);
          try {
            const serverFrame = await recordedFrame(page, "server");
            assertFrame(serverFrame, await recordedFrame(page, "hydrated"), "events hydrated");
            assertFrame(serverFrame, await geometry(page), "events settled");
            expect(await currentHref(page)).toBe("/app/mail/Box001?view=events");
            // Events stays after More and is marked new until the person has opened it once.
            expect(await tabs(page).locator('[data-view-tab="events"] .k2b-view-tabs__badge').textContent()).toBe("neu");
            expect(await page.locator(".mail-events .k2b-list-group-heading").allTextContents()).toEqual(["Heute", "Gestern"]);
            expect(await rows(page).count()).toBe(11);
            const failed = page.locator('[data-mail-event="6"]');
            expect(await failed.getAttribute("data-tone")).toBe("error");
            expect(await failed.textContent()).toContain("Details in der Unterhaltung.");
            expect(await page.locator('[data-mail-event="10"] .mail-event__robot').count()).toBe(1);
            // Search, selection and the view menu belong to conversation lists.
            expect(await page.locator("[data-mail-selection-trigger], [data-mail-view-menu]").count()).toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
            if (screenshots) {
              mkdirSync(screenshots, { recursive: true });
              await page.screenshot({ path: join(screenshots, `events-light-${width}.png`) });
            }
            const response = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await rows(page).first().locator("a").click();
            await response;
            // Every other parameter stays, so the feed stays as it is beside the reader.
            await page.waitForURL(new URL(`${events}&conversation=Conv01`, server.url).href);
            await settled(page);
            expect(await page.locator(".mail-reader-subject").first().textContent()).toContain("Example request 1");
            if (width === 1440) {
              // The feed moves beside the reader and keeps its rows; the open conversation's event is marked.
              expect(await rows(page).count()).toBe(11);
              expect(await rows(page).first().locator("a").getAttribute("aria-current")).toBe("true");
              if (screenshots) await page.screenshot({ path: join(screenshots, "events-reader-light-1440.png") });
            }
          } finally {
            await close(page);
          }
        });

      test("events filters put the kind in the URL, survive a reload, reset, and show the empty and error states", async () => {
        const english = `${boxPath}?view=events&layout=auto`;
        const page = await open(english);
        try {
          await page.locator("[data-mail-events-filters] .k2b-filter-chip").first().click();
          const response = page.waitForResponse((response) => response.url().includes("/workspace-"));
          await page.getByRole("menuitemradio", { name: "Comments" }).click();
          await response;
          await page.waitForURL(/eventKind=comment/);
          await settled(page);
          expect(await rows(page).count()).toBe(1);
          expect(await page.locator("[data-mail-events-filters]").textContent()).toContain("Kind: Comments");
          await page.reload();
          await ready(page);
          expect(await rows(page).count()).toBe(1);
          const reset = page.waitForResponse((response) => response.url().includes("/workspace-"));
          await page.getByRole("button", { name: "Reset" }).click();
          await reset;
          await page.waitForURL(new URL(english, server.url).href);
          await settled(page);
          expect(await rows(page).count()).toBe(11);

          const mine = page.waitForResponse((response) => response.url().includes("/workspace-"));
          await page.locator("[data-mail-events-filters]").getByText("Concerns me").click();
          await mine;
          await settled(page);
          expect(await rows(page).count()).toBe(3);
        } finally {
          await close(page);
        }
        const empty = await open(`${english}&events=empty`);
        try {
          expect(await empty.locator(".mail-events .k2b-placeholder__title").textContent()).toBe("No events yet");
        } finally {
          await close(empty);
        }
        const filteredEmpty = await open(`${english}&events=empty&eventKind=sent`);
        try {
          expect(await filteredEmpty.locator(".mail-events .k2b-placeholder__title").textContent()).toBe("No events for this filter");
          expect(await filteredEmpty.getByRole("button", { name: "Reset filter" }).isVisible()).toBe(true);
        } finally {
          await close(filteredEmpty);
        }
        const failed = await open(`${english}&events=error`);
        try {
          expect(await failed.locator(".mail-events [role='alert']").textContent()).toContain("Events could not be loaded.");
          const retry = failed.waitForResponse((response) => response.url().includes("/workspace-"));
          await failed.getByRole("button", { name: "Try again" }).click();
          await retry;
          // The chips stay usable while the feed cannot load.
          expect(await failed.locator("[data-mail-events-filters] .k2b-filter-chip").count()).toBeGreaterThan(0);
        } finally {
          await close(failed);
        }
      });

      test("events load older pages below the feed and show the loading state while a filter loads", async () => {
        const page = await open(`${events}&events=more`);
        try {
          const before = await rows(page).count();
          const older = page.waitForResponse((response) => response.url().includes("/activity"));
          await page.locator("[data-mail-events-more]").click();
          await older;
          await settled(page);
          expect(await rows(page).count()).toBe(before + 1);
          expect(await page.locator("[data-mail-events-more]").count()).toBe(0);
          // A slow filter shows the skeleton in the feed's place, under the chips that stay where they are.
          await page.route("**/workspace-*", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            await route.continue();
          });
          const chips = await page.locator("[data-mail-events-filters]").boundingBox();
          await page.locator("[data-mail-events-filters]").getByText("Betrifft mich").click();
          await page.locator(".mail-events__skeleton").waitFor();
          expect(await page.locator("[data-mail-events-filters]").boundingBox()).toEqual(chips);
          await page.waitForURL(/eventMine=1/);
          await page.locator(".mail-events__skeleton").waitFor({ state: "detached" });
          expect(await rows(page).count()).toBe(3);
        } finally {
          await close(page);
        }
      });

      test("opening an event far down the feed keeps the feed where the person was", async () => {
        const page = await open(events, 1440, 560);
        try {
          const scroller = page.locator(".mail-events__scroll");
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await settled(page);
          const response = page.waitForResponse((response) => response.url().includes("/workspace-"));
          await rows(page).last().locator("a").click();
          await response;
          await page.waitForURL(/conversation=Conv06/);
          await settled(page);
          // The feed now sits beside the reader and still shows the event that was opened.
          expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          expect(await rows(page).last().locator("a").getAttribute("aria-current")).toBe("true");
          expect(await rows(page).last().isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("a person who sees only assigned conversations gets no Events tab", async () => {
        const page = await open(`${boxPath}?permission=assigned-only&locale=de`);
        try {
          expect(await tabs(page).locator('[data-view-tab="events"]').count()).toBe(0);
        } finally {
          await close(page);
        }
      });
    });

    section("drafts", () => {
      /** A small Mail draft API: what the reader and the composer call around one draft, with what they sent. */
      const draftApi = async (page: Page) => {
        const calls: string[] = [];
        const drafts = new Map<string, Record<string, unknown>>();
        const stamp = MAIL_SHELL_NOW;
        const makeDraft = (id: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
          id,
          mailboxId: "Box001",
          conversationId: "Conv01",
          intent: "reply",
          sourceMessageId: null,
          derivedFromMessageId: null,
          derivationKind: null,
          senderIdentityId: "00000000-0000-4000-8000-0000000000a1",
          signatureTemplateId: "Sig001",
          quoteSource: null,
          to: [{ name: "Example sender", address: "sender@example.test" }],
          cc: [],
          bcc: [],
          subject: "Re: Example request 1",
          body: "",
          format: "markdown",
          priority: "normal",
          requestDeliveryReceipt: false,
          requestReadReceipt: false,
          ...content,
          attachments: [],
          createdBy: { kind: "user", userId: "Usr001" },
          lastEditedBy: { kind: "user", userId: "Usr001" },
          lastEditedByDisplayName: "Ada Example",
          recoveryCopyCount: 0,
          revision: 1,
          state: "draft",
          deliveryClass: "normal",
          suggestion: false,
          createdAt: stamp,
          updatedAt: stamp,
          ...extra,
        });
        drafts.set(
          "Drf001",
          makeDraft(
            "Drf001",
            { subject: "Fwd: Example request 1", body: "Hello Tom, here are the pickup details for Saturday." },
            {
              intent: "forward",
            },
          ),
        );
        drafts.set(
          "DrfSug",
          makeDraft(
            "DrfSug",
            { body: "Hello,\n\nSaturday at 11 works. The chairs are ready in hall A." },
            {
              suggestion: true,
              createdBy: { kind: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000e1" },
              lastEditedBy: { kind: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000e1" },
              lastEditedByDisplayName: "Gustav",
            },
          ),
        );
        const lease = {
          holder: { kind: "user", id: "00000000-0000-4000-8000-0000000000b1", displayName: "Ada Example", avatarHash: null },
          acquiredAt: stamp,
          expiresAt: "2026-10-14T10:10:00.000Z",
          token: "00000000-0000-4000-8000-0000000000c1",
        };
        await page.route("**/api/mail/mailboxes/Box001/**", async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname.replace("/api/mail/mailboxes/Box001", "");
          const method = request.method();
          const draftPath = /^\/drafts\/(\w+)(\/.*)?$/.exec(path);
          calls.push(`${method} ${path}`);
          if (method === "POST" && path === "/draft-seeds") {
            const body = request.postDataJSON();
            const input = body.origin.input;
            return route.fulfill({
              json: {
                id: "00000000-0000-4000-8000-0000000000d1",
                mailboxId: "Box001",
                conversationId: input.conversationId,
                intent: input.intent,
                sourceMessageId: input.sourceMessageId,
                derivedFromMessageId: null,
                derivationKind: null,
                content: {
                  senderIdentityId: input.senderIdentityId,
                  signatureTemplateId: "Sig001",
                  quoteSource: null,
                  to: [{ name: "Example sender", address: "sender@example.test" }],
                  cc: [],
                  bcc: [],
                  subject: input.subject,
                  body: input.body,
                  format: "markdown",
                  priority: "normal",
                  requestDeliveryReceipt: false,
                  requestReadReceipt: false,
                },
                attachments: [],
                origin: body.origin,
                createdAt: stamp,
              },
            });
          }
          if (method === "POST" && path === "/draft-seeds/materialize") {
            const body = request.postDataJSON();
            const created = makeDraft("DrfNew", body.draft, {
              intent: body.origin.input.intent,
              sourceMessageId: body.origin.input.sourceMessageId,
            });
            drafts.set("DrfNew", created);
            return route.fulfill({ json: created });
          }
          if (path === "/compose-templates") return route.fulfill({ json: [{ id: "Sig001", kind: "signature", name: "Support" }] });
          if (path === "/compose-signature-defaults") return route.fulfill({ json: [] });
          if (method === "POST" && path === "/compose-signature")
            return route.fulfill({ json: { html: null, text: "Kind regards\nAda Example\nExample support · Hall A" } });
          if (method === "POST" && path === "/compose-preview")
            return route.fulfill({ json: { html: "<p>Preview of the mail as it arrives.</p>", text: "", formattingWarnings: [] } });
          if (draftPath) {
            const [, id, rest = ""] = draftPath;
            const draft = drafts.get(id!);
            if (!draft) return route.fulfill({ status: 404, json: { error: "Not found" } });
            if (rest === "/attachment-uploads") return route.fulfill({ json: [] });
            if (rest === "/lease" && (method === "POST" || method === "PUT")) return route.fulfill({ json: lease });
            if (rest === "/lease" && method === "DELETE") return route.fulfill({ status: 204, body: "" });
            if (rest === "/lease") return route.fulfill({ json: null });
            if (rest === "/discard") {
              drafts.set(id!, { ...draft, state: "discarded" });
              return route.fulfill({ json: { ...draft, state: "discarded" } });
            }
            if (rest === "" && method === "PUT") {
              const body = request.postDataJSON();
              const saved = { ...draft, ...body.draft, revision: Number(draft.revision) + 1 };
              drafts.set(id!, saved);
              return route.fulfill({ json: saved });
            }
            if (rest === "" && method === "GET") return route.fulfill({ json: draft });
          }
          return route.fallback();
        });
        return { calls, drafts };
      };
      const draftBox = (page: Page) => page.locator("[data-mail-inline-draft]:not([data-mail-inline-draft-pending])");
      const readyDraft = async (page: Page) => {
        await draftBox(page).waitFor();
        await page.locator("[data-mail-inline-draft] .cm-content").waitFor();
      };
      const readerReplies = (page: Page) => page.locator(".mail-reader").getByRole("button", { name: "Reply", exact: true });
      /** Polls a condition that settles after a request the page sends on its own, within a deadline. */
      const eventually = async <T>(read: () => Promise<T> | T, expected: Awaited<T>, label: string, deadline = 6000) => {
        const end = performance.now() + deadline;
        for (;;) {
          const value = await read();
          if (Object.is(value, expected) || performance.now() > end) return expect(value, label).toBe(expected);
          await Bun.sleep(50);
        }
      };

      for (const width of [1440, 390])
        test(`${width}: Reply grows into the draft in place of the pill; Escape on an unchanged draft brings the pill back`, async () => {
          let api!: Awaited<ReturnType<typeof draftApi>>;
          const page = await open(`${boxPath}?conversation=Conv01&identity=1`, width, undefined, "reduce", async (next) => {
            api = await draftApi(next);
          });
          try {
            await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
            await readyDraft(page);
            // The pill became the draft: no second Reply anywhere in the reader, the caret is in the text.
            expect(await page.locator("[data-mail-reply-pill]").count()).toBe(0);
            expect(await readerReplies(page).count()).toBe(0);
            await page.waitForFunction(() => document.activeElement?.closest(".cm-content") !== null);
            expect(new URL(page.url()).searchParams.get("draft")).toBe("DrfNew");
            expect(api.calls).toContain("POST /draft-seeds/materialize");
            // Reduced motion: the state changes at once, nothing glides.
            expect(await page.evaluate(() => document.querySelector("[data-mail-conversation-messages]")!.getAnimations().length)).toBe(0);
            // The draft stands above the newest message.
            const order = await page.evaluate(() => {
              const draft = document.querySelector("[data-mail-inline-draft]")!.getBoundingClientRect();
              const message = document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect();
              return { draftBottom: draft.bottom, messageTop: message.top };
            });
            expect(order.draftBottom).toBeLessThanOrEqual(order.messageTop);
            await page.keyboard.press("Escape");
            await page.locator("[data-mail-reply-pill]").waitFor();
            expect(await draftBox(page).count()).toBe(0);
            await page.waitForFunction(() => !new URL(location.href).searchParams.has("draft"));
            expect(api.calls).toContain("POST /drafts/DrfNew/discard");
          } finally {
            await close(page);
          }
        });

      test("the pill grows into the draft: the messages glide monotonically to their layout place in 280 ms", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "no-preference", async (next) => {
          await draftApi(next);
        });
        try {
          const messagesTop = () =>
            page.evaluate(() => document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect().top);
          const before = await messagesTop();
          // Pause the glide the moment it starts, before a frame passes, then step through it.
          await page.evaluate(() => {
            const state = window as unknown as { mailGlide?: Promise<void> };
            state.mailGlide = new Promise<void>((resolve) => {
              const observer = new MutationObserver(() => {
                const glide = document.querySelector("[data-mail-conversation-messages]")?.getAnimations()[0];
                if (!glide) return;
                glide.pause();
                observer.disconnect();
                resolve();
              });
              observer.observe(document.body, { subtree: true, childList: true });
            });
          });
          await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
          // settled: the paused animation itself is the subject; each step sets its time before reading.
          const samples = await page.evaluate(async () => {
            await (window as unknown as { mailGlide: Promise<void> }).mailGlide;
            const messages = document.querySelector("[data-mail-conversation-messages]")!;
            const glide = messages.getAnimations()[0]!;
            const total = Number(glide.effect!.getComputedTiming().duration);
            const tops = [0, total / 2, total - 1].map((at) => {
              glide.currentTime = at;
              return messages.getBoundingClientRect().top;
            });
            glide.finish();
            return { total, tops, final: messages.getBoundingClientRect().top };
          });
          expect(samples.total).toBe(280);
          expect(Math.abs(samples.tops[0]! - before)).toBeLessThanOrEqual(0.5);
          expect(samples.tops[1]!).toBeGreaterThanOrEqual(samples.tops[0]!);
          expect(samples.tops[2]!).toBeGreaterThanOrEqual(samples.tops[1]!);
          expect(Math.abs(samples.tops[2]! - samples.final)).toBeLessThanOrEqual(1);
          expect(samples.final).toBeGreaterThan(before);
        } finally {
          await close(page);
        }
      });

      test("typing saves the draft, and collapsing keeps it: no discard, the lease is released", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
          await readyDraft(page);
          await page.keyboard.type("Saturday at 11 works.");
          await eventually(() => api.drafts.get("DrfNew")?.body, "Saturday at 11 works.", "autosave");
          await page.waitForFunction(() => document.querySelector(".mail-inline-draft-status")?.textContent?.includes("Saved"));
          await page.locator("[data-mail-draft-collapse]").click();
          await page.locator("[data-mail-reply-pill]").waitFor();
          expect(api.calls).not.toContain("POST /drafts/DrfNew/discard");
          expect(api.calls).toContain("DELETE /drafts/DrfNew/lease");
        } finally {
          await close(page);
        }
      });

      test("the signature follows the text as a fixed block, and the quote line attaches the quote with the person's locale", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
          await readyDraft(page);
          const signature = page.locator("[data-mail-draft-signature]");
          await page.waitForFunction(() => document.querySelector("[data-mail-draft-signature]")?.textContent?.includes("Ada Example"));
          // Fixed: the block is not part of the editable text.
          expect(await signature.evaluate((element) => element.closest(".cm-content"))).toBeNull();
          const quote = page.locator("[data-mail-draft-quote]");
          expect(await quote.textContent()).toContain("Attach quote: Example sender");
          await quote.getByRole("button", { name: "Attach" }).click();
          await eventually(
            () => JSON.stringify(api.drafts.get("DrfNew")?.quoteSource ?? null),
            JSON.stringify({ locale: "en", timeZone: "UTC" }),
            "quote saved with locale and time zone",
          );
          expect(await quote.textContent()).toContain("Quote attached");
          await quote.getByRole("button", { name: "Remove" }).click();
          await eventually(() => api.drafts.get("DrfNew")?.quoteSource ?? null, null, "quote removed");
        } finally {
          await close(page);
        }
      });

      test("Gustav's suggestion is already open in plum, its row says so, and the first typing takes it over", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&suggestion=1`, 1440, undefined, "reduce", async (next) => {
          await draftApi(next);
        });
        try {
          await readyDraft(page);
          const draft = page.locator("[data-mail-inline-draft]");
          expect(await draft.getAttribute("data-suggestion")).toBe("");
          expect(await draft.textContent()).toContain("Suggestion from Gustav");
          expect(await page.locator('[data-conversation-id="Conv01"] [data-mail-row-draft]').getAttribute("data-suggestion")).toBe("");
          // Never a second Reply while the suggestion stands in the pill's place.
          expect(await readerReplies(page).count()).toBe(0);
          await page.locator("[data-mail-inline-draft] .cm-content").click();
          await page.keyboard.type(" Thanks!");
          await page.waitForFunction(() => !document.querySelector("[data-mail-inline-draft]")?.hasAttribute("data-suggestion"));
        } finally {
          await close(page);
        }
      });

      test("a conversation with a colleague's draft shows a draft chip with who writes it", async () => {
        const page = await open(`${boxPath}?drafts=1`, 1440);
        try {
          const chip = page.locator('[data-conversation-id="Conv01"] [data-mail-row-draft]');
          expect(await chip.textContent()).toContain("Draft");
          expect(await chip.textContent()).toContain("JE");
          expect(await chip.getAttribute("aria-label")).toBe("Draft: Jonas Example");
          expect(await chip.getAttribute("data-suggestion")).toBeNull();
        } finally {
          await close(page);
        }
      });

      test("switching to another conversation saves typing the autosave had not sent yet", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
          await readyDraft(page);
          await page.keyboard.type("Not lost");
          // Leave before the 700 ms autosave: the closing session saves, then releases the lease.
          await page.locator('[data-conversation-id="Conv02"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
          await page.waitForFunction(() => !document.querySelector("[data-mail-inline-draft]"));
          await eventually(() => api.drafts.get("DrfNew")?.body, "Not lost", "saved on leave");
          await eventually(() => api.calls.includes("DELETE /drafts/DrfNew/lease"), true, "lease released after the save");
          const saveIndex = api.calls.lastIndexOf("PUT /drafts/DrfNew");
          expect(saveIndex, "the save comes before the release").toBeLessThan(api.calls.indexOf("DELETE /drafts/DrfNew/lease"));
          expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
          // Back returns to the first conversation with its draft open again, as the person left it.
          await page.goBack();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
          expect(new URL(page.url()).searchParams.get("draft")).toBe("DrfNew");
          await readyDraft(page);
          expect(await page.locator("[data-mail-inline-draft] .cm-content").textContent()).toContain("Not lost");
        } finally {
          await close(page);
        }
      });

      test("a colleague's draft is a row; it opens in place, and a reload keeps it open", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&drafts=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          const row = page.locator('[data-mail-draft-row="Drf001"]');
          await row.waitFor();
          expect(await row.textContent()).toContain("Jonas Example");
          await row.click();
          await readyDraft(page);
          expect(api.calls).toContain("GET /drafts/Drf001");
          expect(await page.locator('[data-mail-draft-row="Drf001"]').count()).toBe(0);
          expect(new URL(page.url()).searchParams.get("draft")).toBe("Drf001");
          await page.reload();
          await ready(page);
          await readyDraft(page);
          expect(await page.locator("[data-mail-inline-draft]").getAttribute("data-intent")).toBe("forward");
        } finally {
          await close(page);
        }
      });

      test("full screen moves the list aside, is remembered, and Escape leaves it before collapsing", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          await draftApi(next);
        });
        try {
          await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
          await readyDraft(page);
          const listVisible = () =>
            page.evaluate(() => {
              const pane = document.querySelector(".mail-workspace .k2b-app-workspace__main-pane");
              return Boolean(pane && pane.getClientRects().length > 0 && pane.getBoundingClientRect().width > 0);
            });
          expect(await listVisible()).toBe(true);
          await page.locator("[data-mail-draft-fullscreen]").click();
          await page.waitForFunction(() => document.querySelector("[data-mail-inline-draft]")?.hasAttribute("data-fullscreen"));
          await eventually(listVisible, false, "list aside in full screen");
          expect(decodeURIComponent((await storedCookie(page, "cloud_mail_workspace"))?.value ?? "")).toContain('"draftFullscreen":true');
          await page.locator("[data-mail-inline-draft] .cm-content").click();
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => !document.querySelector("[data-mail-inline-draft]")?.hasAttribute("data-fullscreen"));
          expect(await draftBox(page).count()).toBe(1);
          await eventually(listVisible, true, "list back after full screen");
        } finally {
          await close(page);
        }
      });

      if (screenshots)
        test("draft review screenshots", async () => {
          const directory = resolve(screenshots);
          mkdirSync(directory, { recursive: true });
          const shoot = async (name: string, theme: "light" | "dark", width: number, path: string, act?: (page: Page) => Promise<void>) => {
            const page = await open(`${path}&theme=${theme}`, width, undefined, "reduce", async (next) => {
              await draftApi(next);
            });
            try {
              await act?.(page);
              await settled(page);
              await page.screenshot({ path: join(directory, `${name}-${theme}-${width}.png`) });
            } finally {
              await close(page);
            }
          };
          const reply = async (page: Page) => {
            await page.locator("[data-mail-reply-pill] .mail-reader-pill-reply").click();
            await readyDraft(page);
            await page.keyboard.type("Saturday at 11 works well. The chairs are ready in hall A.");
          };
          const thread = `${boxPath}?conversation=Conv01&identity=1`;
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) {
              await shoot("01-thread-pill", theme, width, thread);
              await shoot("02-draft-open", theme, width, thread, reply);
            }
          for (const width of [1440, 1920])
            await shoot("03-draft-fullscreen", "light", width, thread, async (page) => {
              await reply(page);
              await page.locator("[data-mail-draft-fullscreen]").click();
            });
          await shoot("04-draft-preview", "light", 1440, thread, async (page) => {
            await reply(page);
            await page.locator("[data-mail-draft-preview]").click();
            await page.locator(".mail-inline-draft-preview iframe").waitFor();
          });
          await shoot("05-draft-rows", "light", 1440, `${thread}&drafts=1`);
          await shoot("05-draft-rows", "light", 390, `${thread}&drafts=1`);
          for (const width of [1440, 390])
            await shoot("06-gustav-suggestion", "light", width, `${thread}&suggestion=1`, async (page) => {
              await readyDraft(page);
            });
          await shoot("06-gustav-suggestion", "dark", 1440, `${thread}&suggestion=1`, async (page) => {
            await readyDraft(page);
          });
          await shoot("07-quote-attached", "light", 1440, thread, async (page) => {
            await reply(page);
            await page.locator("[data-mail-draft-quote]").getByRole("button").click();
            await page.waitForFunction(() => document.querySelector("[data-mail-draft-quote]")?.textContent?.includes("attached"));
          });
        }, 240_000);
    });

    if (screenshots && part === "reader")
      test("optional synthetic review screenshots", async () => {
        const directory = resolve(screenshots);
        mkdirSync(directory, { recursive: true });
        for (const theme of ["light", "dark"] as const)
          for (const [width, height] of sizes) {
            if (theme === "dark" && width !== 1440 && width !== 390) continue;
            for (const [name, state, path] of [
              ["mailbox", "tabs", boxPath],
              ["mailbox", "reader", `${boxPath}?conversation=Conv01`],
              ["mailbox", "focus-notice", `${boxPath}?notice=1`],
              ...(theme === "light"
                ? [
                    ["mailbox", "folder", `${boxPath}?folder=Filed1`],
                    ["mailbox", "details", `${boxPath}?conversation=Conv01&details=1`],
                  ]
                : []),
            ]) {
              const page = await open(`${path}${path!.includes("?") ? "&" : "?"}theme=${theme}`, width, height);
              try {
                await page.screenshot({ path: join(directory, `${name}-${state}-${theme}-${width}.png`) });
              } finally {
                await close(page);
              }
            }
          }
      }, 120_000);
  });
