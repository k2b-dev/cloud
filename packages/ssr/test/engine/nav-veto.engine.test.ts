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
let shellId: string;
let columnId: string;
let heldB: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
let receivedB: ReturnType<typeof Promise.withResolvers<void>>;
const swaps = new Map<string, number>();
const wrapper = (id: string, label: string) =>
  `<solid-island data-id="${id}" data-props='${JSON.stringify(toJSON({ label }))}'></solid-island>`;
const html = (label: string) => `<!doctype html><html><head><title>${label}</title></head><body>
  <div data-nav-shell="veto" data-nav-scope="/app">${wrapper(shellId, "shell")}
  <main data-nav-root><h1>${label}</h1>${wrapper(columnId, label)}</main></div>
  <script type="module" data-ssr-assets="/_ssr/v1">
    await import('/_ssr/v1/${shellId}.js'); await import('/_ssr/v1/${columnId}.js');
  </script></body></html>`;
const response = (label: string) => new Response(html(label), { headers: { "content-type": "text/html" } });
beforeAll(async () => {
  root = makeTempRoot(".ssr-veto-engine-");
  const nav = JSON.stringify(resolve(import.meta.dir, "../../src/nav.ts"));
  const dialog = JSON.stringify(resolve(import.meta.dir, "../../../ui/src/feedback/dialog-core.ts"));
  const shell = join(root, "Shell.island.tsx");
  const column = join(root, "Column.island.tsx");
  writeFileSync(
    shell,
    `import { onMount, onCleanup } from "solid-js";
    import { installPageSwap, swapPage, onBeforeLeave, listenPopState } from ${nav};
    // Loaded before nav installs, as a shared chunk would be: dialog-core then hides its own Back from nav.
    import { dialogCore } from ${dialog};
    window.dialogCore = dialogCore;
    const count = key => { const d = document.documentElement.dataset; d[key] = String(Number(d[key] ?? 0) + 1); };
    export default function Shell() {
      onBeforeLeave(event => { count("shellChecks"); event.preventDefault(); });
      onMount(() => {
        // This listener observes the browser's rollback, before nav absorbs it from application listeners.
        const observed = () => { count("observedPops"); const d = document.documentElement.dataset; d.observedPaths = (d.observedPaths ? d.observedPaths + " " : "") + location.pathname; };
        window.addEventListener("popstate", observed, true);
        onCleanup(() => window.removeEventListener("popstate", observed, true));
        onCleanup(installPageSwap());
        onCleanup(listenPopState(() => count("helperPops")));
        const raw = () => count("rawPops");
        const claimed = () => count("claimedPops");
        window.addEventListener("popstate", raw);
        window.addEventListener("ssr:nav-popstate", claimed);
        onCleanup(() => { window.removeEventListener("popstate", raw); window.removeEventListener("ssr:nav-popstate", claimed); });
        document.documentElement.dataset.ready = "yes";
      });
      return <nav><a id="A" href="/app/A">A</a><a id="B" href="/app/B">B</a><a id="C" href="/app/C">C</a>
        <button id="swapB" onClick={() => void swapPage('/app/B').then(() => count("swapDone"))}>Swap B</button></nav>;
    }`,
  );
  writeFileSync(
    column,
    `import { createSignal, onMount } from "solid-js";
    import { onBeforeLeave } from ${nav};
    const count = key => { const d = document.documentElement.dataset; d[key] = String(Number(d[key] ?? 0) + 1); };
    export default function Column(props) {
      const [value, setValue] = createSignal(0);
      onBeforeLeave(event => {
        count("checks" + props.label);
        const d = document.documentElement.dataset;
        d.lastUrl = event.url.href; d.lastDelta = String(event.delta);
        if (d.dirty === "yes" || d.throw === "yes") event.preventDefault();
        if (d.throw === "yes") throw new Error("broken leave check");
        if (d.dirty === "yes" && d.prompt === "yes")
          void event.restored.then(() => window.dialogCore.open(() => <p>Discard?</p>, { history: true, ariaLabel: "Discard" }));
        if (d.pushInCheck === "yes") {
          event.preventDefault();
          history.pushState(null, "", location.href);
        }
        if (d.replaceInCheck === "yes") {
          event.preventDefault();
          history.replaceState({ ...history.state, draft: 1 }, "");
        }
        if (d.dirty === "yes" && d.replaceAfterCheck === "yes") queueMicrotask(() => {
          history.replaceState({ ...history.state, draft: 1 }, "");
          d.replacedPath = location.pathname;
        });
      });
      onMount(() => onBeforeLeave(() => count("laterChecks")));
      return <section><b data-state>{props.label}:{value()}</b><button id="edit" onClick={() => setValue(value() + 1)}>Edit</button>
        <button id="dialog" onClick={() => void window.dialogCore.open(() => <p>Transient dialog</p>, { history: true, ariaLabel: "History dialog" })}>Dialog</button></section>;
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
      if (!/^\/app\/[ABC]$/.test(url.pathname)) return new Response("missing", { status: 404 });
      if (request.headers.get("sec-fetch-dest") !== "document") {
        swaps.set(url.pathname, (swaps.get(url.pathname) ?? 0) + 1);
        if (heldB && url.pathname === "/app/B") {
          receivedB.resolve();
          return heldB.promise;
        }
      }
      return response(url.pathname.slice(-1));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await launchBrowser();
}, 30_000);
beforeEach(() => {
  swaps.clear();
  heldB = undefined;
  receivedB = Promise.withResolvers<void>();
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    heldB?.resolve(response("B"));
    try {
      await server?.stop(true);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
});
const column = (page: Page, label: string, value = 0) =>
  page.waitForFunction(
    ({ label, value }) =>
      document.documentElement.dataset.ready === "yes" &&
      location.pathname === `/app/${label}` &&
      document.querySelector("main h1")?.textContent === label &&
      document.querySelector("[data-state]")?.textContent === `${label}:${value}`,
    { label, value },
  );
const open = async (page: Page) => {
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/app/A`);
  await column(page, "A");
};
const dirty = (page: Page, value = true) =>
  page.evaluate((value) => {
    document.documentElement.dataset.dirty = value ? "yes" : "no";
  }, value);
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
      throw new Error("missing marker");
    return { page: entry.page, position: entry.position };
  });
const counts = (page: Page) =>
  page.evaluate(() => ({
    helper: Number(document.documentElement.dataset.helperPops ?? 0),
    raw: Number(document.documentElement.dataset.rawPops ?? 0),
    claimed: Number(document.documentElement.dataset.claimedPops ?? 0),
    shell: Number(document.documentElement.dataset.shellChecks ?? 0),
  }));
const trackDocuments = (page: Page) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });
  return documents;
};
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const rollback = (page: Page, label: string, position: number, observed: number) =>
  page.waitForFunction(
    ({ label, position, observed }) =>
      Number(document.documentElement.dataset.observedPops ?? 0) >= observed &&
      location.pathname === `/app/${label}` &&
      history.state?.["@k2b/ssr/nav"]?.position === position,
    { label, position, observed },
  );
const inPage = async (run: (page: Page) => Promise<void>) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await open(page);
    await run(page);
  } finally {
    heldB?.resolve(response("B"));
    await context.close();
  }
};

test.each(["click", "swapPage"])(`${browserName}: vetoed %s leaves URL, history, column, and requests untouched`, async (kind) => {
  await inPage(async (page) => {
    const documents = trackDocuments(page);
    await page.click("#edit");
    await dirty(page);
    const before = await marker(page);
    const length = await page.evaluate(() => history.length);
    await page.click(kind === "click" ? "#B" : "#swapB");
    await page.waitForFunction(
      (kind) => document.documentElement.dataset.checksA === "1" && (kind === "click" || document.documentElement.dataset.swapDone === "1"),
      kind,
    );
    await frames(page);
    await column(page, "A", 1);
    expect(await marker(page)).toEqual(before);
    expect(await page.evaluate(() => history.length)).toBe(length);
    expect([...swaps]).toEqual([]);
    expect(documents).toEqual([]);
    expect((await counts(page)).shell).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.laterChecks)).toBeUndefined();
  });
});

test(`${browserName}: vetoed Back restores B's entry and hides both pops; a second Back can leave`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    await page.click("#edit");
    await dirty(page);
    const before = await marker(page);
    const documents = trackDocuments(page);
    const listeners = await counts(page);
    await page.evaluate(() => history.back());
    await rollback(page, "B", before.position, 2);
    await column(page, "B", 1);
    expect(await marker(page)).toEqual(before);
    expect(await counts(page)).toEqual(listeners);
    expect([...swaps]).toEqual([["/app/B", 1]]);
    expect(await page.evaluate(() => document.documentElement.dataset.lastDelta)).toBe("-1");
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "A");
    expect(swaps.get("/app/A")).toBe(1);
    expect(documents).toEqual([]);
  });
});

test(`${browserName}: vetoed Forward restores A's entry and hides both pops; a second Forward can leave`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    await page.evaluate(() => history.back());
    await column(page, "A");
    await dirty(page);
    const before = await marker(page);
    const listeners = await counts(page);
    const documents = trackDocuments(page);
    await page.evaluate(() => history.forward());
    await rollback(page, "A", before.position, 3);
    await column(page, "A");
    expect(await marker(page)).toEqual(before);
    expect(await counts(page)).toEqual(listeners);
    expect(swaps.get("/app/B")).toBe(1);
    expect(await page.evaluate(() => document.documentElement.dataset.lastDelta)).toBe("1");
    await dirty(page, false);
    await page.evaluate(() => history.forward());
    await column(page, "B");
    expect(swaps.get("/app/B")).toBe(2);
    expect(documents).toEqual([]);
  });
});

test(`${browserName}: disposed A checks never run on B, and shell checks never run`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    expect(await page.evaluate(() => document.documentElement.dataset.checksA)).toBe("1");
    await dirty(page);
    await page.click("#C");
    await page.waitForFunction(() => document.documentElement.dataset.checksB === "1");
    expect(await page.evaluate(() => document.documentElement.dataset.checksA)).toBe("1");
    await dirty(page, false);
    await page.click("#C");
    await column(page, "C");
    expect(await page.evaluate(() => document.documentElement.dataset.checksA)).toBe("1");
    expect((await counts(page)).shell).toBe(0);
  });
});

test(`${browserName}: a throwing check allows the swap and reports its error`, async () => {
  await inPage(async (page) => {
    const reported = page.waitForEvent("pageerror");
    await page.evaluate(() => {
      document.documentElement.dataset.throw = "yes";
    });
    await page.click("#B");
    await column(page, "B");
    await page.waitForFunction(() => document.documentElement.dataset.laterChecks === "1");
    expect((await reported).message).toContain("broken leave check");
    expect(swaps.get("/app/B")).toBe(1);
  });
});

test(`${browserName}: rapid Back-Back rolls back to C and keeps the next Back's position in sync`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const b = await marker(page);
    await page.click("#C");
    await column(page, "C");
    await dirty(page);
    const c = await marker(page);
    const listeners = await counts(page);
    const documents = trackDocuments(page);
    await page.evaluate(() => {
      document.documentElement.dataset.observedPaths = "";
      history.back();
      history.back();
    });
    await rollback(page, "C", c.position, 2);
    await frames(page);
    // Chromium runs the second Back before the rollback (nav absorbs the arrival on A); WebKit drops it.
    expect(["/app/B /app/A /app/C", "/app/B /app/C"]).toContain(
      await page.evaluate(() => document.documentElement.dataset.observedPaths ?? ""),
    );
    await column(page, "C");
    expect(await marker(page)).toEqual(c);
    expect(await counts(page)).toEqual(listeners);
    expect([...swaps]).toEqual([
      ["/app/B", 1],
      ["/app/C", 1],
    ]);
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "B");
    expect(await marker(page)).toEqual(b);
    expect(
      await page.evaluate(() => !window.navigation || history.state?.["@k2b/ssr/nav"]?.position === window.navigation.currentEntry?.index),
    ).toBe(true);
    expect(documents).toEqual([]);
  });
});

test(`${browserName}: vetoed Back aborts a held swap and its late response never commits`, async () => {
  await inPage(async (page) => {
    await page.click("#C");
    await column(page, "C");
    const c = await marker(page);
    heldB = Promise.withResolvers<Response>();
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url() === `${origin}/app/B` });
    await page.click("#swapB");
    await receivedB.promise;
    await dirty(page);
    const listeners = await counts(page);
    const documents = trackDocuments(page);
    await page.evaluate(() => history.back());
    await rollback(page, "C", c.position, 2);
    expect((await aborted).failure()?.errorText).toMatch(/abort|cancel/i);
    heldB.resolve(response("B"));
    await page.waitForFunction(() => document.documentElement.dataset.swapDone === "1");
    await frames(page);
    await column(page, "C");
    expect(await marker(page)).toEqual(c);
    expect(await counts(page)).toEqual(listeners);
    expect(documents).toEqual([]);
    expect([...swaps]).toEqual([
      ["/app/C", 1],
      ["/app/B", 1],
    ]);
  });
});

test(`${browserName}: after a dialog closed with its own Back, a vetoed Back rolls back to the page entry`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const before = await marker(page);
    await page.click("#dialog");
    await page.locator("dialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (position) => !document.querySelector("dialog[open]") && history.state?.["@k2b/ssr/nav"]?.position === position,
      before.position,
    );
    await dirty(page);
    const observed = await page.evaluate(() => Number(document.documentElement.dataset.observedPops ?? 0));
    await page.evaluate(() => history.back());
    await rollback(page, "B", before.position, observed + 2);
    await column(page, "B");
    expect(await marker(page)).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.dataset.lastDelta)).toBe("-1");
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "A");
  });
});

test(`${browserName}: a check that opens a history dialog after event.restored`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const before = await marker(page);
    const index = await page.evaluate(() => window.navigation?.currentEntry?.index);
    const documents = trackDocuments(page);
    await dirty(page);
    await page.evaluate(() => {
      document.documentElement.dataset.prompt = "yes";
      history.back();
    });
    await page.locator("dialog[open]").waitFor();
    await column(page, "B");
    expect(await page.evaluate(() => window.navigation?.currentEntry?.index)).toBe(index === undefined ? undefined : index + 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (position) => !document.querySelector("dialog[open]") && history.state?.["@k2b/ssr/nav"]?.position === position,
      before.position,
    );
    await column(page, "B");
    expect(await marker(page)).toEqual(before);
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "A");
    expect(documents).toEqual([]);
  });
});

test(`${browserName}: a check that writes history synchronously during Back loads the document`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const documents = trackDocuments(page);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.evaluate(() => {
      document.documentElement.dataset.pushInCheck = "yes";
    });
    const loaded = page.waitForEvent("load");
    await page.evaluate(() => history.back());
    await loaded;
    await column(page, "A");
    expect(documents).toEqual([`${origin}/app/A`]);
    expect(errors.some((message) => message.includes("A leave check wrote history"))).toBe(true);
  });
});

test(`${browserName}: a check that replaces state at the same URL during Back loads the document`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const documents = trackDocuments(page);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.evaluate(() => {
      document.documentElement.dataset.replaceInCheck = "yes";
    });
    const loaded = page.waitForEvent("load");
    await page.evaluate(() => history.back());
    await loaded;
    await column(page, "A");
    expect(documents).toEqual([`${origin}/app/A`]);
    expect(errors.some((message) => message.includes("A leave check wrote history"))).toBe(true);
  });
});

test(`${browserName}: a same-URL replace before rollback leaves the next Back cross-page`, async () => {
  await inPage(async (page) => {
    await page.click("#B");
    await column(page, "B");
    const before = await marker(page);
    const documents = trackDocuments(page);
    await dirty(page);
    await page.evaluate(() => {
      document.documentElement.dataset.replaceAfterCheck = "yes";
      history.back();
    });
    await rollback(page, "B", before.position, 2);
    await column(page, "B");
    expect(await page.evaluate(() => document.documentElement.dataset.replacedPath)).toBe("/app/A");
    expect(await marker(page)).toEqual(before);
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "A");
    expect(swaps.get("/app/A")).toBe(1);
    expect(await page.evaluate(() => history.state.draft)).toBe(1);
    expect(documents).toEqual([]);
  });
});

test(`${browserName}: veto survives the 50-entry history cap`, async () => {
  await inPage(async (page) => {
    // Chromium keeps 50 entries; WebKit allows at most 100 history writes per 10 s, and nav writes two per push.
    const pushes = browserName === "chromium" ? 60 : 30;
    await page.evaluate((pushes) => {
      for (let n = 1; n <= pushes; n++) history.pushState({}, "", "/app/A?i=" + n);
    }, pushes);
    await page.click("#B");
    await column(page, "B");
    const before = await marker(page);
    // Eviction shifted the Navigation API index below nav's position: the two coordinate systems differ here.
    if (browserName === "chromium") expect(await page.evaluate(() => window.navigation.currentEntry?.index)).toBeLessThan(before.position);
    const documents = trackDocuments(page);
    await dirty(page);
    await page.evaluate(() => history.back());
    await rollback(page, "B", before.position, 2);
    await column(page, "B");
    expect(await marker(page)).toEqual(before);
    expect(documents).toEqual([]);
    await dirty(page, false);
    await page.evaluate(() => history.back());
    await column(page, "A");
    expect(new URL(page.url()).search).toBe(`?i=${pushes}`);
    expect(documents).toEqual([]);
  });
});
