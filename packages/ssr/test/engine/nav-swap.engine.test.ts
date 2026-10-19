import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
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
const scenarios = ["A", "B", "new", "non-html", "403", "redirect", "signature", "prefix", "deploy", "styles", "throw", "sub/nested"];
/** Paths of frame requests, to see which URL a relative `src` in a swapped column resolved against. */
const frames: string[] = [];
const wrapper = (id: string, label: string) =>
  `<solid-island data-id="${id}" data-props='${JSON.stringify(toJSON({ label }))}'>server ${label}</solid-island>`;
const html = (label: string, options: { signature?: string; prefix?: string; style?: string; entry?: string; extra?: string } = {}) => {
  const prefix = options.prefix ?? `/_ssr/${version}`;
  return `<!doctype html><html><head><title>${label}</title><link rel="stylesheet" href="${options.style ?? "/base.css"}"></head><body>
    <div data-nav-shell="${options.signature ?? "sig"}" data-nav-scope="/app" data-nav-attributes="data-mode" data-mode="${label}">
    ${wrapper(railId, "rail")}<main data-nav-root><h1>${label}</h1>${wrapper(options.entry ?? pageId, label)}${options.extra ?? ""}</main></div>
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
    `import { onMount, onCleanup } from "solid-js";
    import { installPageSwap } from ${JSON.stringify(resolve(import.meta.dir, "../../src/nav.ts"))};
    export default function Rail() {
      onMount(() => { onCleanup(installPageSwap()); document.documentElement.dataset.ready = "yes"; });
      return <nav>${scenarios.map((name) => `<a id="${name.replace("/", "-")}" href="/app/${name}">${name}</a>`).join("")}
      <a id="prevented" href="/app/prevented" onClick={e => e.preventDefault()}>prevented</a></nav>;
    }`,
  );
  const source = `import { onMount, onCleanup } from "solid-js";
    export default function Page(props) {
      onMount(() => { const handler = () => {}; window.addEventListener("resize", handler);
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
      if (request.headers.get("sec-fetch-dest") === "document") return pageResponse(label);
      switch (label) {
        case "A":
          heldA = Promise.withResolvers<Response>();
          receivedA.resolve();
          return heldA.promise;
        case "non-html":
          return new Response("plain", { headers: { "content-type": "text/plain" } });
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
beforeEach(() => {
  version = "v1";
  heldA = undefined;
  receivedA = Promise.withResolvers<void>();
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    heldA?.resolve(pageResponse("A"));
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

test.each(["non-html", "403", "redirect", "signature", "prefix", "deploy", "styles"])(
  `${browserName}: %s makes exactly one requested document navigation`,
  async (scenario) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await open(page);
      const documents = trackDocuments(page);
      await page.click(`a[href="/app/${scenario}"]`);
      await page.waitForFunction(
        (path) => location.pathname === path && document.documentElement.dataset.ready === "yes",
        `/app/${scenario}`,
      );
      expect(documents).toEqual([`${origin}/app/${scenario}`]);
    } finally {
      await context.close();
    }
  },
);

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

test(`${browserName}: success focuses and announces; Back loads the previous document once`, async () => {
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
    expect(documents).toEqual([`${origin}/app/old`]);
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

test(`${browserName}: Back after reloading a swapped page loads the previous page`, async () => {
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
    expect(documents).toEqual([`${origin}/app/old`]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back onto a URL with a hash after a swap loads that page`, async () => {
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
    expect(documents).toEqual([`${origin}/app/old`]);
  } finally {
    await context.close();
  }
});
