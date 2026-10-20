import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
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
let railId: string;
let columnId: string;
const swaps = new Map<string, number>();
const wrapper = (id: string, props: { label?: string; tab?: string } = {}) =>
  `<solid-island data-id="${id}" data-props='${JSON.stringify(toJSON(props))}'></solid-island>`;
const html = (url: URL) => {
  const label = url.pathname.endsWith("/B") ? "B" : "A";
  return `<!doctype html><html><head><title>${label}</title><link rel="stylesheet" href="/base.css"></head><body class="k2b-ui">
    <div data-nav-shell="history" data-nav-scope="/app">${wrapper(railId)}
    <main data-nav-root><h1>${label}</h1>${wrapper(columnId, { label, tab: url.searchParams.get("tab") ?? "0" })}</main></div>
    <script type="module" data-ssr-assets="/_ssr/v1">
      await import('/_ssr/v1/${railId}.js');
      await import('/_ssr/v1/${columnId}.js');
    </script></body></html>`;
};
beforeAll(async () => {
  root = makeTempRoot(".ssr-history-engine-");
  const nav = JSON.stringify(resolve(import.meta.dir, "../../src/nav.ts"));
  const dialog = JSON.stringify(resolve(import.meta.dir, "../../../ui/src/feedback/dialog-core.ts"));
  const rail = join(root, "Rail.island.tsx");
  const column = join(root, "Column.island.tsx");
  writeFileSync(
    rail,
    `import { onMount, onCleanup } from "solid-js";
    import { installPageSwap } from ${nav};
    export default function Rail() {
      onMount(() => { onCleanup(installPageSwap()); document.documentElement.dataset.ready = "yes"; });
      return <nav data-rail><a id="A" href="/app/A">A</a><a id="B" href="/app/B">B</a></nav>;
    }`,
  );
  writeFileSync(
    column,
    `import { createSignal, onMount, onCleanup } from "solid-js";
    import { listenPopState } from ${nav};
    import { dialogCore } from ${dialog};
    export default function Column(props) {
      const [tab, setTab] = createSignal(props.tab);
      const showUrl = () => setTab(new URL(location.href).searchParams.get("tab") ?? "0");
      const count = key => { document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key] ?? 0) + 1); };
      const push = value => { history.pushState(null, "", '/app/' + props.label + '?tab=' + value); showUrl(); };
      onMount(() => {
        onCleanup(listenPopState(() => { count("helperPops"); showUrl(); }));
        const raw = () => count("rawPops");
        window.addEventListener("popstate", raw);
        onCleanup(() => window.removeEventListener("popstate", raw));
      });
      return <section>
        <b data-state>{props.label}:{tab()}</b>
        <button id="tab1" onClick={() => push('1')}>Tab 1</button>
        <button id="tab2" onClick={() => push('2')}>Tab 2</button>
        <button id="replace" onClick={() => { history.replaceState({}, "", '/app/' + props.label + '?tab=3'); showUrl(); }}>Replace</button>
        <button id="dialog" onClick={() => void dialogCore.open(() => <p>Transient dialog</p>, { history: true, ariaLabel: "History dialog" })}>Dialog</button>
        <div data-scroll-preserve="column" style="height:100px;overflow:auto"><div style="height:1400px">{props.label} region</div></div>
      </section>;
    }`,
  );
  railId = islandIdFromFile(rail, root);
  columnId = islandIdFromFile(column, root);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: join(root, "_ssr"), dev: false, verbose: false });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/base.css")
        return new Response("body{min-height:4000px}main{min-height:3500px}", { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/_ssr/v1/")) {
        const file = Bun.file(join(root, "_ssr", url.pathname.split("/").at(-1)!));
        return (await file.exists())
          ? new Response(file, { headers: { "content-type": "text/javascript" } })
          : new Response("missing", { status: 404 });
      }
      if (!url.pathname.startsWith("/app/")) return new Response("missing", { status: 404 });
      if (request.headers.get("sec-fetch-dest") !== "document") {
        const path = url.pathname + url.search;
        swaps.set(path, (swaps.get(path) ?? 0) + 1);
      }
      return new Response(html(url), { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, 30_000);
beforeEach(() => swaps.clear());
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
const column = (page: Page, label: string, tab = "0") =>
  page.waitForFunction(
    ({ label, tab }) =>
      document.documentElement.dataset.ready === "yes" &&
      document.querySelector("main h1")?.textContent === label &&
      document.querySelector("main [data-state]")?.textContent === `${label}:${tab}`,
    { label, tab },
  );
const open = async (page: Page) => {
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/app/A`);
  await column(page, "A");
};
const trackDocuments = (page: Page) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });
  return documents;
};
const state = (page: Page) =>
  page.evaluate(() => ({
    h1: document.querySelector("main h1")?.textContent,
    island: document.querySelector("main [data-state]")?.textContent,
  }));
const marker = (page: Page) =>
  page.evaluate(() => {
    const entry: unknown = history.state?.["@k2b/ssr/nav"];
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("page" in entry) ||
      typeof entry.page !== "string" ||
      !("position" in entry) ||
      typeof entry.position !== "number"
    )
      throw new Error("missing page marker");
    return { page: entry.page, position: entry.position };
  });

test(`${browserName}: Back swaps fresh server HTML and preserves the sibling island`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.locator("[data-rail]").evaluate((element) => element.setAttribute("data-identity", "kept"));
    await page.click("#B");
    await column(page, "B");
    expect(swaps.get("/app/B")).toBe(1);
    await page.goBack();
    await column(page, "A");
    expect(swaps.get("/app/A")).toBe(1);
    expect(documents).toEqual([]);
    expect(await page.locator("[data-rail]").getAttribute("data-identity")).toBe("kept");
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back and Forward cross island entries and pages with reload-equivalent content`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    const visited = new Map<string, Awaited<ReturnType<typeof state>>>();
    const visit = async (label: string, tab = "0") => {
      await column(page, label, tab);
      visited.set(page.url(), await state(page));
    };
    await visit("A");
    await page.click("#tab1");
    await visit("A", "1");
    await page.click("#tab2");
    await visit("A", "2");
    await page.click("#B");
    await visit("B");
    expect([...swaps]).toEqual([["/app/B", 1]]);
    await page.goBack();
    await visit("A", "2");
    expect([...swaps]).toEqual([
      ["/app/B", 1],
      ["/app/A?tab=2", 1],
    ]);
    await page.goBack();
    await visit("A", "1");
    await page.goBack();
    await visit("A");
    await page.goForward();
    await visit("A", "1");
    await page.goForward();
    await visit("A", "2");
    expect([...swaps]).toEqual([
      ["/app/B", 1],
      ["/app/A?tab=2", 1],
    ]);
    await page.goForward();
    await visit("B");
    expect([...swaps]).toEqual([
      ["/app/B", 2],
      ["/app/A?tab=2", 1],
    ]);
    expect(documents).toEqual([]);
    // Reload the actual visited entries after checking the uninterrupted traversal sequence.
    const entries = [...visited].reverse();
    for (const [index, [url, expected]] of entries.entries()) {
      expect(page.url()).toBe(url);
      await page.reload();
      await column(page, expected.h1!, expected.island!.slice(2));
      expect(await state(page)).toEqual(expected);
      const next = entries[index + 1]?.[1];
      if (next) {
        await page.goBack();
        await column(page, next.h1!, next.island!.slice(2));
      }
    }
  } finally {
    await context.close();
  }
});

test(`${browserName}: disposed dialog entries stay closed through Back and Forward`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#dialog");
    await page.locator("dialog[open]").waitFor();
    // Native modal inertness prevents a physical click on the rail. The same link swap runs on disposal.
    await page.locator("#B").evaluate((element) => element instanceof HTMLElement && element.click());
    await column(page, "B");
    expect(await page.locator("dialog").count()).toBe(0);
    await page.evaluate(() => {
      const observer = new MutationObserver((records) => {
        if (
          records.some((record) =>
            [...record.addedNodes].some((node) => node instanceof Element && (node.matches("dialog") || node.querySelector("dialog"))),
          )
        ) {
          document.documentElement.dataset.staleDialog = "yes";
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await page.goBack();
    await column(page, "A");
    // Both entries have the same URL and DOM; wait for the arriving history position.
    const position = (await marker(page)).position;
    await page.goBack();
    await page.waitForFunction((position) => history.state?.["@k2b/ssr/nav"]?.position === position, position - 1);
    await column(page, "A");
    await page.goForward();
    await page.waitForFunction((position) => history.state?.["@k2b/ssr/nav"]?.position === position, position);
    await column(page, "A");
    await page.goForward();
    await column(page, "B");
    expect(await page.locator("dialog").count()).toBe(0);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.staleDialog)).toBeUndefined();
    expect([...swaps]).toEqual([
      ["/app/B", 2],
      ["/app/A", 1],
    ]);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: raw island push and replace inherit page identity and session positions`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const initial = await marker(page);
    await page.click("#tab1");
    await column(page, "A", "1");
    expect(await marker(page)).toEqual({ page: initial.page, position: initial.position + 1 });
    await page.click("#replace");
    await column(page, "A", "3");
    expect(await marker(page)).toEqual({ page: initial.page, position: initial.position + 1 });
    await page.click("#B");
    await column(page, "B");
    const b = await marker(page);
    expect(b.page).not.toBe(initial.page);
    expect(b.position).toBe(initial.position + 2);
    await page.click("#tab1");
    await column(page, "B", "1");
    expect(await marker(page)).toEqual({ page: b.page, position: b.position + 1 });
  } finally {
    await context.close();
  }
});

test(`${browserName}: island popstate listeners see only traversals within the shown page`, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.click("#B");
    await column(page, "B");
    await page.click("#A");
    await column(page, "A");
    await page.click("#tab1");
    await column(page, "A", "1");
    await page.click("#tab2");
    await column(page, "A", "2");
    await page.goBack();
    await column(page, "A", "1");
    expect(await page.evaluate(() => [document.documentElement.dataset.helperPops, document.documentElement.dataset.rawPops])).toEqual([
      "1",
      "1",
    ]);
    await page.goBack();
    await column(page, "A");
    expect(await page.evaluate(() => [document.documentElement.dataset.helperPops, document.documentElement.dataset.rawPops])).toEqual([
      "2",
      "2",
    ]);
    await page.goBack();
    await column(page, "B");
    // Both listeners of the departing A island must stay silent on the cross-page Back.
    expect(await page.evaluate(() => [document.documentElement.dataset.helperPops, document.documentElement.dataset.rawPops])).toEqual([
      "2",
      "2",
    ]);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});

test(`${browserName}: Back and Forward restore each entry's window and keyed column scroll`, async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  try {
    const page = await context.newPage();
    await open(page);
    const documents = trackDocuments(page);
    await page.evaluate(() => {
      window.scrollTo(0, 620);
      document.querySelector<HTMLElement>('[data-scroll-preserve="column"]')!.scrollTop = 180;
    });
    await page.waitForFunction(() => scrollY === 620);
    // A programmatic link activation keeps the departure scroll untouched by Playwright's scroll-into-view.
    await page.locator("#B").evaluate((element) => element instanceof HTMLElement && element.click());
    await column(page, "B");
    await page.evaluate(() => {
      window.scrollTo(0, 930);
      document.querySelector<HTMLElement>('[data-scroll-preserve="column"]')!.scrollTop = 410;
    });
    await page.waitForFunction(() => scrollY === 930);
    await page.goBack();
    await column(page, "A");
    await page.waitForFunction(
      () => scrollY === 620 && document.querySelector<HTMLElement>('[data-scroll-preserve="column"]')?.scrollTop === 180,
    );
    await page.goForward();
    await column(page, "B");
    await page.waitForFunction(
      () => scrollY === 930 && document.querySelector<HTMLElement>('[data-scroll-preserve="column"]')?.scrollTop === 410,
    );
    expect([...swaps]).toEqual([
      ["/app/B", 2],
      ["/app/A", 1],
    ]);
    expect(documents).toEqual([]);
  } finally {
    await context.close();
  }
});
