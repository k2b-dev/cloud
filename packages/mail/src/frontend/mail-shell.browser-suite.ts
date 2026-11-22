import { afterAll, beforeAll, test as bunTest, describe, expect, setDefaultTimeout, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import type { Browser, Locator, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, pageErrors as collectPageErrors, hoverInPlace, launchBrowser, settled, storedCookie } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { MailSearchExpression, MailWorkspacePreference } from "../contracts";
import { resolveMailSearchRoute, simpleMailSearchExpression } from "../search-state";
import { mailTagSearch } from "../search-url";
import { renderComposeContent, renderComposeSignatureBlock } from "../service/compose-renderer";
import { readMailHeadFilters } from "./_components/mail-head-filters";
import { buildMessageDocument } from "./_components/mail-message-document";
import { measureGeometry, measurements, measureStrip, tabsSelector } from "./mail-shell-metrics.browser-source";

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
registerSsrTestPlugin({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });

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
/** The list share and seen hints the fixture server stored for this browser, as Mail stores them for the person. */
const WORKSPACE_COOKIE = "mail_fixture_workspace";
const storedWorkspace = (cookieHeader: string | null): Partial<MailWorkspacePreference> | undefined => {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WORKSPACE_COOKIE}=`))
    ?.slice(WORKSPACE_COOKIE.length + 1);
  return value ? JSON.parse(decodeURIComponent(value)) : undefined;
};
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
const sidebarSelector = ".mail-sidebar .k2b-app-workspace__sidebar-desktop";
const metrics = new Bun.Transpiler({ loader: "ts" }).transformSync(
  readFileSync(resolve(import.meta.dir, "mail-shell-metrics.browser-source.ts"), "utf8"),
);
type Frame = { part: string; index: number; x: number; y: number; width: number; height: number }[];
type Strip = {
  overflow: number;
  current: string | null;
  left: number | null;
  right: number | null;
  leftInset: number;
  rightInset: number;
  labels: { text: string | null; scroll: number; width: number }[];
};
let largeMailbox = false;
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
      largeMailbox,
      locale,
      theme,
      // This opt-in exercises the same request-cookie reader as Mail's SSR page
      // without putting an artificial preference into its navigation URL.
      storedWorkspace: storedWorkspace(cookieHeader),
      cookieHeader,
      focusNoticeOpen: url.searchParams.get("notice") === "1" && !cookieHeader?.includes(`${NOTICE_COOKIE}=closed`),
    }),
  );
  // As in Cloud, the page owns the one workspace controller (its body marker), so workspaces do not install their own.
  return `<!doctype html><html lang="${locale}" class="${theme}" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fontPreloads}<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><link rel="stylesheet" href="/mail-shell.css"><style>solid-client,solid-island{display:contents}</style><style>/* Like the Cloud shell on phones: the primary action is the round button beside the bottom bar, out of the head row. */@media not all and (min-width:48rem){.k2b-app-workspace__head-primary{position:fixed;z-index:11;right:12px;bottom:12px}}</style></head><body class="k2b-ui app-accent-scope" data-theme="${theme}" data-k2b-app-workspace-controller="global" style="margin:0;${appAccentStyle("#0f766e")}">${shell(url, html)}<script src="/mail-shell-controller.js"></script>${url.searchParams.has("navigation") ? '<button id="mailbox-navigation-test" style="position:fixed;bottom:12px;left:12px;z-index:12">Open mailbox navigation</button><script src="/mail-shell-navigation.js"></script>' : ""}<script type="module">
    import { measureGeometry, measurements, measureStrip, tabsSelector } from "/mail-shell-metrics.js";
    const geometry=()=>measureGeometry(measurements);
    const strip=()=>measureStrip(tabsSelector);
    const step=(name)=>{document.documentElement.dataset.mailShellStep=name;performance.mark('mail-shell:'+name)};
    step('fonts');
    await document.fonts.ready;
    step('first frame');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    step('server geometry');
    document.documentElement.dataset.serverGeometry=JSON.stringify(geometry());
    document.documentElement.dataset.serverStrip=JSON.stringify(strip());
    document.documentElement.dataset.serverCurrent=document.querySelector(tabsSelector+' [aria-current="page"]')?.getAttribute('href')??'';
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
    [resolve(import.meta.dir, "../../../../styles.css"), resolve(import.meta.dir, "../styles/app.css")].map((entry, index) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind], minify: largeMailbox && index === 0 }),
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
        ["/mail-shell-metrics.js", ["text/javascript", metrics]],
        ["/mail-shell-controller.js", ["text/javascript", controller]],
        ["/mail-shell-navigation.js", ["text/javascript", navigation]],
      ]).get(url.pathname);
      if (asset) return new Response(asset[1], { headers: { "content-type": asset[0], ...cached } });
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)), { headers: cached });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))), { headers: cached });
      if (url.pathname.endsWith("/workspace-route") || url.pathname.endsWith("/workspace-list")) {
        const target = new URL(url.searchParams.get("href") ?? boxPath, server.url);
        const stored = storedWorkspace(request.headers.get("cookie"));
        return Response.json(
          url.pathname.endsWith("/workspace-list") ? mailboxList(target, largeMailbox) : mailboxData(target, stored, largeMailbox),
        );
      }
      // The person's list share and seen hints, kept per browser like Mail keeps them per person and mailbox.
      if (url.pathname.endsWith("/workspace-preference") || url.pathname.endsWith("/workspace-preference/seen-hints")) {
        const target = new URL(request.headers.get("referer") ?? boxPath, server.url);
        const current = mailboxData(target, storedWorkspace(request.headers.get("cookie"))).workspacePreference;
        const body: { listShare?: number | null; hintId?: MailWorkspacePreference["seenHints"][number] } = await request.json();
        const next = url.pathname.endsWith("/seen-hints")
          ? { ...current, seenHints: [...new Set([...current.seenHints, body.hintId!])] }
          : { ...current, listShare: body.listShare ?? null };
        return Response.json(next, {
          headers: { "set-cookie": `${WORKSPACE_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; Path=/` },
        });
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
      if (url.pathname.endsWith("/conversations/completion") && request.method === "POST") {
        const body: { conversationIds: string[]; completion: "done" | "open" } = await request.json();
        return Response.json({
          completion: body.completion,
          results: body.conversationIds.map((conversationId) => ({
            conversationId,
            status: "ok",
            workStatus: body.completion === "done" ? "done" : "needs_action",
            revision: 2,
          })),
        });
      }
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
  /** Another browser, such as one that draws classic scrollbars. */
  engine: Browser = browser,
) => {
  // 390 px is a touch phone in the default browser. Another browser opens a desktop window: a mobile tab would get
  // overlay scrollbars that take no room, even without --hide-scrollbars.
  const touch = width === 390 && engine === browser;
  const context = await engine.newContext({
    viewport: { width, height },
    isMobile: touch,
    hasTouch: touch,
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
/** A real mouse drag in small steps, as a person drags: press, cross the threshold, travel, rest, and let go. */
const pointerDrag = async (page: Page, from: Locator, to: Locator, options: { restMs?: number } = {}) => {
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 4, { steps: 4 });
  // settled: the target is read during the drag, where it stands still under the moving pointer.
  const end = (await to.boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.waitForTimeout(options.restMs ?? 300);
  await page.mouse.move(end.x + end.width / 2 + 1, end.y + end.height / 2, { steps: 1 });
  await page.mouse.up();
};

const close = async (page: Page) => {
  try {
    expect(pageErrors.get(page), "No page errors, including live connections").toEqual([]);
  } finally {
    await page.context().close();
  }
};
/** This browser's place for the reply box, as Mail's cookie keeps it; set before the first navigation. */
const replyAt = (position: "top" | "bottom") => async (page: Page) => {
  await page.context().addCookies([
    {
      name: "cloud_mail_workspace",
      value: encodeURIComponent(JSON.stringify({ replyPosition: position })),
      url: new URL("/", server.url).href,
    },
  ]);
};
/** The reply box, the messages and the fold row of the open conversation, in the order the reader shows them. */
const readerOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "[data-mail-reading-column] [data-mail-reply-box-frame], [data-mail-conversation-messages] [data-mail-message-id], [data-mail-older-messages]",
      ),
      (element) => element.getAttribute("data-mail-message-id") ?? (element.hasAttribute("data-mail-older-messages") ? "older" : "box"),
    ),
  );
/**
 * Records where the reply box and the newest message stand in the server frame, measured from the top of the reading
 * column so the reader's scroll does not count. The page's script sets `data-server-geometry` before it loads islands.
 */
const recordServerReply = async (page: Page) => {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.documentElement?.dataset.serverGeometry) return;
      observer.disconnect();
      const column = document.querySelector("[data-mail-reading-column]")!.getBoundingClientRect().top;
      const top = (selector: string) => (document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN) - column;
      Reflect.set(window, "serverReply", { box: top("[data-mail-reply-box-frame]"), newest: top('[data-mail-message-id="Long06"]') });
    });
    observer.observe(document, { attributes: true, subtree: true, attributeFilter: ["data-server-geometry"] });
  });
};
const replyOffsets = (page: Page) =>
  page.evaluate(() => {
    const column = document.querySelector("[data-mail-reading-column]")!.getBoundingClientRect().top;
    const top = (selector: string) => (document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN) - column;
    return {
      server: Reflect.get(window, "serverReply") as { box: number; newest: number },
      hydrated: { box: top("[data-mail-reply-box-frame]"), newest: top('[data-mail-message-id="Long06"]') },
    };
  });
const expectNoReplyJump = async (page: Page, label: string) => {
  const { server, hydrated } = await replyOffsets(page);
  expect(server, `${label}: the server frame was recorded`).toBeDefined();
  expect(Math.abs(hydrated.box - server.box), `${label}: box ${server.box} → ${hydrated.box}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(hydrated.newest - server.newest), `${label}: newest ${server.newest} → ${hydrated.newest}`).toBeLessThanOrEqual(0.5);
};
const tabs = (page: Page) => page.locator(tabsSelector);
const sidebar = (page: Page) => page.locator(sidebarSelector);
const currentHref = (page: Page) => tabs(page).locator('a[aria-current="page"]').getAttribute("href");
const geometry = (page: Page): Promise<Frame> => page.evaluate(measureGeometry, measurements);
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

/** One test file per part, so the runner spreads the cases over shards and each file stays inside its budget (#1966). */
export type MailShellPart = "head" | "mailboxes" | "layout" | "wide" | "reader" | "events" | "drafts" | "drag" | "performance";

/** The shell tests of one part. `screenshots` is a directory for optional synthetic review screenshots. */
export const defineMailShellTests = (part: MailShellPart, screenshots: string | undefined) =>
  describe(`Mail SSR and hydration shell in ${browserName}`, () => {
    largeMailbox = part === "performance";
    const section = (name: MailShellPart, define: () => void) => {
      if (name === part) define();
    };
    // These cases check behavior and placement, which the theme does not change: Mail's dark rules set only colors
    // and shadows, and the geometry matrix below compares every size in both themes. Dark copies run only for the
    // review screenshots (#1966).
    const reviewThemes = screenshots ? (["light", "dark"] as const) : (["light"] as const);
    section("performance", () => {
      test("large mailbox folder switches retain the pending list and bound warm tasks", async () => {
        const { measureFolderSwitches } = await import("./mail-folder-performance.browser-probe");
        const page = await open(`${boxPath}?folder=Inbox1`);
        try {
          await measureFolderSwitches(page);
        } finally {
          await close(page);
        }
      }, 60_000);
    });
    section("head", () => {
      // One case per summary state, each on its own page; a last case compares the heights they measured (#1966).
      const summaryHeights = new Map<number, Record<string, number>>();
      for (const width of [1440, 390]) {
        for (const state of ["ai", "stale", "writing", "failed", "limited", "person"] as const)
          test(`automation: AI summary ${state} at ${width}: one row, plum only for AI`, async () => {
            const heights = summaryHeights.get(width) ?? {};
            summaryHeights.set(width, heights);
            const page = await open(`${boxPath}?conversation=Conv01&locale=de&summary=${state}`, width, width === 390 ? 844 : 900);
            try {
              const row = page.locator("[data-mail-conversation-summary]");
              await row.waitFor();
              await settled(page);
              heights[state] = (await row.boundingBox())!.height;
              const ai = (await row.getAttribute("data-mail-summary-ai")) !== null;
              expect(ai, `${state}: AI only for AI`).toBe(state !== "person");
              // Plum is the label's ink for AI work, never a fill.
              const look = await row.evaluate((element) => {
                const probe = element.appendChild(document.createElement("i"));
                probe.style.color = "var(--k2b-ai-accent)";
                const plum = getComputedStyle(probe).color;
                probe.remove();
                return {
                  fill: getComputedStyle(element).backgroundColor,
                  plumLabel: getComputedStyle(element.querySelector(".mail-summary-row__label")!).color === plum,
                };
              });
              expect(look.fill).not.toBe("rgb(252, 243, 248)");
              expect(look.plumLabel, `${state}: plum label only for AI`).toBe(state !== "person");
              if (state === "writing") expect(await row.locator(".mail-summary-row__line").textContent()).toBe("wird geschrieben …");
              // Opening the row shows the rest in place.
              const toggle = row.locator(".mail-summary-row__toggle");
              await toggle.click();
              expect(await toggle.getAttribute("aria-expanded")).toBe("true");
              if (state === "stale") await row.getByText("1 neue Nachricht seit dieser Fassung").waitFor();
              if (state === "failed") await row.getByRole("button", { name: "Erneut versuchen" }).waitFor();
              if (state === "limited") await row.getByRole("button", { name: "Diese eine jetzt zusammenfassen" }).waitFor();
              if (screenshots) await page.screenshot({ path: join(screenshots, `summary-${state}-light-${width}.png`) });
            } finally {
              await close(page);
            }
          });
        // Reads the heights that the six state cases above measured, so it runs after them in the same file.
        test(`automation: AI summary at ${width}: every state keeps one row's height`, () => {
          const heights = summaryHeights.get(width) ?? {};
          expect(Object.keys(heights).length, "the six state cases above ran first").toBe(6);
          // Every state is the same one row, so the messages below stay where they are.
          expect(new Set(Object.values(heights).map((height) => Math.round(height))).size).toBe(1);
          expect(Math.round(heights.writing!)).toBe(36);
        });
      }

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`reader head ${theme} ${width}: ×, the subject on one line, sender and count below, fixed while the timeline scrolls`, async () => {
            const page = await open(`${boxPath}?conversation=Conv02&long-subject=1&theme=${theme}`, width, 900);
            try {
              const toolbar = page.locator("[data-mail-reader-toolbar]");
              const heading = toolbar.locator("[data-mail-reader-heading]");
              await heading.waitFor({ state: "visible" });
              expect(await page.locator(".mail-reader-scroll [data-mail-reader-heading]").count()).toBe(0);
              const metrics = await heading.evaluate((element) => {
                const css = getComputedStyle(element);
                return {
                  font: css.fontSize,
                  height: element.getBoundingClientRect().height,
                  line: parseFloat(css.lineHeight),
                  ellipsis: css.textOverflow,
                  clipped: element.scrollWidth > element.clientWidth,
                };
              });
              expect(metrics.font).toBe("17px");
              expect(metrics.height).toBeLessThanOrEqual(metrics.line + 0.5);
              expect(metrics).toMatchObject({ ellipsis: "ellipsis", clipped: true });
              expect(await toolbar.locator(".mail-reader-meta").textContent()).toContain("· 6 messages");
              const closeLink = toolbar.locator("[data-mail-reader-close]");
              const [titleBox, closeBox] = [await heading.boundingBox(), await closeLink.boundingBox()];
              expect(Math.abs(titleBox!.y + titleBox!.height / 2 - (closeBox!.y + closeBox!.height / 2))).toBeLessThanOrEqual(1);
              const before = await toolbar.boundingBox();
              await page.locator(".mail-reader-scroll").evaluate((element) => {
                element.scrollTop = 0;
              });
              await settled(page);
              expect(await toolbar.boundingBox()).toEqual(before);
              expect(await page.locator("[data-mail-details-trigger], [data-app-workspace-detail-toggle]").count()).toBe(0);
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `compact-reader-${theme}-${width}.png`) });
              }
              // × closes the conversation and returns to the list.
              await closeLink.click();
              await page.locator("[data-mail-conversation-list]").waitFor({ state: "visible" });
              expect(new URL(page.url()).searchParams.has("conversation")).toBe(false);
            } finally {
              await close(page);
            }
          });

      /** The filter button at the search field and the menu it opens, as a sheet on phones. */
      const filterButton = (page: Page) => page.locator("[data-mail-filter-button]");
      const openFilters = async (page: Page) => {
        await filterButton(page).click();
        await page.getByRole("menuitem", { name: /More filters/ }).waitFor({ state: "visible" });
      };
      /** Chooses a filter entry and waits for the list it opens. */
      const chooseFilter = async (page: Page, entry: Locator) => {
        const response = page.waitForResponse((response) => response.url().includes("/workspace-list"));
        await entry.click();
        await response;
        await ready(page);
      };
      const headFilters = (page: Page) => {
        const url = new URL(page.url());
        return readMailHeadFilters(url, resolveMailSearchRoute(url), mailboxData(url).folderId);
      };

      // F9: the head's chips now wait behind one filter button at the search field; the URL keeps their state.
      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`F9 filter button ${theme} ${width}: Unread, Flagged, With attachment, date and tag, counted on the button, Reset`, async () => {
            const page = await open(`${boxPath}?folder=Filed1&theme=${theme}&history=1`, width);
            try {
              // The same button stands in the server frame and after hydration.
              expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters");
              await openFilters(page);
              expect(await page.getByRole("menuitemcheckbox", { name: /Unread/ }).getAttribute("aria-checked")).toBe("false");
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `filter-menu-${theme}-${width}.png`) });
              }
              await chooseFilter(page, page.getByRole("menuitemcheckbox", { name: /Unread/ }));
              expect(headFilters(page)?.folderId).toBe("Filed1");
              expect(headFilters(page)?.unread).toBe(true);
              for (const name of ["Flagged", "With attachment"]) {
                if (!(await page.getByRole("menuitemcheckbox", { name }).isVisible())) await openFilters(page);
                await chooseFilter(page, page.getByRole("menuitemcheckbox", { name, exact: true }));
              }
              expect(headFilters(page)?.flagged).toBe(true);
              expect(headFilters(page)?.attachment).toBe(true);
              if (!(await page.getByRole("menuitemradio", { name: "Last 7 days" }).isVisible())) await openFilters(page);
              await chooseFilter(page, page.getByRole("menuitemradio", { name: "Last 7 days", exact: true }));
              expect(headFilters(page)?.dates.length).toBe(2);
              if (!(await page.getByRole("menuitemradio", { name: "Priority" }).isVisible())) await openFilters(page);
              await chooseFilter(page, page.getByRole("menuitemradio", { name: "Priority", exact: true }));
              if (await page.getByRole("menuitem", { name: /More filters/ }).isVisible()) await page.keyboard.press("Escape");
              expect(headFilters(page)?.tagId).toBe("Tag001");
              expect(headFilters(page)?.folderId).toBe("Filed1");
              expect(new URL(page.url()).searchParams.has("folder")).toBe(false);
              expect(await currentHref(page)).toBe(boxPath);
              // Five filters narrow the list; the button says so, and the menu names the folder they filter in.
              expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters, 5 active");
              expect(await filterButton(page).getAttribute("data-active")).toBe("true");
              await openFilters(page);
              expect(await page.getByRole("group", { name: "Only in Filed" }).isVisible()).toBe(true);
              if (screenshots) await page.screenshot({ path: join(screenshots, browserName, `filter-active-${theme}-${width}.png`) });
              await chooseFilter(page, page.getByRole("menuitem", { name: "Reset filters", exact: true }));
              expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
              expect(new URL(page.url()).searchParams.has("search")).toBe(false);
              expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters");
            } finally {
              await close(page);
            }
          });

      for (const width of [1440, 390])
        test(`F9 at ${width}: the moved filters show once at the button, move nothing, and Show filters opens them`, async () => {
          const page = await open(`${boxPath}?folder=Filed1&hints=filters-moved`, width, width === 390 ? 844 : 900);
          try {
            const hint = page.locator(".k2b-moved-hint");
            await hint.waitFor({ state: "visible" });
            expect(await hint.textContent()).toContain("The filters are here now. The views stay as tabs.");
            // The hint floats: the server frame, with the hint's room nowhere, equals the page with the hint.
            const recorded = JSON.parse((await page.locator("html").getAttribute("data-server-geometry"))!) as Frame;
            expect(await geometry(page)).toEqual(recorded);
            const seen = page.waitForRequest((request) => request.url().endsWith("/workspace-preference/seen-hints"));
            await hint.getByRole("button", { name: "Show filters" }).click();
            expect((await seen).postDataJSON()).toEqual({ hintId: "filters-moved" });
            await page.getByRole("menuitem", { name: /More filters/ }).waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            await page.reload();
            await ready(page);
            await settled(page);
            expect(await hint.count()).toBe(0);
          } finally {
            await close(page);
          }
        });

      test("F9: reload and traversal keep the same scoped search on the filter button", async () => {
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
          expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters, 3 active");
        };
        try {
          await assertSearch();
          const initial = page.url();
          await page.reload();
          await ready(page);
          await assertSearch();
          await openFilters(page);
          await chooseFilter(page, page.getByRole("menuitem", { name: "Reset filters", exact: true }));
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
          await close(page);
        }
      });

      test("F9: a custom range uses the existing editor, and Sent keeps its subset", async () => {
        const page = await open(`${boxPath}?folder=Filed1`);
        try {
          await page.route("**/api/mail/mailboxes/Box001/folders", (route) =>
            route.fulfill({ json: { folders: mailboxData(new URL(page.url())).folders } }),
          );
          await openFilters(page);
          await page.getByRole("menuitem", { name: "Custom date range…", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor({ state: "visible" });
          expect(await dialog.getByText(/on or after/i, { exact: true }).count()).toBeGreaterThan(0);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          // Sent keeps With attachment, the dates and tags, without Unread or Flagged.
          await page.goto(new URL(`${boxPath}?folder=Sent1`, server.url).href);
          await ready(page);
          await openFilters(page);
          expect(await page.getByRole("menuitemcheckbox", { name: /Unread|Flagged/ }).count()).toBe(0);
          expect(await page.getByRole("menuitemcheckbox", { name: "With attachment", exact: true }).isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("F9: an old chip link clears one filter at a time, and a view keeps the service's precedence", async () => {
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
        try {
          expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters, 2 active");
          for (const name of ["Flagged", /Unread/]) {
            await openFilters(page);
            await chooseFilter(page, page.getByRole("menuitemcheckbox", { name }));
            await page.keyboard.press("Escape");
          }
          expect(new URL(page.url()).searchParams.has("search")).toBe(false);
          expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
          await page.goto(new URL(`${boxPath}?view=mine&folder=Filed1`, server.url).href);
          await ready(page);
          expect(await currentHref(page)).toBe(`${boxPath}?view=mine`);
          await openFilters(page);
          expect(await page.getByRole("menuitemcheckbox", { name: /Unread/ }).count()).toBe(0);
          await page.keyboard.press("Escape");
          await page.goto(new URL(`${boxPath}?view=unknown&folder=Filed1`, server.url).href);
          await ready(page);
          await openFilters(page);
          expect(await page.getByRole("menuitemcheckbox", { name: /Unread/ }).isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      // The large search field stands in the head from the server on; / focuses it, Escape clears it.
      for (const theme of reviewThemes)
        for (const width of [1440, 390] as const)
          test(`search field ${theme} ${width}: always in the head, / focuses it, Escape clears it without moving the list`, async () => {
            const page = await open(`${boxPath}?folder=Filed1&theme=${theme}`, width);
            try {
              const head = page.locator(".mail-workspace > .k2b-app-workspace__head");
              const input = page.locator('input[name="q"]');
              const recorded = (JSON.parse((await page.locator("html").getAttribute("data-server-geometry"))!) as Frame).find(
                (part) => part.part.includes("k2b-app-workspace__head") && !part.part.includes("__head-"),
              );
              expect(recorded?.height).toBe((await head.boundingBox())!.height);
              expect(await input.isVisible()).toBe(true);
              expect(await input.getAttribute("placeholder")).toBe("Search Example support");
              const bar = (await page.locator(".mail-list-bar").boundingBox())!;
              await page.locator("[data-mail-conversation-list] a.mail-list-row").first().focus();
              await page.keyboard.press("/");
              expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
              const searched = page.waitForURL((url) => url.searchParams.get("q") === "invoice");
              await input.fill("invoice");
              await searched;
              await ready(page);
              // While searching, Search in and the place join the filter menu; the search spans the mailbox at first.
              expect(await filterButton(page).getAttribute("aria-label")).toBe("Filters");
              await openFilters(page);
              await page.getByRole("menuitemcheckbox", { name: "Subject" }).waitFor({ state: "visible" });
              await page.getByRole("menuitemradio", { name: /Only Filed/ }).waitFor({ state: "visible" });
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `search-menu-${theme}-${width}.png`) });
              }
              await page.keyboard.press("Escape");
              await input.focus();
              const cleared = page.waitForURL((url) => !url.searchParams.has("q"));
              await input.press("Escape");
              await cleared;
              await ready(page);
              expect(await input.inputValue()).toBe("");
              expect(new URL(page.url()).searchParams.get("folder")).toBe("Filed1");
              expect((await page.locator(".mail-list-bar").boundingBox())!.y).toBe(bar.y);
            } finally {
              await close(page);
            }
          });

      test("search: More filters opens the search builder from the filter menu", async () => {
        const page = await open(boxPath, 1680, 1050);
        try {
          await openFilters(page);
          await page.getByRole("menuitem", { name: /More filters/ }).click();
          await page
            .getByRole("dialog")
            .filter({ hasText: /filter/i })
            .first()
            .waitFor({ state: "visible" });
        } finally {
          await close(page);
        }
      });

      // F3: the first selection turns the tab row into the bulk bar, at the same place and height.
      for (const theme of reviewThemes)
        for (const width of [1440, 390] as const)
          test(`bulk bar ${theme} ${width}: the first check turns the tab row into the bulk bar at the same height`, async () => {
            const page = await open(`${boxPath}?theme=${theme}`, width);
            try {
              const bar = page.locator(".mail-list-bar");
              const firstRow = page.locator(".mail-list-entry").first();
              const before = { bar: (await bar.boundingBox())!, row: (await firstRow.boundingBox())! };
              await page.getByRole("checkbox", { name: "Select Example request 2", exact: true }).check();
              const toolbar = page.getByRole("toolbar", { name: "Selected conversation actions", exact: true });
              await toolbar.waitFor({ state: "visible" });
              await settled(page);
              expect((await bar.boundingBox())!).toEqual(before.bar);
              expect((await firstRow.boundingBox())!).toEqual(before.row);
              expect(
                await toolbar.locator("button[aria-label]").evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim())),
              ).toEqual(["", "Done", "Archive", "Delete", "Unread", "Later", "Assign", "Move", "Add tags", ""]);
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `bulk-bar-${theme}-${width}.png`) });
              }
              // Done for the selection goes through the existing batch completion route.
              const completed = page.waitForRequest((request) => request.url().endsWith("/conversations/completion"));
              await toolbar.getByRole("button", { name: /^Done/ }).click();
              expect((await completed).postDataJSON()).toMatchObject({ conversationIds: ["Conv02"], completion: "done" });
              await toolbar.waitFor({ state: "hidden" });
              // The tab row's checkbox selects the shown conversations; Escape ends the selection and the tabs return.
              // It never stays checked itself: the bulk bar takes its place at once.
              await bar.getByRole("checkbox", { name: "Select all shown conversations" }).click();
              await toolbar.waitFor({ state: "visible" });
              expect(await toolbar.textContent()).toContain("12 selected");
              await page.keyboard.press("Escape");
              await toolbar.waitFor({ state: "hidden" });
              expect(await tabs(page).getByRole("link", { name: /^All/ }).isVisible()).toBe(true);
              expect(await page.locator(".mail-list-entry .mail-list-checkbox:checked").count()).toBe(0);
            } finally {
              await close(page);
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
                // K8, K14: the group draws no fill around its rows; only the marked folder row is tinted.
                expect(await group.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
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
              Reflect.get(document.querySelector(".mail-split")!, "mailboxSwitchMarker"),
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
            // Without an open conversation there is no reader; the split around the list stays.
            Reflect.set(document.querySelector(".mail-split")!, "mailboxSwitchMarker", "kept");
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
          // The search's place counts on the filter button.
          expect(await page.locator("[data-mail-filter-button]").getAttribute("aria-label")).toBe("Filters, 1 active");
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
          expect(await page.locator("[data-mail-filter-button]").getAttribute("aria-label")).toBe("Filters");
          expect(await page.locator('input[name="q"]').inputValue()).toBe("");
          await page.locator("[data-mail-conversation-list] a.mail-list-row").first().focus();
          await page.keyboard.press("/");
          await page.waitForFunction(() => document.activeElement?.matches('input[name="q"]'));
          expect(await page.locator('input[name="q"]').inputValue()).toBe("");
        } finally {
          await close(page);
        }
      });

      test("mailbox history restores nonzero list scroll after async content commits, reversal and reload", async () => {
        // Install the same shared history owner as Cloud before mounting the island. The two mailboxes use
        // distinct scroll keys on the retained list element; restoration waits for the destination content.
        const source = `${boxPath}?history=1`;
        const destination = "/app/mail/Box002";
        // One-line rows at full width: a short window keeps the list scrollable.
        const page = await open(source, 1440, 420);
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
          await setPosition("Box001", 120);
          await sidebar(page).locator(`a[href="${destination}"]`).first().click();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "a newly opened mailbox starts at its list's top").toBe(0);
          await setPosition("Box002", 160);
          await page.goBack();
          await page.waitForURL(new URL(source, server.url).href);
          await list("Box001").waitFor();
          await ready(page);
          expect(await position("Box001"), "Back restores A after the asynchronous list replacement").toBe(120);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "Forward restores B's own list position").toBe(160);

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
          expect(await position("Box002"), "pending Back still shows the scrolled B list").toBe(160);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await ready(page);
          releaseBack.resolve();
          await backReleased.promise;
          await page.unroute(backRoute);
          await ready(page);
          expect(await position("Box002"), "Forward supersedes the pending A response").toBe(160);
          await page.goBack();
          await page.waitForURL(new URL(source, server.url).href);
          await list("Box001").waitFor();
          await ready(page);
          expect(await position("Box001"), "the pending reversal preserved A's own snapshot").toBe(120);
          await page.goForward();
          await page.waitForURL(new URL(destination, server.url).href);
          await list("Box002").waitFor();
          await ready(page);
          expect(await position("Box002"), "B keeps its own snapshot after the reversal").toBe(160);
          const beforeReload = await geometry(page);
          await page.reload();
          await ready(page);
          expect(await position("Box002"), "reload keeps the shown entry's list position").toBe(160);
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
          test(`compact draft queue ${theme} ${width}: count stays in the tab row and draft links retain context`, async () => {
            const page = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&theme=${theme}`, width);
            try {
              const serverFrame = await recordedFrame(page, "server");
              assertFrame(serverFrame, await recordedFrame(page, "hydrated"), "draft queue hydrated");
              assertFrame(serverFrame, await geometry(page), "draft queue settled");
              expect(await page.locator(".mail-list-bar [data-mail-queue-count]").textContent()).toBe("2 drafts");
              expect(await page.locator("[data-mail-drafts-list] header").count()).toBe(0);
              const rows = page.locator("[data-mail-drafts-list] > [data-draft-id]");
              expect(await rows.count()).toBe(2);
              // A draft is a conversation row: the list's width decides its lines, at the conversations' heights, so
              // nothing moves between the lists. The full-width folder is one line wide; a phone shows three.
              for (const box of [await rows.first().boundingBox(), await rows.nth(1).boundingBox()])
                expect(Math.abs(box!.height - (width < 768 ? 78 : 44))).toBeLessThanOrEqual(1);
              const draft = rows.first().locator("a.mail-list-row");
              const mark = draft.locator(".mail-row-draft");
              const recipients = await draft.locator(".mail-row-sender").boundingBox();
              const markBox = await mark.boundingBox();
              expect(await mark.textContent()).toBe("Draft");
              // Recipients stand where the sender does, and Draft follows them on the same line.
              expect(await draft.locator(".mail-row-sender").textContent()).toBe("Ada Example");
              expect(await rows.nth(1).locator(".mail-row-from .mail-row-more").textContent()).toBe("+1");
              expect(await rows.nth(1).locator('[aria-label="1 attachment"]').count()).toBe(1);
              expect(Math.abs(markBox!.y + markBox!.height / 2 - (recipients!.y + recipients!.height / 2))).toBeLessThanOrEqual(1);
              expect(markBox!.x).toBeGreaterThanOrEqual(recipients!.x + recipients!.width);
              // A new message opens as a window over this folder.
              expect(await draft.getAttribute("href")).toBe(`${boxPath}?folder=Drafts1&drafts-fixture=1&theme=${theme}&draft=Draft1`);
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
              expect(await scheduled.locator(".mail-list-bar [data-mail-queue-count]").count()).toBe(1);
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
              // The tag of an old chip link counts on the filter button.
              const filter = page.locator("[data-mail-filter-button]");
              expect(await filter.getAttribute("aria-label")).toBe("Filters, 1 active");
              expect(await filter.getAttribute("data-active")).toBe("true");
            }
            if (route.query === "view=snoozed") {
              // K15: a view waits behind More only when the strip has no room for it; the current view always shows.
              const hiddenViews = await tabs(page)
                .locator(".k2b-view-tabs__item")
                .evaluateAll((items) => items.filter((item) => item.getClientRects().length === 0).length);
              expect(await tabs(page).getByRole("button", { name: /More/ }).isVisible()).toBe(hiddenViews > 0);
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
      // #2507: on a phone the list always has its head; the reader hides it and Back brings it back.
      for (const selected of [false, true])
        test(`390${selected ? " with a conversation" : ""}: the list shows its head with tabs and Compose`, async () => {
          const page = await open(`${boxPath}${selected ? "?conversation=Conv01" : ""}`, 390, 844);
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
            await page.locator("[data-mail-reader-close]").click();
            await page.waitForFunction(() => !new URL(location.href).searchParams.has("conversation"));
            await settled(page);
            await headShown();
          } finally {
            await close(page);
          }
        });

      /** List, handle and reader boxes, and every list row's height, as the page shows them now. */
      const split = (page: Page) =>
        page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element || element.getClientRects().length === 0) return null;
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            panes: box(".mail-split-panes"),
            list: box(".mail-split-list"),
            handle: box(".mail-list-handle"),
            reader: box(".mail-split-reader"),
            column: box(".mail-reading-column"),
            toolbar: box("[data-mail-reader-toolbar]"),
            bar: box(".mail-list-bar"),
            // A row's height includes the hairline above it (K7): the drag source around the row holds both.
            rows: Array.from(document.querySelectorAll<HTMLElement>(".mail-list-rows > .mail-list-drag"))
              .filter((row) => row.getClientRects().length > 0)
              .slice(0, 6)
              .map((row) => Math.round(row.getBoundingClientRect().height)),
            open: box(".mail-list-entry-active"),
          };
        });
      // K7: a table row is 32 px under a 36 px column head; a stacked row of three lines is 72 px.
      const oneLine = 32;
      const threeLines = 72;

      // F8: list 40 % at least 320 px, reader the rest at least 480 px, no centered column, the density follows.
      for (const [width, height] of [
        [1440, 900],
        [1920, 1080],
        [2560, 1300],
      ] as const)
        test(`F8 at ${width}: list and reader share the full width, the list's width picks its density, server = hydrated`, async () => {
          const page = await open(`${boxPath}?conversation=Conv02`, width, height);
          try {
            const shown = await split(page);
            const panes = shown.panes!.width;
            const expected = Math.min(Math.max(320, panes * 0.4), panes - 492);
            expect(Math.abs(shown.list!.width - expected)).toBeLessThanOrEqual(1);
            expect(shown.handle!.width).toBe(12);
            expect(Math.abs(shown.reader!.x + shown.reader!.width - (shown.panes!.x + panes))).toBeLessThanOrEqual(1);
            // The reader's head and text use its whole width: nothing narrower stands centered in it.
            const text = await page.locator(".mail-reader-scroll").evaluate((element) => {
              const style = getComputedStyle(element);
              return element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
            });
            expect(Math.abs(shown.column!.width - text)).toBeLessThanOrEqual(1);
            expect(shown.toolbar!.width).toBeGreaterThanOrEqual(shown.reader!.width - shown.handle!.width - 1);
            expect(new Set(shown.rows)).toEqual(new Set([shown.list!.width >= 640 ? oneLine : threeLines]));
            // The server's first frame already had this split and these rows.
            const recorded = (name: "server" | "hydrated") =>
              page
                .locator("html")
                .getAttribute(`data-${name}-geometry`)
                .then((value) =>
                  (JSON.parse(value!) as Frame).filter((part) => /mail-split-list|mail-list-handle|mail-list-entry/.test(part.part)),
                );
            expect(await recorded("hydrated")).toEqual(await recorded("server"));
            if (screenshots) await page.screenshot({ path: join(screenshots, `split-light-${width}.png`) });
          } finally {
            await close(page);
          }
        });

      test("F8: without an open conversation the list takes the full width as a table under its column head, with no empty reader", async () => {
        const page = await open(boxPath, 1440, 900);
        try {
          const shown = await split(page);
          expect(shown.reader).toBeNull();
          expect(shown.handle).toBeNull();
          expect(Math.abs(shown.list!.width - shown.panes!.width)).toBeLessThanOrEqual(1);
          expect(new Set(shown.rows)).toEqual(new Set([oneLine]));
          // Date in every row, no day groups; the column head (36 px) stands in line with the rows' columns (K7).
          expect(await page.locator(".mail-list-entry .mail-row-time").count()).toBe(await page.locator(".mail-list-entry").count());
          expect(await page.getByText(/^(Today|Yesterday|This week|Earlier)$/).count()).toBe(0);
          const columns = await page.evaluate(() => {
            const left = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().left);
            const head = document.querySelector<HTMLElement>("[data-mail-list-colhead]")!;
            return {
              head: Math.round(head.getBoundingClientRect().height),
              from: [left('[data-mail-list-colhead] [data-col="from"]'), left(".mail-list-entry .mail-row-from")],
              subject: [left('[data-mail-list-colhead] [data-col="subject"]'), left(".mail-list-entry .mail-row-subject-line")],
              preview: [left('[data-mail-list-colhead] [data-col="preview"]'), left(".mail-list-entry .mail-list-preview")],
              time: [
                Math.round(document.querySelector('[data-mail-list-colhead] [data-col="time"]')!.getBoundingClientRect().right),
                Math.round(document.querySelector(".mail-list-entry .mail-row-time-cell")!.getBoundingClientRect().right),
              ],
            };
          });
          expect(columns.head).toBe(36);
          for (const [name, [head, row]] of Object.entries(columns).filter(([name]) => name !== "head") as [string, number[]][])
            expect(Math.abs(head! - row!), `${name} column stands in line`).toBeLessThanOrEqual(1);
          if (screenshots) await page.screenshot({ path: join(screenshots, "list-full-light-1440.png") });
        } finally {
          await close(page);
        }
      });

      test("F8: the handle moves by pointer and keys, saves the share once a move ends, resets to 40 %, and a reload keeps it", async () => {
        const page = await open(`${boxPath}?conversation=Conv02`, 1440, 900);
        try {
          const handle = page.locator(".mail-list-handle");
          let saves = 0;
          page.on("request", (request) => {
            if (request.method() === "PATCH" && request.url().endsWith("/workspace-preference")) saves++;
          });
          /** The saved share the page sends when a move ends or resets, the first one that `matches`. */
          const nextSave = (matches: (share: number | null) => boolean = () => true) =>
            page
              .waitForResponse(
                (response) =>
                  response.request().method() === "PATCH" &&
                  response.url().endsWith("/workspace-preference") &&
                  matches((response.request().postDataJSON() as { listShare: number | null }).listShare),
              )
              .then((response) => (response.request().postDataJSON() as { listShare: number | null }).listShare);
          await settled(page);
          const before = await split(page);
          const box = (await handle.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + 200);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 });
          expect(saves).toBe(0);
          const dropped = nextSave();
          await page.mouse.up();
          const share = await dropped;
          expect(saves).toBe(1);
          await settled(page);
          const dragged = await split(page);
          expect(Math.abs(dragged.list!.width - (before.list!.width + 120))).toBeLessThanOrEqual(2);
          expect(share!).toBeCloseTo(dragged.list!.width / dragged.panes!.width, 2);
          // Arrow keys, Shift for larger steps, End and Home keep list and reader at their minimums.
          await handle.focus();
          await page.keyboard.press("ArrowLeft");
          await settled(page);
          expect((await split(page)).list!.width).toBeLessThan(dragged.list!.width);
          await page.keyboard.press("End");
          await settled(page);
          const widest = await split(page);
          expect(Math.abs(widest.reader!.width - widest.handle!.width - 480)).toBeLessThanOrEqual(1);
          await page.keyboard.press("Home");
          await settled(page);
          expect(Math.abs((await split(page)).list!.width - 320)).toBeLessThanOrEqual(1);
          const stepSaved = nextSave((share) => share !== null && share > 320 / dragged.panes!.width + 0.03);
          await page.keyboard.press("Shift+ArrowRight");
          await stepSaved;
          await settled(page);
          const stepped = await split(page);
          expect(stepped.list!.width - 320).toBeGreaterThan(stepped.panes!.width * 0.04);
          // A reload renders the saved share in its first frame.
          await page.reload();
          await ready(page);
          await settled(page);
          expect(Math.abs((await split(page)).list!.width - stepped.list!.width)).toBeLessThanOrEqual(1);
          // A double click goes back to 40 % and clears the saved share.
          const cleared = nextSave((share) => share === null);
          await handle.dblclick();
          expect(await cleared).toBeNull();
          await settled(page);
          const reset = await split(page);
          expect(Math.abs(reset.list!.width - before.list!.width)).toBeLessThanOrEqual(1);
          await handle.focus();
          await page.keyboard.press("ArrowRight");
          const entered = nextSave((share) => share === null);
          await page.keyboard.press("Enter");
          expect(await entered).toBeNull();
          await settled(page);
          expect(Math.abs((await split(page)).list!.width - before.list!.width)).toBeLessThanOrEqual(1);
          expect(await handle.getAttribute("role")).toBe("separator");
          expect(await handle.getAttribute("aria-label")).toBe("Resize conversation list");
        } finally {
          await close(page);
        }
      });

      for (const via of ["handle", "window"] as const)
        test(`F2 by ${via}: the switch between three lines and one keeps the selection, the open row's place, and the reader`, async () => {
          // A short window, so the list scrolls and can keep the open row in place.
          const page = await open(`${boxPath}?conversation=Conv09`, 1440, 480);
          try {
            const row = page.locator('[data-conversation-id="Conv02"] .mail-list-checkbox');
            await row.check();
            const scroller = page.locator('[data-scroll-preserve="mail-list-Box001"]');
            await scroller.evaluate((element) => {
              element.scrollTop = 420;
            });
            await settled(page);
            await settled(page);
            const before = await split(page);
            expect(before.open!.y).toBeGreaterThan(before.list!.y);
            expect(before.list!.width).toBeLessThan(640);
            expect(new Set(before.rows)).toEqual(new Set([threeLines]));
            const reader = before.reader!.x + before.reader!.width;
            if (via === "handle") {
              await page.locator(".mail-list-handle").focus();
              for (let step = 0; step < 4; step++) await page.keyboard.press("Shift+ArrowRight");
            } else await page.setViewportSize({ width: 2200, height: 480 });
            await settled(page);
            const after = await split(page);
            expect(after.list!.width).toBeGreaterThanOrEqual(640);
            expect(new Set(after.rows)).toEqual(new Set([oneLine]));
            expect(await row.isChecked()).toBe(true);
            expect(new URL(page.url()).searchParams.get("conversation")).toBe("Conv09");
            // The open row keeps its place in the viewport; the reader's far edge does not move with the handle.
            expect(Math.abs(after.open!.y - before.open!.y)).toBeLessThanOrEqual(1);
            if (via === "handle") expect(Math.abs(after.reader!.x + after.reader!.width - reader)).toBeLessThanOrEqual(1);
            expect(Math.abs(after.bar!.height - before.bar!.height)).toBeLessThanOrEqual(0.5);
          } finally {
            await close(page);
          }
        });

      test("F2: V, which switched the view, shows once at the handle that the list's width decides", async () => {
        const page = await open(`${boxPath}?conversation=Conv02&hints=density-by-width`, 1440, 900);
        try {
          const hint = page.locator(".k2b-moved-hint");
          await page.locator("[data-mail-reader-heading]").focus();
          await settled(page);
          const before = await split(page);
          const seen = page.waitForRequest((request) => request.url().endsWith("/workspace-preference/seen-hints"));
          await page.keyboard.press("v");
          await hint.waitFor({ state: "visible" });
          expect(await hint.textContent()).toContain("The list's width decides how it shows. Drag here.");
          // The hint stands beside the handle and moves nothing.
          const handle = (await page.locator(".mail-list-handle").boundingBox())!;
          const shown = (await hint.boundingBox())!;
          expect(shown.x).toBeGreaterThanOrEqual(handle.x + handle.width - 1);
          expect(await split(page)).toEqual(before);
          await hint.getByRole("button", { name: "Got it" }).click();
          expect((await seen).postDataJSON()).toEqual({ hintId: "density-by-width" });
          await hint.waitFor({ state: "hidden" });
          await page.reload();
          await ready(page);
          await page.locator("[data-mail-reader-heading]").focus();
          await page.keyboard.press("v");
          await settled(page);
          expect(await hint.count()).toBe(0);
        } finally {
          await close(page);
        }
      });

      test("views: the day's done conversations are the status row's key figures above the list", async () => {
        const page = await open(`${boxPath}?done=19,14`, 1440, 900);
        try {
          const row = page.locator(".mail-list-bar .k2b-status-row");
          await row.waitFor();
          expect(await row.locator(".k2b-status-row__fact").allTextContents()).toEqual(["19 done today", "14 of them automatically"]);
          // K6: the status row is 52 px with its hairline, above the list only.
          expect((await page.locator(".mail-list-bar").boundingBox())!.height).toBe(52);
          if (screenshots) await page.screenshot({ path: join(screenshots, "views-done-line-light-1440.png") });
        } finally {
          await close(page);
        }
      });
      test("views: All done with the way to the log", async () => {
        const page = await open(`${boxPath}?done=26,17&inbox=empty`, 1440, 900);
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
            // One fixed line after the rows (36 px, the list's foot, K7): it never moves what is above it.
            expect((await footer.boundingBox())!.height).toBeCloseTo(36, 0);
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
          [`${boxPath}?done=26,17&inbox=empty&hidden=1207&locale=de`, "all-done"],
          [`${boxPath}?hidden=unknown&locale=de`, "uncounted"],
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
                    "Retired rule history",
                    "Mailing lists",
                    "Remote images",
                    "Email link setup",
                    "Settings",
                    ...(permission === "admin" ? ["Sync mailbox", "Mailbox health", "Shared links"] : []),
                  ];
            expect(await head.count()).toBe(1);
            if (permission === "assigned-only") expect(await page.getByRole("link", { name: "New message", exact: true }).count()).toBe(0);
            // Only people who may write select: the tab row's checkbox and every row's checkbox.
            expect(await page.getByRole("checkbox", { name: "Select all shown conversations", exact: true }).count()).toBe(
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
          await pointerDrag(page, page.locator('[data-conversation-id="Conv01"] .mail-list-row'), destination);
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
        test(`${path}: on a phone the search is the card's first row and the tabs follow right below it`, async () => {
          const page = await open(path, 390);
          try {
            const views = (await tabs(page).boundingBox())!;
            const head = (await page.locator(".mail-workspace > .k2b-app-workspace__head").boundingBox())!;
            const search = (await page.locator("[data-mail-head-search]").boundingBox())!;
            const rows = (await page.locator(".mail-list-entry").first().boundingBox())!;
            // One head row: the search, its filter button and "…" share it.
            expect(search.y + search.height).toBeLessThanOrEqual(head.y + head.height + 0.5);
            expect(Math.abs(views.y - (head.y + head.height))).toBeLessThanOrEqual(1);
            expect(views.y + views.height).toBeLessThanOrEqual(rows.y);
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
                    ? await page.evaluate(measureStrip, tabsSelector)
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
      /** Cloud's card with the mockup's 240 px sidebar and a conversation open. */
      const widePath = (options: { panel?: number; path?: string; extra?: string } = {}) =>
        `${options.path ?? `${boxPath}?conversation=Conv01`}${(options.path ?? "?").includes("?") ? "&" : "?"}shell=1&sidebar=240${options.panel ? `&panel=${options.panel}` : ""}${options.extra ?? ""}`;
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
          const pane = box(".mail-workspace .mail-split-list");
          return {
            list: pane ? pane.width : 0,
            pane,
            // The reader's side holds the 12 px handle and the reader.
            reader: box(".mail-workspace .mail-split-reader"),
            column: box(".mail-reading-column"),
            toolbar: box("[data-mail-reader-toolbar]"),
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
      // F8: list 40 % (at least 320 px) and reader the rest (at least 480 px) of Main, in Cloud's card, with and without
      // the panel. Details stay the shared column or wait, as Main's minimum of both and the handle decides.
      const table = [
        { width: 1440, height: 900, panel: 0 },
        { width: 1440, height: 900, panel: 416 },
        { width: 1920, height: 1080, panel: 0 },
        { width: 1920, height: 1080, panel: 416 },
        { width: 2560, height: 1080, panel: 0 },
        { width: 2560, height: 1080, panel: 416 },
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
          // The tab row spans list and reader, so an open conversation leaves the tabs their room.
          [1280, 800, true, 4, 99],
          [1024, 768, true, 2, 99],
        ] as const)
          test(`S3 head at ${width}${reading ? " while reading" : ""}: the tabs fill the head's room, More counts the rest, Events stays whole`, async () => {
            const page = await open(`${boxPath}${reading ? "?conversation=Conv01" : ""}`, width, height);
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
              await page.goto(new URL(`${boxPath}?view=kept${reading ? "&conversation=Conv01" : ""}`, server.url).href);
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
            const page = await open(`${boxPath}${reading ? "?conversation=Conv01" : ""}`, 834, 1194);
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
            const page = await open(`${boxPath}`, width, height, "reduce", async (page) => {
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

        test("on a phone the tab row fits its first views in one line and More holds the rest", async () => {
          const page = await open(`${boxPath}`, 390, 844);
          try {
            await settled(page);
            const tabs = await headTabs(page);
            expect(tabs.shown[0]).toBe("all");
            expect(tabs.more).toBeGreaterThan(0);
            expect(tabs.shown.length + tabs.more).toBe(tabs.flowing);
            expect(tabs.overflow).toBeLessThanOrEqual(1);
            expect(tabs.eventsWhole).toBe(true);
          } finally {
            await close(page);
          }
        });

        test("S3 head: widening and narrowing the window brings tabs back and lets them go, without overflow", async () => {
          const page = await open(`${boxPath}`, 1280, 800);
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

        // Opening and closing the reader moves nothing in the head or the tab row (layout-shift entries with a source
        // there): the tab row spans list and reader, and the list keeps its rows.
        for (const [width, height] of [
          [1680, 1050],
          [1280, 800],
        ] as const)
          test(`F8: opening and closing the reader at ${width} moves nothing in the head or the tab row`, async () => {
            const page = await open(boxPath, width, height);
            try {
              await settled(page);
              const strip = () =>
                page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll(
                      ".mail-workspace :is(.k2b-app-workspace__head [data-mail-head-search], .mail-list-bar :is(.k2b-view-tabs__item, .k2b-view-tabs__more))",
                    ),
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
                      if (source.node instanceof Element && source.node.closest(".k2b-app-workspace__head, .mail-list-bar"))
                        shifts.push(source.node.className || source.node.tagName);
                }).observe({ type: "layout-shift", buffered: false });
              });
              const before = await strip();
              await page.locator('[data-conversation-id="Conv03"] .mail-list-row').first().click();
              await page.waitForURL(/conversation=Conv03/);
              await page.locator("[data-mail-reader-heading]").waitFor({ state: "visible" });
              await settled(page);
              expect(await strip()).toEqual(before);
              await page.locator("[data-mail-reader-close]").click();
              await page.waitForURL((url) => !url.searchParams.has("conversation"));
              await settled(page);
              expect(await strip()).toEqual(before);
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
                ["list", `${boxPath}?theme=light`],
                ["reader", `${boxPath}?conversation=Conv01&theme=light`],
                ["reader-dark", `${boxPath}?conversation=Conv01&theme=dark`],
              ] as const) {
                const page = await open(path, width, height);
                try {
                  await settled(page);
                  await page.screenshot({ path: join(directory, `${width}-${name}.png`) });
                } finally {
                  await close(page);
                }
              }
          }, 180_000);
        for (const row of table) {
          const label = `${row.width}${row.panel ? ` with a ${row.panel} px panel` : ""}`;
          test(`F8 at ${label}: list and reader share Main, server = hydrated = settled`, async () => {
            const page = await open(widePath({ panel: row.panel }), row.width, row.height as 900);
            try {
              const frame = await wide(page);
              const main = frame.pane!.width + frame.reader!.width;
              const list = Math.min(Math.max(320, main * 0.4), main - 492);
              expect(Math.abs(frame.list - list), `${label}: list ${frame.list}`).toBeLessThanOrEqual(1);
              // Mail v5 has no Detail column; the reader keeps at least 480 px.
              expect(frame.reader!.width - 12, `${label}: reader`).toBeGreaterThanOrEqual(479.5);
              // The reader's head and text take its whole width; nothing stands centred in it.
              expect(frame.toolbar!.width, `${label}: toolbar`).toBeGreaterThanOrEqual(frame.reader!.width - 12 - 1);
              expect(frame.column!.width, `${label}: text`).toBeGreaterThan(frame.reader!.width - 12 - 80);
              // Opening the conversation marks it read after hydration; that changes no geometry.
              const read = (parts: Frame) => parts.map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
              const server = read(await recordedFrame(page, "server"));
              assertFrame(server, read(await recordedFrame(page, "hydrated")), `${label} hydrated`);
              assertFrame(server, read(await geometry(page)), `${label} settled`);
              if (screenshots) {
                mkdirSync(join(screenshots, "wide"), { recursive: true });
                await page.screenshot({ path: join(screenshots, "wide", `split-details-${row.width}-${row.panel}.png`) });
              }
            } finally {
              await close(page);
            }
          });
        }

        for (const item of [
          { path: widePath(), width: 2560, height: 1080 },
          { path: widePath(), width: 1920, height: 1080 },
          { path: `${boxPath}?conversation=Conv01`, width: 834, height: 1194 },
        ] as const)
          test(`reader at ${item.width}: Reply all and Forward live in the reply box, not the head, and stay in …`, async () => {
            const page = await open(item.path, item.width, item.height);
            try {
              const label = `${item.width}`;
              await page.locator("[data-mail-reply-box-frame]").waitFor();
              for (const name of ["Reply all", "Forward"])
                expect(
                  await page.locator("[data-mail-reader-toolbar]").getByRole("button", { name, exact: true }).count(),
                  `${label}: ${name} in head`,
                ).toBe(0);
              expect(
                await page.locator("[data-mail-details-trigger], [data-app-workspace-detail-toggle]").count(),
                `${label}: no Details`,
              ).toBe(0);
              // Nothing in the head spills out of the reader.
              const bar = await page.locator("[data-mail-reader-toolbar]").evaluate((element) => element.scrollWidth - element.clientWidth);
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

        // Mail v5: the head has the same actions for everyone; at every reader width they stay inside the reader.
        for (const locale of ["en", "de"] as const)
          test(`reader head ${locale}: every control stays inside the reader from 320 to 2560 px`, async () => {
            const misfits: string[] = [];
            const page = await open(`${boxPath}?conversation=Conv01&team=1&locale=${locale}&long-subject=1`, 320, 900);
            try {
              for (const width of [320, 390, 768, 834, 900, 1024, 1194, 1280, 1440, 1920, 2560]) {
                await page.setViewportSize({ width, height: 900 });
                await settled(page);
                const result = await page.evaluate(() => {
                  const reader = document.querySelector(".mail-reader")!.getBoundingClientRect();
                  const head = document.querySelector("[data-mail-reader-toolbar]")!;
                  const outside = [...head.querySelectorAll<HTMLElement>("button, a")]
                    .filter((element) => element.getClientRects().length > 0 && !element.closest("[popover]"))
                    .filter((element) => {
                      const box = element.getBoundingClientRect();
                      return box.left < reader.left - 0.5 || box.right > reader.right + 0.5;
                    })
                    .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "?");
                  return { reader: Math.round(reader.width), outside, overflow: head.scrollWidth - head.clientWidth };
                });
                if (result.outside.length || result.overflow > 0.5)
                  misfits.push(
                    `${locale} ${width} (reader ${result.reader}): ${result.outside.join(", ") || `overflow ${result.overflow}`}`,
                  );
              }
            } finally {
              await close(page);
            }
            expect(misfits).toEqual([]);
          });
      });

      section("reader", () => {
        // A message with a PDF and 59 photos shows them as tiles after its text; the Lightbox steps through all of them.
        for (const width of [1440, 390])
          test(`attachments at ${width}: tiles after the body hold still, one size, and open the conversation's Lightbox`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&photos=59`, width, width === 390 ? 844 : 900);
            try {
              const list = page.locator("[data-mail-message-attachments]");
              await list.waitFor();
              expect(await list.getAttribute("aria-label")).toBe("60 attachments");
              const box = (await list.boundingBox())!;
              const body = (await page.locator(".mail-message-body").first().boundingBox())!;
              expect(box.y).toBeGreaterThanOrEqual(body.y + body.height - 0.5);
              const tiles = list.locator(".mail-attachment-tile");
              expect(await tiles.count()).toBe(60);
              expect(await list.getByText("application/pdf").count()).toBe(0);
              expect(await list.getByText("Download all 60").count()).toBe(1);
              await settled(page);
              const sizes = await tiles.evaluateAll((nodes) => [
                ...new Set(
                  nodes.map(
                    (node) => `${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`,
                  ),
                ),
              ]);
              expect(sizes).toHaveLength(1);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              await tiles.nth(1).locator(".mail-attachment-tile__open").click();
              const lightbox = page.locator("dialog.k2b-lightbox[open]");
              await lightbox.waitFor();
              expect(await lightbox.locator(".k2b-thumbnail-strip__thumb").count()).toBe(60);
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.keyboard.press("Escape");
                await settled(page);
                await page.screenshot({ path: join(screenshots, browserName, `attachments-light-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });

        // One case per trace, each on its own page (#1966): the current AI assignment leads, every effect stays below.

        // Mail v5: one head with the same five actions for everyone, the state as one row of chips, no details panel.
        for (const [width, height] of [
          [1920, 1080],
          [1440, 900],
          [390, 844],
        ] as const)
          test(`head at ${width}: five actions and "…", the subject on one line, one row of chips, no details`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&team=1&work=waiting&long-subject=1`, width, height);
            try {
              const head = page.locator("[data-mail-reader-toolbar]");
              await head.waitFor();
              await settled(page);
              const shown = await head
                .locator("[data-mail-toolbar-action]")
                .evaluateAll((elements) =>
                  elements
                    .filter((element) => element.getClientRects().length > 0)
                    .map((element) => element.getAttribute("data-mail-toolbar-action")),
                );
              if (width >= 1440) expect(shown).toEqual(["done", "archive", "trash", "later", "assign"]);
              else expect(shown[0]).toBe("done");
              expect(await head.locator("[data-mail-reader-more]").isVisible()).toBe(true);
              // The subject never wraps; the chip row stays one line.
              const title = await page.locator("[data-mail-reader-heading]").evaluate((element) => ({
                lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
                clipped: element.scrollWidth > element.clientWidth,
              }));
              expect(title).toEqual({ lines: 1, clipped: true });
              const chips = page.locator("[data-mail-reader-chips]");
              expect(Math.round((await chips.boundingBox())!.height)).toBe(28);
              expect(await chips.getByText("Waiting for reply").isVisible()).toBe(true);
              expect(
                await page.locator("[data-mail-details-trigger], [data-app-workspace-detail-toggle], .k2b-app-workspace__detail").count(),
              ).toBe(0);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              // Everything the head hides stays in "…".
              await head.locator("[data-mail-reader-more]").click();
              const rows = (await page.getByRole("menuitem").allTextContents()).map((row) => row.trim());
              for (const name of ["Archive", "Move to Trash", "Show later…", "Assign", "Show activity", "Print conversation"])
                expect(rows, name).toContain(name);
              await page.keyboard.press("Escape");
              if (screenshots) {
                mkdirSync(join(screenshots, browserName), { recursive: true });
                await page.screenshot({ path: join(screenshots, browserName, `reader-head-light-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });

        test("notes: an internal note stands centered at its time, a deleted one leaves a quiet line, never a message head", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&notes=1`, 1440, 900);
          try {
            const note = page.locator('[data-mail-note="Note01"]');
            await note.waitFor();
            expect(await note.getByText("Internal note from Nora Example").isVisible()).toBe(true);
            expect(await note.getByText("internal", { exact: true }).isVisible()).toBe(true);
            expect(await note.locator(".k2b-avatar, [data-mail-message-header]").count()).toBe(0);
            const order = await page
              .locator("[data-mail-conversation-messages] > *")
              .evaluateAll((elements) =>
                elements.map((element) => element.getAttribute("data-mail-note") ?? element.getAttribute("data-mail-message-id")),
              );
            // The reply box stands on top, so the newest item comes first and the notes follow at their time.
            expect(order).toEqual(["Msg001", "Note02", "Note01"]);
            expect(await page.getByText("Note from Nora Example deleted").isVisible()).toBe(true);
            const [tile, column] = await Promise.all([note.boundingBox(), page.locator("[data-mail-conversation-messages]").boundingBox()]);
            expect(Math.abs(tile!.x - column!.x - (column!.x + column!.width - tile!.x - tile!.width))).toBeLessThanOrEqual(1);
            // The note's "…" edits it in place.
            await note.getByRole("button", { name: "Note actions" }).click();
            await page.getByRole("menuitem", { name: "Edit" }).click();
            await note.locator("textarea").waitFor();
            expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
            await page.keyboard.press("Escape");
            await note.locator("textarea").waitFor({ state: "detached" });
            if (screenshots) await page.screenshot({ path: join(screenshots, `notes-light-1440.png`) });
          } finally {
            await close(page);
          }
        });

        test("hint: once at the chip row, where notes and the details went; Got it stores it as seen", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&hints=reader-head-moved`, 1440, 900);
          try {
            const hint = page.locator(".k2b-moved-hint:popover-open");
            await hint.waitFor();
            expect(await hint.textContent()).toContain("Notes are now in the timeline, everything else is here in the head.");
            const seen = page.waitForRequest(
              (request) => request.method() === "PUT" && request.url().endsWith("/workspace-preference/seen-hints"),
            );
            await page.route("**/workspace-preference/seen-hints", (route) =>
              route.fulfill({ json: { listShare: null, seenHints: ["reader-head-moved"] } }),
            );
            await hint.getByRole("button", { name: "Got it" }).click();
            expect((await seen).postDataJSON()).toEqual({ hintId: "reader-head-moved" });
            await hint.waitFor({ state: "detached" });
          } finally {
            await close(page);
          }
        });

        test("sender: a click opens the card with the address, earlier conversations, and the sender's actions", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 1440, 900);
          const contactRequested = Promise.withResolvers<void>();
          const finishContact = Promise.withResolvers<void>();
          try {
            await page.route("**/api/capabilities/v1/queries/contacts/contact.resolve", async (route) => {
              contactRequested.resolve();
              await finishContact.promise;
              await route.continue();
            });
            await page.route("**/api/mail/mailboxes/Box001/sender-conversations?*", (route) =>
              route.fulfill({
                json: {
                  items: [
                    {
                      id: "Conv05",
                      subject: "Invented earlier request",
                      participantSummary: "Example sender",
                      latestMessageAt: "2026-09-01T10:00:00.000Z",
                      preview: null,
                    },
                  ],
                  total: 1,
                },
              }),
            );
            const trigger = page.locator("[data-mail-sender-trigger]").first();
            await trigger.click();
            const card = page.getByRole("dialog", { name: "About Example sender" });
            await card.waitFor();
            await card.getByText("Invented earlier request").waitFor();
            await contactRequested.promise;
            // History and contact details load independently. Complete history
            // first to guard against using it as proof that contact rows exist.
            finishContact.resolve();
            // The fixture has no contact app behind the directory: the card says so, keeps the address, and offers Retry.
            await card.getByText("The contact could not be loaded").waitFor();
            expect(await card.getByText("sender@example.test").isVisible()).toBe(true);
            expect(await card.getByText("The contact could not be loaded").isVisible()).toBe(true);
            expect(await card.getByRole("button", { name: "Retry" }).isVisible()).toBe(true);
            expect(await card.getByText("All messages from this sender").isVisible()).toBe(true);
            expect(await trigger.getAttribute("aria-expanded")).toBe("true");
            await page.keyboard.press("Escape");
            await card.waitFor({ state: "hidden" });
            expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
          } finally {
            finishContact.resolve();
            await close(page);
          }
        });

        // One case per width, each on its own page (#1966).
        for (const [width, height] of [
          [1920, 1080],
          [1440, 900],
          [1194, 834],
          [900, 900],
          [834, 1194],
          [390, 844],
          [320, 640],
        ] as const)
          test(`the reply box at ${width} stays inside the reader, above the newest message`, async () => {
            const page = await open(`${boxPath}?conversation=Conv01&theme=dark`, width, height);
            try {
              const frame = page.locator("[data-mail-reply-box-frame]");
              await frame.waitFor();
              const fit = await page.evaluate(() => {
                const box = document.querySelector<HTMLElement>("[data-mail-reply-box-frame]")!.getBoundingClientRect();
                const reader = document.querySelector<HTMLElement>(".mail-reader-scroll")!.getBoundingClientRect();
                const messages = document.querySelector<HTMLElement>("[data-mail-conversation-messages]")!.getBoundingClientRect();
                return {
                  inReader: box.left >= reader.left - 0.5 && box.right <= reader.right + 0.5,
                  above: box.bottom <= messages.top + 0.5,
                };
              });
              expect(fit.inReader, `${width} box inside the reader`).toBe(true);
              expect(fit.above, `${width} box above the newest message`).toBe(true);
              expect(await page.locator("[data-mail-reply-pill]").count()).toBe(0);
            } finally {
              await close(page);
            }
          });

        test("phone: the reply box chosen at the bottom waits there, in thumb reach", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 390, 844, "reduce", replyAt("bottom"));
          try {
            const box = page.locator("[data-mail-reply-box-frame]");
            await box.waitFor();
            const scroller = (await page.locator(".mail-reader-scroll").boundingBox())!;
            const newest = (await page.locator("[data-mail-conversation-messages] [data-mail-message-id]").last().boundingBox())!;
            const frame = (await box.boundingBox())!;
            expect(frame.y).toBeGreaterThanOrEqual(newest.y + newest.height - 0.5);
            expect(frame.y + frame.height).toBeGreaterThan(scroller.y + scroller.height - 48);
          } finally {
            await close(page);
          }
        });

        test("phone: the reply box stands on top, above the newest message; Done is in the head", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`, 390, 844);
          try {
            const box = page.locator("[data-mail-reply-box-frame]");
            await box.waitFor();
            const scroller = (await page.locator(".mail-reader-scroll").boundingBox())!;
            const newest = (await page.locator("[data-mail-conversation-messages] [data-mail-message-id]").first().boundingBox())!;
            const frame = (await box.boundingBox())!;
            expect(frame.y + frame.height).toBeLessThanOrEqual(newest.y + 0.5);
            expect(frame.x).toBeGreaterThanOrEqual(scroller.x - 0.5);
            expect(frame.x + frame.width).toBeLessThanOrEqual(scroller.x + scroller.width + 0.5);
            // The head keeps ×, the subject, Done and "…" on a phone; there is no details control any more.
            expect(await page.locator('[data-mail-reader-toolbar] [data-mail-toolbar-action="done"]').isVisible()).toBe(true);
            expect(await page.locator("[data-mail-details-trigger]").count()).toBe(0);
            // Touch: Done marks the conversation done.
            await page.route("**/api/mail/mailboxes/Box001/conversations/completion", (route) =>
              route.fulfill({
                json: { completion: "done", results: [{ conversationId: "Conv01", status: "ok", workStatus: "done", revision: 2 }] },
              }),
            );
            const completed = page.waitForRequest((request) => request.url().endsWith("/conversations/completion"));
            await page.locator('[data-mail-reader-toolbar] [data-mail-toolbar-action="done"]').tap();
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
            await ready(page);
            // Back loads the link's workspace again, and the URL changes before it arrives. The test holds that answer,
            // so it meets the pending Back on every run, not only on a slow runner, and counts once the reader is idle (#3268).
            const backRequested = Promise.withResolvers<void>();
            const releaseBack = Promise.withResolvers<void>();
            await page.route("**/api/mail/mailboxes/Box001/workspace-route?*", async (route) => {
              backRequested.resolve();
              await releaseBack.promise;
              await route.fallback();
            });
            try {
              await page.goBack();
              await backRequested.promise;
              expect(new URL(page.url()).searchParams.get("message")).toBe("Long02");
              expect(await page.locator(".k2b-app-workspace__main").getAttribute("aria-busy"), "the pending Back says it is busy").toBe(
                "true",
              );
            } finally {
              releaseBack.resolve();
            }
            await ready(page);
            expect(await cards.count()).toBe(6);
            expect(await page.locator("[data-mail-older-messages]").count()).toBe(0);
          } finally {
            await close(page);
          }
        });

        test("reader: the box stands on top by default; “…” moves it under the conversation for this browser, and a reload keeps it without a jump", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 900, "reduce", recordServerReply);
          try {
            await settled(page);
            expect(await readerOrder(page)).toEqual(["box", "Long06", "Long05", "Long04", "older"]);
            await expectNoReplyJump(page, "top");
            const choose = async (name: "Top" | "Bottom") => {
              await page.getByRole("button", { name: "More conversation actions" }).click();
              const choice = page.locator(".k2b-dropdown__menu:popover-open").getByRole("menuitemradio", { name, exact: true });
              expect(await choice.getAttribute("aria-checked")).toBe("false");
              await choice.click();
              await settled(page);
            };
            await choose("Bottom");
            expect(await readerOrder(page)).toEqual(["older", "Long04", "Long05", "Long06", "box"]);
            const stored = await storedCookie(page, "cloud_mail_workspace");
            expect(JSON.parse(decodeURIComponent(stored!.value)).replyPosition).toBe("bottom");
            // The box moved into view where the person chose it.
            const [view, box] = await Promise.all([
              page.locator(".mail-reader-scroll").boundingBox(),
              page.locator("[data-mail-reply-box-frame]").boundingBox(),
            ]);
            expect(box!.y + box!.height).toBeLessThanOrEqual(view!.y + view!.height + 0.5);
            // A reload renders the chosen place on the server; the first frame already shows it.
            await page.reload();
            await ready(page);
            await settled(page);
            expect(await readerOrder(page)).toEqual(["older", "Long04", "Long05", "Long06", "box"]);
            await expectNoReplyJump(page, "bottom after reload");
            await choose("Top");
            expect(await readerOrder(page)).toEqual(["box", "Long06", "Long05", "Long04", "older"]);
            await page.reload();
            await ready(page);
            await settled(page);
            expect(await readerOrder(page)).toEqual(["box", "Long06", "Long05", "Long04", "older"]);
            await expectNoReplyJump(page, "top after reload");
          } finally {
            await close(page);
          }
        });

        test("reader: a conversation taller than the reader opens at its start: the box, then the newest message, the head in view", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 480 as 900);
          try {
            const scroller = page.locator(".mail-reader-scroll");
            expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await settled(page);
            expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
            expect(await readerOrder(page)).toEqual(["box", "Long06", "Long05", "Long04", "older"]);
            const [view, box] = await Promise.all([scroller.boundingBox(), page.locator("[data-mail-reply-box-frame]").boundingBox()]);
            expect(box!.y).toBeGreaterThanOrEqual(view!.y - 0.5);
            expect(await page.locator("[data-mail-reader-heading]").isVisible()).toBe(true);
            const server = await recordedFrame(page, "server");
            assertFrame(server, await geometry(page), "tall conversation on top settled");
          } finally {
            await close(page);
          }
        });

        test("reader: with the box at the bottom, a tall conversation opens at the start of its newest message", async () => {
          const page = await open(widePath({ path: `${boxPath}?conversation=Conv02` }), 1440, 480 as 900, "reduce", replyAt("bottom"));
          try {
            const scroller = page.locator(".mail-reader-scroll");
            expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await settled(page);
            const [view, newest] = await Promise.all([
              scroller.boundingBox(),
              page.locator("[data-mail-conversation-messages] [data-mail-message-id]").last().boundingBox(),
            ]);
            // Its start is in view; at the end of the content it may stand lower than the top.
            expect(newest!.y).toBeGreaterThanOrEqual(view!.y - 0.5);
            expect(newest!.y).toBeLessThan(view!.y + view!.height - 40);
            expect(await page.locator("[data-mail-reader-heading]").isVisible()).toBe(true);
            // The head and the list hold still from the server frame on; only the timeline scrolls to the newest message.
            const server = await recordedFrame(page, "server");
            const read = (parts: Frame) =>
              parts
                .filter((part) => !part.part.includes("mail-reading-column"))
                .map((part) => ({ ...part, part: part.part.replace(" mail-list-entry-unread", "") }));
            assertFrame(read(server), read(await geometry(page)), "tall conversation settled");
          } finally {
            await close(page);
          }
        });

        test("rows: beside the reader at 1440 every row has three lines of one height, tags and all", async () => {
          const page = await open(widePath(), 1440, 900);
          try {
            const rows = await page
              .locator(".mail-workspace .mail-list-entry")
              .evaluateAll((elements) =>
                elements
                  .filter((element) => element.getBoundingClientRect().bottom < innerHeight)
                  .map((element) => element.getBoundingClientRect().height),
              );
            expect(rows.length).toBeGreaterThan(4);
            for (const height of rows) expect(Math.abs(height - 78)).toBeLessThanOrEqual(0.5);
          } finally {
            await close(page);
          }
        });

        test("dark at 1920: the reader shares the list's surface, with no seam", async () => {
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
              const reader = document.querySelector(".mail-reader")!;
              const style = getComputedStyle(reader);
              return {
                reader: surface(document.querySelector(".mail-reader")),
                list: surface(document.querySelector(".mail-workspace .mail-split-list")),
                shadow: style.boxShadow,
              };
            });
            // One surface: the list and the reader (the reader drew a raised dark fill before).
            expect(seam.reader).toBe(seam.list);
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
            expect(rowItems.slice(0, 2)).toEqual(["Reply", "Forward"]);
            expect(rowItems[2]).toBe("Assign to meNora Example stays responsible");
            expect(rowItems[3]).toBe("Mark as done");
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
          const page = await open(`${boxPath}?identity=1`);
          try {
            const row = page.locator('.mail-workspace [data-conversation-id="Conv01"]');
            // The reply starts as a draft in the conversation: Mail creates it before anyone types.
            const seed = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/draft-seeds"));
            await row.locator("a.mail-list-row").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Reply", exact: true }).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv01");
            expect((await seed).postDataJSON()).toMatchObject({
              origin: { kind: "compose", input: { intent: "reply", conversationId: "Conv01" } },
            });
          } finally {
            await close(page);
          }
        });

        test("the reply box stands open and each open message has one reply arrow; a message's right-click and … reply into the box", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&identity=1`);
          try {
            await page.locator("[data-mail-reply-box-frame]").waitFor();
            // Mail v5: besides the box, each open message has one reply arrow beside its date; nothing else replies.
            expect(await page.locator('[data-mail-message-id="Msg001"] [data-mail-message-reply]').count()).toBe(1);
            const visible = await page.locator(".mail-reader").evaluate((reader) =>
              Array.from(reader.querySelectorAll<HTMLElement>("button, a"))
                .filter(
                  (element) =>
                    element.getClientRects().length > 0 &&
                    !element.closest("[data-mail-reply-box-frame]") &&
                    !element.hasAttribute("data-mail-message-reply"),
                )
                .map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "")
                .filter((name) => /^(Reply|Reply all|Forward)(,|$)/.test(name)),
            );
            expect(visible).toEqual([]);
            const message = page.locator('[data-mail-message-id="Msg001"]');
            await message.getByRole("button", { name: "Message actions" }).click();
            for (const name of ["Reply", "Forward"])
              expect(await page.locator(dropdown).getByRole("menuitem", { name, exact: true }).count(), `${name} in …`).toBe(1);
            await dismiss(page, dropdown);
            // Right-click on the message: Reply lands in the box; no second draft, no "Continue draft?" dialog.
            await message.locator("[data-mail-message-header]").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Reply", exact: true }).click();
            expect(await page.locator("[data-mail-reply-box-frame]").count()).toBe(1);
            expect(await page.getByRole("dialog").count()).toBe(0);
          } finally {
            await close(page);
          }
        });

        test("the head marks done and archives; the … menu keeps the row's order", async () => {
          const page = await open(`${boxPath}?conversation=Conv01`);
          try {
            const toolbar = page.locator("[data-mail-reader-toolbar]");
            expect(await toolbar.locator('[data-mail-toolbar-action="archive"]').isVisible()).toBe(true);
            const done = toolbar.getByRole("button", { name: "Done", exact: true });
            expect(await done.isVisible()).toBe(true);
            expect(await page.locator("[data-mail-reply-box-frame]").getByRole("button", { name: "Mark as done" }).count()).toBe(0);
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
            expect(items.slice(0, 3)).toEqual(["Reply", "Reply all", "Forward"]);
            const archived = page.waitForRequest((request) => request.url().endsWith("/actions") && request.method() === "POST");
            await page.locator(dropdown).getByRole("menuitem", { name: "Archive", exact: true }).click();
            expect(JSON.stringify((await archived).postDataJSON())).toContain("archive");
          } finally {
            await close(page);
          }
        });

        test("a done conversation offers Reopen in the head and in its menus", async () => {
          const page = await open(`${boxPath}?conversation=Conv01&work=done&locale=de`);
          try {
            expect(
              await page.locator("[data-mail-reader-toolbar]").getByRole("button", { name: "Wieder öffnen", exact: true }).isVisible(),
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
                  // Each row stands in its drag source (S7); headings stand on their own.
                  .locator(":scope > [role='listitem'], :scope > .mail-list-drag > [role='listitem']")
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
                // Headings have the group head's fixed height (36 px, K17), so the rows do not move after hydration.
                const heights = await list
                  .locator("[data-mail-assigned-group]")
                  .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
                for (const height of heights) expect(height).toBe(36);
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

        for (const [locale, both] of [
          ["en", "Responsible: You, Nora Example"],
          ["de", "Zuständig: Du, Nora Example"],
        ] as const)
          test(`a shared mailbox's rows show who is responsible: one face, you first, then +n (${locale})`, async () => {
            const page = await open(`${boxPath}?team=1&locale=${locale}`);
            try {
              const faces = (id: string) => page.locator(`.mail-workspace [data-conversation-id="${id}"] [data-mail-assignees]`);
              expect(await faces("Conv01").locator(".k2b-avatar").count()).toBe(1);
              expect(await faces("Conv01").locator(".k2b-avatar-stack__more").count()).toBe(0);
              expect(await faces("Conv02").locator(".k2b-avatar").count()).toBe(1);
              expect(await faces("Conv02").locator(".k2b-avatar-stack__more").textContent()).toBe("+1");
              expect(await faces("Conv02").getAttribute("aria-label")).toBe(both);
              expect(await faces("Conv03").count()).toBe(0);
              // The date ends every row at the same edge, whatever marks stand before it.
              const ends = await page
                .locator(".mail-workspace .mail-row-time")
                .evaluateAll((times) => times.map((time) => Math.round(time.getBoundingClientRect().right)));
              expect(new Set(ends).size).toBe(1);
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

        test("Copy Cloud ID writes the permalink and the structured reference from every menu", async () => {
          const { parseCloudResourceClipboard, parseCloudResourceUrl } = await import("@k2b/cloud/contracts");
          const page = await open(`${boxPath}?conversation=Conv01`);
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

            // A right-click on the conversation opens the same "…" menu.
            await page.locator("[data-mail-reader-heading]").click({ button: "right" });
            await page.locator(contextMenu).getByRole("menuitem", { name: "Copy conversation Cloud ID" }).click();

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
            const page = await open(`${boxPath}?conversation=Conv01&theme=light`, width);
            try {
              if (width === 1920) {
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
      const events = `${boxPath}?view=events&locale=de`;
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
            // Each day heads its rows; the copy that stays at the top of the list is decoration for sighted readers.
            expect(await page.locator(".mail-events .k2b-virtual-feed__item .k2b-virtual-feed__separator").allTextContents()).toEqual([
              "Heute",
              "Gestern",
            ]);
            expect(await page.locator(".mail-events .k2b-virtual-feed__sticky").getAttribute("aria-hidden")).toBe("true");
            expect(await page.locator(".mail-events .k2b-virtual-feed__sticky").textContent()).toBe("Heute");
            expect(await rows(page).count()).toBe(11);
            expect(await rows(page).locator(".k2b-activity__entry").count()).toBe(11);
            expect(await rows(page).locator("[title]").count()).toBe(0);
            expect(await page.locator(".mail-events__person.k2b-filter-chip").count()).toBe(1);
            const filterLooks = await page.locator("[data-mail-events-filters] .k2b-filter-chip").evaluateAll((chips) =>
              chips.map((chip) => {
                const style = getComputedStyle(chip);
                // FilterChip draws its 1px edge as an inset shadow (the control edge contract), not a border.
                return [style.getPropertyValue("--k2b-edge-width").trim(), style.minHeight, style.padding, style.borderRadius];
              }),
            );
            expect(filterLooks[0]?.[0]).toBe("1px");
            expect(filterLooks[1]).toEqual(filterLooks[0]);

            const firstRow = rows(page).first().locator(".k2b-activity__entry");
            const rowGeometry = await firstRow.evaluate((element) => {
              const surface = element.getBoundingClientRect();
              const item = element.parentElement!.getBoundingClientRect();
              const css = getComputedStyle(element);
              return { left: surface.left - item.left, right: item.right - surface.right, radius: css.borderRadius };
            });
            expect([rowGeometry.left, rowGeometry.right]).toEqual([8, 8]);
            expect(rowGeometry.radius).toBe("8px");
            const beforeHover = await firstRow.boundingBox();
            await hoverInPlace(firstRow);
            await settled(page);
            expect(await firstRow.boundingBox()).toEqual(beforeHover);
            const ink = await firstRow.evaluate((element) => [
              getComputedStyle(element.querySelector(".k2b-activity__text")!).color,
              getComputedStyle(element.querySelector("a")!).color,
            ]);
            expect(ink[0]).toBe(ink[1]);
            const failed = page.locator('[data-mail-event="6"]');
            expect(await failed.getAttribute("data-tone")).toBe("error");
            expect(await failed.textContent()).toContain("Details in der Unterhaltung.");
            expect(await page.locator('[data-mail-event="10"] .k2b-activity__avatar .ti-robot').count()).toBe(1);
            // Search, selection and the view menu belong to conversation lists.
            expect(await page.locator("[data-mail-selection-trigger]").count()).toBe(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
            if (screenshots) {
              mkdirSync(screenshots, { recursive: true });
              await page.screenshot({ path: join(screenshots, `events-light-${width}.png`) });
            }
            const response = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await rows(page).first().locator("a").focus();
            await page.keyboard.press("Enter");
            await response;
            // Every other parameter stays, so the feed stays as it is beside the reader.
            await page.waitForURL(new URL(`${events}&conversation=Conv01`, server.url).href);
            await settled(page);
            expect(await page.locator(".mail-reader-title").first().textContent()).toContain("Example request 1");
            if (width === 1440) {
              // The feed moves beside the reader and keeps its rows; the open conversation's event is marked.
              expect(await rows(page).count()).toBe(11);
              expect(await rows(page).first().locator("a").getAttribute("aria-current")).toBe("true");
              const selectedRow = rows(page).first().locator(".k2b-activity__entry");
              await page.mouse.move(0, 0);
              await settled(page);
              const selectedFill = await selectedRow.evaluate((element) => getComputedStyle(element).backgroundColor);
              await hoverInPlace(selectedRow);
              await settled(page);
              expect(await selectedRow.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(selectedFill);
              if (screenshots) await page.screenshot({ path: join(screenshots, "events-reader-light-1440.png") });
            }
          } finally {
            await close(page);
          }
        });

      for (const width of [1440, 390])
        test(`events filters ${width}: kind, person and concerns-me survive a reload without moving the feed`, async () => {
          const english = `${boxPath}?view=events`;
          const page = await open(english, width, width === 390 ? 844 : 900);
          try {
            const filters = page.locator("[data-mail-events-filters]");
            const frame = await filters.boundingBox();
            const feedFrame = await page.locator(".mail-events__feed").boundingBox();
            await page.locator("[data-mail-events-filters] .k2b-filter-chip").first().click();
            const response = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await page.getByRole("menuitemradio", { name: "Comments" }).click();
            await response;
            await page.waitForURL(/eventKind=comment/);
            await settled(page);
            expect(await rows(page).count()).toBe(1);
            expect(await page.locator("[data-mail-events-filters]").textContent()).toContain("Kind: Comments");
            expect(await filters.boundingBox()).toEqual(frame);
            expect(await page.locator(".mail-events__feed").boundingBox()).toEqual(feedFrame);
            await page.reload();
            await ready(page);
            expect(await rows(page).count()).toBe(1);
            const reset = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await page.getByRole("button", { name: "Reset" }).click();
            await reset;
            await page.waitForURL(new URL(english, server.url).href);
            await settled(page);
            expect(await rows(page).count()).toBe(11);
            await page.locator(".mail-events__person").click();
            const person = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await page.getByRole("option", { name: "Mira Schulz", exact: true }).click();
            await person;
            await page.waitForURL(/eventActor=/);
            await page.reload();
            await ready(page);
            expect(await page.locator(".mail-events__person").textContent()).toContain("Mira Schulz");
            expect(await rows(page).count()).toBeGreaterThan(0);
            expect(await filters.boundingBox()).toEqual(frame);
            expect(await page.locator(".mail-events__feed").boundingBox()).toEqual(feedFrame);
            const clearPerson = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await page.getByRole("button", { name: "Reset", exact: true }).click();
            await clearPerson;
            await settled(page);

            const mine = page.waitForResponse((response) => response.url().includes("/workspace-"));
            await page.locator("[data-mail-events-filters]").getByText("Concerns me").click();
            await mine;
            await settled(page);
            expect(await rows(page).count()).toBe(3);
            expect(await filters.boundingBox()).toEqual(frame);
            expect(await page.locator(".mail-events__feed").boundingBox()).toEqual(feedFrame);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
          } finally {
            await close(page);
          }
          const empty = await open(`${english}&events=empty`, width, width === 390 ? 844 : 900);
          try {
            expect(await empty.locator(".mail-events .k2b-placeholder__title").textContent()).toBe("No events yet");
          } finally {
            await close(empty);
          }
          const filteredEmpty = await open(`${english}&events=empty&eventKind=sent`, width, width === 390 ? 844 : 900);
          try {
            expect(await filteredEmpty.locator(".mail-events .k2b-placeholder__title").textContent()).toBe("No events for this filter");
            expect(await filteredEmpty.getByRole("button", { name: "Reset filter" }).isVisible()).toBe(true);
          } finally {
            await close(filteredEmpty);
          }
          const failed = await open(`${english}&events=error`, width, width === 390 ? 844 : 900);
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
          // The end of a short feed is within reach at once: the older page loads by itself below the server's rows,
          // and the edge is gone once nothing older is left.
          await page.locator(".mail-events .k2b-load-more[data-state='done']").waitFor({ state: "attached" });
          await settled(page);
          expect(await rows(page).count()).toBe(12);
          expect(await page.locator(".mail-events .k2b-load-more button").count()).toBe(0);
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
          // Three events concern the person; the short list then loads the fixture's older page, which it does not filter.
          await page.locator(".mail-events .k2b-load-more[data-state='done']").waitFor({ state: "attached" });
          expect(await rows(page).count()).toBe(4);
        } finally {
          await close(page);
        }
      });

      test("opening an event far down the feed keeps the feed where the person was", async () => {
        const page = await open(events, 1440, 560);
        try {
          const scroller = page.locator(".mail-events .k2b-virtual-feed__viewport");
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

    // S7: a conversation dragged with the mouse shows its targets over list and reader; the sidebar stays free.
    section("drag", () => {
      const overlay = ".mail-workspace .k2b-drop-overlay";
      const tile = (page: Page, name: string | RegExp) =>
        page.locator(`${overlay} .k2b-drop-overlay__tile`).filter({ hasText: name }).first();
      /** Presses a row and crosses the 6 px threshold; returns the pointer's place. */
      const lift = async (page: Page, conversationId: string) => {
        await settled(page);
        const box = (await page.locator(`[data-conversation-id="${conversationId}"] .mail-list-row`).boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 4, { steps: 3 });
      };
      const glide = async (page: Page, target: Locator) => {
        // settled: a tile is read during the drag; the surface keeps its tiles still while the pointer moves.
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      };
      /** Counts API requests and layout shifts from now on. */
      const watch = async (page: Page) => {
        const requests: string[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(`${request.method()} ${request.url()}`);
        });
        await page.evaluate(() => {
          const record = window as unknown as { __shift: number };
          record.__shift = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) record.__shift += (entry as unknown as { value: number }).value;
          }).observe({ type: "layout-shift" });
        });
        return { requests, shift: () => page.evaluate(() => (window as unknown as { __shift: number }).__shift) };
      };

      test("S7: resting on Assign to someone else, then a person, assigns on the drop; no request or shift before it", async () => {
        const page = await open(`${boxPath}?team=1&locale=de`, 1440, 900, "no-preference");
        try {
          const seen = await watch(page);
          await lift(page, "Conv02");
          await page.locator(overlay).waitFor();
          expect(await page.locator(`${overlay} .k2b-drop-overlay__tile`).allTextContents()).toEqual(
            expect.arrayContaining([
              expect.stringContaining("Mir zuweisen"),
              expect.stringContaining("Jemand anderem zuweisen"),
              expect.stringContaining("In Ordner verschieben"),
              expect.stringContaining("Als erledigt markieren"),
            ]),
          );
          // The sidebar stays free beside the surface.
          const surface = (await page.locator(overlay).boundingBox())!;
          const side = (await page.locator(sidebarSelector).boundingBox())!;
          expect(surface.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
          await glide(page, tile(page, "Jemand anderem zuweisen"));
          await page.locator(`${overlay} .k2b-drop-overlay__title`).filter({ hasText: "Häufig" }).waitFor();
          const person = page.locator(`${overlay} .k2b-drop-overlay__tile:not([data-back])`).first();
          await page.waitForTimeout(260);
          await glide(page, person);
          const name = (await person.locator(".k2b-drop-overlay__label").textContent())!;
          expect(seen.requests, "no request before the drop").toEqual([]);
          await page.route("**/api/mail/mailboxes/Box001/conversations/assign", (route) =>
            route.fulfill({ json: { results: [{ conversationId: "Conv02", status: "ok" }] } }),
          );
          const assigned = page.waitForRequest((request) => request.url().endsWith("/conversations/assign"));
          await page.mouse.up();
          expect((await assigned).postDataJSON()).toMatchObject({ conversationIds: ["Conv02"], mode: "add" });
          await page.locator(".k2b-toast").filter({ hasText: name }).getByRole("button", { name: "Rückgängig" }).waitFor();
          expect(await page.locator(overlay).count()).toBe(0);
          expect(await seen.shift()).toBe(0);
          if (screenshots) await page.screenshot({ path: join(screenshots, "drag-assigned-light-1440.png") });
        } finally {
          await close(page);
        }
      });

      test("S7: a drop straight on Assign to someone else opens the person search", async () => {
        const page = await open(`${boxPath}?team=1&locale=de`);
        try {
          await lift(page, "Conv02");
          await glide(page, tile(page, "Jemand anderem zuweisen"));
          await page.waitForTimeout(260);
          await page.mouse.up();
          await page
            .getByRole("dialog")
            .filter({ has: page.getByRole("searchbox") })
            .first()
            .waitFor();
        } finally {
          await close(page);
        }
      });

      test("S7: Esc cancels with a note and changes nothing; letting go on the cancel area does too", async () => {
        const page = await open(`${boxPath}?team=1&locale=de`);
        try {
          const seen = await watch(page);
          await lift(page, "Conv02");
          await page.locator(overlay).waitFor();
          if (screenshots) await page.screenshot({ path: join(screenshots, "drag-surface-light-1440.png") });
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await page.locator(".k2b-toast").filter({ hasText: "Abgebrochen, nichts geändert" }).waitFor();
          await settled(page);
          await lift(page, "Conv03");
          await glide(page, page.locator(`${overlay} .k2b-drop-overlay__cancel`));
          await page.mouse.up();
          expect(await page.locator(overlay).count()).toBe(0);
          expect(seen.requests).toEqual([]);
        } finally {
          await close(page);
        }
      });

      test("S7: a selection drags as one; a personal mailbox has no assignment targets", async () => {
        const page = await open(`${boxPath}?locale=de`);
        try {
          await page.locator('[data-conversation-id="Conv02"] .mail-list-checkbox').check();
          await page.locator('[data-conversation-id="Conv03"] .mail-list-checkbox').check();
          await lift(page, "Conv02");
          await page.locator(overlay).waitFor();
          expect(await page.locator(`${overlay} .k2b-drop-overlay__what`).textContent()).toBe("2 Unterhaltungen");
          const labels = await page.locator(`${overlay} .k2b-drop-overlay__label`).allTextContents();
          expect(labels).not.toContain("Mir zuweisen");
          expect(labels).not.toContain("Jemand anderem zuweisen");
          await page.keyboard.press("Escape");
          await page.mouse.up();
        } finally {
          await close(page);
        }
      });

      test("S7: a mailbox read only has no drag", async () => {
        const page = await open(`${boxPath}?permission=read&locale=de`);
        try {
          await lift(page, "Conv02");
          await page.mouse.move(700, 500, { steps: 6 });
          await page.waitForTimeout(300);
          expect(await page.locator(overlay).count()).toBe(0);
          await page.mouse.up();
        } finally {
          await close(page);
        }
      });

      // The flat layout (K1, K2, K7): nothing overlaps, spills, is cut, or draws a double line; a scrollbar moves
      // nothing. Playwright hides scrollbars, while Linux and Windows desktops draw classic ones that take room, so
      // Chromium runs these with classic scrollbars in desktop windows (no touch, see open). Few and many rows, list and
      // reader, 390 to 1440 px; at 1100 px with the reader open.
      let classic: Browser | undefined;
      beforeAll(async () => {
        classic = browserName === "chromium" ? await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] }) : undefined;
      }, 30_000);
      afterAll(async () => {
        await classic?.close();
      });
      for (const [name, path, width, height] of [
        ["stacked list, few rows", `${boxPath}?team=1&view=mine`, 390, 844],
        ["stacked list, many rows", boxPath, 390, 844],
        ["reader", `${boxPath}?conversation=Conv02`, 390, 844],
        ["table", `${boxPath}?team=1`, 768, 1024],
        ["open conversation", `${boxPath}?team=1&conversation=Conv02`, 768, 1024],
        ["list and reader", `${boxPath}?shell=1&team=1&conversation=Conv02`, 1100, 800],
        ["table without scrollbar", `${boxPath}?shell=1&team=1&view=mine`, 1440, 900],
        ["table with reader and scrolling list", `${boxPath}?shell=1&team=1&conversation=Conv02`, 1440, 900],
      ] as const)
        test(`flat ${width} px, ${name}, classic scrollbars: no overlap, spill, cut, or double line`, async () => {
          const page = await open(path, width, height, "reduce", undefined, classic);
          try {
            await settled(page);
            // A classic run is only worth its name when a scrollbar really takes room.
            if (classic)
              expect(
                await page.evaluate(() => {
                  const probe = document.createElement("div");
                  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
                  document.body.append(probe);
                  const gutter = probe.offsetWidth - probe.clientWidth;
                  probe.remove();
                  return gutter;
                }),
              ).toBeGreaterThan(0);
            const found = await page.evaluate(layoutProblems, { root: "main" });
            expect(found.problems).toEqual([]);
          } finally {
            await close(page);
          }
        });

      test("K12: a tablet shows the open conversation alone at its full width; closing it returns to the list", async () => {
        const page = await open(`${boxPath}?team=1&conversation=Conv02`, 768, 1024);
        try {
          await settled(page);
          expect(await page.locator(".mail-split-list").isVisible()).toBe(false);
          expect(await page.locator(".mail-list-handle").isVisible()).toBe(false);
          const reader = (await page.locator(".mail-split-reader").boundingBox())!;
          const panes = (await page.locator(".mail-split-panes").boundingBox())!;
          expect(Math.abs(reader.width - panes.width)).toBeLessThanOrEqual(1);
          await page.locator("[data-mail-reader-close]").click();
          await page.waitForFunction(() => !new URL(location.href).searchParams.has("conversation"));
          await settled(page);
          expect(await page.locator(".mail-split-list").isVisible()).toBe(true);
        } finally {
          await close(page);
        }
      });

      test("phone: a stacked row keeps its time and has no …; the open conversation's … holds every action of the row's menu", async () => {
        const page = await open(boxPath, 390, 844);
        let rowEntries: string[] = [];
        try {
          await settled(page);
          const entry = page.locator('.mail-list-entry[data-conversation-id="Conv02"]');
          // K15: the time stays; the row's actions live in its menu (long press) and in the open conversation's ….
          expect(await entry.locator(".mail-row-time-cell").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
          expect(
            await entry
              .locator(".mail-row-menu")
              .evaluateAll((elements) => elements.every((element) => getComputedStyle(element).display === "none")),
          ).toBe(true);
          await entry.locator("a.mail-list-row").click({ button: "right" });
          const menu = page.locator(".k2b-context-menu");
          await menu.waitFor({ state: "visible" });
          rowEntries = (await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim());
          expect(rowEntries.length).toBeGreaterThan(3);
        } finally {
          await close(page);
        }
        const reader = await open(`${boxPath}?conversation=Conv02`, 390, 844);
        try {
          // K13: a phone shows the reader alone, without the list's handle (it stands in a contents slot).
          expect(await reader.locator(".mail-list-handle").isVisible()).toBe(false);
          await reader.getByRole("button", { name: "More conversation actions" }).click();
          const menu = reader.locator(".k2b-dropdown__menu:popover-open");
          await menu.waitFor({ state: "visible" });
          const readerEntries = (await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim());
          expect(rowEntries.filter((label) => !readerEntries.includes(label))).toEqual([]);
        } finally {
          await close(reader);
        }
      });

      test("S7: on a phone a finger never drags; holding a row opens its menu", async () => {
        const page = await open(`${boxPath}?locale=de`, 390, 844);
        try {
          const row = page.locator('[data-conversation-id="Conv02"] .mail-list-row');
          const box = (await row.boundingBox())!;
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
          await page.waitForTimeout(650);
          await row.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
          await page.locator(".k2b-context-menu").waitFor();
          expect(await page.locator(overlay).count()).toBe(0);
        } finally {
          await close(page);
        }
      });
    });

    section("drafts", () => {
      /** A small Mail draft API: what the reader and the composer call around one draft, with what they sent. */
      /** `suggestedBy` names the automated account behind the untouched suggestion `DrfSug`. */
      /**
       * The compose-signature answer as the server gives it for an HTML draft: the send renderer's signature with an
       * empty text, plus the editor fragment and text. Fictional sender data only.
       */
      const signatureAnswer = (
        signature: string,
        design: Pick<Parameters<typeof renderComposeContent>[0], "customCss" | "logo"> = { customCss: "" },
      ) => {
        const shared = {
          signature,
          context: {
            actor: { display_name: "Erika Beispiel", email: "erika@beispiel.test" },
            mailbox: { name: "Beispiel Handel GmbH", description: "" },
            sender: { display_name: "Beispiel Handel", email: "info@beispiel.test", reply_to: "" },
            message: { subject: "", to: [], cc: [] },
          },
          format: "markdown" as const,
          renderLiquid: true,
          ...design,
        };
        const alone = renderComposeContent({ ...shared, body: "" });
        const block = renderComposeSignatureBlock({ ...shared, logoAltText: design.logo?.altText });
        if (!alone.ok || !alone.data.html || !block.ok) throw new Error("The fixture signature did not render");
        return {
          answer: { ...block.data, mailHtml: alone.data.html },
          render: (body: string) => renderComposeContent({ ...shared, body }),
        };
      };
      const defaultSignature = signatureAnswer("Kind regards  \nAda Example  \nExample support · Hall A").answer;
      const draftApi = async (page: Page, suggestedBy = "Gustav", options: { consolidated?: number; sendFails?: boolean } = {}) => {
        const calls: string[] = [];
        const notes: string[] = [];
        const drafts = new Map<string, Record<string, unknown>>();
        /** Sent submissions by id, to the draft they came from, so Undo can return it. */
        const submissions = new Map<string, string>();
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
              consolidatedCount: options.consolidated ?? 0,
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
              suggestedBy,
              createdBy: { kind: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000e1" },
              lastEditedBy: { kind: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000e1" },
              lastEditedByDisplayName: suggestedBy,
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
                  quoteSource: input.quoteSource ?? null,
                  // A reply goes to the sender, as the server derives it; a new message starts without recipients.
                  to: input.intent === "new" ? (input.to ?? []) : [{ name: "Example sender", address: "sender@example.test" }],
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
              conversationId: body.origin.input.conversationId,
            });
            drafts.set("DrfNew", created);
            // Materialize answers how it got the draft; only a draft it created is fresh, so Escape discards it.
            return route.fulfill({ json: { ...created, creationOutcome: "created" } });
          }
          if (method === "POST" && path === "/conversations/Conv01/comments") {
            const body = request.postDataJSON();
            notes.push(body.body);
            return route.fulfill({
              json: {
                id: `Note0${notes.length}`,
                conversationId: "Conv01",
                body: body.body,
                author: { kind: "user", id: "Usr001", displayName: "Ada Example", avatarHash: null },
                referencedMessageId: null,
                revision: 1,
                canEdit: true,
                canDelete: true,
                editedAt: null,
                deletedAt: null,
                createdAt: stamp,
                updatedAt: stamp,
              },
            });
          }
          if (method === "POST" && path === "/commands") {
            if (options.sendFails)
              return route.fulfill({ status: 503, json: { code: "SMTP_UNAVAILABLE", message: "The mail server does not answer." } });
            const sent = String(request.postDataJSON().draftId);
            const draft = drafts.get(sent);
            if (draft) drafts.set(sent, { ...draft, state: "sending" });
            submissions.set("Dlv001", sent);
            return route.fulfill({
              json: { id: "00000000-0000-4000-8000-0000000000f1", result: { conversationId: "Conv01", outboxSubmissionId: "Dlv001" } },
            });
          }
          // Undo of a send: the submission returns to its draft.
          const cancel = /^\/scheduled-sends\/(\w+)\/cancel$/.exec(path);
          if (method === "POST" && cancel) {
            const draftId = submissions.get(cancel[1]!);
            const draft = draftId ? drafts.get(draftId) : undefined;
            if (!draftId || !draft)
              return route.fulfill({ status: 409, json: { code: "SEND_ALREADY_STARTED", message: "Already on its way" } });
            drafts.set(draftId, { ...draft, state: "draft", revision: Number(draft.revision ?? 1) + 1 });
            return route.fulfill({ json: { disposition: "draft", draftId, projectionSnapshotId: null } });
          }
          if (path === "/compose-templates") return route.fulfill({ json: [{ id: "Sig001", kind: "signature", name: "Support" }] });
          if (path === "/compose-signature-defaults") return route.fulfill({ json: [] });
          if (method === "POST" && path === "/compose-signature") return route.fulfill({ json: defaultSignature });
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
            if (rest === "/safety-review")
              return route.fulfill({
                json: { revision: draft.revision, fingerprint: "f".repeat(64), warnings: [], contentHash: "a".repeat(64) },
              });
            if (rest === "/consolidation/acknowledge") {
              drafts.set(id!, { ...draft, consolidatedCount: 0 });
              return route.fulfill({ json: { ...draft, consolidatedCount: 0 } });
            }
            if (rest === "/intent") {
              const body = request.postDataJSON();
              const switched = {
                ...draft,
                intent: body.intent,
                subject: body.intent === "forward" ? "Fwd: Example request 1" : "Re: Example request 1",
                to: body.intent === "forward" ? [] : draft.to,
                revision: Number(draft.revision) + 1,
              };
              drafts.set(id!, switched);
              return route.fulfill({ json: switched });
            }
          }
          return route.fallback();
        });
        return { calls, drafts, notes, makeDraft };
      };
      const draftBox = (page: Page) => page.locator("[data-mail-reply-box='mail']");
      const readyDraft = async (page: Page) => {
        await draftBox(page).waitFor();
        await page.locator("[data-mail-reply-box='mail'] .cm-content").waitFor();
      };
      const chooseMode = async (page: Page, name: string) => {
        await page.locator("[data-mail-reply-box-frame] [data-mail-reply-mode]").first().click();
        await page.getByRole("menuitemradio", { name }).click();
      };
      /** Reply buttons that start a reply to the conversation; each open message keeps its own reply arrow beside its date. */
      const readerReplies = (page: Page) =>
        page
          .locator(".mail-reader")
          .getByRole("button", { name: "Reply", exact: true })
          .and(page.locator(":not([data-mail-message-reply])"));
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
        test(`${width}: with two senders the reply box's sender reads at the head's size and never covers Cc`, async () => {
          const page = await open(`${boxPath}?conversation=Conv01&identity=2`, width, undefined, "reduce", async (next) => {
            await draftApi(next);
          });
          try {
            await readyDraft(page);
            const sender = '.mail-reply-box-head button[aria-haspopup="menu"][aria-label^="Change sender identity"]';
            await page.locator(sender).waitFor();
            const head = await page.locator("[data-mail-reply-box-frame]").evaluate((frame, sender) => {
              const trigger = frame.querySelector<HTMLElement>(sender)!;
              const cc = frame.querySelector<HTMLElement>(".mail-reply-box-cc button")!;
              const input = frame.querySelector<HTMLInputElement>(".mail-reply-box-recipients input")!;
              const style = getComputedStyle(input);
              const context = document.createElement("canvas").getContext("2d")!;
              context.font = style.font;
              // The input keeps a minimum width inside a control that scrolls sideways: measure what is visible of it.
              const control = input.closest<HTMLElement>(".mail-recipient-control")!;
              const inner = control.getBoundingClientRect().left + control.clientLeft + control.clientWidth;
              const shown = input.getBoundingClientRect();
              const room =
                Math.min(shown.right, inner) - shown.left - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
              const wrapper = trigger.closest<HTMLElement>(".mail-reply-box-sender")!.getBoundingClientRect();
              const button = trigger.getBoundingClientRect();
              return {
                trigger: getComputedStyle(trigger).fontSize,
                cc: getComputedStyle(cc).fontSize,
                placeholder: input.placeholder,
                fits: context.measureText(input.placeholder).width <= room,
                // The sender stays inside its own place, left of Cc, and keeps "from" and the chevron readable.
                contained: button.left >= wrapper.left - 0.5 && button.right <= wrapper.right + 0.5,
                beforeCc: button.right <= cc.getBoundingClientRect().left,
                width: button.width,
                name: (() => {
                  const name = trigger.querySelector<HTMLElement>(".truncate")!;
                  return name.scrollWidth <= name.clientWidth;
                })(),
              };
            }, sender);
            // "from Support ⌄" is a quiet label like Cc and Bcc beside it, not body text.
            expect(head.trigger).toBe(head.cc);
            expect(head.placeholder.length).toBeGreaterThan(0);
            expect(head.contained).toBe(true);
            expect(head.beforeCc).toBe(true);
            if (width === 1440) {
              // With room, the whole sender name shows and the recipients field keeps its hint.
              expect(head.name).toBe(true);
              expect(head.fits).toBe(true);
            } else expect(head.width).toBeGreaterThanOrEqual(50);
          } finally {
            await close(page);
          }
        });

      for (const width of [1440, 390])
        test(`${width}: the reply box stands open above the newest message; opening creates no draft, the first typing does`, async () => {
          let api!: Awaited<ReturnType<typeof draftApi>>;
          const page = await open(`${boxPath}?conversation=Conv01&identity=1`, width, undefined, "reduce", async (next) => {
            api = await draftApi(next);
          });
          try {
            await readyDraft(page);
            // No pill, no Reply that opens a draft, and opening the conversation never moved the focus into the box.
            expect(await page.locator("[data-mail-reply-pill]").count()).toBe(0);
            expect(await readerReplies(page).count()).toBe(0);
            expect(await page.evaluate(() => document.activeElement?.closest("[data-mail-reply-box]") ?? null)).toBeNull();
            expect(await draftBox(page).textContent()).toContain("Example sender");
            expect(api.calls).toContain("POST /draft-seeds");
            expect(api.calls).not.toContain("POST /draft-seeds/materialize");
            const order = await page.evaluate(() => {
              const box = document.querySelector("[data-mail-reply-box='mail']")!.getBoundingClientRect();
              const messages = document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect();
              const send = document.querySelector("[data-mail-reply-box='mail'] footer")!.getBoundingClientRect();
              return { boxBottom: box.bottom, messagesTop: messages.top, footHeight: send.height };
            });
            expect(order.boxBottom).toBeLessThanOrEqual(order.messagesTop);
            // The bar keeps one row, also on a phone.
            expect(order.footHeight).toBeLessThan(56);
            await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
            await page.keyboard.type("Saturday at 11 works.");
            await eventually(() => api.drafts.get("DrfNew")?.body, "Saturday at 11 works.", "the first input creates the draft");
            await page.waitForFunction(() =>
              document.querySelector("[data-mail-reply-box='mail'] [data-mail-save-status]")?.textContent?.includes("Saved"),
            );
          } finally {
            await close(page);
          }
        });

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          for (const position of ["top", "bottom"] as const)
            test(`reply focus keeps its height ${position} ${theme} ${width}`, async () => {
              const page = await open(`${boxPath}?conversation=Conv01&identity=1&theme=${theme}`, width, 900, "reduce", async (next) => {
                await replyAt(position)(next);
                await draftApi(next);
              });
              try {
                await readyDraft(page);
                await draftBox(page).locator(".mail-inline-draft-signature").waitFor();
                const editor = draftBox(page).locator(".cm-content");
                await editor.scrollIntoViewIfNeeded();
                await settled(page);
                const measure = () =>
                  draftBox(page).evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    const send = element.querySelector("[data-mail-reply-send]")!.getBoundingClientRect();
                    const quote = element.querySelector("[data-mail-quote-card]")!.getBoundingClientRect();
                    const signature = element.querySelector(".mail-inline-draft-signature")!.getBoundingClientRect();
                    return { height: box.height, sendTop: send.top, quoteTop: quote.top, signatureTop: signature.top };
                  });
                const before = await measure();
                const screenshot = async (state: string) => {
                  if (!screenshots) return;
                  mkdirSync(screenshots, { recursive: true });
                  await page.screenshot({ path: join(screenshots, `reply-height-${position}-${theme}-${width}-${state}.png`) });
                };
                await screenshot("unfocused");
                await editor.click();
                await settled(page);
                const after = await measure();
                await screenshot("focused");
                const sameGeometry = (actual: typeof before, expected: typeof before) => {
                  for (const key of ["height", "sendTop", "quoteTop", "signatureTop"] as const)
                    expect(Math.abs(actual[key] - expected[key]), `${key}: ${expected[key]} → ${actual[key]}`).toBeLessThanOrEqual(0.5);
                };
                sameGeometry(after, before);
                // A keyboard focus return keeps the same geometry as well.
                await page.keyboard.press("Shift+Tab");
                await page.keyboard.press("Tab");
                expect(await editor.evaluate((element) => element === document.activeElement)).toBe(true);
                await settled(page);
                sameGeometry(await measure(), after);
                // The person's own text grows the box to its content, up to its cap; beyond that the one surface scrolls.
                await page.keyboard.insertText(Array.from({ length: 24 }, (_, line) => `Example reply line ${line + 1}`).join("\n"));
                await eventually(async () => (await measure()).height > before.height, true, "content grows the reply box");
                await settled(page);
                const capped = await draftBox(page).evaluate((element) => ({
                  height: element.getBoundingClientRect().height,
                  cap: Number.parseFloat(getComputedStyle(element).maxHeight),
                  scrolls:
                    (element.querySelector<HTMLElement>("[data-mail-compose-body]")?.scrollHeight ?? 0) >
                    (element.querySelector<HTMLElement>("[data-mail-compose-body]")?.clientHeight ?? 0),
                }));
                expect(Math.abs(capped.height - capped.cap), `height ${capped.height}, cap ${capped.cap}`).toBeLessThanOrEqual(1);
                expect(capped.scrolls).toBe(true);
                const send = draftBox(page).locator("[data-mail-reply-send]");
                await send.scrollIntoViewIfNeeded();
                await settled(page);
                const sendBox = (await send.boundingBox())!;
                expect(sendBox.y).toBeGreaterThanOrEqual(0);
                expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(900);
              } finally {
                await close(page);
              }
            });

      // #3297: on a slow runner the first measurement met the placeholder, and the ready box grew 63 px taller. With
      // the box on top that moved the messages. A late draft answer makes every runner meet the placeholder.
      test("a late draft answer: the box keeps the placeholder's height, so the messages below never move", async () => {
        const releaseSeed = Promise.withResolvers<void>();
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "no-preference", async (next) => {
          await draftApi(next);
          await next.route("**/draft-seeds", async (route) => {
            await releaseSeed.promise;
            await route.fallback();
          });
        });
        try {
          await page.locator('[data-mail-reply-box="pending"]').waitFor();
          const measure = () =>
            page.evaluate(() => ({
              messages: document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect().top,
              box: document.querySelector("[data-mail-reply-box-frame]")!.getBoundingClientRect().height,
              scroll: document.querySelector(".mail-reader-scroll")!.scrollTop,
            }));
          const pending = await measure();
          releaseSeed.resolve();
          await readyDraft(page);
          await settled(page);
          const ready = await measure();
          expect(Math.abs(ready.box - pending.box), `box ${pending.box} → ${ready.box}`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(ready.messages - pending.messages), `messages ${pending.messages} → ${ready.messages}`).toBeLessThanOrEqual(0.5);
          expect(ready.scroll).toBe(pending.scroll);
          // A click alone keeps the height; the person's own input fits the box to its content.
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await settled(page);
          expect(Math.abs((await measure()).box - ready.box)).toBeLessThanOrEqual(0.5);
          await page.keyboard.type("Saturday works.");
          await page.locator("[data-mail-reply-box='mail'][data-compose-fitted]").waitFor();
        } finally {
          releaseSeed.resolve();
          await close(page);
        }
      });

      const longSignature = Array.from({ length: 12 }, (_, line) => `Example support line ${line + 1}`);
      const longSignatureAnswers = {
        // An HTML draft shows the sent signature in its frame; a plain draft shows the text.
        frame: signatureAnswer(longSignature.join("  \n")).answer,
        text: { html: null, text: longSignature.join("\n"), mailHtml: null },
      };
      for (const variant of ["frame", "text"] as const)
        test(`a long signature that arrives last scrolls whole in the box and moves nothing until the person writes (${variant})`, async () => {
          const releaseSignature = Promise.withResolvers<void>();
          const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "no-preference", async (next) => {
            await draftApi(next);
            await next.route("**/compose-signature", async (route) => {
              await releaseSignature.promise;
              await route.fulfill({ json: longSignatureAnswers[variant] });
            });
          });
          try {
            await readyDraft(page);
            await settled(page);
            const messagesTop = () =>
              page.evaluate(() => document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect().top);
            const before = await messagesTop();
            releaseSignature.resolve();
            if (variant === "frame") {
              const frame = page.locator("[data-mail-signature-frame]");
              await frame.waitFor();
              await page.frameLocator("[data-mail-signature-frame]").getByText("Example support line 12").waitFor();
              await eventually(
                async () => (await frame.evaluate((element) => element.getBoundingClientRect().height)) > 150,
                true,
                "frame height",
              );
            } else
              await page.waitForFunction(() => document.querySelector("[data-mail-draft-signature]")?.textContent?.includes("line 12"));
            await settled(page);
            expect(Math.abs((await messagesTop()) - before)).toBeLessThanOrEqual(0.5);
            // The signature keeps its whole height and scrolls with the text; Send stays in view at the reserved height.
            const signature = await page.locator("[data-mail-draft-signature]").evaluate((element) => ({
              height: element.getBoundingClientRect().height,
              cut: element.scrollHeight > element.clientHeight + 1,
              shrink: getComputedStyle(element).flexShrink,
            }));
            expect(signature.height).toBeGreaterThan(150);
            expect(signature.cut).toBe(false);
            expect(signature.shrink).toBe("0");
            expect(await page.locator("[data-mail-reply-box='mail'] footer").isVisible()).toBe(true);
            // Writing in the box fits it to its content, up to the cap.
            await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
            await page.keyboard.type("Thanks");
            await page.locator("[data-mail-reply-box='mail'][data-compose-fitted]").waitFor();
            expect(Math.abs((await messagesTop()) - before)).toBeGreaterThan(0.5);
          } finally {
            releaseSignature.resolve();
            await close(page);
          }
        });

      // Composer v4 (Höhenmodell A): one head, one scrolling surface, and the bar; the box is as high as its content
      // after the person's own input, with no hole below the content; text, signature, quote line and Send share one
      // edge, and the first line starts 12 px under the head.
      for (const position of ["top", "bottom"] as const)
        test(`the reply box is one surface as high as its content, with one edge (${position})`, async () => {
          const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, 900, "reduce", async (next) => {
            await replyAt(position)(next);
            await draftApi(next);
          });
          try {
            await readyDraft(page);
            await draftBox(page).locator("[data-mail-draft-signature]").waitFor();
            await draftBox(page).locator("[data-mail-quote-card]:not([data-loading])").waitFor();
            await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
            await page.keyboard.type("Saturday at 11 works for us.");
            await page.locator("[data-mail-reply-box='mail'][data-compose-fitted]").waitFor();
            await settled(page);
            const geometry = () =>
              draftBox(page).evaluate((box) => {
                const rect = (selector: string) => box.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
                const body = box.querySelector<HTMLElement>("[data-mail-compose-body]")!;
                const content = box.querySelector<HTMLElement>(".mail-compose-content")!;
                const scrollers = [...box.querySelectorAll<HTMLElement>("*")].filter((element) => {
                  const overflow = getComputedStyle(element).overflowY;
                  return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1;
                });
                const kept = [".mail-inline-draft-text", "[data-mail-draft-signature]", "[data-mail-quote-card]"].flatMap((selector) => {
                  const element = box.querySelector<HTMLElement>(selector);
                  return element
                    ? [{ selector, cut: element.scrollHeight > element.clientHeight + 1, shrink: getComputedStyle(element).flexShrink }]
                    : [];
                });
                const firstLine = box.querySelector<HTMLElement>(".cm-line")!.getBoundingClientRect();
                const quote = box.querySelector<HTMLElement>("[data-mail-quote-card]")?.getBoundingClientRect() ?? null;
                return {
                  height: box.getBoundingClientRect().height,
                  sendGap: box.getBoundingClientRect().bottom - rect("[data-mail-reply-send]").bottom,
                  hole: body.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom,
                  scrollers: scrollers.map((element) => element.className),
                  bodyScrollable: getComputedStyle(body).overflowY,
                  kept,
                  headGap: firstLine.top - rect(".mail-compose-head").bottom,
                  edges: {
                    text: firstLine.left,
                    signature: rect("[data-mail-draft-signature]").left,
                    quote: quote?.left ?? firstLine.left,
                  },
                  // Composer A: Send ends on the box's right text edge, inside its padding.
                  sendRight: (
                    box.querySelector("[data-mail-reply-send]")!.closest(".mail-compose-action") ??
                    box.querySelector("[data-mail-reply-send]")!
                  ).getBoundingClientRect().right,
                  textRight: box.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(box).paddingRight),
                  quoteHeight: quote?.height ?? 0,
                };
              });
            const fitted = await geometry();
            // One scrolling surface; text, signature, and quote card keep their whole height.
            expect(["auto", "scroll"]).toContain(fitted.bodyScrollable);
            expect(fitted.scrollers).toEqual([]);
            for (const part of fitted.kept) {
              expect(part.cut, part.selector).toBe(false);
              expect(part.shrink, part.selector).toBe("0");
            }
            // Send ends 10 px above the box's bottom edge.
            expect(Math.abs(fitted.sendGap - 10), `send gap ${fitted.sendGap}`).toBeLessThanOrEqual(1);
            // No hole: below the content only the 8 px room that puts the caret at the end of the text.
            expect(Math.abs(fitted.hole - 8), `room ${fitted.hole}`).toBeLessThanOrEqual(2);
            // The first line starts 12 px under the head; text, signature, and quote line share one edge, and Send ends on
            // the box's right text edge (Composer A, like a chat).
            expect(Math.abs(fitted.headGap - 12), `head gap ${fitted.headGap}`).toBeLessThanOrEqual(1);
            for (const [part, left] of Object.entries(fitted.edges))
              expect(Math.abs(left - fitted.edges.text), `${part} edge ${left} vs text ${fitted.edges.text}`).toBeLessThanOrEqual(1);
            expect(
              Math.abs(fitted.sendRight - fitted.textRight),
              `send end ${fitted.sendRight} vs ${fitted.textRight}`,
            ).toBeLessThanOrEqual(1);
            // Leaving the original out is the person's own input: the box loses the card's height, and adding it back
            // restores the height.
            await draftBox(page).getByRole("button", { name: "Leave the original message out" }).click();
            await settled(page);
            const without = await geometry();
            expect(without.height, `${fitted.height} → ${without.height}`).toBeLessThan(fitted.height - fitted.quoteHeight / 2);
            expect(Math.abs(without.hole - 8)).toBeLessThanOrEqual(2);
            await draftBox(page).locator("[data-mail-quote-add]").click();
            await draftBox(page).locator("[data-mail-quote-card]").waitFor();
            await settled(page);
            expect(Math.abs((await geometry()).height - fitted.height)).toBeLessThanOrEqual(1);
            if (screenshots) {
              mkdirSync(screenshots, { recursive: true });
              await draftBox(page).scrollIntoViewIfNeeded();
              await page.screenshot({ path: join(screenshots, `compose-surface-${position}-light-1440.png`) });
            }
          } finally {
            await close(page);
          }
        });

      // The composer shows the signature exactly as the recipient gets it (2026-11-18): the same markup, logo, link and
      // design as the sent HTML, in the reader's message document. Fictional sender data only.
      const sentSignature = (() => {
        const signature = signatureAnswer(
          [
            "{{ mailbox.logo }}",
            "<strong>{{ actor.display_name }}</strong>",
            "Musterweg 1 · 12345 Beispielstadt · [+49 30 000000](tel:+4930000000) · [beispiel.test](https://beispiel.test)",
            "---",
            "Beispiel Handel GmbH · Amtsgericht Beispielstadt · HRB 000000",
          ].join("\n\n"),
          {
            customCss:
              ".mail-signature strong { text-transform: uppercase; letter-spacing: 1px; } .mail-signature hr ~ p { color: #71717a; font-size: 11px; }",
            logo: {
              src: `data:image/png;base64,${photoPng}`,
              altText: "Beispiel Handel Logo",
              displayWidth: 96,
              pixelWidth: 48,
              pixelHeight: 36,
              byteLength: Buffer.from(photoPng, "base64").length,
            },
          },
        );
        const sent = signature.render("Hallo zusammen,\n\nanbei das Angebot.");
        if (!sent.ok || !sent.data.html) throw new Error("The fixture message did not render");
        return {
          response: signature.answer,
          sentDocument: buildMessageDocument(sent.data.html, "sent-reference", false, "en", undefined, "light"),
        };
      })();
      const withSentSignature = async (page: Page) => {
        await draftApi(page);
        await page.route("**/compose-signature", (route) => route.fulfill({ json: sentSignature.response }));
      };
      /** Waits for the composer's signature frame to report its height and returns the frame. */
      const signatureFrame = async (page: Page, scope: Locator) => {
        const frame = scope.locator("[data-mail-signature-frame]");
        await frame.waitFor();
        await eventually(
          async () => (await frame.evaluate((element) => element.getBoundingClientRect().height)) > 40,
          true,
          "frame height",
        );
        return scope.frameLocator("[data-mail-signature-frame]");
      };
      const expectSentSignature = async (page: Page, scope: Locator, theme: "light" | "dark") => {
        const composed = await signatureFrame(page, scope);
        const box = scope.locator("[data-mail-draft-signature]");
        // The logo is an image, never its alt text; links are links, never "[tel:…]" or "[https://…]" text.
        expect(await box.textContent()).not.toContain("Beispiel Handel Logo");
        const shownText = await composed.locator("body").innerText();
        expect(shownText).not.toMatch(/\[(?:tel|https?):/);
        expect(shownText).toContain("ERIKA BEISPIEL");
        expect(await composed.locator('img[alt="Beispiel Handel Logo"]').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(
          48,
        );
        expect(await composed.locator('a[href="tel:+4930000000"]').count()).toBe(1);
        expect(await composed.locator("hr").count()).toBe(1);
        // The same signature as the sent HTML in the reader's document beside it.
        await page.evaluate((source) => {
          const reference = document.createElement("iframe");
          reference.id = "sent-reference";
          reference.setAttribute("sandbox", "allow-scripts");
          reference.style.cssText = "position:fixed;left:0;top:0;width:600px;height:400px;visibility:hidden";
          reference.srcdoc = source;
          document.body.append(reference);
        }, sentSignature.sentDocument);
        const sent = page.frameLocator("#sent-reference");
        // The reference stays invisible, so it is ready once its signature is there, not once it shows.
        await sent.locator(".mail-signature").waitFor({ state: "attached" });
        const footer = (frame: typeof sent) =>
          frame.locator(".mail-signature hr ~ p").evaluate((element) => {
            const style = getComputedStyle(element);
            return { fontSize: style.fontSize, color: style.color };
          });
        const composedFooter = await footer(composed);
        expect(composedFooter.fontSize).toBe("11px");
        expect(composedFooter.fontSize).toBe((await footer(sent)).fontSize);
        if (theme === "light") {
          // In light the frame changes nothing: markup and colors are those of the sent message.
          const markup = (frame: typeof sent) => frame.locator(".mail-signature").evaluate((element) => element.outerHTML);
          expect(await markup(composed)).toBe(await markup(sent));
          expect(composedFooter.color).toBe((await footer(sent)).color);
        }
        await page.evaluate(() => document.getElementById("sent-reference")?.remove());
      };

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`${theme} ${width}: the reply box shows the signature exactly as the sent HTML, without moving the box`, async () => {
            const page = await open(
              `${boxPath}?conversation=Conv01&identity=1&theme=${theme}`,
              width,
              undefined,
              "reduce",
              withSentSignature,
            );
            try {
              await readyDraft(page);
              await expectSentSignature(page, draftBox(page), theme);
              await settled(page);
              const frameBox = await draftBox(page).locator("[data-mail-signature-frame]").boundingBox();
              const signatureBox = await draftBox(page).locator("[data-mail-draft-signature]").boundingBox();
              // The frame fills the signature's width and stays inside the box, also on a phone.
              expect(Math.abs(frameBox!.width - signatureBox!.width)).toBeLessThanOrEqual(1);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              if (screenshots) {
                mkdirSync(screenshots, { recursive: true });
                await page.screenshot({ path: join(screenshots, `signature-sent-reply-${theme}-${width}.png`) });
              }
              // Writing grows the box to the whole signature; the frame keeps its height and nothing fades.
              const before = frameBox!.height;
              await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
              await page.keyboard.type("Hallo zusammen");
              await settled(page);
              expect((await draftBox(page).locator("[data-mail-signature-frame]").boundingBox())!.height).toBe(before);
            } finally {
              await close(page);
            }
          });

      test("the signature frame runs nothing from the signature, loads nothing remote, and a late signature never moves the caret", async () => {
        type HostileWindow = { hostile: string[] };
        const remote: string[] = [];
        // Markup the server never sends, handed to the frame directly: the reader's sandbox and policy must still hold.
        const hostile = [
          '<div class="mail-content"><div class="mail-signature"><p>Erika Beispiel</p>',
          '<script>parent.postMessage({ hostile: "script" }, "*")</script>',
          `<img src="data:," onerror="parent.postMessage({ hostile: 'onerror' }, '*')">`,
          '<img src="https://remote.beispiel.test/pixel.png" alt="">',
          "</div></div>",
        ].join("");
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          await draftApi(next);
          // Only a request that reaches the network counts: Chromium also reports the image the policy blocked.
          await next.route("https://remote.beispiel.test/**", (route) => {
            remote.push(route.request().url());
            return route.abort();
          });
          await next.route("**/compose-signature", async (route) => {
            await held;
            await route.fulfill({ json: { html: "", text: "Erika Beispiel", mailHtml: hostile } });
          });
        });
        try {
          await page.evaluate(() => {
            const state = window as unknown as HostileWindow;
            state.hostile = [];
            addEventListener("message", (event) => {
              // Only what the signature frame itself posts counts.
              const frame = document.querySelector<HTMLIFrameElement>("[data-mail-signature-frame]");
              if (!frame || event.source !== frame.contentWindow) return;
              if (event.data && typeof event.data === "object" && "hostile" in event.data) state.hostile.push(String(event.data.hostile));
            });
          });
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Hallo");
          await settled(page);
          const caret = () =>
            page.evaluate(() => document.querySelector("[data-mail-reply-box='mail'] .cm-cursor")?.getBoundingClientRect().top ?? null);
          const before = await caret();
          expect(before).not.toBeNull();
          release();
          await page.waitForFunction(() => (document.querySelector<HTMLElement>("[data-mail-signature-frame]")?.offsetHeight ?? 0) > 0);
          await settled(page);
          // The signature grows in below the text once; the caret in the text stays where it was.
          expect(await caret()).toBe(before);
          expect(await page.evaluate(() => (window as unknown as HostileWindow).hostile)).toEqual([]);
          expect(remote).toEqual([]);
        } finally {
          await close(page);
        }
      });

      for (const theme of reviewThemes)
        for (const width of [1440, 390])
          test(`${theme} ${width}: the new message window shows the sent signature`, async () => {
            const page = await open(`${boxPath}?identity=1&theme=${theme}`, width, undefined, "reduce", withSentSignature);
            try {
              await page.getByRole("link", { name: "New message" }).first().click();
              const window = page.locator(".mail-compose-window");
              await window.locator("[data-mail-inline-draft] .cm-content").waitFor();
              await expectSentSignature(page, window, theme);
              await settled(page);
              if (screenshots) {
                mkdirSync(screenshots, { recursive: true });
                await page.screenshot({ path: join(screenshots, `signature-sent-window-${theme}-${width}.png`) });
              }
            } finally {
              await close(page);
            }
          });

      test("the box takes its place without moving the messages below it", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "no-preference", async (next) => {
          await draftApi(next);
        });
        try {
          const messagesTop = () =>
            page.evaluate(() => document.querySelector("[data-mail-conversation-messages]")!.getBoundingClientRect().top);
          const pendingHeight = await page.evaluate(
            () => document.querySelector("[data-mail-reply-box-frame]")?.getBoundingClientRect().height ?? 0,
          );
          const before = await messagesTop();
          await readyDraft(page);
          await settled(page);
          expect(Math.abs((await messagesTop()) - before)).toBeLessThanOrEqual(0.5);
          const readyHeight = await page.evaluate(
            () => document.querySelector("[data-mail-reply-box-frame]")!.getBoundingClientRect().height,
          );
          expect(pendingHeight).toBeGreaterThan(0);
          expect(readyHeight).toBeGreaterThanOrEqual(pendingHeight);
        } finally {
          await close(page);
        }
      });

      test("the mode menu switches Reply to Forward on the server and keeps the text", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("See the details below.");
          await eventually(() => api.drafts.get("DrfNew")?.body, "See the details below.", "saved before the switch");
          await chooseMode(page, "Forward");
          await page.waitForFunction(
            () => document.querySelector("[data-mail-reply-box='mail']")?.getAttribute("data-intent") === "forward",
          );
          expect(api.calls).toContain("POST /drafts/DrfNew/intent");
          expect(await page.locator("[data-mail-reply-box='mail'] .cm-content").textContent()).toContain("See the details below.");
          expect(api.calls.some((call) => call.endsWith("/discard"))).toBe(false);
        } finally {
          await close(page);
        }
      });

      test("internal note: yellow, Mod+Enter saves the note and never sends; the reply comes back unchanged", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Reply for the customer.");
          await eventually(() => api.drafts.get("DrfNew")?.body, "Reply for the customer.", "reply saved");
          await settled(page);
          const heightBefore = await page.evaluate(
            () => document.querySelector("[data-mail-reply-box-frame]")!.getBoundingClientRect().height,
          );
          await chooseMode(page, "Internal note");
          const note = page.locator("[data-mail-reply-box='note']");
          await note.waitFor();
          expect(await draftBox(page).isHidden()).toBe(true);
          expect(await note.textContent()).toContain("Only for the team.");
          expect(await note.getByRole("button", { name: "Save note" }).isDisabled()).toBe(true);
          // The note keeps the box's height: nothing moves.
          const heightNote = await page.evaluate(
            () => document.querySelector("[data-mail-reply-box-frame]")!.getBoundingClientRect().height,
          );
          expect(Math.abs(heightNote - heightBefore)).toBeLessThanOrEqual(1);
          await note.locator("textarea").fill("Order the oak boards before Friday.");
          await page.keyboard.press("Control+Enter");
          await eventually(() => api.notes.length, 1, "note saved");
          expect(api.notes).toEqual(["Order the oak boards before Friday."]);
          expect(api.calls.some((call) => call.endsWith("/commands") || call.endsWith("/safety-review"))).toBe(false);
          expect(JSON.stringify([...api.drafts.values()])).not.toContain("oak boards");
          await page.locator("[data-mail-conversation-messages]").getByText("Order the oak boards before Friday.").waitFor();
          await draftBox(page).waitFor();
          expect(await page.locator("[data-mail-reply-box='mail'] .cm-content").textContent()).toContain("Reply for the customer.");
          expect(await page.locator("[data-mail-reply-box='note']").count()).toBe(0);
        } finally {
          await close(page);
        }
      });

      /** The toasts on the rail, each as [title, description]. */
      const toasts = (page: Page) =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] .k2b-toast-slot:not([data-state='closing']) .k2b-toast"),
          ].map((card) => [
            card.querySelector<HTMLElement>(".k2b-toast__title:not([hidden])")?.textContent ?? null,
            card.querySelector(".k2b-toast__description")?.textContent ?? "",
          ]),
        );

      test("a failed send keeps the box and its text; one toast names the reason, and Try again sends", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const failing = { sendFails: true };
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next, "Gustav", failing);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Ready to go.");
          const footTop = () =>
            page.evaluate(() => document.querySelector("[data-mail-reply-box='mail'] footer")!.getBoundingClientRect().top);
          await eventually(() => api.drafts.get("DrfNew")?.body, "Ready to go.", "saved");
          await settled(page);
          const before = await footTop();
          await page.keyboard.press("Control+Enter");
          await page.locator("[data-mail-reply-box='mail'] [data-mail-send-again]").waitFor();
          await eventually(async () => (await toasts(page)).length, 1, "one failure toast");
          expect(await toasts(page)).toEqual([["Not sent", "The mail server does not answer. Your text stays in the draft."]]);
          // The box stays with its text, the bar stays where it was, and the reason stands once: in the toast.
          expect(await page.locator("[data-mail-reply-box='mail'] .cm-content").textContent()).toContain("Ready to go.");
          expect(Math.abs((await footTop()) - before)).toBeLessThanOrEqual(1);
          expect(await draftBox(page).textContent()).not.toContain("does not answer");
          failing.sendFails = false;
          await page.locator("[data-k2b-toast-container]").getByRole("button", { name: "Try again" }).click();
          await eventually(async () => (await toasts(page)).map(([title]) => title).join(), "Sending", "sending toast");
          await eventually(() => api.drafts.get("DrfNew")?.state, "sending", "sent");
        } finally {
          await close(page);
        }
      });

      test("a sent reply closes the box; one toast says when it goes out, and Undo brings the text back", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Saturday works.");
          await eventually(() => api.drafts.get("DrfNew")?.body, "Saturday works.", "saved");
          await page.keyboard.press("Control+Enter");
          await eventually(() => api.drafts.get("DrfNew")?.state, "sending", "sent");
          await eventually(async () => (await toasts(page)).length, 1, "one toast");
          // A short title for the outcome, what happens next as the description; nothing big stays in the box.
          expect(await toasts(page)).toEqual([["Sending", "The message goes out in 20 s."]]);
          await eventually(
            async () => (await page.locator("[data-mail-reply-box='mail'] .cm-content").textContent())?.includes("Saturday works."),
            false,
            "the box is empty again",
          );
          expect(await page.locator(".k2b-notice-card").count()).toBe(0);
          await page.locator("[data-k2b-toast-container]").getByRole("button", { name: "Undo" }).click();
          await eventually(() => api.calls.includes("POST /scheduled-sends/Dlv001/cancel"), true, "undo cancels the submission");
          await page.locator("[data-mail-reply-box='mail'] .cm-content", { hasText: "Saturday works." }).waitFor();
        } finally {
          await close(page);
        }
      });

      test("the signature follows the text as a fixed block, and the original goes along as a card that × leaves out", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          const signature = page.locator("[data-mail-reply-box='mail'] [data-mail-draft-signature]");
          // An HTML draft shows the sent signature in its frame.
          await page.frameLocator("[data-mail-reply-box='mail'] [data-mail-signature-frame]").getByText("Ada Example").waitFor();
          // Fixed: the block is not part of the editable text.
          expect(await signature.evaluate((element) => element.closest(".cm-content"))).toBeNull();
          // A reply quotes the message it answers: the card under the signature names who wrote it and shows its text.
          const card = page.locator("[data-mail-reply-box='mail'] [data-mail-quote-card]");
          expect(await card.getAttribute("aria-label")).toBe("Original message from Example sender");
          expect(await card.locator(".mail-quote-card-text").textContent()).toBe("Invented message for the browser suite.");
          const below = await card.evaluate((element) => {
            const signature = element.closest("[data-mail-reply-box='mail']")!.querySelector("[data-mail-draft-signature]")!;
            return element.getBoundingClientRect().top >= signature.getBoundingClientRect().bottom;
          });
          expect(below).toBe(true);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Saturday works.");
          await eventually(
            () => JSON.stringify(api.drafts.get("DrfNew")?.quoteSource ?? null),
            JSON.stringify({ locale: "en", timeZone: "UTC" }),
            "the quote goes along with locale and time zone",
          );
          // × leaves it out; the same place offers it again, and the saved draft keeps the choice.
          await card.getByRole("button", { name: "Leave the original message out" }).click();
          const add = page.locator("[data-mail-reply-box='mail'] [data-mail-quote-add]");
          await add.waitFor();
          await eventually(() => api.drafts.get("DrfNew")?.quoteSource ?? null, null, "left out");
          await add.click();
          await card.waitFor();
          await eventually(() => Boolean(api.drafts.get("DrfNew")?.quoteSource), true, "added again");
        } finally {
          await close(page);
        }
      });

      test("Gustav's suggestion stands in the box in plum, its row says so, and the first typing takes it over", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&suggestion=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          const draft = draftBox(page);
          expect(await draft.getAttribute("data-suggestion")).toBe("");
          expect(await draft.textContent()).toContain("Suggestion from Gustav");
          expect(await draft.textContent()).toContain("Type to take it over, or send it as it is.");
          expect(await page.locator('[data-conversation-id="Conv01"] [data-mail-row-draft]').getAttribute("data-suggestion")).toBe("");
          expect(api.calls).not.toContain("POST /drafts/DrfSug/lease");
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type(" Thanks!");
          await page.waitForFunction(() => !document.querySelector("[data-mail-reply-box='mail']")?.hasAttribute("data-suggestion"));
        } finally {
          await close(page);
        }
      });

      // #3859: the box above the conversation grew on the press, which moved Send from under the pointer, so the click
      // on a suggestion cut off at the reserved height never arrived. Send now sends it as it is, with one click.
      // Composer v4: the box no longer grows on a press at all; a long text scrolls in its one surface, so neither Send
      // nor the quote card moves between press and click.
      test("one click on Send sends an untouched suggestion that the box cuts off, and the press moves nothing", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&suggestion=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
          const lines = Array.from({ length: 16 }, (_, line) => `Example answer line ${line + 1}.`);
          // A reply quotes the message it answers, so the card stands under the long text too.
          api.drafts.set("DrfSug", {
            ...api.drafts.get("DrfSug"),
            body: `Hello,\n\n${lines.join("\n")}`,
            sourceMessageId: "Msg001",
            quoteSource: { locale: "en", timeZone: "UTC" },
          });
        });
        try {
          await readyDraft(page);
          await page.waitForFunction(() => {
            const body = document.querySelector<HTMLElement>("[data-mail-reply-box='mail'] [data-mail-compose-body]");
            return Boolean(body && body.scrollHeight > body.clientHeight + 1);
          });
          await settled(page);
          const pressStays = async (target: Locator, label: string) => {
            const before = (await target.boundingBox())!;
            await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
            await page.mouse.down();
            await settled(page);
            const pressed = (await target.boundingBox())!;
            expect(Math.abs(pressed.y - before.y), `${label} ${before.y} → ${pressed.y} on the press`).toBeLessThanOrEqual(0.5);
            await page.mouse.up();
          };
          // The quote card under the long text: its × leaves the original out on the first click.
          const remove = draftBox(page).locator("[data-mail-quote-card]").getByRole("button", { name: "Leave the original message out" });
          await remove.scrollIntoViewIfNeeded();
          await settled(page);
          await pressStays(remove, "Leave the original out");
          await draftBox(page).locator("[data-mail-quote-add]").waitFor();
          await settled(page);
          await pressStays(draftBox(page).locator("[data-mail-reply-send]"), "Send");
          await eventually(() => api.calls.includes("POST /commands"), true, "one click sends the suggestion as it is");
          expect(api.calls).toContain("POST /drafts/DrfSug/safety-review");
        } finally {
          await close(page);
        }
      });

      test("another automated account's suggestion carries that account's name, in plum, in the box and its row", async () => {
        const page = await open(
          `${boxPath}?conversation=Conv01&identity=1&suggestion=1&suggestionBy=Rechnungseingang`,
          1440,
          undefined,
          "reduce",
          async (next) => {
            await draftApi(next, "Rechnungseingang");
          },
        );
        try {
          await readyDraft(page);
          const draft = draftBox(page);
          expect(await draft.getAttribute("data-suggestion")).toBe("");
          expect(await draft.textContent()).toContain("Suggestion from Rechnungseingang");
          expect(await draft.textContent()).not.toContain("Gustav");
          const row = page.locator('[data-conversation-id="Conv01"] [data-mail-row-draft]');
          expect(await row.getAttribute("data-suggestion")).toBe("");
          expect(await row.textContent()).toContain("Suggestion");
          expect(await row.getAttribute("aria-label")).toBe("Suggestion from Rechnungseingang");
        } finally {
          await close(page);
        }
      });

      /** The new message's window, portaled over the workspace. */
      const composeWindow = (page: Page, draftId = "DrfNew") =>
        page.locator(".mail-compose-window", { has: page.locator(`[data-mail-compose-window="${draftId}"]`) });
      const readyWindow = async (page: Page, draftId = "DrfNew") => {
        await composeWindow(page, draftId).locator("[data-mail-inline-draft] .cm-content").waitFor();
      };

      test("Compose opens a window over the open conversation; the list and the reader behind stay usable", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          await draftApi(next);
        });
        try {
          await page.getByRole("link", { name: "New message" }).first().click();
          await readyWindow(page);
          // The window docks at the bottom end of the app and leaves the conversation where it was.
          expect(new URL(page.url()).searchParams.get("conversation")).toBe("Conv01");
          expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
          expect(await composeWindow(page).getAttribute("aria-modal")).toBe("false");
          const box = (await composeWindow(page).boundingBox())!;
          const area = (await page.locator(".mail-workspace").boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
          expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
          // The new message starts with its recipients; its title follows the subject.
          await page.waitForFunction(() => document.activeElement?.closest(".mail-compose-window .mail-inline-draft-recipients") !== null);
          await composeWindow(page).locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
          await composeWindow(page).locator(".k2b-floating-window__title", { hasText: "Pickup on Saturday" }).waitFor();
          // Another conversation opens behind the window, which stays.
          await page.locator('[data-conversation-id="Conv02"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
          expect(await composeWindow(page).count()).toBe(1);
        } finally {
          await close(page);
        }
      });

      test("a new message window docks, survives a reload, closes into Drafts, and Open brings it back", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.getByRole("link", { name: "New message" }).first().click();
          await readyWindow(page);
          expect(api.calls).toContain("POST /draft-seeds/materialize");
          await composeWindow(page).locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
          await eventually(() => api.drafts.get("DrfNew")?.subject, "Pickup on Saturday", "subject saved");
          await composeWindow(page).locator(".mail-compose-window-status", { hasText: "Saved" }).waitFor();
          // Minimized, it is a bar at the bottom; the list keeps its last row above it.
          await composeWindow(page).getByRole("button", { name: "Minimize" }).click();
          await page.waitForFunction(() => document.querySelector(".mail-compose-window")?.getAttribute("data-state") === "minimized");
          await page.locator(".mail-windows-docked").waitFor();
          // F5: the tab remembers the window and its state.
          await page.reload();
          await ready(page);
          await page.waitForFunction(() => document.querySelector(".mail-compose-window")?.getAttribute("data-state") === "minimized");
          await page.getByRole("button", { name: "Restore Pickup on Saturday" }).click();
          await readyWindow(page);
          expect(await composeWindow(page).locator(".mail-inline-draft-subject input").inputValue()).toBe("Pickup on Saturday");
          // Close keeps the draft and says where it is; Open brings the window back.
          await composeWindow(page).getByRole("button", { name: "Close window" }).click();
          await composeWindow(page).waitFor({ state: "detached" });
          expect(api.calls).not.toContain("POST /drafts/DrfNew/discard");
          expect(api.drafts.get("DrfNew")?.state).toBe("draft");
          const notice = page.locator("[data-k2b-toast-container]", { hasText: "It is in “Drafts”." });
          await notice.waitFor();
          await notice.getByRole("button", { name: "Open" }).click();
          await readyWindow(page);
          // An old link to the draft opens its window too and leaves the list's URL clean.
          await page.goto(new URL(`${boxPath}?identity=1&draft=DrfNew`, page.url()).href);
          await ready(page);
          await readyWindow(page);
          await page.waitForFunction(() => !new URL(location.href).searchParams.has("draft"));
          expect(await page.locator(".mail-compose-window").count()).toBe(1);
        } finally {
          await close(page);
        }
      });

      test("Send closes the new message window; the save state stands once, and the toast's Undo brings the window back", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.getByRole("link", { name: "New message" }).first().click();
          await readyWindow(page);
          await page.waitForFunction(() => document.activeElement?.closest(".mail-compose-window .mail-inline-draft-recipients") !== null);
          await page.keyboard.type("lena@example.test");
          await composeWindow(page).locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
          await composeWindow(page).locator(".cm-content").click();
          await page.keyboard.type("The chairs are ready.");
          await eventually(() => api.drafts.get("DrfNew")?.body, "The chairs are ready.", "body saved");
          await composeWindow(page).locator(".mail-compose-window-status", { hasText: "Saved" }).waitFor();
          // One save state, in the head: the text area shows only what someone wrote.
          expect(await composeWindow(page).getByText("Saved", { exact: true }).count()).toBe(1);
          expect(await composeWindow(page).locator(".k2b-ste-status").count()).toBe(0);
          await composeWindow(page).locator(".mail-compose-window-foot .mail-compose-action .k2b-split-button__primary").click();
          await composeWindow(page).waitFor({ state: "detached" });
          await eventually(async () => (await toasts(page)).length, 1, "one toast");
          expect(await toasts(page)).toEqual([["Sending", "The message goes out in 20 s."]]);
          await page.locator("[data-k2b-toast-container]").getByRole("button", { name: "Undo" }).click();
          await readyWindow(page);
          expect(api.calls).toContain("POST /scheduled-sends/Dlv001/cancel");
          expect(await composeWindow(page).locator(".mail-inline-draft-subject input").inputValue()).toBe("Pickup on Saturday");
        } finally {
          await close(page);
        }
      });

      test("Maximize turns a new message window large and back with the same text, without a page error (#3683)", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.getByRole("link", { name: "New message" }).first().click();
          await readyWindow(page);
          await composeWindow(page).locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
          await eventually(() => api.drafts.get("DrfNew")?.subject, "Pickup on Saturday", "subject saved");
          // The bar stands on the scroller's bottom edge, normal and large: no inset below it where text scrolls on.
          const barGap = (scroller: string) =>
            composeWindow(page).evaluate((window, selector) => {
              const box = window.querySelector(selector)!.getBoundingClientRect();
              return Math.round(box.bottom - window.querySelector(".mail-compose-window-foot")!.getBoundingClientRect().bottom);
            }, scroller);
          // Long text never squeezes the field rows: Subject starts below To with room for a focus ring.
          await composeWindow(page).locator(".cm-content").click();
          await page.keyboard.insertText(
            Array.from({ length: 30 }, (_, line) => `Line ${line + 1}: the planks arrive on Saturday.`).join("\n\n"),
          );
          const fieldGap = () =>
            composeWindow(page).evaluate((window) => {
              const to = window.querySelector(".mail-recipient-control")!.getBoundingClientRect();
              return Math.round(
                window.querySelector(".mail-inline-draft-subject .k2b-input-shell")!.getBoundingClientRect().top - to.bottom,
              );
            });
          // At the end of a long text, To and Subject still stand at the top: only the text scrolled.
          const fieldsAtTop = (scroller: string) =>
            composeWindow(page).evaluate((window, selector) => {
              const element = window.querySelector<HTMLElement>(selector)!;
              element.scrollTop = element.scrollHeight;
              const top = element.getBoundingClientRect().top;
              const to = window.querySelector(".mail-recipient-control")!.getBoundingClientRect();
              const subject = window.querySelector(".mail-inline-draft-subject .k2b-input-shell")!.getBoundingClientRect();
              // The fields stand above the one scrolling surface and stay there (Composer v4).
              return element.scrollTop > 0 && to.bottom <= top && subject.bottom <= top;
            }, scroller);
          await settled(page);
          expect(await barGap(".mail-compose-window-body > .mail-inline-draft")).toBe(0);
          expect(await fieldGap()).toBeGreaterThanOrEqual(4);
          expect(await fieldsAtTop(".mail-compose-window-body [data-mail-compose-body]")).toBe(true);
          await composeWindow(page).getByRole("button", { name: "Maximize" }).click();
          await composeWindow(page).locator(".mail-inline-draft[data-large] .mail-large-panes .mail-draft-block").waitFor();
          await settled(page);
          expect(await barGap(".mail-large-panes .mail-draft-block")).toBe(0);
          expect(await fieldGap()).toBeGreaterThanOrEqual(4);
          // Only the one surface scrolls; the draft block itself holds still (Composer v4).
          expect(await fieldsAtTop(".mail-large-panes [data-mail-compose-body]")).toBe(true);
          expect(
            await composeWindow(page).evaluate(
              (window) => window.querySelector<HTMLElement>(".mail-large-panes .mail-draft-block")!.scrollTop,
            ),
          ).toBe(0);
          expect(await composeWindow(page).locator(".mail-inline-draft-subject input").inputValue()).toBe("Pickup on Saturday");
          await composeWindow(page).getByRole("button", { name: "Restore size" }).click();
          await composeWindow(page).locator(".mail-inline-draft:not([data-large]) > .mail-draft-block-place > .mail-draft-block").waitFor();
          expect(await composeWindow(page).locator(".mail-inline-draft-subject input").inputValue()).toBe("Pickup on Saturday");
          // close() fails on any page error, such as the HierarchyRequestError the move used to raise.
        } finally {
          await close(page);
        }
      });

      test("390: a new message is a full-screen sheet with Send in its head; Close keeps the draft", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?identity=1`, 390, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await page.locator("[data-workspace-primary]").first().click();
          await readyWindow(page);
          const sheet = composeWindow(page);
          expect(await sheet.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
          expect(await sheet.getAttribute("aria-modal")).toBe("true");
          expect(await sheet.locator(".k2b-floating-window__actions .mail-compose-action").isVisible()).toBe(true);
          expect(await sheet.locator(".mail-compose-window-foot .mail-compose-action").count()).toBe(0);
          await sheet.locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
          await eventually(() => api.drafts.get("DrfNew")?.subject, "Pickup on Saturday", "subject saved");
          await sheet.getByRole("button", { name: "Close window" }).click();
          await sheet.waitFor({ state: "detached" });
          expect(api.drafts.get("DrfNew")?.state).toBe("draft");
        } finally {
          await close(page);
        }
      });

      test("a new message in Drafts opens as a window over the folder", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?folder=Drafts1&drafts-fixture=1&identity=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
          api.drafts.set("Draft1", api.makeDraft("Draft1", { subject: "Quarterly figures" }, { conversationId: null, intent: "new" }));
        });
        try {
          await page.locator('[data-draft-id="Draft1"] a.mail-list-row').click();
          await readyWindow(page, "Draft1");
          await composeWindow(page, "Draft1").locator(".k2b-floating-window__title", { hasText: "Quarterly figures" }).waitFor();
          // The folder stays; the URL drops the draft, and the window is the tab's to remember.
          expect(await page.locator("[data-mail-drafts-list]").isVisible()).toBe(true);
          await page.waitForFunction(() => !new URL(location.href).searchParams.has("draft"));
        } finally {
          await close(page);
        }
      });

      test("a conversation with a colleague's draft shows a draft chip with who writes it", async () => {
        const page = await open(`${boxPath}?drafts=1`, 1440);
        try {
          const chip = page.locator('[data-conversation-id="Conv01"] [data-mail-row-draft]');
          // "Draft" beside the sender; who writes it stands in its label.
          expect((await chip.textContent())?.trim()).toBe("Draft");
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
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Not lost");
          // Leave before the 700 ms autosave: the draft is created and saved on the way out.
          await page.locator('[data-conversation-id="Conv02"] a.mail-list-row').click();
          await page.waitForFunction(() => new URL(location.href).searchParams.get("conversation") === "Conv02");
          await eventually(() => api.drafts.get("DrfNew")?.body, "Not lost", "saved on leave");
        } finally {
          await close(page);
        }
      });

      test("a colleague's reply draft stands in the box in its mode, and a reload keeps it there", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&drafts=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next);
        });
        try {
          await readyDraft(page);
          expect(api.calls).toContain("GET /drafts/Drf001");
          expect(await draftBox(page).getAttribute("data-intent")).toBe("forward");
          expect(await page.locator("[data-mail-draft-row]").count()).toBe(0);
          await page.reload();
          await ready(page);
          await readyDraft(page);
          expect(await draftBox(page).getAttribute("data-intent")).toBe("forward");
        } finally {
          await close(page);
        }
      });

      test("F6: the one-time line names how many drafts were here; Got it removes it", async () => {
        let api!: Awaited<ReturnType<typeof draftApi>>;
        const page = await open(`${boxPath}?conversation=Conv01&identity=1&drafts=1`, 1440, undefined, "reduce", async (next) => {
          api = await draftApi(next, "Gustav", { consolidated: 2 });
        });
        try {
          const line = page.locator("[data-mail-reply-consolidated]");
          await line.waitFor();
          expect(await line.textContent()).toContain("There were 3 drafts here. The most recently edited one is in the box.");
          await line.getByRole("button", { name: "Got it" }).click();
          await line.waitFor({ state: "detached" });
          expect(api.calls).toContain("POST /drafts/Drf001/consolidation/acknowledge");
        } finally {
          await close(page);
        }
      });

      /** The conversation beside a large draft: two messages, the newest with a file, and one internal note. */
      const historyApi = async (page: Page) => {
        const person = (name: string, address: string) => ({ name, address });
        const summary = (id: string, subject: string, preview: string, date: string, hasAttachments: boolean) => ({
          id,
          subject,
          preview,
          hasAttachments,
          messageId: `<${id}@example.test>`,
          internalDate: date,
          sentAt: date,
          from: [person("Example sender", "sender@example.test")],
          to: [person("Example support", "support@example.test")],
          flags: ["\\Seen"],
          keywords: [],
          hydrationStatus: "complete",
          remoteAvailable: true,
          folderId: null,
        });
        const messages = [
          summary("Hist01", "Example request 1", "Hello, could you set up chairs for Saturday?", "2026-10-13T08:12:00.000Z", false),
          summary("Hist02", "Re: Example request 1", "Saturday works for us. The quote is attached.", "2026-10-14T09:12:00.000Z", true),
        ];
        const detail = (message: (typeof messages)[number]) => ({
          ...message,
          deletedOnServer: false,
          contentType: "text/plain",
          sizeBytes: 2048,
          replyTo: [],
          cc: [],
          plainText: `Hello,\n\n${message.preview}\n\nKind regards\nExample sender`,
          sanitizedHtml: null,
          forwardText: "",
          selectedHeaders: {},
          sourceAvailable: false,
          mailingList: null,
          remoteContent: { imageIds: [], allowedByRule: false, allowRules: [], sender: null, domain: null },
          delivery: null,
          attachments: message.hasAttachments
            ? [
                {
                  id: "Att900",
                  filename: "Quote_Saturday.pdf",
                  contentType: "application/pdf",
                  sizeBytes: 18_000,
                  contentId: null,
                  checksum: null,
                },
              ]
            : [],
        });
        await page.route("**/api/mail/mailboxes/Box001/conversations/Conv01/messages**", (route) =>
          route.fulfill({ json: { items: messages.toReversed(), nextCursor: null } }),
        );
        await page.route(/\/api\/mail\/mailboxes\/Box001\/messages\/Hist0\d$/, (route) =>
          route.fulfill({ json: detail(messages.find((message) => route.request().url().endsWith(message.id))!) }),
        );
        await page.route("**/api/mail/mailboxes/Box001/conversations/Conv01/comments?**", (route) =>
          route.request().method() === "GET"
            ? route.fulfill({
                json: {
                  items: [
                    {
                      id: "Note90",
                      conversationId: "Conv01",
                      body: "Hall A is free until noon only.",
                      author: { kind: "user", id: "Usr002", displayName: "Tom Example", avatarHash: null },
                      referencedMessageId: null,
                      revision: 1,
                      canEdit: false,
                      canDelete: false,
                      editedAt: null,
                      deletedAt: null,
                      createdAt: "2026-10-13T16:40:00.000Z",
                      updatedAt: "2026-10-13T16:40:00.000Z",
                    },
                  ],
                  nextCursor: null,
                },
              })
            : route.fallback(),
        );
      };
      const largeWindow = (page: Page) => page.locator('.mail-compose-window[data-state="maximized"]');
      const writeLarge = async (page: Page) => {
        await page.locator("[data-mail-reply-box='mail'] [data-mail-write-large]").click();
        await largeWindow(page).locator(".mail-large-panes .cm-content").waitFor();
      };

      test("Write large: the draft beside its conversation above the preview; Esc gives it back to the box; the arrangement stays", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 1440, undefined, "reduce", async (next) => {
          await draftApi(next);
          await historyApi(next);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Saturday at 11 works.");
          await writeLarge(page);
          const panes = largeWindow(page).locator(".mail-large-panes");
          // F3: draft on the left; on the right the conversation above the preview.
          expect(await panes.locator('[role="tab"]').allTextContents()).toEqual(["Draft", "History", "Preview"]);
          const panel = async (name: string) =>
            (await panes
              .locator(`[role="tabpanel"][aria-labelledby="${await panes.getByRole("tab", { name }).getAttribute("id")}"]`)
              .boundingBox())!;
          const [draft, history, preview] = [await panel("Draft"), await panel("History"), await panel("Preview")];
          expect(draft.x + draft.width).toBeLessThanOrEqual(history.x);
          expect(history.y + history.height).toBeLessThanOrEqual(preview.y);
          expect(Math.abs(history.x - preview.x)).toBeLessThan(1);
          expect(await largeWindow(page).locator(".mail-large-panes .cm-content").textContent()).toContain("Saturday at 11 works.");
          await panes.locator(".mail-large-preview iframe").waitFor();
          await panes.locator(".mail-composer-history", { hasText: "Saturday works for us." }).waitFor();
          await panes.locator(".mail-note", { hasText: "Hall A is free until noon only." }).waitFor();
          await panes.getByRole("button", { name: "Attach Quote_Saturday.pdf to the reply" }).waitFor();
          // The caret is in the text, where it stood in the box.
          expect(await page.evaluate(() => document.activeElement?.closest(".mail-large-panes .cm-content") !== null)).toBe(true);
          if (screenshots) {
            await settled(page);
            await page.screenshot({ path: join(resolve(screenshots), "large-stacked-light-1440.png") });
            await panes.locator(".k2b-panes__arrange").click();
            await page.locator(".k2b-panes__menu:popover-open").waitFor();
            await settled(page);
            await page.screenshot({ path: join(resolve(screenshots), "large-arrange-light-1440.png") });
            await page.keyboard.press("Escape");
          }

          // The person chooses Tabs; Mail keeps that choice.
          await panes.locator(".k2b-panes__arrange").click();
          await page.locator(".k2b-panes__menu:popover-open").getByRole("menuitemradio", { name: "Tabs" }).click();
          await eventually(
            async () =>
              decodeURIComponent((await storedCookie(page, "settings-app-mail-composer-panes"))?.value ?? "").includes('"type":"group"'),
            true,
            "the arrangement is stored",
          );

          // The preview's mail stays in an opaque sandbox. Esc from the draft leaves the large window: the draft stands in
          // the box again, with its text. (After a click into the preview's mail, keys stay in its frame until the person
          // clicks outside; "Restore size" stays visible. Agreed exception, see the PR.)
          await panes.getByRole("tab", { name: "Preview" }).click();
          expect(await largeWindow(page).locator(".mail-large-preview iframe").getAttribute("sandbox")).toBe("");
          await panes.getByRole("tab", { name: "Draft" }).click();
          await largeWindow(page).locator(".mail-large-panes .cm-content").click();
          await page.keyboard.press("Escape");
          await largeWindow(page).waitFor({ state: "detached" });
          await page.locator("[data-mail-reply-box='mail'] .cm-content", { hasText: "Saturday at 11 works." }).waitFor();
          await page.waitForFunction(() => document.activeElement?.closest("[data-mail-reply-box='mail'] .cm-content") != null);

          // Next time it opens as chosen.
          await writeLarge(page);
          expect(await largeWindow(page).locator('.mail-large-panes [role="tablist"]').count()).toBe(1);
        } finally {
          await close(page);
        }
      });

      test("390: Write large is a full-screen sheet with Draft, History and Preview as tabs", async () => {
        const page = await open(`${boxPath}?conversation=Conv01&identity=1`, 390, undefined, "reduce", async (next) => {
          await draftApi(next);
          await historyApi(next);
        });
        try {
          await readyDraft(page);
          await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
          await page.keyboard.type("Saturday at 11 works.");
          await page.locator("[data-mail-reply-box='mail'] [data-mail-write-large]").click();
          const panes = page.locator('.mail-compose-window .mail-large-panes[data-narrow="true"]');
          await panes.waitFor();
          // The mockup's order on a phone: the draft, how it arrives, then the conversation.
          expect(await panes.locator('[role="tab"]').allTextContents()).toEqual(["Draft", "Preview", "History"]);
          expect(await panes.locator(".k2b-panes__arrange, .k2b-panes__separator").count()).toBe(0);
          if (screenshots) {
            await settled(page);
            await page.screenshot({ path: join(resolve(screenshots), "large-phone-light-390.png") });
          }
          await panes.getByRole("tab", { name: "Preview" }).click();
          await panes.locator(".mail-large-preview iframe").waitFor();
        } finally {
          await close(page);
        }
      });

      if (screenshots)
        test("Write large review screenshots", async () => {
          const directory = resolve(screenshots);
          const shot = async (
            name: string,
            path: string,
            width: number,
            act: (page: Page) => Promise<void>,
            failing?: "history" | "preview",
          ) => {
            const page = await open(path, width, undefined, "reduce", async (next) => {
              await draftApi(next);
              await historyApi(next);
              if (failing === "history")
                await next.route("**/api/mail/mailboxes/Box001/conversations/Conv01/messages**", (route) =>
                  route.fulfill({ status: 503, json: { message: "Unavailable" } }),
                );
              if (failing === "preview")
                await next.route("**/api/mail/mailboxes/Box001/compose-preview", (route) =>
                  route.fulfill({ status: 503, json: { message: "Unavailable" } }),
                );
            });
            try {
              await readyDraft(page);
              await act(page);
              await settled(page);
              await page.screenshot({ path: join(directory, `${name}.png`) });
            } finally {
              await page.context().close();
            }
          };
          const thread = `${boxPath}?conversation=Conv01&identity=1`;
          await shot("large-entry-light-1440", thread, 1440, async (page) => {
            await page.locator("[data-mail-reply-box='mail'] [data-mail-write-large]").hover();
            await page.locator("[role='tooltip']", { hasText: "Write large" }).waitFor();
          });
          await shot("large-stacked-dark-1440", `${thread}&theme=dark`, 1440, writeLarge);
          await shot(
            "large-history-error-light-1440",
            thread,
            1440,
            async (page) => {
              await writeLarge(page);
              await page.locator(".mail-composer-history", { hasText: "The conversation could not load" }).waitFor();
            },
            "history",
          );
          await shot(
            "large-preview-error-light-1440",
            thread,
            1440,
            async (page) => {
              await writeLarge(page);
              await page.locator(".mail-large-preview", { hasText: "Preview could not be rendered" }).waitFor();
            },
            "preview",
          );
        }, 120_000);

      if (screenshots)
        test("draft review screenshots", async () => {
          const directory = resolve(screenshots);
          mkdirSync(directory, { recursive: true });
          const shoot = async (
            name: string,
            theme: "light" | "dark",
            width: number,
            path: string,
            act?: (page: Page) => Promise<void>,
            api: { consolidated?: number; sendFails?: boolean } = {},
          ) => {
            const page = await open(`${path}&theme=${theme}`, width, undefined, "reduce", async (next) => {
              await draftApi(next, "Gustav", api);
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
            await readyDraft(page);
            await page.locator("[data-mail-reply-box='mail'] .cm-content").click();
            await page.keyboard.type("Saturday at 11 works well. The chairs are ready in hall A.");
          };
          const thread = `${boxPath}?conversation=Conv01&identity=1`;
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) {
              await shoot("01-box-empty", theme, width, thread, readyDraft);
              await shoot("02-box-reply", theme, width, thread, reply);
              await shoot("03-box-note", theme, width, thread, async (page) => {
                await readyDraft(page);
                await chooseMode(page, "Internal note");
                await page
                  .locator("[data-mail-reply-box='note'] textarea")
                  .fill("Frau Lindqvist moves mid December. Deliver before the 12th.");
              });
            }
          await shoot("04-box-mode-menu", "light", 1440, thread, async (page) => {
            await readyDraft(page);
            await page.locator("[data-mail-reply-box-frame] [data-mail-reply-mode]").first().click();
            await page.getByRole("menuitemradio", { name: "Internal note" }).waitFor();
          });
          await shoot(
            "05-box-send-failed",
            "light",
            1440,
            thread,
            async (page) => {
              await reply(page);
              await page.keyboard.press("Control+Enter");
              await page.locator("[data-mail-reply-box='mail'] [data-mail-send-again]").waitFor();
            },
            { sendFails: true },
          );
          await shoot("06-box-suggestion", "light", 1440, `${thread}&suggestion=1`, readyDraft);
          await shoot("06-box-suggestion", "dark", 1440, `${thread}&suggestion=1`, readyDraft);
          await shoot(
            "07-box-consolidated",
            "light",
            1440,
            `${thread}&drafts=1`,
            async (page) => {
              await page.locator("[data-mail-reply-consolidated]").waitFor();
            },
            { consolidated: 2 },
          );
          const compose = async (page: Page) => {
            await page.locator("[data-workspace-primary]").first().click();
            await readyWindow(page);
            await composeWindow(page).locator(".mail-inline-draft-subject input").fill("Pickup on Saturday");
            await composeWindow(page).locator(".mail-compose-window-status", { hasText: "Saved" }).waitFor();
          };
          // A phone shows Compose with the list, not beside an open conversation.
          for (const [theme, width] of [
            ["light", 1440],
            ["light", 390],
            ["dark", 1440],
          ] as const)
            await shoot("08-new-message", theme, width, `${boxPath}?${width < 640 ? "" : "conversation=Conv01&"}identity=1`, compose);
          // After Send: the composer is gone and one short toast says what happens next; a failure keeps the text.
          const sendNew = async (page: Page, width: number) => {
            await compose(page);
            await composeWindow(page).locator(".mail-inline-draft-recipients input").first().fill("lena@example.test");
            await composeWindow(page).locator(".cm-content").click();
            await page.keyboard.type("The chairs are ready in hall A.");
            await composeWindow(page).locator(".mail-compose-window-status", { hasText: "Saved" }).waitFor();
            const send =
              width < 640
                ? composeWindow(page).locator(".k2b-floating-window__actions .mail-compose-action .k2b-split-button__primary")
                : composeWindow(page).locator(".mail-compose-window-foot .mail-compose-action .k2b-split-button__primary");
            await send.click();
          };
          for (const theme of ["light", "dark"] as const)
            for (const width of [1440, 390]) {
              const list = `${boxPath}?${width < 640 ? "" : "conversation=Conv01&"}identity=1`;
              await shoot("12-new-written", theme, width, list, async (page) => {
                await compose(page);
                await composeWindow(page).locator(".cm-content").click();
                await page.keyboard.type("The chairs are ready in hall A.");
                await composeWindow(page).locator(".mail-compose-window-status", { hasText: "Saved" }).waitFor();
              });
              await shoot("13-new-sent-toast", theme, width, list, async (page) => {
                await sendNew(page, width);
                await composeWindow(page).waitFor({ state: "detached" });
                await page.locator("[data-k2b-toast-container] .k2b-toast", { hasText: "Sending" }).waitFor();
              });
              await shoot(
                "14-box-send-failed-toast",
                theme,
                width,
                thread,
                async (page) => {
                  await reply(page);
                  await page.keyboard.press("Control+Enter");
                  await page.locator("[data-k2b-toast-container] .k2b-toast", { hasText: "Not sent" }).waitFor();
                },
                { sendFails: true },
              );
              await shoot("15-box-sent-toast", theme, width, thread, async (page) => {
                await reply(page);
                await page.keyboard.press("Control+Enter");
                await page.locator("[data-k2b-toast-container] .k2b-toast", { hasText: "Sending" }).waitFor();
              });
            }
          await shoot("09-new-minimized", "light", 1440, `${boxPath}?conversation=Conv01&identity=1`, async (page) => {
            await compose(page);
            await composeWindow(page).getByRole("button", { name: "Minimize" }).click();
          });
          await shoot("10-new-maximized", "light", 1440, `${boxPath}?conversation=Conv01&identity=1`, async (page) => {
            await compose(page);
            await composeWindow(page).getByRole("button", { name: "Maximize" }).click();
          });
          await shoot("11-new-closed", "light", 1440, `${boxPath}?identity=1`, async (page) => {
            await compose(page);
            await composeWindow(page).getByRole("button", { name: "Close window" }).click();
            await page.locator("[data-k2b-toast-container]", { hasText: "It is in “Drafts”." }).waitFor();
          });
          await shoot("08-box-preview", "light", 1440, thread, async (page) => {
            await reply(page);
            await page.locator("[data-mail-reply-box='mail'] button[aria-label='More']").click();
            await page.getByRole("menuitemcheckbox", { name: "Preview (how the mail arrives)" }).click();
            await page.locator(".mail-inline-draft-preview iframe").waitFor();
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
                    ["mailbox", "notes", `${boxPath}?conversation=Conv01&notes=1`],
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
