import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJSON } from "seroval";
import { launchBrowser } from "../../../ui/test/browser";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let islandId: string;

// The island's server markup, as the page sends it before the island's script runs.
const markup = `<section><h2>Chart</h2><div class="chart" tabindex="0" id="target">Values</div><button id="other">Other</button></section>`;

beforeAll(async () => {
  root = makeTempRoot(".ssr-focus-engine-");
  const island = join(root, "Focus.island.tsx");
  writeFileSync(
    island,
    `import { onMount } from "solid-js";
    export default function Focus() {
      onMount(() => { document.documentElement.dataset.mounted = "yes"; });
      const count = () => { document.documentElement.dataset.focusins = String(Number(document.documentElement.dataset.focusins ?? 0) + 1); };
      return <section><h2>Chart</h2><div class="chart" tabindex="0" id="target" data-client="yes" onFocusIn={count}>Values</div><button id="other">Other</button></section>;
    }`,
  );
  islandId = islandIdFromFile(island, root);
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
      // The island loads only when the test calls mountIsland(), like a script that runs late on a slow device.
      return new Response(
        `<!doctype html><html><body><solid-island data-id="${islandId}" data-props='${JSON.stringify(toJSON({}))}'>${markup}</solid-island>
        <script type="module">window.mountIsland = () => import('/_ssr/v1/${islandId}.js');</script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
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

test("focus taken on the server markup moves to the same element when the island renders", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof (window as unknown as { mountIsland?: unknown }).mountIsland === "function");
    // A keyboard user (or a fast test) focuses the server element before the island's script ran.
    await page.focus("#target");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("target");
    await page.evaluate(() => (window as unknown as { mountIsland: () => Promise<unknown> }).mountIsland());
    await page.waitForFunction(() => document.documentElement.dataset.mounted === "yes");
    // The focused element is the island's own, and its focus listeners heard the focus.
    expect(
      await page.evaluate(() => ({
        id: document.activeElement?.id,
        client: (document.activeElement as HTMLElement | null)?.dataset.client,
        focusins: document.documentElement.dataset.focusins,
      })),
    ).toEqual({ id: "target", client: "yes", focusins: "1" });
  } finally {
    await page.close();
  }
});

test("an island that renders without focus inside leaves the focus where it is", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof (window as unknown as { mountIsland?: unknown }).mountIsland === "function");
    await page.evaluate(() => (window as unknown as { mountIsland: () => Promise<unknown> }).mountIsland());
    await page.waitForFunction(() => document.documentElement.dataset.mounted === "yes");
    expect(await page.evaluate(() => [document.activeElement === document.body, document.documentElement.dataset.focusins])).toEqual([
      true,
      undefined,
    ]);
  } finally {
    await page.close();
  }
});
