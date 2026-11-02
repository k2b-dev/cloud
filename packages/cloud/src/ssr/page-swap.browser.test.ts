import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { buildIslands } from "../../../ssr/src/build";
import { islandIdFromFile } from "../../../ssr/src/island-id";
import { launchBrowser } from "../../../ui/test/browser";

setDefaultTimeout(30_000);
const rootDir = resolve(import.meta.dir, "../..");
// Transform real SSR wrappers with the same root used by buildIslands below.
// Discovery is explicit in beforeAll; importing a page must not start a second build.
const { plugin } = createConfig({ dev: true, rootDir, componentRoots: [] });
Bun.plugin(plugin());
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { session } = await import("../services/session");
const { person } = await import("../_internal/define-app.test-fixture");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { server } = await import("./page-swap.browser-harness");
let browser: Browser;
let served: ReturnType<typeof Bun.serve>;
let output: string;
let origin: string;
let providerRequests = 0;
let fileRequests = 0;
const pending = new Set<ReturnType<typeof Promise.withResolvers<Response>>>();
let pendingStarted = Promise.withResolvers<void>();
const spies: { mockRestore(): void }[] = [];
const releasePending = () => {
  for (const request of pending) request.resolve(new Response("resolved in provider"));
  pending.clear();
};

beforeAll(async () => {
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue({
      ...defaultRailPreferences(),
      shortcuts: [
        { id: "a", kind: "link", title: "Page A", href: "/app/fixture/A", icon: "ti ti-box" },
        { id: "b", kind: "link", title: "Page B", href: "/app/fixture/B", icon: "ti ti-box" },
      ],
    }),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    spyOn(help, "getLayoutHelp").mockReturnValue({
      baseLocale: "en",
      locale: "en",
      manifestHash: "fixture",
      pageBase: "/help/apps/fixture",
      documents: ["A", "B", "order"].map((page) => ({
        id: `help-${page.toLowerCase()}`,
        title: `Help ${page}`,
        description: "Help",
        order: 0,
        url: `/help/${page}`,
        searchUrl: "/help/search",
      })),
    }),
    spyOn(session, "getToken").mockImplementation((c) => (c.req.path.endsWith("/protected-login") ? null : "fixture")),
    spyOn(session, "appSessionFallback").mockReturnValue(null),
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user: person,
      data: { userId: person.id, sid: "fixture", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
    }),
  );
  output = mkdtempSync(join(tmpdir(), "cloud-page-swap-"));
  await buildIslands({
    pattern: "**/*.{island,client}.tsx",
    cwd: rootDir,
    componentRoots: [resolve(import.meta.dir, "page-swap-fixture"), resolve(rootDir, "src")],
    outdir: output,
    dev: false,
    verbose: false,
  });
  const styles = await Bun.build({ entrypoints: [resolve(rootDir, "../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile page swap fixture styles");
  const css = await styles.outputs[0]!.text();
  const shellEntry = `${islandIdFromFile(resolve(import.meta.dir, "ShellRuntime.island.tsx"), rootDir)}.js`;
  served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.css") return new Response(css, { headers: { "content-type": "text/css" } });
      // The shipped loader asks for <prefix>/<entry>.js; every prefix serves this one build.
      if (url.pathname.startsWith("/_ssr/")) {
        const name = url.pathname.split("/").at(-1)!;
        // The shell entry arrives last, so only the loader's order can put nav before the column islands.
        if (name === shellEntry) await Bun.sleep(400);
        const file = Bun.file(join(output, name));
        return (await file.exists())
          ? new Response(file, { headers: { "content-type": "text/javascript" } })
          : new Response("missing", { status: 404 });
      }
      if (url.pathname === "/fixture/pending") {
        const held = Promise.withResolvers<Response>();
        pending.add(held);
        request.signal.addEventListener(
          "abort",
          () => {
            pending.delete(held);
            held.resolve(new Response("aborted"));
          },
          { once: true },
        );
        pendingStarted.resolve();
        return held.promise;
      }
      if (url.pathname === "/app/provider/panel" && request.headers.get("sec-fetch-dest") === "iframe") providerRequests++;
      if (url.pathname === "/app/fixture/file") fileRequests++;
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      // Keep the shipped island loader (it orders shell before column islands); drop the other module scripts.
      let html = (await response.text())
        .replace(/<script type="module"(?![^>]*data-ssr-assets)[^>]*>[\s\S]*?<\/script>/g, "")
        .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, "")
        .replace("</head>", '<link rel="stylesheet" href="/fixture.css"></head>');
      if (request.headers.get("cookie")?.includes("fixture_build=2"))
        html = html.replace(/data-nav-shell="[^"]*"/, 'data-nav-shell="changed-build"');
      return new Response(html, { status: response.status, headers: response.headers });
    },
  });
  origin = `http://127.0.0.1:${served.port}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  releasePending();
  try {
    await browser?.close();
  } finally {
    try {
      await served?.stop(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
      if (output) rmSync(output, { recursive: true, force: true });
    }
  }
});

const column = (page: Page, name: string) =>
  page.waitForFunction(
    (name) =>
      // Set by the column island once it mounted; the server-rendered output alone does not prove that.
      document.documentElement.dataset.columnMounted === name &&
      document.querySelector("output[data-column-mounted]")?.textContent === name &&
      // ShellRuntime installed the swap: nav's live region exists.
      document.querySelector("[data-nav-announcer]") !== null,
    name,
  );
const trackDocuments = (page: Page) => {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(new URL(request.url()).pathname);
  });
  return documents;
};
async function fixture(width = 1440, path = "/app/fixture/A") {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC", reducedMotion: "reduce" });
  await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}${path}`);
  await column(page, path.split("/").at(-1) ?? "A");
  const documents = trackDocuments(page);
  return {
    context,
    page,
    documents,
    errors,
    close: async () => {
      releasePending();
      await context.close();
      expect(errors).toEqual([]);
    },
  };
}
const swapTo = async (page: Page, name: string) => {
  await page.locator(`#to-${name}`).click();
  await column(page, name);
};
/** Proves the opt-in swaps before a test checks what must stay a document load. */
const swapOnce = async (f: { page: Page; documents: string[] }) => {
  await swapTo(f.page, "B");
  expect(f.documents).toEqual([]);
};
const panelReady = (page: Page) => page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "ready");

// The twenty-swap test exercises a real provider document, not an iframe-shaped mock.
test("20 regular/fullPage swaps keep the slot, provider, draft, pending work and context", async () => {
  pendingStarted = Promise.withResolvers<void>();
  const f = await fixture();
  try {
    let providerNavigations = 0;
    f.page.on("request", (request) => {
      if (request.isNavigationRequest() && new URL(request.url()).pathname === "/app/provider/panel") providerNavigations++;
    });
    const before = providerRequests;
    await f.page.keyboard.press("Control+j");
    await panelReady(f.page);
    const provider = f.page.frameLocator("#cloud-panel iframe");
    await provider.locator("html[data-provider-mounted=true]").waitFor();
    await pendingStarted.promise;
    await provider.getByRole("textbox", { name: "Provider draft" }).fill("Unsent provider draft");
    const initial = await f.page.evaluate(() => {
      const slot = document.getElementById("cloud-panel");
      const frame = slot?.querySelector("iframe");
      if (!slot || !frame?.contentWindow) throw new Error("Provider missing");
      Reflect.set(window, "fixtureSlot", slot);
      Reflect.set(window, "fixtureProviderDocument", frame.contentDocument);
      Reflect.set(frame, "fixtureIdentity", "kept");
      return {
        token: Reflect.get(frame.contentWindow, "fixtureProviderToken"),
        context: JSON.parse(frame.contentDocument?.getElementById("provider-context")?.textContent ?? "null"),
      };
    });
    let seq = initial.context.seq;
    for (let index = 0; index < 20; index++) {
      const name = index % 2 === 0 ? "B" : "A";
      await swapTo(f.page, name);
      await f.page.waitForFunction((name) => {
        const frame = document.querySelector<HTMLIFrameElement>("#cloud-panel iframe");
        return (
          JSON.parse(frame?.contentDocument?.getElementById("provider-context")?.textContent ?? "null")?.help?.[0] ===
          `help-${name.toLowerCase()}`
        );
      }, name);
      const state = await f.page.evaluate(() => {
        const slot = document.getElementById("cloud-panel");
        const frame = slot?.querySelector("iframe");
        if (!frame?.contentWindow) throw new Error("Provider missing");
        return {
          sameSlot: slot === Reflect.get(window, "fixtureSlot"),
          frame: Reflect.get(frame, "fixtureIdentity"),
          token: Reflect.get(frame.contentWindow, "fixtureProviderToken"),
          sameDocument: frame.contentDocument === Reflect.get(window, "fixtureProviderDocument"),
          context: JSON.parse(frame.contentDocument?.getElementById("provider-context")?.textContent ?? "null"),
        };
      });
      // Document identity is stable; WebKit may round timing values differently between reads.
      expect(state).toMatchObject({ sameSlot: true, sameDocument: true, frame: "kept", token: initial.token });
      expect(state.context).toMatchObject({
        app: "fixture",
        help: [`help-${name.toLowerCase()}`],
        scope: { type: "fixture.page", id: name },
        pageId: initial.context.pageId,
      });
      expect(state.context.seq).toBeGreaterThan(seq);
      seq = state.context.seq;
    }
    releasePending();
    await provider.getByText("resolved in provider", { exact: true }).waitFor();
    expect(await provider.getByRole("textbox", { name: "Provider draft" }).inputValue()).toBe("Unsent provider draft");
    expect(providerRequests - before).toBe(1);
    expect(providerNavigations).toBe(1);
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});

test("rail, phone bar, title and trail follow swaps and Back/Forward", async () => {
  const f = await fixture(390);
  try {
    const check = async (name: string) => {
      await column(f.page, name);
      expect(await f.page.locator(`.layout-rail .rail-item[href='/app/fixture/${name}'][aria-current=page]`).count()).toBe(1);
      expect(await f.page.locator(`.cloud-tab-bar a[href='/app/fixture/${name}'][aria-current=page]`).count()).toBe(1);
      const title = name === "B" ? "Full page B" : "Regular page A";
      expect(await f.page.title()).toBe(title);
      expect(await f.page.locator("script[data-k2b-page-trail]").textContent()).toContain(title);
      expect(await f.page.locator(".layout-page-head").innerText()).toContain(title);
    };
    await swapTo(f.page, "B");
    await check("B");
    await f.page.goBack();
    await check("A");
    await f.page.goForward();
    await check("B");
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});

/** The shell's rectangles; a swapped page must lay out exactly as a reload of it. */
const shellGeometry = (page: Page) =>
  page.evaluate(() =>
    [
      ".cloud-app-canvas",
      ".layout-rail",
      ".layout-shell-content",
      ".layout-page-head",
      "main.layout-content-main",
      "#cloud-panel",
      ".cloud-tab-bar",
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const { x, y, width, height } = element.getBoundingClientRect();
      return [selector, element.checkVisibility(), x, y, width, height];
    }),
  );
for (const width of [390, 1440]) {
  test(`${width}px: a regular and a full page swapped in lay out as their reload`, async () => {
    const f = await fixture(width);
    try {
      const settle = () => f.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      for (const name of ["B", "A"]) {
        await swapTo(f.page, name);
        await settle();
        const swapped = await shellGeometry(f.page);
        const fresh = await f.context.newPage();
        try {
          await fresh.goto(`${origin}/app/fixture/${name}`);
          await column(fresh, name);
          await fresh.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          expect(swapped).toEqual(await shellGeometry(fresh));
        } finally {
          await fresh.close();
        }
      }
      expect(f.documents).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const [link, destination] of [
  ["focus", "/app/fixture/focus"],
  ["other", "/app/other"],
  ["api", "/api/fixture"],
  ["file", "/app/fixture/file"],
] as const) {
  test(`${link} loads as exactly one document`, async () => {
    const f = await fixture();
    try {
      await swapOnce(f);
      const filesBefore = fileRequests;
      const navigation = f.page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === f.page.mainFrame() && new URL(frame.url()).pathname === destination,
      });
      await f.page.locator(`#to-${link}`).click();
      await navigation;
      expect(f.documents).toEqual([destination]);
      // An in-scope link learns that the target is no page only from the swap fetch, so the server sees it twice;
      // `download` or `data-nav-document` avoids that (url-state-and-navigation.md).
      if (link === "file") expect(fileRequests - filesBefore).toBe(2);
    } finally {
      await f.close();
    }
  });
}

test("downloads stay native and GET forms load a document", async () => {
  const f = await fixture();
  try {
    await swapOnce(f);
    const download = f.page.waitForEvent("download");
    await f.page.locator("#to-download").click();
    expect((await download).suggestedFilename()).toBe("fixture.txt");
    expect(f.documents).toEqual([]);
    await Promise.all([f.page.waitForURL("**/app/fixture/A?query=submitted"), f.page.locator("#submit").click()]);
    await column(f.page, "A");
    expect(f.documents).toEqual(["/app/fixture/A"]);
  } finally {
    await f.close();
  }
});

for (const [name, value] of [
  ["cloud.locale", "de"],
  ["fixture_person", "22222222-2222-4222-8222-222222222222"],
  ["fixture_build", "2"],
] as const) {
  test(`changed ${name} loads one document`, async () => {
    const f = await fixture();
    try {
      await swapOnce(f);
      await f.context.addCookies([{ name, value, url: origin }]);
      await swapTo(f.page, "A");
      expect(f.documents).toEqual(["/app/fixture/A"]);
    } finally {
      await f.close();
    }
  });
}

test("Back and Forward restore the page scroller; a link opens the next page at the top", async () => {
  const f = await fixture();
  try {
    const main = () => f.page.locator("main.layout-content-main").evaluate((element) => element.scrollTop);
    await f.page.locator("main.layout-content-main").evaluate((element) => {
      element.scrollTop = 240;
    });
    // A pointer click would scroll the link into view first.
    await f.page.locator("#to-C").evaluate((link) => {
      if (link instanceof HTMLElement) link.click();
    });
    await column(f.page, "C");
    expect(await main()).toBe(0);
    await f.page.locator("main.layout-content-main").evaluate((element) => {
      element.scrollTop = 120;
    });
    await f.page.goBack();
    await column(f.page, "A");
    await f.page.waitForFunction(() => document.querySelector("main.layout-content-main")?.scrollTop === 240);
    await f.page.goForward();
    await column(f.page, "C");
    await f.page.waitForFunction(() => document.querySelector("main.layout-content-main")?.scrollTop === 120);
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});

test("Alt+Up swaps to the remembered parent, restores main scroll and marks the row", async () => {
  const f = await fixture();
  try {
    await f.page.locator("main.layout-content-main").evaluate((main) => {
      main.scrollTop = 240;
    });
    // A pointer click would scroll the link into view first and change what the tab remembers.
    await f.page.locator("#to-B").evaluate((link) => {
      if (link instanceof HTMLElement) link.click();
    });
    await column(f.page, "B");
    // A page reached by a link starts at the top, as after a document load.
    expect(await f.page.locator("main.layout-content-main").evaluate((main) => main.scrollTop)).toBe(0);
    await f.page.keyboard.press("Alt+ArrowUp");
    await column(f.page, "A");
    await f.page.waitForFunction(
      () =>
        document.querySelector("[data-page-trail-recent]")?.id === "to-B" &&
        document.querySelector("main.layout-content-main")?.scrollTop === 240,
    );
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const destination of ["protected-login", "forbidden", "revoked"]) {
  test(`route policy ${destination} agrees with reload`, async () => {
    const f = await fixture();
    try {
      await swapOnce(f);
      const url = `${origin}/app/fixture/${destination}`;
      await f.page.locator(`#to-${destination}`).click();
      await f.page.waitForFunction(
        () =>
          location.pathname.includes("/auth/login") ||
          document.title.includes("403") ||
          document.querySelector("main")?.textContent?.includes("permission"),
      );
      await f.page.waitForLoadState("load");
      const actual = { title: await f.page.title(), text: await f.page.locator("main").innerText(), path: new URL(f.page.url()).pathname };
      const fresh = await f.context.newPage();
      fresh.on("pageerror", (error) => f.errors.push(error.message));
      await fresh.goto(url);
      await fresh.waitForLoadState("load");
      expect({ title: await fresh.title(), text: await fresh.locator("main").innerText(), path: new URL(fresh.url()).pathname }).toEqual(
        actual,
      );
      expect(f.documents.length).toBe(destination === "protected-login" ? 2 : 1); // The sign-in document follows the HTTP redirect.
    } finally {
      await f.close();
    }
  });
}

test("a phone sheet opened after a swap closes on cross-page Back", async () => {
  const f = await fixture(390);
  try {
    await swapTo(f.page, "B");
    await f.page.locator(".layout-header").getByRole("button", { name: "Open help" }).click();
    await f.page.waitForFunction(() => document.querySelector(".cloud-app-canvas")?.getAttribute("data-panel-sheet") === "open");
    await f.page.goBack();
    await column(f.page, "A");
    expect(await f.page.locator(".cloud-app-canvas").getAttribute("data-panel-sheet")).toBeNull();
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the shipped loader installs nav before column islands write their first entry", async () => {
  // The column island pushes an entry while it mounts, on the first document load, and the shell entry arrives last.
  const f = await fixture(1440, "/app/fixture/order");
  try {
    const fetches: string[] = [];
    f.page.on("request", (request) => {
      if (request.resourceType() === "fetch" && new URL(request.url()).pathname.startsWith("/app/fixture/")) fetches.push(request.url());
    });
    expect(
      await f.page.evaluate(() => [location.search, history.state?.fixtureColumn, typeof history.state?.["@k2b/ssr/nav"]?.page]),
    ).toEqual(["?entry=column", true, "string"]);
    const before = await f.page.evaluate(() => Number(document.documentElement.dataset.rawPops ?? 0));
    // Same page: the island reconciles its own entry; nav neither fetches nor remounts the column.
    await f.page.goBack();
    await f.page.waitForFunction((before) => Number(document.documentElement.dataset.rawPops ?? 0) === before + 1, before);
    expect(await f.page.evaluate(() => location.search)).toBe("");
    // Cross page: nav swaps; the raw listener of the leaving column never sees it.
    await swapTo(f.page, "A");
    const raw = await f.page.evaluate(() => Number(document.documentElement.dataset.rawPops ?? 0));
    await f.page.goBack();
    await column(f.page, "order");
    expect(await f.page.evaluate(() => Number(document.documentElement.dataset.rawPops ?? 0))).toBe(raw);
    expect(fetches).toEqual([`${origin}/app/fixture/A`, `${origin}/app/fixture/order`]);
    expect(f.documents).toEqual([]);
  } finally {
    await f.close();
  }
});
