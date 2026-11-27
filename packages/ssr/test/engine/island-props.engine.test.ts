import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../ui/test/browser";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { transform } from "../../src/transform";
import { makeTempRoot } from "../temp-root";

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let page = "";

// Text that would end the props comment, start markup, or break a JavaScript string if the server wrote it unescaped.
const hostile = [
  "--><img src=x onerror=globalThis.pwned=1>",
  "--!><script>globalThis.pwned=1</script>",
  "<!--<!-- inner --><img src=x>",
  "</script><img src=x onerror=globalThis.pwned=1>",
  `"' & &amp; &lt; >`,
  "line\u2028paragraph\u2029end",
];

beforeAll(async () => {
  root = makeTempRoot(".ssr-props-engine-");
  const island = join(root, "Probe.island.tsx");
  writeFileSync(
    island,
    `export default function Probe(props) {
      if (typeof document !== "undefined") document.documentElement.dataset.received = JSON.stringify({ hostile: props.hostile, at: props.at.toISOString(), map: [...props.map] });
      return "mounted";
    }`,
  );
  const id = islandIdFromFile(island, root);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: join(root, "_ssr"), dev: false, verbose: false });
  // The server page, rendered through the real SSR transform as an application renders it.
  const source = join(root, "Page.tsx");
  const output = await transform(
    `import Probe from "./Probe.island";
    import Later from "./Later.client";
    export default () => <main><Probe hostile={${JSON.stringify(hostile)}} at={new Date("2026-10-01T12:34:56Z")} map={new Map([["k", "v"]])} /><Later note="-->" /></main>;`,
    source,
    "ssr",
    false,
    root,
  );
  writeFileSync(join(root, "Page.js"), output);
  const { default: Page } = await import(join(root, "Page.js"));
  page = `<!doctype html><html><body>${renderToString(() => Page())}<script type="module">import('/_ssr/v1/${id}.js');</script></body></html>`;
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
      // `/stripped`: the same page after a proxy or optimizer removed its HTML comments.
      const body = url.pathname === "/stripped" ? page.replace(/<!--[\s\S]*?-->/g, "") : page;
      return new Response(body, { headers: { "content-type": "text/html" } });
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

test("a page whose comments a proxy stripped shows the island's error and names the cause", async () => {
  const tab = await browser.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  try {
    await tab.goto(`${origin}/stripped`);
    await tab.waitForSelector("solid-island [role=alert][data-ssr-error]");
    // The island never rendered with missing props: it shows the fallback with Try again instead.
    expect(await tab.evaluate(() => document.documentElement.dataset.received)).toBeUndefined();
    expect(await tab.textContent("solid-island [data-ssr-error] button")).toBe("Try again");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Island props comment missing");
    expect(errors[0]).toContain("strip HTML comments");
  } finally {
    await tab.close();
  }
});

test("props that try to end their comment reach the island as the same data and run nothing", async () => {
  const tab = await browser.newPage();
  try {
    await tab.goto(`${origin}/`);
    await tab.waitForFunction(() => document.documentElement.dataset.received !== undefined);
    const result = await tab.evaluate(() => ({
      received: JSON.parse(document.documentElement.dataset.received ?? "null"),
      pwned: (globalThis as { pwned?: unknown }).pwned,
      // The browser parsed exactly the page's elements: one island, no injected image or script.
      images: document.images.length,
      scripts: document.scripts.length,
      island: document.querySelector("solid-island")?.outerHTML,
      // A client component whose code never loads keeps its props comment, which CSS and text do not see.
      client: document.querySelector("solid-client")?.innerHTML.startsWith("<!--ssr-props:"),
      clientEmpty: document.querySelector("solid-client")?.matches(":empty"),
      clientText: document.querySelector("solid-client")?.textContent,
    }));
    expect(result).toEqual({
      received: { hostile, at: "2026-10-01T12:34:56.000Z", map: [["k", "v"]] },
      pwned: undefined,
      images: 0,
      scripts: 1,
      // The props comment left the island before it rendered.
      island: '<solid-island data-id="' + page.match(/data-id="([^"]+)"/)![1] + '">mounted</solid-island>',
      client: true,
      clientEmpty: true,
      clientText: "",
    });
  } finally {
    await tab.close();
  }
});

test("a props comment changes nothing CSS sees: the next child stays first and a lone comment leaves the wrapper empty", async () => {
  const tab = await browser.newPage();
  try {
    await tab.setContent(
      '<div id="host"><solid-island><!--ssr-props:{}--><b id="first">first</b></solid-island><solid-client><!--ssr-props:{}--></solid-client><i id="next"></i></div>',
    );
    expect(
      await tab.evaluate(() => ({
        first: document.getElementById("first")?.matches(":first-child"),
        empty: document.querySelector("solid-client")?.matches(":empty"),
        // `+` steps from the empty wrapper to its next sibling as it would without the comment.
        adjacent: document.getElementById("next")?.matches("solid-client:empty + i"),
      })),
    ).toEqual({ first: true, empty: true, adjacent: true });
  } finally {
    await tab.close();
  }
});
