import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, hoverInPlace, launchBrowser } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot, fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot, source, upload } from "./AssistantChatSidebar.fixture";

// Which presentation the sidebar takes, whether the server's first frame is final, and whether live updates move what
// someone reads are layout results of the shipped cascade, which happy-dom does not model. A real engine lays out the
// same component rendered on the server and in the browser.

const root = mkdtempSync(resolve(tmpdir(), "assistant-chat-sidebar-browser-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
registerSsrTestPlugin({ dev: true, rootDir: root });
const { SidebarHarness } = await import("./AssistantChatSidebar.browser-fixture");

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "AssistantChatSidebar.browser-entry.tsx");
const entrySource = `
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import { SidebarHarness } from ${JSON.stringify(resolve(import.meta.dir, "AssistantChatSidebar.browser-fixture.tsx"))};
import { openAssistantContextBoxSheet } from ${JSON.stringify(resolve(import.meta.dir, "AssistantChatContextSheet.tsx"))};
import { revealChatDelivery } from ${JSON.stringify(resolve(import.meta.dir, "chat-sidebar-layout.ts"))};

const config = window.harness;
const [snapshot, setSnapshot] = createSignal(config.snapshot);
// \`next\`: what the following reload returns; without it a reload returns the same content anew.
const sidebar = { setSnapshot, jumps: [], revealed: null, next: null, actions: [], opened: [] };
window.sidebar = sidebar;
const state = { snapshot, projectContext: () => null, error: () => undefined, refresh: async () => undefined };
render(
  () => (
    <SidebarHarness
      snapshot={snapshot}
      refresh={async () => setSnapshot(JSON.parse(JSON.stringify(sidebar.next ?? snapshot())))}
      onOpenFile={(file) => sidebar.opened.push(file.path)}
      onJump={(target) => {
        sidebar.jumps.push(target);
        sidebar.revealed = revealChatDelivery(document.querySelector(".harness-timeline"), target)?.textContent ?? null;
      }}
      view={config.view}
      tabs={config.tabs}
      pending={config.pending}
      onOpenSecrets={() => sidebar.actions.push({ name: "secrets", sheetOpen: false })}
      box={{
        onOpenAll: () => sidebar.actions.push({ name: "all", sheetOpen: document.querySelector(".assistant-context-sheet") !== null }),
        onOpenSources: () => sidebar.actions.push({ name: "sources", sheetOpen: document.querySelector(".assistant-context-sheet") !== null }),
        onOpenContext: () => sidebar.actions.push({ name: "context", sheetOpen: document.querySelector(".assistant-context-sheet") !== null }),
      }}
      onSheet={() =>
        void openAssistantContextBoxSheet({
          state,
          actions: {
            onOpen(target) {
              if (target.kind === "file") sidebar.opened.push(target.path);
            },
            onJump(target) {
              sidebar.jumps.push(target);
            },
            onOpenAll() {},
            onOpenSources() {},
            onOpenContext() {
              sidebar.actions.push({ name: "context", sheetOpen: document.querySelector(".assistant-context-sheet") !== null });
            },
          },
          wrap: (content) => <LocaleProvider locale="de">{content()}</LocaleProvider>,
        })
      }
    />
  ),
  document.getElementById("root"),
);
`;

let browser: Browser;
let css: string;
let script: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const source = path === entry ? entrySource : await Bun.file(path).text();
            const result = await transformAsync(source, {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the chat sidebar harness.");
  script = await build.outputs[0]!.text();
  // Cloud compiles app stylesheets; the Assistant reaches its Tailwind plugin through @k2b/cloud.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../cloud")))).default;
  // The page head's order: the app's stylesheet, then Cloud's global one.
  const stylesheets = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (path) => {
      const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
      return output.outputs[0]!.text();
    }),
  );
  css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

type HarnessView = { view: "box" | "tab"; tabs?: boolean; pending?: "loading" | "error" };
const pageHtml = (body: string, view: HarnessView, snapshot: AssistantChatContextSnapshot) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
  `<body class="k2b-ui" style="margin:0"><div id="root">${body}</div>` +
  `<script>window.harness = ${JSON.stringify({ ...view, snapshot })};</script></body></html>`;

const newPage = (width: number, touch = width < 768) =>
  browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 768, hasTouch: touch });

/** Serves the page from an origin, so it has cookies and history like the real one. */
const load = async (page: Page, html: string) => {
  await page.route("http://assistant.test/", (route) => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("http://assistant.test/");
};

/** The server's HTML only, as the browser paints it before any script runs. */
const serverPage = async (width: number, view: HarnessView = { view: "box" }, snapshot = sidebarSnapshot()) => {
  const page = await newPage(width);
  const html = renderToString(() => createComponent(SidebarHarness, { snapshot: () => snapshot, view: view.view, tabs: view.tabs }));
  await load(page, pageHtml(html, view, snapshot));
  return page;
};

/** The same component rendered in the browser, with live controls on `window.sidebar`. */
const clientPage = async (width: number, view: HarnessView, snapshot = sidebarSnapshot(), touch = width < 768) => {
  const page = await newPage(width, touch);
  await load(page, pageHtml("", view, snapshot));
  page.setDefaultTimeout(4000);
  await page.addScriptTag({ content: script });
  await page.locator(view.view === "tab" ? "#assistant-chat-context" : ".assistant-context-button").waitFor({ state: "attached" });
  return page;
};
/** The tab "In this chat" with the chat's whole list. */
const tabPage = (width: number, snapshot = sidebarSnapshot(), touch = width < 768) => clientPage(width, { view: "tab" }, snapshot, touch);
/** The chat with its box "In this chat". */
const boxPage = (width: number, snapshot = sidebarSnapshot(), view: Omit<HarnessView, "view"> = {}) =>
  clientPage(width, { view: "box", ...view }, snapshot);

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      island: box(document.querySelector(".assistant-context-boxcol > .assistant-context-box")),
      button: box(document.querySelector(".assistant-context-button")),
      drawer: box(document.querySelector('.assistant-context-boxcol[data-drawer="open"]')),
      timeline: box(document.querySelector(".harness-timeline")),
      composer: box(document.querySelector(".assistant-chat-composer")),
      firstRow: box(document.querySelector(".assistant-context-boxcol .assistant-context-box__row")),
    };
  });

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

type HarnessWindow = { sidebar: { setSnapshot: (value: unknown) => void; next: unknown; actions: unknown[] } };
/** A live update: the snapshot as the server sends it, a new object every time. */
const push = (page: Page, snapshot: AssistantChatContextSnapshot) =>
  page.evaluate((json) => (window as unknown as HarnessWindow).sidebar.setSnapshot(JSON.parse(json)), JSON.stringify(snapshot));
/** Pointer and focus away from the sidebar, so live updates apply. */
const leaveSidebar = async (page: Page) => {
  await page.mouse.move(100, 400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
};
const automationsGroup = () => ({
  key: "automations",
  label: "Automationen",
  count: 3,
  rows: [
    {
      key: "a1",
      icon: "ti ti-code",
      title: "Code von info@",
      word: "Bereit, noch aus",
      tone: "ai" as const,
      attention: true,
      jump: { messageSeq: 9, callId: "c1" },
    },
    { key: "a2", icon: "ti ti-code", title: "Angebote nachfassen", word: "Eingeschaltet", tone: "ok" as const, href: "/code/a2" },
    { key: "a3", icon: "ti ti-code", title: "Wochenbericht Vertrieb", word: "Pausiert", tone: "warn" as const, href: "/code/a3" },
  ],
});
const workingFile = (path: string, index: number) => ({
  path,
  size: 1_000,
  mediaType: "text/html",
  origin: "assistant",
  updatedAt: minutesAgo(30 + index),
  version: 1,
});

describe(`Tab "In this chat" in ${browserName}`, () => {
  test("a result that arrives while the pointer rests in the sidebar waits behind a count and nothing moves", async () => {
    const page = await tabPage(1280);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      const heading = page.locator(".assistant-sidebar-results .k2b-section__header");
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      const before = await layout(page);
      const headingBefore = await heading.boundingBox();
      const next = sidebarSnapshot();
      next.results = [
        fileResult("/Prognose Q4.xlsx", { description: "Die Prognose für Q4.", at: SIDEBAR_NOW, turn: "turn-4", seq: 12 }),
        ...next.results,
      ];
      await page.evaluate(
        (json) => (window as unknown as { sidebar: { setSnapshot: (value: unknown) => void } }).sidebar.setSnapshot(JSON.parse(json)),
        JSON.stringify(next),
      );
      await frames(page);
      expect(await layout(page)).toEqual(before);
      expect(await heading.boundingBox()).toEqual(headingBefore);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Umsatzbericht Q1-Q3.pdf");
      const pending = page.locator('.assistant-sidebar-new[data-pending="true"]');
      expect(await pending.textContent()).toBe("Neu · 1");

      // Leaving the sidebar takes over the new state.
      await page.mouse.move(100, 400);
      await frames(page);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Prognose Q4.xlsx");
      expect(await pending.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a long chat keeps older results in day and month groups that open in place", async () => {
    const results = Array.from({ length: 150 }, (_, index) =>
      fileResult(`/bericht-${String(index).padStart(3, "0")}.pdf`, {
        at: minutesAgo(30 + index * 24 * 60),
        turn: `t${index}`,
        seq: index + 1,
      }),
    );
    const page = await tabPage(1280, sidebarSnapshot({ results }));
    try {
      const results = page.locator(".assistant-sidebar-results");
      // The latest turn as a card, five more of the last 24 hours do not exist; one day per group, then months.
      expect(await results.locator(".assistant-result").count()).toBe(1);
      for (const label of ["Gestern", "September 2026", "Mai 2026"])
        expect(await results.getByRole("button", { name: new RegExp(label) }).count()).toBe(1);
      const august = results.getByRole("button", { name: /August 2026 · 31/ });
      expect(await august.getAttribute("aria-expanded")).toBe("false");
      await august.click();
      expect(await august.getAttribute("aria-expanded")).toBe("true");
      expect(await results.locator(".assistant-sidebar-group__body .k2b-detail-panel__action").count()).toBe(31);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a result's title jumps to the call that delivered it", async () => {
    const page = await tabPage(1280);
    try {
      await page.getByRole("button", { name: "„Umsatzbericht Q1-Q3.pdf“ im Chat zeigen" }).click();
      const state = await page.evaluate(() => (window as unknown as { sidebar: { jumps: unknown[]; revealed: string | null } }).sidebar);
      expect(state.jumps).toEqual([{ messageSeq: 9, callId: "call-/Umsatzbericht Q1-Q3.pdf", presentationId: null }]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("⤢ on a file result shows the chat's file results in the Lightbox, whose Open opens the file as a tab", async () => {
    const page = await tabPage(1280);
    try {
      await page.getByRole("button", { name: "Vorschau von Umsatzbericht Q1-Q3.pdf" }).click();
      const lightbox = page.locator("dialog.k2b-lightbox[open]");
      await lightbox.waitFor();
      expect(await lightbox.getAttribute("aria-label")).toBe("Umsatzbericht Q1-Q3.pdf");
      // The blue Open pill leads the actions; the strip holds the other file results to step to.
      const actions = lightbox.locator(".k2b-lightbox__actions");
      expect(await actions.locator("button").first().textContent()).toContain("Öffnen");
      expect(await lightbox.locator(".k2b-thumbnail-strip__thumb").count()).toBeGreaterThan(1);
      await actions.getByRole("button", { name: "Öffnen" }).click();
      await lightbox.waitFor({ state: "detached" });
      expect(await page.evaluate(() => (window as unknown as { sidebar: { opened: string[] } }).sidebar.opened)).toEqual([
        "/Umsatzbericht Q1-Q3.pdf",
      ]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("opened groups and a working folder's loaded files stay through live updates and a deletion inside", async () => {
    const results = Array.from({ length: 40 }, (_, index) =>
      fileResult(`/bericht-${index}.pdf`, { at: minutesAgo(30 + index * 24 * 60), turn: `t${index}`, seq: index + 1 }),
    );
    const snapshot = sidebarSnapshot({ results });
    const page = await tabPage(1280, snapshot);
    const listed: string[] = [];
    await page.route("http://assistant.test/api/ai/conversations/**", async (route) => {
      if (route.request().method() === "DELETE") return route.fulfill({ json: { deleted: true } });
      const prefix = new URL(route.request().url()).searchParams.get("prefix")!;
      listed.push(prefix);
      return route.fulfill({
        json: {
          files: ["bericht.html", "chart.png", "daten.csv"].map((name, index) => workingFile(`${prefix}${name}`, index)),
          totalBytes: 0,
        },
      });
    });
    try {
      const sidebar = page.locator("#assistant-chat-context");
      const august = sidebar.getByRole("button", { name: /August 2026/ });
      await august.click();
      await sidebar.getByRole("button", { name: /Arbeitsdateien/ }).click();
      const folder = sidebar.getByRole("button", { name: /^umsatzbericht-q1-q3/ });
      await folder.click();
      await sidebar.getByText("chart.png", { exact: true }).waitFor();

      // Every live update builds the groups from a new snapshot.
      await leaveSidebar(page);
      await push(page, snapshot);
      await frames(page);
      expect(await august.getAttribute("aria-expanded")).toBe("true");
      expect(await folder.getAttribute("aria-expanded")).toBe("true");
      expect(await sidebar.getByText("chart.png", { exact: true }).count()).toBe(1);
      expect(listed).toEqual(["/temp/umsatzbericht-q1-q3/"]);

      // Deleting a file reloads the snapshot with one file less; the folder stays open with its other files.
      const next = structuredClone(snapshot);
      next.working.groups[0]!.count -= 1;
      next.working.count -= 1;
      await page.evaluate((json) => {
        (window as unknown as HarnessWindow).sidebar.next = JSON.parse(json);
      }, JSON.stringify(next));
      await sidebar.getByRole("button", { name: "chart.png löschen" }).click();
      await page.getByRole("button", { name: "Löschen", exact: true }).click();
      await sidebar.getByText("chart.png", { exact: true }).waitFor({ state: "detached" });
      await frames(page);
      expect(await folder.getAttribute("aria-expanded")).toBe("true");
      expect(await august.getAttribute("aria-expanded")).toBe("true");
      expect(await sidebar.getByText("daten.csv", { exact: true }).count()).toBe(1);
      expect(listed).toHaveLength(1);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("on a touch screen the tab keeps what someone reads until they touch outside it", async () => {
    const page = await tabPage(820, sidebarSnapshot(), true);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      await sidebar.locator(".assistant-result__description").first().tap();
      const next = sidebarSnapshot();
      next.results = [fileResult("/Prognose Q4.xlsx", { at: SIDEBAR_NOW, turn: "turn-4", seq: 12 }), ...next.results];
      await push(page, next);
      await frames(page);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Umsatzbericht Q1-Q3.pdf");
      expect(await page.locator('.assistant-sidebar-new[data-pending="true"]').textContent()).toBe("Neu · 1");

      // A touch on the chat ends the reading.
      await page.touchscreen.tap(100, 400);
      await frames(page);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Prognose Q4.xlsx");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("other changes than results also wait while someone reads, behind an update control", async () => {
    const page = await tabPage(1280);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      const next = sidebarSnapshot();
      next.files = [upload("/neu-hochgeladen.csv", SIDEBAR_NOW), ...next.files];
      next.fileCount += 1;
      await push(page, next);
      await frames(page);
      expect(await sidebar.getByText("neu-hochgeladen.csv", { exact: true }).count()).toBe(0);
      const update = page.locator('.assistant-sidebar-new[data-pending="true"]');
      expect(await update.textContent()).toBe("Aktualisieren");
      await update.click();
      await sidebar.getByText("neu-hochgeladen.csv", { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a focused control that disappears, like Load more after the last page, does not keep holding the sidebar", async () => {
    const page = await tabPage(1280);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      // WebKit moves focus to the body without a focusout when the focused element leaves the document.
      await page.evaluate(() => {
        const control = document.createElement("button");
        document.getElementById("assistant-chat-context")!.append(control);
        control.focus();
        control.remove();
      });
      await page.mouse.move(100, 400);
      const next = sidebarSnapshot();
      next.files = [upload("/neu-hochgeladen.csv", SIDEBAR_NOW), ...next.files];
      next.fileCount += 1;
      await push(page, next);
      await frames(page);
      expect(await sidebar.getByText("neu-hochgeladen.csv", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("sources bundled into few rows still lead to all of them, and loaded pages start over with a new first page", async () => {
    const mails = Array.from({ length: 100 }, (_, index) =>
      source("resource", `mail.message:M${index}`, `Mail ${index}`, minutesAgo(10 + index), {
        ref: { type: "mail.message", id: `M${index}` },
        sourceCallId: index < 50 ? "list-1" : "list-2",
        icon: "ti ti-mail",
      }),
    );
    const snapshot = sidebarSnapshot({ sources: mails, sourceCount: 150, sourceCursor: "cursor-1" });
    const page = await tabPage(1280, snapshot);
    const cursors: (string | null)[] = [];
    await page.route("http://assistant.test/api/assistant/**", async (route) => {
      cursors.push(new URL(route.request().url()).searchParams.get("cursor"));
      return route.fulfill({
        json: { sources: [source("web", "https://example.test/older", "Ältere Seite", minutesAgo(600))], total: 150 },
      });
    });
    try {
      const sidebar = page.locator("#assistant-chat-context");
      await sidebar.getByRole("button", { name: /^Quellen/ }).click();
      // The first page is two bundles, one per call; the older sources are one step away.
      await sidebar.getByRole("button", { name: "Alle 150" }).click();
      await sidebar.getByRole("button", { name: "Weitere laden" }).click();
      await sidebar.getByText("Ältere Seite", { exact: true }).waitFor();
      expect(cursors).toEqual(["cursor-1"]);

      // A new first page ends elsewhere: the loaded pages start over instead of leaving a gap.
      await leaveSidebar(page);
      await push(page, { ...snapshot, sourceCount: 151, sourceCursor: "cursor-2" });
      await frames(page);
      expect(await sidebar.getByText("Ältere Seite", { exact: true }).count()).toBe(0);
      await sidebar.getByRole("button", { name: "Weitere laden" }).click();
      await sidebar.getByText("Ältere Seite", { exact: true }).waitFor();
      expect(cursors).toEqual(["cursor-1", "cursor-2"]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("deleting a working folder names the results stored in it", async () => {
    const snapshot = sidebarSnapshot();
    snapshot.results.push(
      fileResult("/temp/umsatzbericht-q1-q3/vorschau.html", {
        title: "Vorschau",
        at: minutesAgo(200),
        turn: "turn-1",
        seq: 2,
        mediaType: "text/html",
      }),
    );
    const page = await tabPage(1280, snapshot);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      await sidebar.getByRole("button", { name: /Arbeitsdateien/ }).click();
      await sidebar.locator(".assistant-sidebar-group__row").getByRole("button", { name: "Aktionen für Umsatzbericht Q1-Q3.pdf" }).click();
      await page.getByRole("menuitem", { name: "Gruppe löschen" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Damit werden 7 Dateien aus diesem Chat gelöscht, darunter das Ergebnis „Vorschau“.");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  }, 20_000);
});

// Error class: flat DetailPanel styles scoped to one host leave reused panels with nested boxes.
for (const theme of ["light", "dark"] as const)
  test(`${theme}: the tab "In this chat" is one surface with flat sections`, async () => {
    const page = await tabPage(1440);
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
      const paint = await page.locator(".assistant-context-tab").evaluate((element) => {
        const sections = Array.from(element.querySelectorAll(".k2b-detail-panel__group,.k2b-detail-panel__body > .k2b-section"));
        return {
          count: sections.length,
          flat: sections.every((section) => {
            const style = getComputedStyle(section);
            return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderRadius === "0px";
          }),
        };
      });
      expect(paint.count).toBeGreaterThan(0);
      expect(paint.flat).toBe(true);
    } finally {
      await page.close();
    }
  }, 20_000);

/** Text styles (size/weight in px) and the centres of leading signs of one surface; the type rule of concept 6d. */
const typeOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((surface) => {
    const styles = new Set<string>();
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim() || element.closest("[aria-hidden='true'],[hidden],.k2b-tooltip")) continue;
      if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") continue;
      const style = getComputedStyle(element);
      styles.add(`${Number.parseFloat(style.fontSize)}/${style.fontWeight}`);
    }
    const left = surface.getBoundingClientRect().left;
    const axes = new Set(
      Array.from(surface.querySelectorAll(".assistant-context-box__main > :first-child")).map((sign) => {
        const rect = sign.getBoundingClientRect();
        return Math.round((rect.left + rect.width / 2 - left) * 2) / 2;
      }),
    );
    return { styles: [...styles].sort(), axes: [...axes] };
  });

describe(`Box "In this chat" in ${browserName}`, () => {
  test("the server's first frame is final: a column docked beside the chat when there is room, otherwise the button", async () => {
    for (const [width, tabs] of [
      [1440, false],
      [1280, false],
      [1280, true],
      [820, false],
      [390, false],
    ] as const) {
      const server = await serverPage(width, { view: "box", tabs });
      const client = await boxPage(width, sidebarSnapshot(), { tabs });
      try {
        const first = await layout(server);
        await frames(client);
        expect(await layout(client)).toEqual(first);
        if (width >= 1280 && !tabs) {
          // Gustav flat: 320 px docked at the right edge, from top to bottom; the chat column ends before it, no button.
          expect(first.island).toMatchObject({ x: width - 320, y: 0, width: 320, height: 800 });
          expect(first.timeline!.x + first.timeline!.width).toBeLessThanOrEqual(width - 320);
          expect(first.button).toBeNull();
          expect(first.firstRow!.height).toBe(36);
        } else {
          expect(first.island).toBeNull();
          expect(first.button).not.toBeNull();
        }
      } finally {
        await server.close();
        await client.close();
      }
    }
  }, 60_000);

  test("a flat column: no shadow, no corners, a 56 px head, sections between hairlines, rows of 36 px, signs on one axis", async () => {
    const page = await boxPage(1440, sidebarSnapshot({ groups: [automationsGroup()] }));
    try {
      const paint = await page.locator(".assistant-context-boxcol").evaluate((column) => {
        const element = column.querySelector(".assistant-context-box")!;
        const style = getComputedStyle(column);
        const rows = Array.from(element.querySelectorAll(".assistant-context-box__row")).map((row) => row.getBoundingClientRect().height);
        const sign = element.querySelector(".assistant-context-box__icon")!.getBoundingClientRect();
        const trailing = getComputedStyle(element.querySelector(".assistant-context-box__trailing")!);
        const head = element.querySelector(".assistant-context-box__head")!;
        const sections = Array.from(element.querySelectorAll(".assistant-context-box__body > *")).map(
          (section) => getComputedStyle(section).borderTopWidth,
        );
        const grip = column.querySelector(".assistant-context-grip")!.getBoundingClientRect();
        return {
          radius: style.borderRadius,
          shadow: style.boxShadow,
          border: style.borderLeftWidth,
          head: head.getBoundingClientRect().height,
          headLine: getComputedStyle(head).borderBottomWidth,
          sections,
          // The grip stands on the column's start edge.
          grip: Math.round(grip.left + grip.width / 2 - column.getBoundingClientRect().left),
          rows,
          signWidth: sign.width,
          trailing: trailing.fontSize,
        };
      });
      expect(paint.radius).toBe("0px");
      expect(paint.shadow).toBe("none");
      expect(paint.border).toBe("0px");
      expect(paint.head).toBe(56);
      expect(paint.headLine).toBe("1px");
      // One line, one owner: the body draws a hairline above every section after the first.
      expect(paint.sections[0]).toBe("0px");
      expect(paint.sections.slice(1).every((width) => width === "1px")).toBe(true);
      expect(Math.abs(paint.grip)).toBeLessThanOrEqual(1);
      expect(new Set(paint.rows)).toEqual(new Set([36]));
      expect(paint.rows.length).toBeLessThanOrEqual(10);
      expect(paint.signWidth).toBe(18);
      expect(paint.trailing).toBe("12px");
      const type = await typeOf(page, ".assistant-context-boxcol > .assistant-context-box");
      expect(type.styles).toEqual(["12/400", "13/400", "13/600", "14/600"]);
      expect(type.axes).toHaveLength(1);
      // A state word is in colour, not bold; the thing that waits for the person has a ring on its tile.
      const word = await page
        .locator('.assistant-context-box__trailing[data-tone="ai"]')
        .evaluate((element) => getComputedStyle(element).fontWeight);
      expect(word).toBe("400");
      const ring = await page
        .locator(".assistant-context-box__row[data-attention] .assistant-context-box__tile")
        .evaluate((element) => getComputedStyle(element).boxShadow);
      expect(ring).not.toBe("none");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("pointing at a row shows exactly one action over its fixed place; the row keeps its height and nothing moves", async () => {
    const page = await boxPage(1440);
    try {
      const row = page.locator(".assistant-context-boxcol .assistant-context-box__row").first();
      const before = await layout(page);
      const rowBefore = await row.boundingBox();
      await hoverInPlace(row);
      await frames(page);
      expect(await row.boundingBox()).toEqual(rowBefore);
      expect(await layout(page)).toEqual(before);
      const shown = await row.evaluate((element) => ({
        actions: Array.from(element.querySelectorAll(".assistant-context-box__act :is(a, button)")).filter(
          (action) => action.getClientRects().length > 0,
        ).length,
        trailing: getComputedStyle(element.querySelector(".assistant-context-box__trailing")!).visibility,
      }));
      expect(shown).toEqual({ actions: 1, trailing: "hidden" });
      expect(await row.getByRole("link", { name: "„Umsatzbericht Q1-Q3.pdf“ herunterladen" }).count()).toBe(1);
      // The click on the row opens the file as a tab.
      await row.locator(".assistant-context-box__main").click();
      expect(await page.evaluate(() => (window as unknown as { sidebar: { opened: string[] } }).sidebar.opened)).toEqual([
        "/Umsatzbericht Q1-Q3.pdf",
      ]);
      // A result without a file shows where it came from.
      const app = page.locator(".assistant-context-boxcol .assistant-context-box__row").nth(1);
      await app.hover();
      await app.getByRole("button", { name: "„Umsatz-Dashboard“ im Chat zeigen" }).click();
      const jumps = await page.evaluate(() => (window as unknown as { sidebar: { jumps: unknown[] } }).sidebar.jumps);
      expect(jumps).toEqual([{ messageSeq: 9, callId: "call-app", presentationId: null }]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("news while the pointer rests in the box wait behind “Neu · n” in its head, and nothing moves", async () => {
    const page = await boxPage(1440);
    try {
      const island = page.locator(".assistant-context-boxcol > .assistant-context-box");
      const box = (await island.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 60);
      const before = await layout(page);
      const islandBefore = await island.boundingBox();
      const next = sidebarSnapshot();
      next.results = [fileResult("/Prognose Q4.xlsx", { at: SIDEBAR_NOW, turn: "turn-4", seq: 12 }), ...next.results];
      await push(page, next);
      await frames(page);
      expect(await layout(page)).toEqual(before);
      expect(await island.boundingBox()).toEqual(islandBefore);
      expect(await island.locator(".assistant-context-box__title").first().textContent()).toBe("Umsatzbericht Q1-Q3.pdf");
      const fresh = island.locator('.assistant-context-box__new[data-pending="true"]');
      expect(await fresh.textContent()).toBe("Neu · 1");
      await fresh.click();
      expect(await island.locator(".assistant-context-box__title").first().textContent()).toBe("Prognose Q4.xlsx");
      expect(await fresh.count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("with tabs open or without room, the button opens the column as a drawer over the chat; Escape closes it", async () => {
    for (const [width, tabs] of [
      [1280, true],
      [820, false],
    ] as const) {
      const page = await boxPage(width, sidebarSnapshot(), { tabs });
      try {
        const before = await layout(page);
        expect(before.drawer).toBeNull();
        await page.getByRole("button", { name: "In diesem Chat" }).click();
        const drawer = page.locator('.assistant-context-boxcol[data-drawer="open"]');
        await drawer.getByText("Umsatzbericht Q1-Q3.pdf").waitFor();
        const open = await layout(page);
        // Over the chat at its right edge, from top to bottom; the chat behind it does not move.
        expect(open.timeline).toEqual(before.timeline);
        expect(open.composer).toEqual(before.composer);
        expect(open.button).toEqual(before.button);
        expect(open.drawer).toMatchObject({ x: width - 320, y: 0, width: 320, height: 800 });
        expect(await drawer.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
        await page.waitForFunction(() => document.activeElement?.id === "assistant-chat-context-title");
        await page.keyboard.press("Escape");
        await drawer.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.classList.contains("assistant-context-button"));
        // "Open as tab" leaves the drawer for the tab.
        await page.getByRole("button", { name: "In diesem Chat" }).click();
        await drawer.getByRole("button", { name: "Als Tab öffnen", exact: true }).click();
        await drawer.waitFor({ state: "detached" });
        expect(await page.evaluate(() => (window as unknown as HarnessWindow).sidebar.actions)).toEqual([
          { name: "all", sheetOpen: false },
        ]);
        // A press outside closes it too.
        await page.getByRole("button", { name: "In diesem Chat" }).click();
        await drawer.waitFor();
        await page.mouse.click(40, 400);
        await drawer.waitFor({ state: "detached" });
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  test("the docked column closes to the button in the chat's head and comes back; its grip resizes it, the chat keeps 400 px", async () => {
    const page = await boxPage(1440);
    try {
      const docked = await layout(page);
      expect(docked.button).toBeNull();
      await page.getByRole("button", { name: "„In diesem Chat“ schließen" }).click();
      const button = page.getByRole("button", { name: "In diesem Chat" });
      await button.waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains("assistant-context-button"));
      const closed = await layout(page);
      expect(closed.island).toBeNull();
      // The chat takes the room.
      const chatWidth = () => page.evaluate(() => document.querySelector(".assistant-chat-messages")!.getBoundingClientRect().width);
      expect(await chatWidth()).toBe(1440);
      await button.click();
      await page.locator(".assistant-context-boxcol .assistant-context-box__row").first().waitFor();
      await page.waitForFunction(() => document.activeElement?.id === "assistant-chat-context-title");
      expect(await layout(page)).toEqual(docked);
      // The grip: a separator with its value; arrows move it in 16 px steps, toward the chat to grow.
      const grip = page.getByRole("separator", { name: "Breite von „In diesem Chat“" });
      await grip.focus();
      await page.keyboard.press("ArrowLeft");
      await frames(page);
      expect((await layout(page)).island!.width).toBe(336);
      await page.keyboard.press("End");
      await frames(page);
      const widest = (await layout(page)).island!.width;
      expect(widest).toBeLessThanOrEqual(480);
      expect(await chatWidth()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("the button never covers a message: it stands in a head row, and the timeline scrolls below it", async () => {
    for (const [width, tabs] of [
      [390, false],
      [820, false],
      [1280, true],
    ] as const) {
      const page = await boxPage(width, sidebarSnapshot(), { tabs });
      try {
        const box = await page.evaluate(() => {
          // Scrolled into the middle: what passes the top of the scrollport must still not run under the button.
          const viewport = document.querySelector(".k2b-chat-timeline__viewport")!;
          viewport.scrollTop = viewport.scrollHeight / 2;
          const button = document.querySelector(".assistant-context-button")!.getBoundingClientRect();
          return { top: viewport.getBoundingClientRect().top, buttonBottom: button.bottom, buttonHeight: button.height };
        });
        expect(box.buttonHeight).toBeGreaterThan(0);
        expect(box.top).toBeGreaterThanOrEqual(box.buttonBottom);
        // The head names the chat at every width (Gustav flat).
        expect(await page.locator(".assistant-context-head__title").isVisible()).toBe(true);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  test("on a phone the button opens the box as a sheet; its lines run after the sheet closed, and Back closes it", async () => {
    const page = await boxPage(390);
    try {
      await page.getByRole("button", { name: "In diesem Chat" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.locator(".assistant-context-sheet").getByText("Umsatzbericht Q1-Q3.pdf").waitFor();
      expect(await sheet.getByRole("heading", { name: "In diesem Chat" }).count()).toBe(1);
      const type = await typeOf(page, ".assistant-context-sheet .assistant-context-box");
      expect(type.styles).toEqual(["12/400", "13/400", "13/600"]);
      // As high as the box, and the chat behind it stays as bright as before (v12, picture 66).
      const fit = await page.evaluate(() => {
        const frame = document.querySelector(".k2b-bottom-sheet-frame")!;
        const box = document.querySelector(".assistant-context-sheet")!.getBoundingClientRect();
        const backdrop = getComputedStyle(frame, "::backdrop");
        return {
          frame: frame.getBoundingClientRect().height,
          box: box.height,
          dim: backdrop.backgroundColor,
          blur: backdrop.backdropFilter,
        };
      });
      expect(fit.frame - fit.box).toBeLessThan(96);
      expect(fit.dim).toBe("rgba(0, 0, 0, 0)");
      expect(fit.blur).toBe("none");
      await sheet.getByRole("button", { name: /^Kontext/ }).click();
      await sheet.waitFor({ state: "detached" });
      await page.waitForFunction(() => (window as unknown as HarnessWindow).sidebar.actions.length > 0);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).sidebar.actions)).toEqual([
        { name: "context", sheetOpen: false },
      ]);
      await page.getByRole("button", { name: "In diesem Chat" }).click();
      await sheet.waitFor();
      await page.goBack();
      await sheet.waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  }, 20_000);

  test("dark: the column stands on the surface", async () => {
    const page = await boxPage(1440);
    try {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      const paint = await page.locator(".assistant-context-boxcol").evaluate((element) => {
        const chat = getComputedStyle(document.querySelector(".assistant-chat-pane")!).backgroundColor;
        return { island: getComputedStyle(element).backgroundColor, chat };
      });
      expect(paint.island).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await page.close();
    }
  }, 20_000);
});

/** Three mails among the sources, which Mail counts in its own nouns. */
const withMails = (snapshot: AssistantChatContextSnapshot): AssistantChatContextSnapshot => ({
  ...snapshot,
  sources: [
    ...["M1", "M2", "M3"].map((id) =>
      source("resource", `mail.message:${id}`, `Lieferavis ${id}`, minutesAgo(40), { ref: { type: "mail.message", id } }),
    ),
    ...snapshot.sources,
  ],
  sourceCount: snapshot.sourceCount + 3,
  resourceCounts: [{ type: "mail.message", count: 3, label: "3 Mails" }],
});

// Screenshots of every state of the box for the image comparison with the concept, when asked for.
const shots = process.env.ASSISTANT_SCREENSHOT_DIR;
test.skipIf(!shots)(
  "screenshots of the box in light, 1440 and 390",
  async () => {
    // Fonts and icons as Cloud serves them, so the images compare with the concept's.
    const publicDir = resolve(root, "public");
    await (await import("../../../core/scripts/font-assets")).buildFontAssets(publicDir);
    await (await import("../../../core/scripts/tabler-assets")).buildTablerIconAssets(publicDir);
    const states: Array<[string, number, AssistantChatContextSnapshot, Omit<HarnessView, "view">, ((page: Page) => Promise<void>)?]> = [
      ["kasten-normal", 1440, withMails(sidebarSnapshot({ groups: [automationsGroup()] })), {}],
      [
        "kasten-zeigen",
        1440,
        sidebarSnapshot({ groups: [automationsGroup()] }),
        {},
        async (page) => {
          await page.locator(".assistant-context-boxcol .assistant-context-box__row").nth(1).hover();
        },
      ],
      [
        "kasten-neu",
        1440,
        sidebarSnapshot(),
        {},
        async (page) => {
          const island = (await page.locator(".assistant-context-boxcol > .assistant-context-box").boundingBox())!;
          await page.mouse.move(island.x + 40, island.y + 10);
          const next = sidebarSnapshot();
          next.results = [fileResult("/Prognose Q4.xlsx", { at: SIDEBAR_NOW, turn: "turn-4", seq: 12 }), ...next.results];
          await push(page, next);
        },
      ],
      ["kasten-leer", 1440, emptySidebarSnapshot(), {}],
      ["kasten-laedt", 1440, sidebarSnapshot(), { pending: "loading" }],
      ["kasten-fehler", 1440, sidebarSnapshot(), { pending: "error" }],
      ["kasten-knopf", 1280, sidebarSnapshot(), { tabs: true }],
      [
        "kasten-knopf-offen",
        1280,
        sidebarSnapshot({ groups: [automationsGroup()] }),
        { tabs: true },
        async (page) => {
          await page.getByRole("button", { name: "In diesem Chat" }).click();
          await page.locator('.assistant-context-boxcol[data-drawer="open"] .assistant-context-box__row').first().waitFor();
        },
      ],
      ["kasten-telefon", 390, sidebarSnapshot(), {}],
      [
        "kasten-telefon-offen",
        390,
        sidebarSnapshot({ groups: [automationsGroup()] }),
        {},
        async (page) => {
          await page.getByRole("button", { name: "In diesem Chat" }).click();
          await page.locator(".assistant-context-sheet .assistant-context-box__row").first().waitFor();
          await page.waitForTimeout(600);
        },
      ],
    ];
    for (const [name, width, snapshot, view, act] of states) {
      const page = await clientPage(width, { view: "box", ...view }, snapshot);
      try {
        await page.route("http://assistant.test/public/**", (route) =>
          route.fulfill({ path: resolve(root, new URL(route.request().url()).pathname.slice(1)) }),
        );
        await page.addStyleTag({ url: "http://assistant.test/public/fonts.css" });
        await page.addStyleTag({ url: "http://assistant.test/public/tabler-icons.css" });
        await page.evaluate(() => document.fonts.ready);
        await page.setViewportSize({ width, height: width < 768 ? 780 : 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await act?.(page);
        await frames(page);
        await page.screenshot({ path: resolve(shots!, `${name}-light-${width}.png`) });
      } finally {
        await page.close();
      }
    }
  },
  120_000,
);
