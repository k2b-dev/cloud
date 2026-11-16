import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJSON } from "seroval";
import { launchBrowser } from "../../../ui/test/browser";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { TYPED_INPUT_SCRIPT } from "../../src/typed-fields";
import { makeTempRoot } from "../temp-root";

setDefaultTimeout(30_000);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let formId: string;
let nameId: string;

// Each island records what its fields hear: the value and the number of input and change events.
const recorder = `
const record = (name, kind, value) => {
  const data = document.documentElement.dataset;
  if (value !== undefined) data[name] = value;
  data[name + kind] = String(Number(data[name + kind] ?? 0) + 1);
};`;

beforeAll(async () => {
  root = makeTempRoot(".ssr-typing-engine-");
  const form = join(root, "Form.island.tsx");
  // The island's own values: a draft or prefill it restores, and a field it may lock.
  writeFileSync(
    form,
    `import { createSignal, onMount } from "solid-js";
    ${recorder}
    export default function Form() {
      const [message, setMessage] = createSignal(window.islandMessage ?? window.serverPrefill ?? "");
      const [search, setSearch] = createSignal("Lager");
      onMount(() => { document.documentElement.dataset.mounted = "yes"; });
      return <form>
        <textarea aria-label="Message" id="message" value={message()} onInput={(e) => { setMessage(e.currentTarget.value); record("message", "Input", e.currentTarget.value); }} onChange={() => record("message", "Change")} />
        <input type="search" aria-label="Search" id="search" value={search()} onInput={(e) => { setSearch(e.currentTarget.value); record("search", "Input", e.currentTarget.value); }} onChange={() => record("search", "Change")} />
        <input type="password" aria-label="Password" id="password" onInput={(e) => record("password", "Input", e.currentTarget.value)} />
        <input type="text" aria-label="Code" id="code" disabled={Boolean(window.lockCode)} onInput={(e) => record("code", "Input", e.currentTarget.value)} />
      </form>;
    }`,
  );
  const name = join(root, "Name.island.tsx");
  writeFileSync(
    name,
    `${recorder}
    export default function Name() {
      return <input type="text" aria-label="Name" id="name" onInput={(e) => record("name", "Input", e.currentTarget.value)} />;
    }`,
  );
  formId = islandIdFromFile(form, root);
  nameId = islandIdFromFile(name, root);
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
      // The server's markup. `prefill` puts text into the textarea as a server would; `note` adds a field the island
      // does not render, before the others.
      const prefill = url.searchParams.get("prefill") ?? "";
      const note = url.searchParams.has("note") ? `<input type="text" aria-label="Note" id="note">` : "";
      const props = JSON.stringify(toJSON({}));
      return new Response(
        `<!doctype html><html><body>
        <solid-island data-id="${formId}" data-props='${props}'><form>${note}<textarea aria-label="Message" id="message">${prefill}</textarea><input type="search" aria-label="Search" id="search" value="Lager"><input type="password" aria-label="Password" id="password"><input type="text" aria-label="Code" id="code"></form></solid-island>
        <solid-island data-id="${nameId}" data-props='${props}'><input type="text" aria-label="Name" id="name"></solid-island>
        <script>${TYPED_INPUT_SCRIPT}</script>
        <script type="module">window.mountIslands = () => Promise.all([import('/_ssr/v1/${formId}.js'), import('/_ssr/v1/${nameId}.js')]);</script>
        </body></html>`,
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

/** Open the page before its islands loaded; `setup` runs then, like a person or a browser acting on the server markup. */
const open = async (query = "", setup: (page: Page) => Promise<void> = async () => {}) => {
  const page = await browser.newPage();
  await page.goto(`${origin}/${query}`);
  await page.waitForFunction(() => typeof (window as unknown as { mountIslands?: unknown }).mountIslands === "function");
  await setup(page);
  await page.evaluate(() => (window as unknown as { mountIslands: () => Promise<unknown> }).mountIslands());
  await page.waitForFunction(() => document.documentElement.dataset.mounted === "yes");
  return page;
};
const state = (page: Page) =>
  page.evaluate(() => {
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value;
    const focused = document.activeElement as HTMLTextAreaElement | null;
    return {
      message: value("message"),
      search: value("search"),
      password: value("password"),
      code: value("code"),
      name: value("name"),
      note: document.getElementById("note") !== null,
      focused: focused?.id,
      selection: focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null,
      heard: { ...document.documentElement.dataset, mounted: undefined },
    };
  });

test("typed text reaches the same field of the new markup once, with focus, selection and change where they belong", async () => {
  const page = await open("?note", async (page) => {
    // A field only the server shows, a password, the search and the name in the second island, then the message.
    await page.focus("#note");
    await page.keyboard.insertText("Notiz");
    await page.focus("#password");
    await page.keyboard.insertText("geheim");
    await page.fill("#search", "Regal");
    await page.focus("#name");
    await page.keyboard.insertText("Lea");
    await page.focus("#message");
    await page.keyboard.insertText("Hallo Gustav");
    // The caret inside the text, with a selection.
    await page.evaluate(() => (document.getElementById("message") as HTMLTextAreaElement).setSelectionRange(0, 5));
  });
  try {
    expect(await state(page)).toEqual({
      message: "Hallo Gustav",
      search: "Regal",
      password: "",
      code: "",
      name: "Lea",
      note: false,
      focused: "message",
      selection: [0, 5],
      heard: {
        mounted: undefined,
        // The focused field hears one input and no change; the others also hear change, as after leaving them.
        message: "Hallo Gustav",
        messageInput: "1",
        search: "Regal",
        searchInput: "1",
        searchChange: "1",
        // The second island gets its own field's text.
        name: "Lea",
        nameInput: "1",
      },
    });
  } finally {
    await page.close();
  }
});

test("a prefilled textarea is not doubled, and emptying a prefilled field keeps it empty", async () => {
  const typed = await open("?prefill=Vorlage", async (page) => {
    await page.evaluate(() => {
      (window as unknown as { serverPrefill: string }).serverPrefill = "Vorlage";
    });
    await page.focus("#message");
    await page.keyboard.press("End");
    await page.keyboard.insertText(" mit Zusatz");
    // The search's server value is deleted.
    await page.fill("#search", "");
  });
  try {
    const result = await state(typed);
    expect([result.message, result.search, result.heard.searchInput]).toEqual(["Vorlage mit Zusatz", "", "1"]);
  } finally {
    await typed.close();
  }
  const emptied = await open("?prefill=Vorlage", async (page) => {
    await page.evaluate(() => {
      (window as unknown as { serverPrefill: string }).serverPrefill = "Vorlage";
    });
    await page.fill("#message", "");
  });
  try {
    const result = await state(emptied);
    expect([result.message, result.heard.message, result.heard.messageInput]).toEqual(["", "", "1"]);
  } finally {
    await emptied.close();
  }
});

test("a draft the island restores stays, and the text typed before follows it", async () => {
  const page = await open("", async (page) => {
    await page.evaluate(() => {
      (window as unknown as { islandMessage: string }).islandMessage = "Gespeicherter Entwurf";
    });
    await page.focus("#message");
    await page.keyboard.insertText("Hallo Gustav");
  });
  try {
    const result = await state(page);
    expect([result.message, result.heard.message, result.selection]).toEqual([
      "Gespeicherter Entwurf\nHallo Gustav",
      "Gespeicherter Entwurf\nHallo Gustav",
      [34, 34],
    ]);
  } finally {
    await page.close();
  }
});

test("a disabled counterpart and a value the browser set by itself take nothing", async () => {
  const page = await open("", async (page) => {
    await page.evaluate(() => {
      (window as unknown as { lockCode: boolean }).lockCode = true;
      // Like form restoration: the value changes without the person's input.
      (document.getElementById("search") as HTMLInputElement).value = "Wiederhergestellt";
    });
    await page.focus("#code");
    await page.keyboard.insertText("4711");
  });
  try {
    const result = await state(page);
    expect([result.code, result.search, result.heard.codeInput, result.heard.searchInput]).toEqual(["", "Lager", undefined, undefined]);
  } finally {
    await page.close();
  }
});

test("islands rendered over untouched fields hear no input", async () => {
  const page = await open();
  try {
    expect((await state(page)).heard).toEqual({ mounted: undefined });
  } finally {
    await page.close();
  }
});
