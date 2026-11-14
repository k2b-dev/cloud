import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { sidebarSnapshot } from "../frontend/AssistantChatSidebar.fixture";

// The tabs beside the chat are the real Panes of @k2b/ui: arranging, dragging, boundaries, and the hint carry over
// unchanged, and the chat keeps its place and width while tabs change. A real engine lays them out.
const ui = new URL("../../../ui/", import.meta.url).pathname;
/** The reading view's server: an address from the chat reads at once, the other one asks first. */
const reads: Array<{ url: string; confirmed?: boolean }> = [];
const webReader = async (request: Request) => {
  const body = (await request.json()) as { url: string; confirmed?: boolean };
  reads.push(body);
  if (body.url.includes("versicherung") && !body.confirmed) return Response.json({ status: "confirm", url: body.url });
  return Response.json({
    status: "ready",
    url: body.url,
    finalUrl: body.url,
    title: body.url.includes("preise") ? "Preise" : "Versand nach Frankreich",
    description: null,
    markdown:
      "Pakete bis 31,5 kg erreichen Frankreich in zwei bis vier Werktagen. Die Laufzeit gilt ab Übergabe an den Paketdienst.\n\n## Preise\n\nEin Paket bis 5 kg kostet 17,99 €, bis 10 kg 23,99 €. [Alle Preise](https://paketdienst-beispiel.de/preise)\n\n## Zerbrechliche Ware\n\nFür Glas und Keramik empfiehlt der Paketdienst einen doppelwandigen Karton.",
    truncated: false,
    contentAt: new Date().toISOString(),
  });
};
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const shots = process.env.ASSISTANT_SCREENSHOT_DIR;

beforeAll(async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./tabs-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud", import.meta.url).pathname))).default;
  const appCss = await Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] });
  if (!appCss.success) throw new AggregateError(appCss.logs, "Could not compile the Assistant stylesheet.");
  const css = await appCss.outputs[0]!.text();
  const snapshot = sidebarSnapshot({ chatId: "chat01" });
  // Fonts and icons as Cloud serves them, for the screenshots compared with the concept.
  const publicDir = mkdtempSync(resolve(tmpdir(), "assistant-tabs-public-"));
  if (shots) {
    await (await import("../../../core/scripts/font-assets")).buildFontAssets(publicDir);
    await (await import("../../../core/scripts/tabler-assets")).buildTablerIconAssets(publicDir);
  }
  const head = shots ? '<link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css">' : "";
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (url.pathname.startsWith("/public/")) return new Response(Bun.file(resolve(publicDir, url.pathname.slice("/public/".length))));
      if (url.pathname === "/ui.css") return new Response(Bun.file(`${ui}dist/styles.css`));
      if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.endsWith("/files/content"))
        return new Response("Lieferung 4471, voraussichtlich 18.11.2026\nMessinggriff 96 mm: 200\nTopfband 110°: 80\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      if (url.pathname.endsWith("/context")) return Response.json(snapshot);
      if (url.pathname.endsWith("/web-reader")) return webReader(request);
      if (url.pathname.endsWith("/sources")) return Response.json({ sources: snapshot.sources, total: snapshot.sources.length });
      return new Response(
        `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css">${head}<body class="k2b-ui" style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/bundle.js"></script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const openPage = async (width = 1440, path = "/") => {
  const page = await browser.newPage({
    viewport: { width, height: width < 768 ? 780 : 900 },
    isMobile: width < 768,
    hasTouch: width < 768,
  });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL(path, server.url).href);
  await page.locator("#root > *").first().waitFor();
  return { page, errors };
};
const open = (page: Page, name: "report" | "table" | "sources" | "web" | "ask") =>
  page.evaluate((key) => (window as unknown as { open: Record<string, () => void> }).open[key]!(), name);
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const chatBox = (page: Page) =>
  page.evaluate(() => {
    const rect = document.querySelector(".harness-chat")!.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  });

describe(`Tabs beside the chat in ${browserName}`, () => {
  test("Panes carries tabs with grip, Add pane, Arrange and its menu; the chat stays ≥ 360 px behind a shadow edge", async () => {
    const { page, errors } = await openPage();
    try {
      await open(page, "report");
      await open(page, "table");
      await page.locator(".k2b-panes__tab").nth(1).waitFor();
      expect(await page.locator(".k2b-panes__grip").count()).toBeGreaterThan(0);
      expect(await page.locator(".k2b-panes__arrange").count()).toBe(1);
      expect(await page.locator(".k2b-panes__add").count()).toBeGreaterThan(0);
      const chat = await chatBox(page);
      expect(chat.width).toBeGreaterThanOrEqual(360);
      // The boundary to the chat is a shadow, not a line.
      const edge = await page.evaluate(() => {
        const pane = document.querySelector(".artifact-workspace")!.closest("[data-pane-id], .k2b-app-workspace__pane, section, div")!;
        const style = getComputedStyle(pane);
        return { border: style.borderInlineStartWidth };
      });
      expect(edge.border).toBe("0px");
      // Arrange: two panes side by side, with a boundary between them.
      await page.locator(".k2b-panes__arrange").click();
      await page.getByRole("menuitemradio", { name: /Zwei|Two/ }).click();
      await page.locator(".k2b-panes__separator").first().waitFor();
      expect(await page.locator(".k2b-panes__group").count()).toBe(2);
      expect(await chatBox(page)).toEqual(chat);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("switching, opening another, closing one, and the menu “…” never move or resize the chat", async () => {
    const { page } = await openPage();
    try {
      await open(page, "report");
      await open(page, "table");
      await frames(page);
      const before = await chatBox(page);
      await page.getByRole("tab", { name: /Lieferavis/ }).click();
      await frames(page);
      expect(await chatBox(page)).toEqual(before);
      await open(page, "sources");
      await frames(page);
      expect(await chatBox(page)).toEqual(before);
      await page.locator(".artifact-pane__more").first().click();
      await page.getByRole("menuitem", { name: "Andere schließen" }).waitFor();
      expect(await chatBox(page)).toEqual(before);
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: /Quellen/ }).hover();
      await page.getByRole("button", { name: /Quellen schließen/ }).click();
      await frames(page);
      expect(await chatBox(page)).toEqual(before);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("every pane has the same head: title 14/600, meta 12/400, at most two actions and “…” with what Cloud can do", async () => {
    const { page } = await openPage();
    try {
      await open(page, "report");
      const head = page.locator(".artifact-pane__head").first();
      await head.waitFor();
      const type = await head.evaluate((element) => {
        const style = (selector: string) => {
          const node = getComputedStyle(element.querySelector(selector)!);
          return `${Number.parseFloat(node.fontSize)}/${node.fontWeight}`;
        };
        return {
          title: style(".artifact-pane__title"),
          meta: style(".artifact-pane__meta"),
          // Download and "…": at most two actions beside the title.
          actions: Array.from(element.querySelectorAll(".artifact-pane__actions :is(a, button)")).filter(
            (control) => control.getClientRects().length > 0,
          ).length,
        };
      });
      expect(type).toEqual({ title: "14/600", meta: "12/400", actions: 2 });
      await head.locator(".artifact-pane__more").click();
      const labels = await page.getByRole("menuitem").allTextContents();
      for (const label of [
        "Gustav dazu fragen",
        "Link kopieren",
        "Herunterladen",
        "Aus dem Chat löschen",
        "Anheften",
        "Schließen",
        "Andere schließen",
      ])
        expect(labels.some((text) => text.includes(label))).toBe(true);
      await page.getByRole("menuitem", { name: /Gustav dazu fragen/ }).click();
      expect(await page.evaluate(() => (window as unknown as { asked?: string }).asked)).toBe("Lieferavis Kern 11-2026.txt");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("open tabs, their arrangement and the front tab are kept for the chat; the URL names the front tab and wins", async () => {
    const { page } = await openPage();
    try {
      await open(page, "report");
      await open(page, "table");
      await page.getByRole("tab", { name: /Lieferavis/ }).click();
      await page.waitForFunction(() => (window as unknown as { tabs: { stored: unknown } }).tabs.stored !== null);
      await page.waitForTimeout(700);
      const stored = await page.evaluate(
        () => (window as unknown as { tabs: { stored: { state: { tabs: { key: string }[]; front: string } } } }).tabs.stored,
      );
      expect(stored.state.tabs).toHaveLength(2);
      expect(new URL(page.url()).searchParams.get("workspace")).toContain("Lieferavis");
      // Another device: the same chat opens with the same tabs and the same front tab.
      await page.goto(new URL("/", server.url).href);
      await page.getByRole("tab", { name: /Offene Rückfragen/ }).waitFor();
      expect(await page.getByRole("tab", { name: /Lieferavis/ }).getAttribute("aria-selected")).toBe("true");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("on a phone an open thing fills the screen, with “Zum Chat” above the row of tabs; a choice there reaches the URL", async () => {
    const { page } = await openPage(390);
    try {
      await open(page, "report");
      await open(page, "table");
      await page.getByRole("button", { name: "Zum Chat" }).waitFor();
      expect(await page.locator('.k2b-panes[data-narrow="true"]').count()).toBe(1);
      const workspace = (await page.locator(".artifact-workspace").boundingBox())!;
      expect(Math.round(workspace.width)).toBe(390);
      await page.getByRole("tab", { name: /Lieferavis/ }).click();
      await frames(page);
      expect(new URL(page.url()).searchParams.get("workspace")).toContain("Lieferavis");
      await page.getByRole("button", { name: "Zum Chat" }).click();
      await page.locator(".harness-chat").waitFor({ state: "visible" });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a web page from the chat opens as a reading view: content time, no pictures, links stay in the tab; another address asks first", async () => {
    const { page } = await openPage();
    try {
      await open(page, "web");
      const reader = page.locator(".web-reader");
      await reader.getByRole("heading", { name: "Versand nach Frankreich" }).waitFor();
      expect(await reader.locator(".web-reader__mark").textContent()).toContain("Leseansicht");
      expect(await reader.locator(".web-reader__stand").textContent()).toMatch(
        /Stand von heute, \d\d:\d\d · ohne Anmeldung, ohne Skripte, ohne Bilder/,
      );
      expect(await reader.locator("img").count()).toBe(0);
      // The address is shown, not typed.
      expect(await reader.locator("input").count()).toBe(0);
      await reader.getByRole("link", { name: "Alle Preise" }).click();
      await reader.getByRole("heading", { name: "Preise", exact: true }).first().waitFor();
      await reader.getByRole("button", { name: "Zurück" }).click();
      await reader.getByRole("heading", { name: "Versand nach Frankreich" }).waitFor();

      await open(page, "ask");
      const ask = page.locator(".web-reader__ask");
      await ask.getByText("Diese Seite holen?").waitFor();
      expect(await ask.locator("code").textContent()).toBe("https://versicherung-beispiel.de/kunst?wert=2000&ziel=lyon");
      expect(await ask.textContent()).toContain("Darin: wert = 2000 · ziel = lyon");
      expect(reads.at(-1)).toEqual({ url: "https://versicherung-beispiel.de/kunst?wert=2000&ziel=lyon", confirmed: false });
      await ask.getByRole("button", { name: "Seite holen" }).click();
      await page.locator(".web-reader__stand").last().waitFor();
      expect(reads.at(-1)).toEqual({ url: "https://versicherung-beispiel.de/kunst?wert=2000&ziel=lyon", confirmed: true });
    } finally {
      await page.close();
    }
  }, 30_000);

  test.skipIf(!shots)(
    "screenshots of the tabs, light, 1440 and 390",
    async () => {
      for (const [name, width, act] of [
        [
          "tabs-ergebnis",
          1440,
          async (page: Page) => {
            await open(page, "report");
            await open(page, "table");
          },
        ],
        [
          "tabs-menue",
          1440,
          async (page: Page) => {
            await open(page, "table");
            await open(page, "report");
            await page.locator(".artifact-pane__more").first().click();
          },
        ],
        [
          "tabs-zwei-bereiche",
          1440,
          async (page: Page) => {
            await open(page, "report");
            await open(page, "table");
            await open(page, "sources");
            await page.locator(".k2b-panes__arrange").click();
            await page.getByRole("menuitemradio", { name: /Gestapelt|Stacked/ }).click();
          },
        ],
        [
          "webseite-leseansicht",
          1440,
          async (page: Page) => {
            await open(page, "sources");
            await open(page, "web");
            await page.locator(".web-reader__stand").waitFor();
          },
        ],
        [
          "webseite-adresse-fragt",
          1440,
          async (page: Page) => {
            await open(page, "sources");
            await open(page, "ask");
            await page.locator(".web-reader__ask").waitFor();
          },
        ],
        [
          "tabs-ergebnis",
          390,
          async (page: Page) => {
            await open(page, "report");
            await open(page, "table");
          },
        ],
      ] as const) {
        const { page } = await openPage(width);
        try {
          await page.evaluate(() => sessionStorage.clear());
          await page.emulateMedia({ reducedMotion: "reduce" });
          await act(page);
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${shots}/${name}-light-${width}.png` });
        } finally {
          await page.close();
        }
      }
    },
    120_000,
  );
});
