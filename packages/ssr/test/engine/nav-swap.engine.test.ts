import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toJSON } from "seroval";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

// Each test opens a fresh context and waits for real page loads.
setDefaultTimeout(30_000);

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let version = "v1";
let railId: string;
let pageId: string;
let unseenId: string;
let brokenId: string;
let heldA: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
let receivedA: ReturnType<typeof Promise.withResolvers<void>>;
/** Holds the document load of `non-html-stream` until the test saw the swap fetch end. */
let streamDocument: ReturnType<typeof Promise.withResolvers<void>>;
const scenarios = [
  "A",
  "B",
  "new",
  "non-html",
  "non-html-stream",
  "403",
  "redirect",
  "signature",
  "prefix",
  "deploy",
  "styles",
  "throw",
  "lang",
  "hidden-heading",
  "slow",
  "offline",
  "sub/nested",
];
/** Held swap fetches of `slow`, released after each test so the server can stop. */
const slow = new Set<ReturnType<typeof Promise.withResolvers<Response>>>();
/** Paths of frame requests, to see which URL a relative `src` in a swapped column resolved against. */
const frames: string[] = [];
const wrapper = (id: string, label: string) =>
  `<solid-island data-id="${id}" data-props='${JSON.stringify(toJSON({ label }))}'>server ${label}</solid-island>`;
const html = (
  label: string,
  options: {
    signature?: string;
    prefix?: string;
    style?: string;
    entry?: string;
    extra?: string;
    lang?: string;
    hiddenTitle?: boolean;
  } = {},
) => {
  const prefix = options.prefix ?? `/_ssr/${version}`;
  return `<!doctype html><html lang="${options.lang ?? "en"}"><head><title>${label}</title><meta name="description" content="About ${label}"><link rel="stylesheet" href="${options.style ?? "/base.css"}"></head><body>
    <div data-nav-shell="${options.signature ?? "sig"}" data-nav-scope="/app" data-nav-attributes="data-mode" data-mode="${label}">
    ${wrapper(railId, "rail")}<main data-nav-root><h1${options.hiddenTitle ? ' style="display:none"' : ""}>${label}</h1>${wrapper(options.entry ?? pageId, label)}${options.extra ?? ""}</main></div>
    <script type="module" data-ssr-assets="${prefix}">const p="${prefix}";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>
    </body></html>`;
};
const pageResponse = (label: string, options: Parameters<typeof html>[1] = {}) =>
  new Response(html(label, options), { headers: { "content-type": "text/html" } });
beforeAll(async () => {
  root = makeTempRoot(".ssr-nav-engine-");
  const rail = join(root, "Rail.island.tsx");
  const page = join(root, "Page.island.tsx");
  const unseen = join(root, "Unseen.island.tsx");
  const broken = join(root, "Broken.island.tsx");
  writeFileSync(
    rail,
    `import { onSettled, onCleanup } from "solid-js";
    import { installPageSwap, swapPage } from ${JSON.stringify(resolve(import.meta.dir, "../../src/nav.ts"))};
    export default function Rail() {
      const timeout = new URL(location.href).searchParams.get("timeout");
      onSettled(() => { onCleanup(installPageSwap(timeout ? { timeout: Number(timeout) } : {})); document.documentElement.dataset.ready = "yes"; });
      return <nav>${scenarios.map((name) => `<a id="${name.replace("/", "-")}" href="/app/${name}">${name}</a>`).join("")}
      <button id="swap-replace" onClick={() => void swapPage("/app/new", { replace: true })}>Replace page</button>
      <a id="prevented" href="/app/prevented" onClick={e => e.preventDefault()}>prevented</a></nav>;
    }`,
  );
  const source = `import { onSettled, onCleanup } from "solid-js";
    export default function Page(props) {
      onSettled(() => { const handler = () => {}; window.addEventListener("resize", handler);
        onCleanup(() => window.removeEventListener("resize", handler)); });
      return <b data-mounted>{props.label}</b>;
    }`;
  writeFileSync(page, source);
  writeFileSync(unseen, source.replace("function Page", "function Unseen"));
  writeFileSync(broken, `throw new Error("entry evaluation failed"); export default () => <b>unreachable</b>;`);
  railId = islandIdFromFile(rail, root);
  pageId = islandIdFromFile(page, root);
  unseenId = islandIdFromFile(unseen, root);
  brokenId = islandIdFromFile(broken, root);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: join(root, "_ssr"), dev: false, verbose: false });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/frame.html")) {
        frames.push(url.pathname);
        return new Response("<!doctype html><title>frame</title>", { headers: { "content-type": "text/html" } });
      }
      if (url.pathname.endsWith(".css")) return new Response("body{min-height:2000px}", { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/_ssr/")) {
        const file = Bun.file(join(root, "_ssr", url.pathname.split("/").at(-1)!));
        if (!url.pathname.startsWith(`/_ssr/${version}/`) || !(await file.exists())) return new Response("missing", { status: 404 });
        return new Response(file, { headers: { "content-type": "text/javascript" } });
      }
      const label = url.pathname.split("/").at(-1)!;
      if (request.headers.get("sec-fetch-dest") === "document") {
        if (label === "non-html-stream") await streamDocument.promise;
        return pageResponse(label);
      }
      switch (label) {
        case "A":
          heldA = Promise.withResolvers<Response>();
          receivedA.resolve();
          return heldA.promise;
        case "non-html":
          return new Response("plain", { headers: { "content-type": "text/plain" } });
        case "non-html-stream":
          // The body never ends, so only the swap itself can end this fetch before the document unloads.
          return new Response(
            new ReadableStream({
              start: (controller) => controller.enqueue(new TextEncoder().encode("plain")),
            }),
            { headers: { "content-type": "text/plain" } },
          );
        case "403":
          return new Response("forbidden", { status: 403 });
        case "redirect":
          return Response.redirect(`${origin}/outside`, 302);
        case "signature":
          return pageResponse(label, { signature: "other" });
        case "prefix":
          return pageResponse(label, { prefix: "/_ssr/v2" });
        case "styles":
          return pageResponse(label, { style: "/changed.css" });
        case "lang":
          return pageResponse(label, { lang: "de" });
        case "hidden-heading":
          return pageResponse(label, { hiddenTitle: true, extra: '<h2 id="visible-heading">Visible</h2>' });
        case "slow": {
          const held = Promise.withResolvers<Response>();
          slow.add(held);
          return held.promise;
        }
        case "throw":
          return pageResponse(label, { entry: brokenId });
        case "nested":
          return pageResponse(label, { extra: '<iframe title="frame" src="frame.html"></iframe>' });
        case "deploy": {
          const result = pageResponse(label, { entry: unseenId });
          version = "v2";
          return result;
        }
        default:
          return pageResponse(label);
      }
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, 30_000);
const releaseSlow = () => {
  for (const held of slow) held.resolve(pageResponse("slow"));
  slow.clear();
};
afterEach(releaseSlow);
beforeEach(() => {
  version = "v1";
  heldA = undefined;
  receivedA = Promise.withResolvers<void>();
  streamDocument = Promise.withResolvers<void>();
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    heldA?.resolve(pageResponse("A"));
    releaseSlow();
    try {
      await server?.stop(true);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
});
const open = async (page: Page, path = "/app/old") => {
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(
    () => document.documentElement.dataset.ready === "yes" && document.querySelector("main [data-mounted]")?.textContent === "old",
  );
};
const trackDocuments = (page: Page) => {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) urls.push(request.url());
  });
  return urls;
};

test(`${browserName}: rapid clicks abort A and commit only B without a document load`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url() === `${origin}/app/A` });
    await page.click("#A");
    await receivedA.promise;
    await page.click("#B");
    await page.waitForFunction(() => location.pathname === "/app/B" && document.querySelector("main [data-mounted]")?.textContent === "B");
    expect((await aborted).failure()?.errorText).toMatch(/abort|cancel/i);
    heldA!.resolve(pageResponse("A"));
    expect(await page.locator("h1").textContent()).toBe("B");
    expect(await page.title()).toBe("B");
    expect(documents).toEqual([]);
  } finally {
    heldA?.resolve(pageResponse("A"));
    await context.close();
  }
});

/** Records every `ssr:nav-fallback` across the document loads of one tab. */
const recordFallbacks = (page: Page) =>
  page.addInitScript(() => {
    window.addEventListener("ssr:nav-fallback", (event) => {
      if (!(event instanceof CustomEvent)) throw new Error("Missing fallback detail");
      const rows = JSON.parse(sessionStorage.getItem("fallbacks") ?? "[]");
      rows.push({ ...event.detail, url: new URL(event.detail.url).pathname, column: document.querySelector("main h1")?.textContent });
      sessionStorage.setItem("fallbacks", JSON.stringify(rows));
    });
  });
const fallbacks = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("fallbacks") ?? "[]"));

test.each([
  ["non-html", { reason: "content-type" }],
  ["403", { reason: "status", status: 403 }],
  ["redirect", { reason: "redirect" }],
  ["signature", { reason: "shell" }],
  ["prefix", { reason: "assets" }],
  ["deploy", { reason: "module" }],
  ["styles", { reason: "head" }],
  ["lang", { reason: "head" }],
  ["throw", { reason: "module" }],
] as const)(`${browserName}: %s makes exactly one requested document navigation and reports why`, async (scenario, reported) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await recordFallbacks(page);
    await open(page);
    const documents = trackDocuments(page);
    await page.click(`a[href="/app/${scenario}"]`);
    await page.waitForFunction(
      (path) => location.pathname === path && document.documentElement.dataset.ready === "yes",
      `/app/${scenario}`,
    );
    expect(documents).toEqual([`${origin}/app/${scenario}`]);
    // Reported before the document load, while the old column still shows.
    expect(await fallbacks(page)).toEqual([{ ...reported, url: `/app/${scenario}`, column: "old" }]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a failing request loads the document once and reports a network fallback`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await recordFallbacks(page);
    await page.route(`${origin}/app/offline`, (route) =>
      route.request().isNavigationRequest() ? route.continue() : route.abort("internetdisconnected"),
    );
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#offline");
    await page.waitForFunction(() => location.pathname === "/app/offline" && document.documentElement.dataset.ready === "yes");
    expect(documents).toEqual([`${origin}/app/offline`]);
    expect(await fallbacks(page)).toEqual([{ reason: "network", url: "/app/offline", column: "old" }]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a page that does not answer in time loads as a document instead of staying pending`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await recordFallbacks(page);
    await open(page, "/app/old?timeout=300");
    const documents = trackDocuments(page);
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url() === `${origin}/app/slow` && !request.isNavigationRequest(),
    });
    await page.click("#slow");
    await page.waitForFunction(() => location.pathname === "/app/slow" && document.documentElement.dataset.ready === "yes");
    expect((await aborted).failure()?.errorText).toMatch(/abort|cancel/i);
    expect(documents).toEqual([`${origin}/app/slow`]);
    expect(await fallbacks(page)).toEqual([{ reason: "timeout", url: "/app/slow", column: "old" }]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a swap takes the arriving page's description and reports no fallback`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await recordFallbacks(page);
    await open(page, "/app/old?timeout=5000");
    await page.click("#B");
    await page.waitForFunction(() => document.title === "B");
    expect(
      await page.locator('meta[name="description"]').evaluateAll((metas) => metas.map((meta) => meta.getAttribute("content"))),
    ).toEqual(["About B"]);
    expect(await fallbacks(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a rejected body stops downloading before the document load asks again`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    const fetchEnded = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url() === `${origin}/app/non-html-stream` && !request.isNavigationRequest(),
    });
    // The document response is held below: waiting for navigation here would deadlock its release.
    await page.click("#non-html-stream", { noWaitAfter: true });
    expect((await fetchEnded).failure()?.errorText).toMatch(/abort|cancel/i);
    streamDocument.resolve();
    await page.waitForFunction(() => location.pathname === "/app/non-html-stream" && document.documentElement.dataset.ready === "yes");
    expect(documents).toEqual([`${origin}/app/non-html-stream`]);
  } finally {
    streamDocument.resolve();
    await context.close();
  }
});

test(`${browserName}: evaluation failure leaves the old column mounted until the document load`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    // beforeunload runs when the document navigation starts: record the column the page still shows then.
    await page.evaluate(() =>
      window.addEventListener("beforeunload", () => {
        const column = [document.querySelector("main h1")?.textContent, document.querySelector("main [data-mounted]")?.textContent];
        sessionStorage.setItem("column-at-unload", JSON.stringify(column));
      }),
    );
    const documents = trackDocuments(page);
    await page.click("#throw");
    await page.waitForFunction(() => location.pathname === "/app/throw" && document.documentElement.dataset.ready === "yes");
    expect(await page.evaluate(() => sessionStorage.getItem("column-at-unload"))).toBe(JSON.stringify(["old", "old"]));
    expect(documents).toEqual([`${origin}/app/throw`]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a Solid handler prevents the page swap`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.click("#prevented");
    // Events arrive in order: once B's swap is done, a request for the prevented link would have been seen.
    await page.click("#B");
    await page.waitForFunction(() => document.querySelector("main [data-mounted]")?.textContent === "B");
    expect(requests).toEqual([`${origin}/app/B`]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: success focuses and announces; Back swaps the previous page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    const before = await page.evaluate(() => history.length);
    await page.click("#new");
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]")?.textContent === "new");
    expect(await page.title()).toBe("new");
    expect(await page.evaluate(() => document.activeElement === document.querySelector("main h1"))).toBe(true);
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    expect(await page.locator("main [data-mounted]").textContent()).toBe("new");
    expect(documents).toEqual([]);
    await page.goBack();
    await page.waitForFunction(
      () =>
        location.pathname === "/app/old" &&
        document.documentElement.dataset.ready === "yes" &&
        document.querySelector("main [data-mounted]")?.textContent === "old",
    );
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a same-page hash link after a swap stays native`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    await page.click("#new");
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]")?.textContent === "new");
    await page.evaluate(() => {
      Object.assign(window, { __alive: true });
      document
        .querySelector("main")!
        .insertAdjacentHTML("beforeend", '<a id="toc" href="#later">Later</a><div style="height:2000px"></div><p id="later">Later</p>');
    });
    const documents = trackDocuments(page);
    await page.click("#toc");
    expect(await page.evaluate(() => location.hash)).toBe("#later");
    expect(await page.evaluate(() => "__alive" in window && window.__alive)).toBe(true);
    expect(await page.locator("main [data-mounted]").textContent()).toBe("new");
    expect(documents).toEqual([]);
    await page.goBack();
    expect(page.url()).toBe(`${origin}/app/new`);
    expect(await page.evaluate(() => "__alive" in window && window.__alive)).toBe(true);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back across an island push after a reload swaps the right page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    await page.click("#new");
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]")?.textContent === "new");
    await page.evaluate(() => history.pushState(null, "", "/app/new?tab=2"));
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "yes" && document.querySelector("main [data-mounted]")?.textContent === "new",
    );
    const documents = trackDocuments(page);
    await page.evaluate(() => history.go(-2));
    await page.waitForFunction(
      () =>
        location.pathname === "/app/old" &&
        document.documentElement.dataset.ready === "yes" &&
        document.querySelector("main [data-mounted]")?.textContent === "old",
    );
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a relative URL in the swapped column resolves against the new page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    frames.length = 0;
    await page.click("#sub-nested");
    await page.waitForFunction(() => document.querySelector("main iframe") !== null);
    expect(page.url()).toBe(`${origin}/app/sub/nested`);
    // An iframe navigates on insertion: inserted before the history commit, it would load /app/frame.html.
    await page.frameLocator("main iframe").locator("title").waitFor({ state: "attached" });
    expect(frames).toEqual(["/app/sub/frame.html"]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back after reloading a swapped page swaps the previous page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    await page.click("#new");
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]")?.textContent === "new");
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "yes" && document.querySelector("main [data-mounted]")?.textContent === "new",
    );
    const documents = trackDocuments(page);
    await page.goBack();
    await page.waitForFunction(
      () =>
        location.pathname === "/app/old" &&
        document.documentElement.dataset.ready === "yes" &&
        document.querySelector("main [data-mounted]")?.textContent === "old",
    );
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back onto a URL with a hash after a swap swaps that page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page, "/app/old#section");
    await page.click("#new");
    await page.waitForFunction(() => document.querySelector("[data-nav-announcer]")?.textContent === "new");
    const documents = trackDocuments(page);
    await page.goBack();
    // Replacing the same URL with a hash would only scroll and keep the swapped column.
    await page.waitForFunction(
      () =>
        location.hash === "#section" &&
        document.documentElement.dataset.ready === "yes" &&
        document.querySelector("main [data-mounted]")?.textContent === "old",
    );
    // The request carries no fragment; location.hash above shows the URL kept it.
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: post-commit signal observes mounted, focused and announced columns, never a fallback`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.addEventListener("ssr:nav-swapped", (event) => {
        if (!(event instanceof CustomEvent)) throw new Error("Missing swap detail");
        const rows = JSON.parse(sessionStorage.getItem("swap-signals") ?? "[]");
        rows.push({
          title: document.title,
          mounted: event.detail.root.querySelector("[data-mounted]")?.textContent,
          root: event.detail.root === document.querySelector("[data-nav-root]"),
          focused: document.activeElement === event.detail.root.querySelector("h1"),
          announced: document.querySelector("[data-nav-announcer]")?.textContent,
        });
        sessionStorage.setItem("swap-signals", JSON.stringify(rows));
      });
    });
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#B");
    await page.waitForFunction(() => document.title === "B");
    await page.click("#swap-replace");
    await page.waitForFunction(() => document.title === "new");
    await page.goBack();
    await page.waitForFunction(() => document.title === "old");
    const expected = ["B", "new", "old"].map((title) => ({ title, mounted: title, root: true, focused: true, announced: title }));
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("swap-signals") ?? "[]"))).toEqual(expected);
    expect(documents).toEqual([]);
    await page.click("#non-html");
    await page.waitForFunction(() => location.pathname === "/app/non-html" && document.documentElement.dataset.ready === "yes");
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("swap-signals") ?? "[]"))).toEqual(expected);
    expect(documents).toEqual([`${origin}/app/non-html`]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a throwing swap listener reports an error without loading a document`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const documents = trackDocuments(page);
    await page.evaluate(() =>
      window.addEventListener("ssr:nav-swapped", () => {
        throw new Error("fixture swap listener");
      }),
    );
    await page.click("#B");
    await page.waitForFunction(() => document.title === "B");
    expect(errors).toEqual(["fixture swap listener"]);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: 50 swaps keep window and document listeners, the head and the shell at their first size`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const ids = new WeakMap<object, number>();
      let next = 0;
      const id = (value: object) => {
        if (!ids.has(value)) ids.set(value, ++next);
        return ids.get(value);
      };
      const active = new Set<string>();
      const key = (target: EventTarget, type: string, listener: object, options?: boolean | EventListenerOptions) =>
        `${target === window ? "window" : "document"}:${type}:${id(listener)}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if ((this === window || this === document) && listener && !(typeof options === "object" && options?.once))
          active.add(key(this, type, listener, options));
        return add.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function (type, listener, options) {
        if ((this === window || this === document) && listener) active.delete(key(this, type, listener, options));
        return remove.call(this, type, listener, options);
      };
      // Every history write, nav's own included: nav keeps the prototype methods it finds at install.
      const writes: number[] = [];
      for (const name of ["pushState", "replaceState"] as const) {
        const original = History.prototype[name];
        History.prototype[name] = function (...args: Parameters<History["pushState"]>) {
          writes.push(performance.now());
          return original.apply(this, args);
        };
      }
      Object.assign(window, {
        historyWrites: () => writes.length,
        recentHistoryWrites: () => writes.filter((time) => performance.now() - time < 10_000).length,
        footprint: () => ({
          listeners: active.size,
          head: document.head.children.length,
          announcers: document.querySelectorAll("[data-nav-announcer]").length,
          islands: document.querySelectorAll("solid-island").length,
          mounted: document.querySelectorAll("[data-mounted]").length,
        }),
      });
    });
    await recordFallbacks(page);
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await open(page);
    const documents = trackDocuments(page);
    const footprint = () => page.evaluate(() => (window as unknown as { footprint: () => Record<string, number> }).footprint());
    let step = 0;
    const historyWrites = () => page.evaluate(() => (window as unknown as { historyWrites: () => number }).historyWrites());
    const swap = async (label: string) => {
      step++;
      // This test measures leaks, not the browser's history budget (WebKit: 100 writes per 10 s, see the
      // history-limit test): stay below it, paced by the writes that really happened.
      await page.waitForFunction(() => (window as unknown as { recentHistoryWrites: () => number }).recentHistoryWrites() < 40, undefined, {
        timeout: 15_000,
      });
      const before = await historyWrites();
      await page.click(`#${label}`);
      await page.waitForFunction((value) => document.querySelector("main [data-mounted]")?.textContent === value, label);
      // A swap writes history exactly once, so fast navigation spends the browser's budget as slowly as possible.
      expect({ step, writes: (await historyWrites()) - before }).toEqual({ step, writes: 1 });
      // Name the step and the reason at once: a document load anywhere in 52 swaps breaks the contract.
      if (documents.length > 0)
        expect({ step, label, documents, fallbacks: await fallbacks(page), consoleErrors }).toEqual({
          step,
          label,
          documents: [],
          fallbacks: [],
          consoleErrors: [],
        });
    };
    // One round trip first: the first swap preloads the shared modules once.
    await swap("B");
    await swap("new");
    const first = await footprint();
    for (let round = 0; round < 25; round++) {
      await swap("B");
      await swap("new");
    }
    expect(await footprint()).toEqual(first);
    expect(first).toMatchObject({ announcers: 1, islands: 2, mounted: 1 });
    expect({ documents, fallbacks: await fallbacks(page) }).toEqual({ documents: [], fallbacks: [] });
  } finally {
    await context.close();
  }
});

test(`${browserName}: focus goes to the first heading a person can see, not to one hidden by CSS`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#hidden-heading");
    await page.waitForFunction(() => document.querySelector("main [data-mounted]")?.textContent === "hidden-heading");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("visible-heading");
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

/** Opens a page whose history writes can be dropped on demand, as a throttling browser does. */
const dropHistoryWrites = (page: Page) =>
  page.addInitScript(() => {
    for (const name of ["pushState", "replaceState"] as const) {
      const original = History.prototype[name];
      History.prototype[name] = function (...args: Parameters<History["pushState"]>) {
        if ((window as unknown as { dropHistory?: boolean }).dropHistory) return;
        return original.apply(this, args);
      };
    }
  });

test(`${browserName}: a history write the browser drops loads the document and reports history-limit`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await dropHistoryWrites(page);
    await recordFallbacks(page);
    await open(page);
    const documents = trackDocuments(page);
    await page.evaluate(() => Object.assign(window, { dropHistory: true }));
    await page.click("#B");
    await page.waitForFunction(() => location.pathname === "/app/B" && document.documentElement.dataset.ready === "yes");
    expect(documents).toEqual([`${origin}/app/B`]);
    expect(await fallbacks(page)).toEqual([{ reason: "history-limit", url: "/app/B", column: "old" }]);
  } finally {
    await context.close();
  }
});

test.if(browserName === "webkit")(
  `${browserName}: past WebKit's history budget a swap loads the document and reports history-limit`,
  async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await recordFallbacks(page);
      await open(page);
      const documents = trackDocuments(page);
      // Spend the budget with raw writes until WebKit refuses one.
      const refusedAt = await page.evaluate(() => {
        for (let index = 0; index < 1_000; index++) {
          try {
            History.prototype.replaceState.call(history, history.state, "", `#spent-${index}`);
          } catch {
            return index;
          }
        }
        return -1;
      });
      expect(refusedAt).toBeGreaterThan(0);
      await page.click("#B");
      await page.waitForFunction(() => location.pathname === "/app/B" && document.documentElement.dataset.ready === "yes");
      expect(documents).toEqual([`${origin}/app/B`]);
      expect(await fallbacks(page)).toEqual([{ reason: "history-limit", url: "/app/B", column: "old" }]);
    } finally {
      await context.close();
    }
  },
);
