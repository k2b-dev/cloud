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

// The island's server markup: a message field and a search field, as the page sends them before the island's script runs.
// A note field only the server shows comes first, so the island's fields stand at other places in the new markup.
const markup = `<form><input type="text" aria-label="Note" id="note"><textarea aria-label="Message" id="message"></textarea><input type="search" aria-label="Search" id="search" value="Lager"><input type="password" aria-label="Password" id="password"></form>`;

beforeAll(async () => {
  root = makeTempRoot(".ssr-typing-engine-");
  const island = join(root, "Typing.island.tsx");
  writeFileSync(
    island,
    `import { createSignal, onMount } from "solid-js";
    export default function Typing() {
      const [message, setMessage] = createSignal(window.restoredDraft ?? "");
      const [search, setSearch] = createSignal("Lager");
      onMount(() => { document.documentElement.dataset.mounted = "yes"; });
      const record = (name, value) => {
        document.documentElement.dataset[name] = value;
        document.documentElement.dataset[name + "Events"] = String(Number(document.documentElement.dataset[name + "Events"] ?? 0) + 1);
      };
      return <form>
        <textarea aria-label="Message" id="message" value={message()} onInput={(event) => { setMessage(event.currentTarget.value); record("message", event.currentTarget.value); }} />
        <input type="search" aria-label="Search" id="search" value={search()} onInput={(event) => { setSearch(event.currentTarget.value); record("search", event.currentTarget.value); }} />
        <input type="password" aria-label="Password" id="password" onInput={(event) => record("password", event.currentTarget.value)} />
      </form>;
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

const mountIsland = async (page: Awaited<ReturnType<Browser["newPage"]>>) => {
  await page.evaluate(() => (window as unknown as { mountIsland: () => Promise<unknown> }).mountIsland());
  await page.waitForFunction(() => document.documentElement.dataset.mounted === "yes");
};

test("text typed into the server markup before the island renders stays in the field and reaches the island", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof (window as unknown as { mountIsland?: unknown }).mountIsland === "function");
    // The person types right after the page appeared, before the island's script ran: a note the island drops, the
    // message, and a password.
    await page.focus("#note");
    await page.keyboard.insertText("Notiz");
    await page.focus("#password");
    await page.keyboard.insertText("geheim");
    await page.focus("#message");
    await page.keyboard.insertText("Hallo Gustav");
    await mountIsland(page);
    expect(
      await page.evaluate(() => ({
        field: (document.getElementById("message") as HTMLTextAreaElement).value,
        island: document.documentElement.dataset.message,
        // One input event for the field the island controls, not one from the framework and one from a value effect.
        events: document.documentElement.dataset.messageEvents,
        // The untouched search field keeps the island's own value and reports nothing.
        search: (document.getElementById("search") as HTMLInputElement).value,
        searchEvents: document.documentElement.dataset.search,
        // A password never moves, and the dropped note is gone without landing in another field.
        password: (document.getElementById("password") as HTMLInputElement).value,
        passwordEvents: document.documentElement.dataset.password,
        note: document.getElementById("note"),
      })),
    ).toEqual({
      field: "Hallo Gustav",
      island: "Hallo Gustav",
      events: "1",
      search: "Lager",
      searchEvents: undefined,
      password: "",
      passwordEvents: undefined,
      note: null,
    });
  } finally {
    await page.close();
  }
});

test("a draft the island restores stays, and the text typed before follows it", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof (window as unknown as { mountIsland?: unknown }).mountIsland === "function");
    await page.evaluate(() => {
      (window as unknown as { restoredDraft: string }).restoredDraft = "Gespeicherter Entwurf";
    });
    await page.focus("#message");
    await page.keyboard.insertText("Hallo Gustav");
    await mountIsland(page);
    expect(await page.evaluate(() => (document.getElementById("message") as HTMLTextAreaElement).value)).toBe(
      "Gespeicherter Entwurf\nHallo Gustav",
    );
    expect(await page.evaluate(() => document.documentElement.dataset.message)).toBe("Gespeicherter Entwurf\nHallo Gustav");
  } finally {
    await page.close();
  }
});

test("an island rendered over untouched fields reports no input", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => typeof (window as unknown as { mountIsland?: unknown }).mountIsland === "function");
    await mountIsland(page);
    expect(await page.evaluate(() => [document.documentElement.dataset.message, document.documentElement.dataset.search])).toEqual([
      undefined,
      undefined,
    ]);
  } finally {
    await page.close();
  }
});
