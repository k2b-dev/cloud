import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toJSON } from "seroval";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let shellId: string;
let columnId: string;
const wrapper = (id: string, label: string) =>
  `<solid-island data-id="${id}" data-props='${JSON.stringify(toJSON({ label }))}'></solid-island>`;
const html = (label: string) => `<!doctype html><html><head><title>${label}</title></head><body>
  <div data-nav-shell="unsaved" data-nav-scope="/app">${wrapper(shellId, "shell")}
  <main data-nav-root><h1>${label}</h1>${wrapper(columnId, label)}</main></div>
  <script type="module" data-ssr-assets="/_ssr/v1">
    await import('/_ssr/v1/${shellId}.js'); await import('/_ssr/v1/${columnId}.js');
  </script></body></html>`;
beforeAll(async () => {
  root = makeTempRoot(".ssr-unsaved-engine-");
  const nav = JSON.stringify(resolve(import.meta.dir, "../../src/nav.ts"));
  const shell = join(root, "Shell.island.tsx");
  const column = join(root, "Column.island.tsx");
  writeFileSync(
    shell,
    `import { onMount, onCleanup } from "solid-js";
    import { installPageSwap } from ${nav};
    export default function Shell() {
      onMount(() => {
        onCleanup(installPageSwap());
        document.documentElement.dataset.ready = "yes";
      });
      return <nav><a id="A" href="/app/A">A</a><a id="B" href="/app/B">B</a><a id="fail" href="/app/fail">fail</a>
        <a id="other" href="/other">other</a></nav>;
    }`,
  );
  writeFileSync(
    column,
    `import { protectUnsavedInput } from ${nav};
    export default function Column(props) {
      const d = document.documentElement.dataset;
      protectUnsavedInput({
        dirty: () => d.dirty === "yes",
        confirm: (url) => {
          d.asked = String(Number(d.asked ?? 0) + 1);
          d.askedFor = url.pathname;
          return new Promise((resolve) => setTimeout(() => resolve(d.answer === "yes"), 10));
        },
      });
      return <b data-mounted>{props.label}</b>;
    }`,
  );
  shellId = islandIdFromFile(shell, root);
  columnId = islandIdFromFile(column, root);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: join(root, "_ssr"), dev: false, verbose: false });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/v1/")) {
        const file = Bun.file(join(root, "_ssr", url.pathname.split("/").at(-1)!));
        return (await file.exists())
          ? new Response(file, { headers: { "content-type": "text/javascript" } })
          : new Response("missing", { status: 404 });
      }
      const document = request.headers.get("sec-fetch-dest") === "document";
      if (url.pathname === "/app/fail" && !document) return new Response("broken", { status: 500 });
      const label = url.pathname.split("/").at(-1)!;
      return new Response(html(label), { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.stop(true);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
});

const open = async (page: Page, path = "/app/A") => {
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}${path}`);
  await page.waitForFunction(
    (label) => document.documentElement.dataset.ready === "yes" && document.querySelector("main b")?.textContent === label,
    path.split("/").at(-1),
  );
  // Registered after the column's guard, so it sees whether the guard asked the browser to stay.
  await page.evaluate(() =>
    window.addEventListener("beforeunload", (event) => sessionStorage.setItem("unload", event.defaultPrevented ? "asked" : "free")),
  );
};
const trackDocuments = (page: Page) => {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) urls.push(new URL(request.url()).pathname);
  });
  return urls;
};
const set = (page: Page, values: Record<string, string>) =>
  page.evaluate((entries) => Object.assign(document.documentElement.dataset, entries), values);
const data = (page: Page) => page.evaluate(() => ({ ...document.documentElement.dataset }));
const shows = (page: Page, label: string) =>
  page.waitForFunction((value) => location.pathname === `/app/${value}` && document.querySelector("main b")?.textContent === value, label);

test(`${browserName}: a declined question keeps the page and its input; nothing is fetched`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    const fetched: string[] = [];
    page.on("request", (request) => fetched.push(new URL(request.url()).pathname));
    await set(page, { dirty: "yes", answer: "no" });
    await page.click("#B");
    await page.waitForFunction(() => document.documentElement.dataset.asked === "1");
    // The answer arrives asynchronously; the page must still be the same afterwards.
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => location.pathname)).toBe("/app/A");
    expect((await data(page)).askedFor).toBe("/app/B");
    expect(fetched).toEqual([]);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a confirmed click swaps once without a document load`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await set(page, { dirty: "yes", answer: "yes" });
    await page.click("#B");
    await shows(page, "B");
    expect((await data(page)).asked).toBe("1");
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back asks first and, when confirmed, swaps the previous page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#B");
    await shows(page, "B");
    await set(page, { dirty: "yes", answer: "yes" });
    await page.evaluate(() => history.back());
    await shows(page, "A");
    expect(await data(page)).toMatchObject({ asked: "1", askedFor: "/app/A" });
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Forward asks first and, when confirmed, swaps the next page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#B");
    await shows(page, "B");
    await page.evaluate(() => history.back());
    await shows(page, "A");
    await set(page, { dirty: "yes", answer: "yes" });
    await page.evaluate(() => history.forward());
    await shows(page, "B");
    expect(await data(page)).toMatchObject({ asked: "1", askedFor: "/app/B" });
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back that is declined returns to the page with its input`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    await page.click("#B");
    await shows(page, "B");
    await set(page, { dirty: "yes", answer: "no" });
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.documentElement.dataset.asked === "1");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => [location.pathname, document.querySelector("main b")?.textContent])).toEqual(["/app/B", "B"]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: a document load with unsaved input asks the browser, as before page swaps`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await open(page);
    await set(page, { dirty: "yes" });
    await page.click("#other");
    await page.waitForFunction(() => location.pathname === "/other");
    expect(await page.evaluate(() => sessionStorage.getItem("unload"))).toBe("asked");
  } finally {
    await context.close();
  }
});

test(`${browserName}: a confirmed swap that falls back to a document load does not ask twice`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    await open(page);
    const documents = trackDocuments(page);
    await set(page, { dirty: "yes", answer: "yes" });
    await page.click("#fail");
    await page.waitForFunction(() => location.pathname === "/app/fail" && document.documentElement.dataset.ready === "yes");
    expect(await page.evaluate(() => sessionStorage.getItem("unload"))).toBe("free");
    expect(documents).toEqual(["/app/fail"]);
  } finally {
    await context.close();
  }
});
