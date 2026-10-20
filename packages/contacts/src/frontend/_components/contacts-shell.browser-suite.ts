import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Locator, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser, settled, storedCookie } from "../../../../ui/test/browser";

const packageCache = resolve(import.meta.dir, "../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "contacts-shell-browser-"));
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [resolve(import.meta.dir, "..")] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const {
  default: ContactsShellFixture,
  TIME,
  books,
  tags,
  contacts,
  favoriteKeys,
  notesPage,
  results,
} = await import("./contacts-shell.browser-fixture");
const { contactsFavoritesHintOpen } = await import("../contacts-hints");
const ui = resolve(import.meta.dir, "../../../../ui/dist");
// Review screenshots only when asked for (CONTACTS_SHOTS_DIR); the default run keeps their assertions at one width.
const reviewShots = Boolean(process.env.CONTACTS_SHOTS_DIR);
const shots = join(process.env.CONTACTS_SHOTS_DIR || tmpdir(), browserName);
if (reviewShots) mkdirSync(shots, { recursive: true });
const person = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "printshop-reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Alina",
  sn: "Beispiel",
  displayName: "Alina Beispiel",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;
const hints = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: person });
    await next();
  })
  .get("*", (c) => c.json({ open: contactsFavoritesHintOpen(c, c.req.query("noBooks") ? 0 : books.length) }));

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let css = "";
let controller = "";

// This function is serialized into the page before any island imports. Keep it self-contained.
function frame() {
  const groups = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".k2b-app-workspace__head-views,.k2b-app-workspace__head-filters,.k2b-app-workspace__head-actions,[data-workspace-primary],.k2b-app-workspace__sidebar-item",
    ),
  );
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-contact-row]")).slice(0, 5);
  return [...groups, ...rows].map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { key: element.getAttribute("href") ?? element.className.trim(), x, y, width, height };
  });
}
const pageHtml = (url: URL, hintOpen: boolean) => {
  const html = renderToString(() => createComponent(ContactsShellFixture, { source: `${url.pathname}${url.search}`, hintOpen }));
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const host = Number(url.searchParams.get("host"));
  return `<!doctype html><html lang="de" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>
    <style>solid-client,solid-island{display:contents}</style></head>
    <body class="k2b-ui" data-theme="${theme}" style="margin:0"><main style="container-type:inline-size;container-name:k2b-app-area;display:flex;flex-direction:column;height:100dvh;${host > 0 ? `width:${host}px;` : ""}">${html}</main>
    <script>${controller}</script><script type="module">await document.fonts.ready;
    document.documentElement.dataset.serverGeometry=JSON.stringify((${frame.toString()})());
    await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));
    document.documentElement.dataset.contactsReady='true';</script></body></html>`;
};
beforeAll(async () => {
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../cloud/src/styles/global.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile Contacts fixture styles");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))),
  ].join("\n");
  const entry = resolve(import.meta.dir, "contacts-shell.controller.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { installAppWorkspaceController } from ${JSON.stringify(join(ui, "browser/index.js"))}; installAppWorkspaceController();`,
    },
    target: "browser",
    format: "iife",
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle workspace controller");
  if (!built.outputs[0]) throw new Error("Missing workspace controller bundle");
  controller = await built.outputs[0].text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/contacts/search" || /^\/api\/contacts\/books\/[^/]+\/contacts$/.test(url.pathname))
        return Response.json(results(url, url.pathname.split("/")[4]));
      if (url.pathname.endsWith("/notes/page")) return Response.json(notesPage);
      if (url.pathname.startsWith("/api/contacts/favorites/"))
        return Response.json({ favorite: favoriteKeys.includes(url.pathname.split("/").slice(-2).join(":")) });
      const contactMatch = /^\/api\/contacts\/books\/([^/]+)\/contacts\/([^/]+)$/.exec(url.pathname);
      if (contactMatch)
        return Response.json(contacts.find((contact) => contact.bookId === contactMatch[1] && contact.id === contactMatch[2]) ?? null);
      // Unexpected API calls fail explicitly instead of hiding an incomplete fixture behind [].
      if (url.pathname.startsWith("/api/")) return Response.json({ error: `Unmocked fixture endpoint: ${url.pathname}` }, { status: 501 });
      if (!/^\/app\/contacts(?:\/[^/]+)?$/.test(url.pathname)) return new Response("Not found", { status: 404 });
      const decision = await hints.fetch(request);
      const { open } = await decision.json();
      const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
      for (const cookie of decision.headers.getSetCookie()) headers.append("set-cookie", cookie);
      return new Response(pageHtml(url, open), { headers });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
const ready = async (page: Page) => {
  await page.waitForFunction(() => document.documentElement.dataset.contactsReady === "true");
  await settled(page);
};
const errorsByPage = new WeakMap<Page, string[]>();
const close = async (page: Page) => {
  await page.context().close();
  expect(errorsByPage.get(page), "No hydration or unexpected HTTP errors during the scenario").toEqual([]);
};
const open = async (path: string, width = 1440, seen = true) => {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    hasTouch: width === 390,
    isMobile: width === 390,
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    const expectedFailure =
      response.status() === 500 && url.pathname === "/api/contacts/books/kunden/contacts" && url.searchParams.get("favorites") === "true";
    if (response.status() >= 400 && !expectedFailure) errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    if (seen) await context.addCookies([{ name: "cloud_seen_hints", value: "contacts.favorites-tab", url: server.url.href }]);
    await page.clock.setFixedTime(new Date(TIME));
    await page.goto(new URL(path, server.url).href);
    await ready(page);
    expect(errors, "No hydration or mount request errors").toEqual([]);
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const visit = async (page: Page, path: string) => {
  await page.goto(new URL(path, server.url).href);
  await ready(page);
};
const head = (page: Page) => page.locator(".k2b-app-workspace__head");
const tabs = (page: Page) => page.locator(".k2b-app-workspace__head-views");
const tab = (page: Page, name: "Alle" | "Favoriten") => tabs(page).getByRole("link", { name: new RegExp(`^${name}\\b`) });
const sidebar = (page: Page) => page.locator(".k2b-app-workspace__sidebar");
const detail = (page: Page) => page.locator(".k2b-app-workspace__detail");
const menu = (page: Page) => head(page).getByRole("button", { name: "Aktionen für das Kontaktbuch", exact: true });
const visible = async (locator: Locator) => {
  await locator.waitFor({ state: "visible" });
  expect(await locator.isVisible()).toBe(true);
};
const hidden = async (locator: Locator) => {
  await locator.waitFor({ state: "hidden" });
  expect(await locator.isVisible()).toBe(false);
};
const box = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (!value) throw new Error(`Missing box: ${locator}`);
  return value;
};
const shot = async (page: Page, state: string, theme: string, width: number) => {
  await settled(page);
  if (reviewShots) await page.screenshot({ path: join(shots, `${state}-${theme}-${width}.png`) });
};
const current = async (page: Page, favorites: boolean) => {
  expect(new URL(page.url()).searchParams.get("favorites") === "true").toBe(favorites);
  expect(await tab(page, favorites ? "Favoriten" : "Alle").getAttribute("aria-current")).toBe("page");
  expect(await tabs(page).locator('[aria-current="page"]').count()).toBe(1);
};
const stableFrame = async (page: Page) => {
  const raw = await page.locator("html").getAttribute("data-server-geometry");
  if (!raw) throw new Error("Missing pre-hydration frame");
  const before: ReturnType<typeof frame> = JSON.parse(raw);
  const after = await page.evaluate(frame);
  expect(after.length).toBe(before.length);
  expect(after.filter((part) => part.key.includes("contact=")).length).toBe(5);
  for (const [index, part] of after.entries()) {
    expect(part.key).toBe(before[index]!.key);
    for (const axis of ["x", "y", "width", "height"] as const)
      expect(Math.abs(part[axis] - before[index]![axis]), `${part.key}: ${axis}`).toBeLessThanOrEqual(0.5);
  }
};

// Every case exercises the new objects/sidebar + views/head seam; reverting its
// ContactsWorkspace composition prevents these selectors and behaviors from existing.
describe(`Contacts workspace SSR and hydration in ${browserName}`, () => {
  test("1. Favorites is URL-backed across all/books, reload and document Back/Forward", async () => {
    const page = await open("/app/contacts?favorites=true");
    try {
      for (const path of ["/app/contacts", "/app/contacts/kunden"]) {
        await visit(page, `${path}?favorites=true`);
        await current(page, true);
        await page.reload();
        await ready(page);
        await current(page, true);
        for (const name of ["Alle", "Favoriten", "Alle"] as const) {
          await tab(page, name).click();
          await ready(page);
          await current(page, name === "Favoriten");
        }
        await page.goBack();
        await ready(page);
        await current(page, true);
        await page.goBack();
        await ready(page);
        await current(page, false);
        await page.goForward();
        await ready(page);
        await current(page, true);
        await page.goForward();
        await ready(page);
        await current(page, false);
      }
    } finally {
      await close(page);
    }
  }, 30_000);

  test("2. Objects stay current in the sidebar; Favorites is never a sidebar row", async () => {
    const page = await open("/app/contacts?favorites=true");
    try {
      await visible(sidebar(page));
      expect(await sidebar(page).getByRole("link", { name: "Alle Kontakte", exact: true }).getAttribute("aria-current")).toBe("page");
      expect(await sidebar(page).getByRole("link", { name: "Favoriten", exact: true }).count()).toBe(0);
      await visit(page, "/app/contacts/kunden?favorites=true");
      expect(await sidebar(page).getByRole("link", { name: "Kunden", exact: true }).getAttribute("aria-current")).toBe("page");
      expect(await sidebar(page).getByRole("link", { name: "Favoriten", exact: true }).count()).toBe(0);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("3. The real server hint is anchored, dismissed and consumed by visiting Favorites", async () => {
    const page = await open("/app/contacts", 1440, false);
    try {
      const hint = page.locator(".k2b-moved-hint");
      await visible(hint);
      expect(await hint.textContent()).toContain("Favoriten sind jetzt ein Tab oben.");
      const row = await box(sidebar(page).getByRole("link", { name: "Alle Kontakte", exact: true }));
      const popover = await box(hint);
      expect(popover.y).toBeGreaterThanOrEqual(row.y + row.height);
      expect(popover.x).toBeLessThan(row.x + row.width);
      expect(popover.x + popover.width).toBeGreaterThan(row.x);
      await hint.getByRole("button").click();
      await hidden(hint);
      expect((await storedCookie(page, "cloud_seen_hints"))?.value).toContain("contacts.favorites-tab");
      const response = await page.reload();
      await ready(page);
      expect(await response!.text()).not.toContain("Favoriten sind jetzt ein Tab oben.");
    } finally {
      await close(page);
    }
    const fresh = await open("/app/contacts", 1440, false);
    try {
      await tab(fresh, "Favoriten").click();
      await ready(fresh);
      await hidden(fresh.locator(".k2b-moved-hint"));
      await storedCookie(fresh, "cloud_seen_hints");
      await fresh.goBack();
      await ready(fresh);
      const response = await fresh.request.get(fresh.url());
      expect(await response.text()).not.toContain("Favoriten sind jetzt ein Tab oben.");
      // Also prove server-side consumption for a directly opened Favorites URL (no client click).
      await fresh.context().clearCookies();
      await visit(fresh, "/app/contacts?favorites=true");
      expect((await storedCookie(fresh, "cloud_seen_hints"))?.value).toContain("contacts.favorites-tab");
      expect(await (await fresh.request.get(new URL("/app/contacts", server.url).href)).text()).not.toContain(
        "Favoriten sind jetzt ein Tab oben.",
      );
    } finally {
      await close(fresh);
    }
    const empty = await open("/app/contacts?noBooks=1", 1440, false);
    try {
      expect(await (await empty.request.get(empty.url())).text()).not.toContain("Favoriten sind jetzt ein Tab oben.");
      await hidden(empty.locator(".k2b-moved-hint"));
    } finally {
      await close(empty);
    }
  }, 30_000);

  test("4. Book actions honor permissions, keyboard focus and selection mode", async () => {
    const page = await open("/app/contacts");
    try {
      expect(await menu(page).count()).toBe(0);
      await visit(page, "/app/contacts/presse");
      expect(await menu(page).count()).toBe(0);
      await visit(page, "/app/contacts/kunden");
      await menu(page).focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect(
        await menu(page).evaluate((element) => {
          const style = getComputedStyle(element);
          return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
        }),
      ).toBe(true);
      await menu(page).press("Enter");
      for (const name of ["Buch-Einstellungen", "Duplikate", "Auswählen"]) await visible(page.getByRole("menuitem", { name, exact: true }));
      await page.getByRole("menuitem", { name: "Auswählen", exact: true }).click();
      await visible(page.getByRole("checkbox").first());
      await menu(page).press("Enter");
      await visible(page.getByRole("menuitem", { name: "Auswahl beenden", exact: true }));
      await page.getByRole("menuitem", { name: "Auswahl beenden", exact: true }).click();
      await hidden(page.getByRole("checkbox").first());
      await visit(page, "/app/contacts/lieferanten");
      await menu(page).press("Enter");
      expect(await page.getByRole("menuitem", { name: "Buch-Einstellungen", exact: true }).count()).toBe(0);
      await visible(page.getByRole("menuitem", { name: "Auswählen", exact: true }));
    } finally {
      await close(page);
    }
  }, 30_000);

  test("5. Phone detail is a page and both Back paths preserve the list position", async () => {
    const page = await open("/app/contacts", 390);
    try {
      // Resolve the real list's scroll owner; some workspace layouts scroll the document.
      await page.evaluate(() => {
        const row = document.querySelector("[data-contact-row]");
        let parent = row?.parentElement;
        while (parent && !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)))
          parent = parent.parentElement;
        (parent ?? document.scrollingElement)!.scrollTop = 240;
      });
      await settled(page);
      const scrollPosition = () =>
        page.evaluate(() => {
          let parent = document.querySelector("[data-contact-row]")?.parentElement;
          while (parent && !(parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)))
            parent = parent.parentElement;
          return (parent ?? document.scrollingElement)!.scrollTop;
        });
      const before = await scrollPosition();
      expect(before).toBe(240);
      const row = page.locator("[data-contact-row]").nth(6);
      const href = await row.getAttribute("href");
      for (const back of ["history", "control"]) {
        await row.tap();
        await page.waitForURL((url) => url.searchParams.has("contact") && url.searchParams.has("contactBook"));
        expect(new URL(page.url()).searchParams.get("contact")).toBe(new URL(href!, server.url).searchParams.get("contact"));
        await visible(detail(page));
        expect(await detail(page).getAttribute("data-workspace-detail-phone")).toBe("page");
        const bounds = await box(detail(page));
        expect(Math.abs(bounds.y)).toBeLessThanOrEqual(1);
        expect(bounds.height).toBeGreaterThanOrEqual(843);
        expect(bounds.width).toBeGreaterThanOrEqual(389);
        await hidden(detail(page).locator("[data-workspace-detail-close]"));
        await visible(detail(page).getByRole("button", { name: "Kontakte", exact: true }));
        if (back === "history") await page.goBack();
        else await detail(page).getByRole("button", { name: "Kontakte", exact: true }).tap();
        await page.waitForURL((url) => !url.searchParams.has("contact") && !url.searchParams.has("contactBook"));
        await hidden(detail(page));
        await settled(page);
        expect(Math.abs((await scrollPosition()) - before)).toBeLessThanOrEqual(1);
        const rowBox = await box(row);
        expect(rowBox.y).toBeGreaterThanOrEqual(0);
        expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(844);
      }
    } finally {
      await close(page);
    }
  }, 30_000);

  test("6. Visible sidebar removes duplicate titles and book descriptions", async () => {
    const page = await open("/app/contacts");
    try {
      for (const width of [1440, 1194])
        for (const path of ["/app/contacts", "/app/contacts/kunden"]) {
          await page.setViewportSize({ width, height: 1000 });
          await visit(page, path);
          await visible(sidebar(page));
          const titles = page.locator(
            ".k2b-app-workspace__head :is(h1,h2,h3,.k2b-page-title,[data-k2b-page-trail-title],.k2b-app-workspace__head-heading),.k2b-app-workspace__main :is(h1,h2,h3)",
          );
          for (const title of await titles.all()) {
            // A semantic heading may exist, but must be visually hidden rather than paint a title.
            expect(
              await title.evaluate((element) => {
                const r = element.getBoundingClientRect();
                const s = getComputedStyle(element);
                return (
                  s.display === "none" ||
                  s.visibility === "hidden" ||
                  (r.width <= 1 && r.height <= 1) ||
                  s.clipPath !== "none" ||
                  s.clip !== "auto"
                );
              }),
            ).toBe(true);
          }
          for (const book of books) expect(await page.getByText(book.description!, { exact: true }).count()).toBe(0);
          expect(await head(page).locator(".k2b-app-workspace__head-title:visible").count()).toBe(0);
        }
    } finally {
      await close(page);
    }
  }, 30_000);

  for (const theme of ["light", "dark"])
    test(`7. Tag dots and names stay readable, including active Rückruf (${theme})`, async () => {
      const page = await open(`/app/contacts/kunden?theme=${theme}`);
      try {
        for (const active of [false, true]) {
          if (active) {
            await head(page).getByRole("link", { name: "Rückruf", exact: true }).click();
            await page.waitForURL((url) => url.searchParams.get("tag_id") === "rueckruf");
            await visible(head(page).locator(".contacts-head-count"));
          }
          for (const tag of tags) {
            const chip = head(page).getByRole("link", { name: tag.name, exact: true });
            const dot = chip.locator(".contacts-tag-dot");
            await visible(dot);
            const dotBox = await box(dot);
            expect(dotBox.width).toBeGreaterThan(0);
            expect(dotBox.height).toBeGreaterThan(0);
            expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
              `rgb(${[1, 3, 5].map((offset) => Number.parseInt(tag.color.slice(offset, offset + 2), 16)).join(", ")})`,
            );
            expect(await chip.textContent()).toContain(tag.name);
            const ratio = await chip.evaluate((element, name) => {
              const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
              const composite = (...colors: string[]) => {
                canvas.clearRect(0, 0, 1, 1);
                for (const color of colors) {
                  canvas.fillStyle = color;
                  canvas.fillRect(0, 0, 1, 1);
                }
                return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
              };
              const ancestors: Element[] = [];
              for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
              const backgrounds = ancestors.map((ancestor) => getComputedStyle(ancestor).backgroundColor);
              const label = Array.from(element.querySelectorAll("span")).find((span) => span.textContent?.trim() === name) ?? element;
              const ink = composite("white", ...backgrounds, getComputedStyle(label).color);
              const fill = composite("white", ...backgrounds);
              const luminance = (rgb: number[]) => {
                const values = rgb.map((c) => {
                  const s = c / 255;
                  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                });
                return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
              };
              const a = luminance(ink),
                b = luminance(fill);
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            }, tag.name);
            expect(ratio, `${tag.name}, ${theme}, active=${active}`).toBeGreaterThanOrEqual(4.5);
          }
          if (active)
            expect(await head(page).getByRole("link", { name: "Rückruf", exact: true }).getAttribute("aria-current")).toBe("true");
        }
      } finally {
        await close(page);
      }
    }, 30_000);

  test("8. Quiet count and Reset follow filters, not sort or Favorites", async () => {
    const page = await open("/app/contacts/kunden");
    const count = head(page).locator(".contacts-head-count");
    const reset = head(page).getByRole("link", { name: "Zurücksetzen", exact: true });
    try {
      for (const query of ["", "?sort=updated", "?favorites=true"]) {
        await visit(page, `/app/contacts/kunden${query}`);
        expect(await count.count()).toBe(0);
        expect(await reset.count()).toBe(0);
      }
      await head(page).getByRole("searchbox").fill("Alina");
      await page.waitForURL((url) => url.searchParams.get("search") === "Alina");
      await visible(count);
      expect(await count.textContent()).toBe("1 Treffer");
      await visible(reset);
      await head(page).getByRole("button", { name: "Suche zurücksetzen", exact: true }).click();
      await hidden(count);
      await hidden(reset);
      await head(page).getByRole("link", { name: "Stammkunde", exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get("tag_id") === "stammkunde");
      await visible(count);
      await visible(reset);
      expect(await count.textContent()).toMatch(/\d+ Treffer/);
      await reset.click();
      await hidden(count);
      await hidden(reset);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("9. Detail column fits the host and waits behind Details at 782px", async () => {
    const page = await open("/app/contacts/kunden?host=952&contact=person1&contactBook=kunden");
    const toggle = page.locator(".k2b-app-workspace__detail-toggle");
    try {
      for (const [width, host] of [
        [1440, 952],
        [1440, 0],
        [1194, 0],
      ]) {
        await page.setViewportSize({ width: width!, height: 1000 });
        await visit(page, `/app/contacts/kunden?contact=person1&contactBook=kunden${host ? `&host=${host}` : ""}`);
        await visible(detail(page));
        await hidden(toggle);
        const main = await box(page.locator(".k2b-app-workspace__main"));
        const panel = await box(detail(page));
        expect(main.width).toBeGreaterThanOrEqual(368);
        expect(panel.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
      }
      await page.setViewportSize({ width: 1194, height: 1000 });
      await visit(page, "/app/contacts/kunden?host=782&contact=person1&contactBook=kunden");
      await hidden(detail(page));
      await visible(toggle);
      await toggle.click();
      await visible(detail(page));
      await page.keyboard.press("Escape");
      await hidden(detail(page));
      await visible(toggle);
      expect(new URL(page.url()).searchParams.get("contact")).toBe("person1");
    } finally {
      await close(page);
    }
  }, 30_000);

  test("10. German phone tabs fit and lead the card", async () => {
    // Both pages have a way up in Cloud's trail (Start, Kontakte), so the shared head puts the title row first and the
    // tabs directly below it, at the top of the card's content (F4).
    for (const [path, title] of [
      ["/app/contacts", true],
      ["/app/contacts/kunden", true],
    ] as const) {
      const page = await open(path, 390);
      try {
        const labels = tabs(page).locator(".k2b-view-tabs__label");
        expect(await labels.count()).toBeGreaterThanOrEqual(2);
        for (const label of await labels.all())
          if (await label.isVisible()) expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        const views = await box(tabs(page));
        const filters = await box(head(page).locator(".k2b-app-workspace__head-filters"));
        const card = await box(page.locator(".k2b-app-workspace"));
        if (title) {
          const heading = await box(head(page).locator(".k2b-page-title").first());
          expect(views.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
          expect(views.y - (heading.y + heading.height)).toBeLessThanOrEqual(16);
        } else expect(views.y - card.y).toBeLessThanOrEqual(16);
        expect(filters.y).toBeGreaterThanOrEqual(views.y + views.height - 1);
        expect((await box(sidebar(page))).y).toBeGreaterThanOrEqual(views.y + views.height - 1);
      } finally {
        await close(page);
      }
    }
  }, 30_000);

  for (const width of [1440, 1194, 834, 390])
    test(`11. Server and hydrated frame agree, also after reload (${width}px)`, async () => {
      const page = await open("/app/contacts/kunden", width);
      try {
        await stableFrame(page);
        await page.reload();
        await ready(page);
        await stableFrame(page);
      } finally {
        await close(page);
      }
    }, 30_000);

  for (const width of [1440, 1194, 834, 390])
    test(`12. Selecting Favorites moves no head neighbor (${width}px)`, async () => {
      const page = await open("/app/contacts/kunden", width);
      const neighbors = () =>
        page
          .locator(
            ".k2b-app-workspace__head-views,.k2b-app-workspace__head-filters,.k2b-app-workspace__head-actions,[data-workspace-primary]",
          )
          .evaluateAll((elements) =>
            elements.map((element, index) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, height, ...(index === 0 ? {} : { width }) };
            }),
          );
      try {
        const before = await neighbors();
        expect(before.length).toBe(4);
        await tab(page, "Favoriten").click();
        await ready(page);
        await current(page, true);
        expect(await neighbors()).toEqual(before);
      } finally {
        await close(page);
      }
    }, 30_000);

  for (const width of [1440, 390])
    test(`A count-only failure offers Retry without moving the head (${width}px)`, async () => {
      const page = await open("/app/contacts/kunden", width);
      try {
        const before = await page.evaluate(frame);
        await page.route("**/api/contacts/books/kunden/contacts?**", (route) => {
          const query = new URL(route.request().url()).searchParams;
          return query.get("per_page") === "1" && query.get("favorites") === "true"
            ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Count unavailable" }) })
            : route.continue();
        });
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("contacts:favorite-changed", { detail: { bookId: "kunden", contactId: "person1", favorite: false } }),
          ),
        );
        const retry = head(page).getByRole("button", {
          name: "Die Kontaktzahlen konnten nicht aktualisiert werden. Erneut versuchen",
          exact: true,
        });
        await visible(retry);
        await visible(head(page).getByRole("alert"));
        expect(await page.evaluate(frame)).toEqual(before);
        await shot(page, "count-error", "light", width);
        await page.unrouteAll({ behavior: "wait" });
        await retry.click();
        await hidden(retry);
        await hidden(head(page).getByRole("alert"));
        expect(await page.evaluate(frame)).toEqual(before);
      } finally {
        await close(page);
      }
    }, 30_000);

  test("13. Reduced motion gives Detail and the drawer no running transitions", async () => {
    const page = await open("/app/contacts/kunden", 390);
    const noMotion = async () => {
      expect(
        await detail(page).evaluate((element) => {
          const durations = getComputedStyle(element)
            .transitionDuration.split(",")
            .map((value) => parseFloat(value));
          return (
            durations.every((value) => value === 0) ||
            element.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running")
          );
        }),
      ).toBe(true);
    };
    try {
      await page.locator("[data-contact-row]").first().tap();
      await visible(detail(page));
      await noMotion();
      await page.setViewportSize({ width: 1194, height: 1000 });
      await visit(page, "/app/contacts/kunden?host=782&contact=person1&contactBook=kunden");
      await page.locator(".k2b-app-workspace__detail-toggle").click();
      await visible(detail(page));
      await noMotion();
    } finally {
      await close(page);
    }
  }, 30_000);

  // Screenshots are review artifacts, never pixel assertions. Each combination
  // is a separate bounded case so a slow capture cannot consume the whole suite.
  for (const [theme, widths] of reviewShots
    ? ([
        ["light", [1440, 1194, 834, 390, 1920]],
        ["dark", [1440, 390]],
      ] as const)
    : ([["light", [1440]]] as const))
    for (const width of widths)
      test(`Loading keeps the rows and a failed refresh offers Retry (${theme} ${width}px; review screenshots when asked)`, async () => {
        const page = await open(`/app/contacts?theme=${theme}`, width);
        try {
          const states = [
            ["all", "/app/contacts"],
            ["book", "/app/contacts/kunden"],
            ["book-favorites", "/app/contacts/kunden?favorites=true"],
            ["book-tag", "/app/contacts/kunden?tag_id=rueckruf"],
            ["book-search-empty", "/app/contacts/kunden?search=NiemandGefunden"],
            ["book-empty", "/app/contacts/kunden?fixtureEmpty=book"],
            ["favorites-empty", "/app/contacts/presse?favorites=true"],
            ["book-readonly", "/app/contacts/presse"],
            ["detail", "/app/contacts/kunden?contact=person1&contactBook=kunden"],
            ["long-name", "/app/contacts/kunden?contact=person13&contactBook=kunden"],
            ["panel-1440", "/app/contacts/kunden?host=952&contact=person1&contactBook=kunden"],
            ["panel-1194", "/app/contacts/kunden?host=782&contact=person1&contactBook=kunden"],
          ] as const;
          for (const [state, path] of reviewShots ? states : []) {
            await visit(page, `${path}${path.includes("?") ? "&" : "?"}theme=${theme}`);
            await shot(page, state, theme, width);
            if (width === 390 && state === "detail") await shot(page, "phone-detail", theme, width);
          }
          await page.context().clearCookies();
          await visit(page, `/app/contacts?theme=${theme}`);
          if (width >= 1194) await visible(page.locator(".k2b-moved-hint"));
          await shot(page, "all-hint", theme, width);
          await page.context().addCookies([{ name: "cloud_seen_hints", value: "contacts.favorites-tab", url: server.url.href }]);
          await visit(page, `/app/contacts/kunden?theme=${theme}`);
          await menu(page).press("Enter");
          await visible(page.getByRole("menuitem", { name: "Auswählen", exact: true }));
          await shot(page, "book-menu", theme, width);
          await page.keyboard.press("Escape");
          // Hold the response with a promise, not a timed delay; always release it on failure.
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          await page.route("**/api/contacts/books/kunden/contacts?**", async (route) => {
            await gate;
            await route.continue();
          });
          try {
            // While a change loads, the committed rows stay at their height and place and the search shows it is busy.
            const rows = page.locator("[data-contact-row]");
            const before = await rows.evaluateAll((items) => items.slice(0, 5).map((item) => item.getBoundingClientRect().toJSON()));
            await head(page).getByRole("searchbox").fill("Alina");
            await visible(head(page).locator(".contacts-head-search .ti-loader-2"));
            expect(await rows.evaluateAll((items) => items.slice(0, 5).map((item) => item.getBoundingClientRect().toJSON()))).toEqual(
              before,
            );
            await shot(page, "loading", theme, width);
          } finally {
            release();
          }
          await visible(head(page).locator(".contacts-head-count"));
          await page.unrouteAll({ behavior: "wait" });
          // Fail only the list read; the tabs' count reads (per_page=1) keep answering.
          await page.route("**/api/contacts/books/kunden/contacts?**", (route) =>
            new URL(route.request().url()).searchParams.get("per_page") === "1"
              ? route.continue()
              : route.fulfill({
                  status: 500,
                  contentType: "application/json",
                  body: JSON.stringify({ error: "Fixture: Kontakte konnten nicht geladen werden" }),
                }),
          );
          // A failed refresh of the shown list keeps the rows and names the failure with a retry in a fixed place.
          // A failed filter change instead falls back to a document load, which the server renders.
          await visit(page, `/app/contacts/kunden?favorites=true&theme=${theme}`);
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("contacts:favorite-changed", { detail: { bookId: "kunden", contactId: "person1", favorite: false } }),
            ),
          );
          const retry = page.getByRole("button", { name: "Erneut versuchen", exact: true });
          await visible(retry);
          await visible(page.getByRole("alert"));
          await shot(page, "error", theme, width);
          await page.unrouteAll({ behavior: "wait" });
          await retry.click();
          await hidden(retry);
          await hidden(page.getByRole("alert"));
        } finally {
          await close(page);
        }
      }, 30_000);
});
