import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser, settled } from "../../../ui/test/browser";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot, fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot, source, upload } from "./AssistantChatSidebar.fixture";

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
import { SidebarHarness } from ${JSON.stringify(resolve(import.meta.dir, "AssistantChatSidebar.browser-fixture.tsx"))};
import { revealChatDelivery } from ${JSON.stringify(resolve(import.meta.dir, "chat-sidebar-layout.ts"))};

const config = window.harness;
const [snapshot, setSnapshot] = createSignal(config.snapshot);
// \`next\`: what the following reload returns; without it a reload returns the same content anew.
const sidebar = { setSnapshot, jumps: [], revealed: null, next: null, actions: [] };
window.sidebar = sidebar;
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
      onSecrets={() => {
        const page = document.querySelector(".k2b-app-workspace__detail");
        sidebar.actions.push({ name: "secrets", detailsShown: Boolean(page && page.getClientRects().length > 0) });
      }}
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
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style></head>` +
  // The window is the app area, as in Cloud's shell below 1024 px.
  `<body class="k2b-ui" style="margin:0"><div id="root" style="display:flex;flex-direction:column;height:100dvh;container:k2b-app-area / inline-size">${body}</div>` +
  `<script>window.harness = ${JSON.stringify({ closed, snapshot })};</script></body></html>`;

const newPage = (width: number, touch = width < 768) =>
  browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 768, hasTouch: touch, reducedMotion: "reduce" });

/** Serves the page and the UI fonts from an origin, so it has cookies and history like the real one. */
const load = async (page: Page, html: string) => {
  await page.route("http://assistant.test/ui/**", (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(4)) }),
  );
  await page.route("http://assistant.test/", (route) => route.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("http://assistant.test/");
  await page.evaluate(() => document.fonts.ready);
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
  await page.locator(".assistant-context-sidebar").waitFor({ state: "attached" });
  await settled(page);
  return page;
};

const DETAIL = "#k2b-workspace-detail-assistant-chat-context";
const details = (page: Page) => page.locator(DETAIL);
const detailsButton = (page: Page) => page.locator("[data-app-workspace-detail-toggle]");

const layout = (page: Page) =>
  page.evaluate((selector) => {
    const box = (element: Element | null) => {
      if (!element || element.getClientRects().length === 0) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      sidebar: box(document.querySelector(selector)),
      toggle: box(document.querySelector("[data-app-workspace-detail-toggle]")),
      timeline: box(document.querySelector(".harness-timeline")),
      composer: box(document.querySelector(".assistant-chat-composer")),
      firstResult: box(document.querySelector(".assistant-result")),
    };
  }, DETAIL);

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
  test("the server's first frame is final: a column at 1280 px, Details while closed or narrow, and the browser render agrees", async () => {
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
        expect(await layout(client)).toEqual(first);
        if (width === 1280 && !closed) {
          // The shared Detail column at the workspace's end, 8 px inside its edge, the chat beside it.
          expect(first.sidebar).toMatchObject({ width: 416 });
          expect(first.sidebar!.x + first.sidebar!.width).toBe(1280 - 1 - 8);
          expect(first.timeline!.x + first.timeline!.width).toBeLessThanOrEqual(first.sidebar!.x);
          expect(first.firstResult).not.toBeNull();
          expect(await detailsButton(client).getAttribute("aria-expanded")).toBe("true");
        } else {
          // Closed, waiting as a drawer, or waiting as the phone page: only the Details button shows it.
          expect(first.sidebar).toBeNull();
          expect(await detailsButton(client).getAttribute("aria-expanded")).toBe("false");
        }
        if (width !== 390) expect(first.toggle).not.toBeNull();
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
      await details(page).getByRole("button", { name: "Chatdetails schließen" }).click();
      await settled(page);
      const closed = await layout(page);
      expect(closed.sidebar).toBeNull();
      expect(closed.timeline!.y).toBe(before.timeline!.y);
      expect(closed.composer!.y).toBe(before.composer!.y);
      expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-app-workspace-detail-toggle"))).toBe(true);
      expect(await page.evaluate(() => document.cookie)).toContain("assistant_context=closed");

      await detailsButton(page).click();
      await settled(page);
      expect(await layout(page)).toEqual(before);
      expect(await page.evaluate(() => document.cookie)).not.toContain("assistant_context=closed");
      // Escape in the column closes it like its close button.
      await details(page).getByRole("heading", { name: "In diesem Chat" }).focus();
      await page.keyboard.press("Escape");
      await settled(page);
      expect((await layout(page)).sidebar).toBeNull();
      expect(await page.evaluate(() => document.cookie)).toContain("assistant_context=closed");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("the column resizes from its leading edge and the chat gives way", async () => {
    const page = await clientPage(1440);
    try {
      const handle = page.locator('[data-app-workspace-resize="detail"]');
      expect(await handle.getAttribute("aria-controls")).toBe(DETAIL.slice(1));
      const before = await layout(page);
      await handle.focus();
      await page.keyboard.press("ArrowLeft");
      await settled(page);
      const after = await layout(page);
      expect(after.sidebar!.width).toBeGreaterThan(before.sidebar!.width);
      expect(after.sidebar!.x + after.sidebar!.width).toBe(before.sidebar!.x + before.sidebar!.width);
      expect(after.timeline!.x + after.timeline!.width).toBeLessThanOrEqual(after.sidebar!.x);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("at 820 px Details opens a drawer over the chat's edge without moving the chat; Escape and close park it", async () => {
    const page = await clientPage(820);
    try {
      const before = await layout(page);
      for (const park of ["Escape", "close"] as const) {
        await detailsButton(page).press("Enter");
        await settled(page);
        const open = await layout(page);
        expect(open.sidebar).toMatchObject({ width: 416 });
        expect(open.sidebar!.x + open.sidebar!.width).toBe(820 - 1);
        expect(open.timeline).toEqual(before.timeline);
        expect(open.composer).toEqual(before.composer);
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("In diesem Chat");
        if (park === "Escape") await page.keyboard.press("Escape");
        else await details(page).getByRole("button", { name: "Chatdetails schließen" }).click();
        await settled(page);
        expect(await layout(page)).toEqual(before);
        expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-app-workspace-detail-toggle"))).toBe(true);
        // Parking the drawer is not remembered.
        expect(await page.evaluate(() => document.cookie)).not.toContain("assistant_context=closed");
      }
    } finally {
      await page.close();
    }
  }, 20_000);

  test("on a phone Details opens the chat details as a page, and close or Escape return to the chat", async () => {
    const page = await clientPage(390);
    try {
      const before = await layout(page);
      for (const park of ["close", "Escape"] as const) {
        await detailsButton(page).click();
        await settled(page);
        expect((await layout(page)).sidebar).toEqual({ x: 0, y: 0, width: 390, height: 800 });
        await details(page).getByText("Umsatzbericht Q1-Q3.pdf").first().waitFor();
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("In diesem Chat");
        expect(await page.locator(".k2b-app-workspace__main").getAttribute("inert")).toBe("");
        if (park === "close") await details(page).getByRole("button", { name: "Chatdetails schließen" }).click();
        else await page.keyboard.press("Escape");
        await settled(page);
        expect(await layout(page)).toEqual(before);
        expect(await page.locator("[inert]").count()).toBe(0);
        expect(await page.evaluate(() => document.cookie)).not.toContain("assistant_context=closed");
      }
    } finally {
      await page.close();
    }
  }, 20_000);

  test("empty results read None yet, your files list each upload, and Context opens in place", async () => {
    const snapshot = emptySidebarSnapshot({ files: [upload("/image.png", minutesAgo(12), "image/png", 334_336)], fileCount: 1 });
    const page = await clientPage(1280, false, snapshot);
    try {
      const sidebar = details(page);
      const results = sidebar.locator("section", { has: page.getByRole("heading", { name: "Ergebnisse" }) });
      expect(await results.locator(".k2b-detail-panel__section-header").textContent()).toContain("Noch keine");
      expect(await results.locator(".k2b-detail-panel__section-body").count()).toBe(0);
      const files = sidebar.locator("section", { has: page.getByRole("heading", { name: "Deine Dateien" }) });
      expect(await files.locator(".k2b-detail-panel__section-header").textContent()).toContain("1");
      const rows = files.locator(".k2b-detail-panel__action");
      expect(await rows.count()).toBe(1);
      expect(await rows.textContent()).toContain("image.png");
      expect(await rows.textContent()).toContain("326.5 KB");
      expect(await files.getByRole("button", { name: "image.png löschen" }).count()).toBe(1);
      const context = sidebar.getByRole("button", { name: /^Kontext/ });
      expect(await context.getAttribute("aria-expanded")).toBe("false");
      expect(await context.textContent()).toContain("Secrets & Freigaben");
      await context.click();
      await sidebar.getByRole("button", { name: "Secrets & Freigaben" }).waitFor();
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a result that arrives while the pointer rests in the sidebar waits behind a count and nothing moves", async () => {
    const page = await clientPage(1280);
    try {
      const sidebar = details(page);
      const heading = page.locator(".assistant-sidebar-results .k2b-detail-panel__section-header");
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      await settled(page);
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
      await settled(page);
      expect(await layout(page)).toEqual(before);
      expect(await heading.boundingBox()).toEqual(headingBefore);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Umsatzbericht Q1-Q3.pdf");
      const pending = page.locator('.assistant-sidebar-new[data-pending="true"]');
      expect(await pending.textContent()).toBe("Neu · 1");

      // Leaving the sidebar takes over the new state.
      await page.mouse.move(100, 400);
      await settled(page);
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
      await settled(page);
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
      await detailsButton(page).click();
      await page.setViewportSize({ width: 1280, height: 800 });
      await settled(page);
      expect((await layout(page)).sidebar).toMatchObject({ width: 416 });
      await details(page).getByRole("button", { name: "Chatdetails schließen" }).click();
      await settled(page);
      expect((await layout(page)).sidebar).toBeNull();
      expect(await page.evaluate(() => document.cookie)).toContain("assistant_context=closed");
      // Narrow again, it stays closed until Details opens it.
      await page.setViewportSize({ width: 820, height: 800 });
      await settled(page);
      expect((await layout(page)).sidebar).toBeNull();
      expect(await detailsButton(page).getAttribute("aria-expanded")).toBe("false");
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
      const sidebar = details(page);
      const august = sidebar.getByRole("button", { name: /August 2026/ });
      await august.click();
      await sidebar.getByRole("button", { name: /Arbeitsdateien/ }).click();
      const folder = sidebar.getByRole("button", { name: /^umsatzbericht-q1-q3/ });
      await folder.click();
      await sidebar.getByText("chart.png", { exact: true }).waitFor();

      // Every live update builds the groups from a new snapshot.
      await leaveSidebar(page);
      await push(page, snapshot);
      await settled(page);
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
      await settled(page);
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
      await detailsButton(page).tap();
      const sidebar = details(page);
      await sidebar.locator(".assistant-result__description").first().tap();
      const next = sidebarSnapshot();
      next.results = [fileResult("/Prognose Q4.xlsx", { at: SIDEBAR_NOW, turn: "turn-4", seq: 12 }), ...next.results];
      await push(page, next);
      await settled(page);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Umsatzbericht Q1-Q3.pdf");
      expect(await page.locator('.assistant-sidebar-new[data-pending="true"]').textContent()).toBe("Neu · 1");

      // A touch on the chat ends the reading.
      await page.touchscreen.tap(100, 400);
      await settled(page);
      expect(await page.locator(".assistant-result__title").first().textContent()).toBe("Prognose Q4.xlsx");
    } finally {
      await page.close();
    }
  }, 20_000);

  test("other changes than results also wait while someone reads, behind an update control", async () => {
    const page = await clientPage(1280);
    try {
      const sidebar = details(page);
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      const next = sidebarSnapshot();
      next.files = [upload("/neu-hochgeladen.csv", SIDEBAR_NOW), ...next.files];
      next.fileCount += 1;
      await push(page, next);
      await settled(page);
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
      const sidebar = details(page);
      const box = (await sidebar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      // WebKit moves focus to the body without a focusout when the focused element leaves the document.
      await page.evaluate(() => {
        const control = document.createElement("button");
        document.querySelector(".assistant-context-sidebar")!.append(control);
        control.focus();
        control.remove();
      });
      await page.mouse.move(100, 400);
      const next = sidebarSnapshot();
      next.files = [upload("/neu-hochgeladen.csv", SIDEBAR_NOW), ...next.files];
      next.fileCount += 1;
      await push(page, next);
      await settled(page);
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
      const sidebar = details(page);
      await sidebar.getByRole("button", { name: /^Quellen/ }).click();
      // The first page is two bundles, one per call; the older sources are one step away.
      await sidebar.getByRole("button", { name: "Alle 150" }).click();
      await sidebar.getByRole("button", { name: "Weitere laden" }).click();
      await sidebar.getByText("Ältere Seite", { exact: true }).waitFor();
      expect(cursors).toEqual(["cursor-1"]);

      // A new first page ends elsewhere: the loaded pages start over instead of leaving a gap.
      await leaveSidebar(page);
      await push(page, { ...snapshot, sourceCount: 151, sourceCursor: "cursor-2" });
      await settled(page);
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
      const sidebar = details(page);
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

  test("on a phone, an action in Context runs after the page gave the chat back", async () => {
    const page = await clientPage(390);
    try {
      await detailsButton(page).click();
      await details(page)
        .getByRole("button", { name: /^Kontext/ })
        .click();
      await details(page).getByRole("button", { name: "Secrets & Freigaben" }).click();
      await page.waitForFunction(() => (window as unknown as HarnessWindow).sidebar.actions.length > 0);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).sidebar.actions)).toEqual([
        { name: "secrets", detailsShown: false },
      ]);
      expect(await page.locator("[inert]").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 20_000);
});

// Error class: an application host around a shared panel paints its own column, frame, or nested section boxes. The
// chat details use the workspace's Detail in each presentation, with flat sections and no fill of their own.
for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 834, 390])
    test(`${width} ${theme}: chat details share the Detail surface with flat sections`, async () => {
      const page = await clientPage(width);
      try {
        await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
        if (width < 1000) await detailsButton(page).click();
        await settled(page);
        const paint = await details(page).evaluate((aside) => {
          const sections = Array.from(
            aside.querySelectorAll(".k2b-detail-panel__group,.k2b-detail-panel__body > .k2b-detail-panel__section"),
          );
          const host = aside.querySelector(".assistant-context-sidebar")!;
          return {
            count: sections.length,
            flat: sections.every((section) => {
              const style = getComputedStyle(section);
              return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderRadius === "0px";
            }),
            host: getComputedStyle(host).backgroundColor,
            header: Boolean(aside.querySelector(".k2b-detail-panel__header h2")),
            drawer: aside.dataset.workspaceDetailDrawer ?? null,
          };
        });
        expect(paint.count).toBeGreaterThan(0);
        expect(paint.flat).toBe(true);
        expect(paint.host).toBe("rgba(0, 0, 0, 0)");
        expect(paint.header).toBe(true);
        expect(paint.drawer).toBe(width === 1440 ? null : "open");
      } finally {
        await page.close();
      }
    }, 20_000);
