import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot, source, upload } from "./AssistantChatSidebar.fixture";

// Which presentation the sidebar takes, whether the server's first frame is final, and whether live updates move what
// someone reads are layout results of the shipped cascade, which happy-dom does not model. A real engine lays out the
// same component rendered on the server and in the browser.

const root = mkdtempSync(resolve(tmpdir(), "assistant-chat-sidebar-browser-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const { SidebarHarness } = await import("./AssistantChatSidebar.browser-fixture");

const ui = resolve(import.meta.dir, "../../../ui");
const entry = resolve(import.meta.dir, "AssistantChatSidebar.browser-entry.tsx");
const entrySource = `
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import { SidebarHarness } from ${JSON.stringify(resolve(import.meta.dir, "AssistantChatSidebar.browser-fixture.tsx"))};
import { openAssistantChatSidebarSheet } from ${JSON.stringify(resolve(import.meta.dir, "AssistantChatSidebar.tsx"))};
import { revealChatDelivery } from ${JSON.stringify(resolve(import.meta.dir, "chat-sidebar-layout.ts"))};

const config = window.harness;
const [snapshot, setSnapshot] = createSignal(config.snapshot);
// \`next\`: what the following reload returns; without it a reload returns the same content anew.
const sidebar = { setSnapshot, jumps: [], revealed: null, next: null, actions: [] };
window.sidebar = sidebar;
const state = { snapshot, projectContext: () => null, error: () => undefined, refresh: async () => undefined };
render(
  () => (
    <SidebarHarness
      snapshot={snapshot}
      initialClosed={config.closed}
      refresh={async () => setSnapshot(JSON.parse(JSON.stringify(sidebar.next ?? snapshot())))}
      onJump={(target) => {
        sidebar.jumps.push(target);
        sidebar.revealed = revealChatDelivery(document.querySelector(".harness-timeline"), target)?.textContent ?? null;
      }}
      onSheet={() =>
        void openAssistantChatSidebarSheet({
          state,
          actions: {
            onOpenFile() {},
            onOpenApp() {},
            onJump() {},
            onOpenSecrets() {
              sidebar.actions.push({ name: "secrets", sheetOpen: document.querySelector('[role="dialog"]') !== null });
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

const pageHtml = (body: string, closed: boolean, snapshot: AssistantChatContextSnapshot) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
  `<body class="k2b-ui" style="margin:0"><div id="root">${body}</div>` +
  `<script>window.harness = ${JSON.stringify({ closed, snapshot })};</script></body></html>`;

const newPage = (width: number, touch = width < 768) =>
  browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 768, hasTouch: touch });

/** Serves the page from an origin, so it has cookies and history like the real one. */
const load = async (page: Page, html: string) => {
  await page.route("http://assistant.test/", (route) => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("http://assistant.test/");
};

/** The server's HTML only, as the browser paints it before any script runs. */
const serverPage = async (width: number, closed = false, snapshot = sidebarSnapshot()) => {
  const page = await newPage(width);
  const html = renderToString(() => createComponent(SidebarHarness, { snapshot: () => snapshot, initialClosed: closed }));
  await load(page, pageHtml(html, closed, snapshot));
  return page;
};

/** The same component rendered in the browser, with live controls on `window.sidebar`. */
const clientPage = async (width: number, closed = false, snapshot = sidebarSnapshot(), touch = width < 768) => {
  const page = await newPage(width, touch);
  await load(page, pageHtml("", closed, snapshot));
  page.setDefaultTimeout(4000);
  await page.addScriptTag({ content: script });
  await page.locator("#assistant-chat-context").waitFor({ state: "attached" });
  return page;
};

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      sidebar: box(document.getElementById("assistant-chat-context")),
      toggle: box(document.querySelector(".assistant-context-toggle")),
      timeline: box(document.querySelector(".harness-timeline")),
      composer: box(document.querySelector(".assistant-chat-composer")),
      firstResult: box(document.querySelector(".assistant-result")),
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
const workingFile = (path: string, index: number) => ({
  path,
  size: 1_000,
  mediaType: "text/html",
  origin: "assistant",
  updatedAt: minutesAgo(30 + index),
  version: 1,
});

describe(`Assistant chat sidebar in ${browserName}`, () => {
  test("the server's first frame is final: column at 1280 px, toggle when closed or narrow, and the browser render agrees", async () => {
    for (const [width, closed] of [
      [1280, false],
      [1280, true],
      [820, false],
      [390, false],
    ] as const) {
      const server = await serverPage(width, closed);
      const client = await clientPage(width, closed);
      try {
        const first = await layout(server);
        await frames(client);
        expect(await layout(client)).toEqual(first);
        if (width === 1280 && !closed) {
          // A 20 rem column at the right edge, the chat column next to it, no toggle.
          expect(first.sidebar).toMatchObject({ width: 320, height: 800 });
          expect(first.sidebar!.x).toBe(1280 - 320);
          expect(first.timeline!.x + first.timeline!.width).toBeLessThanOrEqual(1280 - 320);
          expect(first.toggle).toBeNull();
          expect(first.firstResult).not.toBeNull();
        } else {
          expect(first.sidebar).toBeNull();
          expect(first.toggle).not.toBeNull();
        }
      } finally {
        await server.close();
        await client.close();
      }
    }
  }, 60_000);

  test("closing and reopening the column keeps the chat's vertical place and remembers only the close", async () => {
    const page = await clientPage(1280);
    try {
      const before = await layout(page);
      await page.getByRole("button", { name: "Seitenleiste schließen" }).click();
      const closed = await layout(page);
      expect(closed.sidebar).toBeNull();
      expect(closed.timeline!.y).toBe(before.timeline!.y);
      expect(closed.composer!.y).toBe(before.composer!.y);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("assistant-context-toggle"))).toBe(true);
      expect(await page.evaluate(() => document.cookie)).toContain("assistant_context=closed");

      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).click();
      expect(await layout(page)).toEqual(before);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("assistant-chat-context-title");
      expect(await page.evaluate(() => document.cookie)).not.toContain("assistant_context=closed");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("below 56 rem the toggle opens a drawer over the chat's edge without moving the chat; Escape closes it", async () => {
    const page = await clientPage(820);
    try {
      const before = await layout(page);
      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).click();
      const open = await layout(page);
      expect(open.sidebar).toMatchObject({ x: 820 - 320, width: 320 });
      expect(open.timeline).toEqual(before.timeline);
      expect(open.composer).toEqual(before.composer);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("assistant-chat-context-title");
      await page.keyboard.press("Escape");
      expect(await layout(page)).toEqual(before);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("assistant-context-toggle"))).toBe(true);
      // Closing the drawer is not remembered.
      expect(await page.evaluate(() => document.cookie)).not.toContain("assistant_context=closed");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("on a phone the toggle opens the sidebar as a sheet that Back closes", async () => {
    const page = await clientPage(390);
    try {
      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("Umsatzbericht Q1-Q3.pdf").first().waitFor();
      expect(await sheet.getByRole("heading", { name: "In diesem Chat" }).count()).toBe(1);
      await page.goBack();
      await sheet.waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a result that arrives while the pointer rests in the sidebar waits behind a count and nothing moves", async () => {
    const page = await clientPage(1280);
    try {
      const sidebar = page.locator("#assistant-chat-context");
      const heading = page.locator(".assistant-sidebar-results .k2b-detail-panel__section-header");
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
    const page = await clientPage(1280, false, sidebarSnapshot({ results }));
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
    const page = await clientPage(1280);
    try {
      await page.getByRole("button", { name: "„Umsatzbericht Q1-Q3.pdf“ im Chat zeigen" }).click();
      const state = await page.evaluate(() => (window as unknown as { sidebar: { jumps: unknown[]; revealed: string | null } }).sidebar);
      expect(state.jumps).toEqual([{ messageSeq: 9, callId: "call-/Umsatzbericht Q1-Q3.pdf", presentationId: null }]);
      expect(state.revealed).toBe("Übergabe 9");
      const delivered = await page.locator('[data-call-id="call-/Umsatzbericht Q1-Q3.pdf"]').boundingBox();
      expect(delivered!.y).toBeGreaterThan(0);
      expect(delivered!.y).toBeLessThan(800);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a drawer that widened into the column closes with its close button and stays closed", async () => {
    const page = await clientPage(820);
    try {
      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).click();
      await page.setViewportSize({ width: 1280, height: 800 });
      await frames(page);
      expect((await layout(page)).sidebar).toMatchObject({ x: 1280 - 320, width: 320 });
      await page.getByRole("button", { name: "Seitenleiste schließen" }).click();
      await frames(page);
      const closed = await layout(page);
      expect(closed.sidebar).toBeNull();
      expect(closed.toggle).not.toBeNull();
      expect(await page.evaluate(() => document.cookie)).toContain("assistant_context=closed");
      // Narrow again, it stays closed until the toggle opens it.
      await page.setViewportSize({ width: 820, height: 800 });
      await frames(page);
      expect((await layout(page)).sidebar).toBeNull();
    } finally {
      await page.close();
    }
  }, 20_000);

  test("opened groups and a working folder's loaded files stay through live updates and a deletion inside", async () => {
    const results = Array.from({ length: 40 }, (_, index) =>
      fileResult(`/bericht-${index}.pdf`, { at: minutesAgo(30 + index * 24 * 60), turn: `t${index}`, seq: index + 1 }),
    );
    const snapshot = sidebarSnapshot({ results });
    const page = await clientPage(1280, false, snapshot);
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

  test("on a touch screen the drawer keeps what someone reads until they touch outside it", async () => {
    const page = await clientPage(820, false, sidebarSnapshot(), true);
    try {
      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).tap();
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
    const page = await clientPage(1280);
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
    const page = await clientPage(1280);
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
    const page = await clientPage(1280, false, snapshot);
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
    const page = await clientPage(1280, false, snapshot);
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

  test("the toggle never covers the first message: below 56 rem the timeline starts below it", async () => {
    for (const [width, closed] of [
      [390, false],
      [820, false],
      [900, true],
      [1280, true],
    ] as const) {
      const page = await clientPage(width, closed);
      try {
        const box = await page.evaluate(() => {
          const content = document.querySelector(".harness-timeline")!;
          const style = getComputedStyle(content);
          const rect = content.getBoundingClientRect();
          const toggle = document.querySelector(".assistant-context-toggle")!.getBoundingClientRect();
          return {
            top: rect.top + Number.parseFloat(style.paddingTop),
            right: rect.right - Number.parseFloat(style.paddingRight),
            toggleBottom: toggle.bottom,
            toggleLeft: toggle.left,
          };
        });
        // The messages start below the toggle, or end left of it.
        expect(box.top >= box.toggleBottom || box.right <= box.toggleLeft).toBe(true);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  test("on a phone, an action in the sheet's Context runs after the sheet closed", async () => {
    const page = await clientPage(390);
    try {
      await page.getByRole("button", { name: "Zeigen, was in diesem Chat ist" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: /^Kontext/ }).click();
      await sheet.getByRole("button", { name: "Secrets" }).click();
      await sheet.waitFor({ state: "detached" });
      await page.waitForFunction(() => (window as unknown as HarnessWindow).sidebar.actions.length > 0);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).sidebar.actions)).toEqual([
        { name: "secrets", sheetOpen: false },
      ]);
    } finally {
      await page.close();
    }
  }, 20_000);
});
