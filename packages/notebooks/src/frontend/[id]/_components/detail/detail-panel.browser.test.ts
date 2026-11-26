import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import type { DetailPanelHarness } from "./detail-panel.browser-harness";

// Each fixture types its browser window locally; other harnesses use the same property.
declare const window: { harness: DetailPanelHarness };

const activityPage = {
  data: ["note.edited", "comment.created", "note.restored", "note.edited", "note.created"].map((action, index) => ({
    id: `activity-${index}`,
    actor: { kind: "user", id: "00000000-0000-4000-8000-000000000002", displayName: "Jana Berger", avatarHash: "h1" },
    action,
    metadata: { commentId: "m11" },
    occurrenceCount: 1,
    lastOccurredAt: "2026-10-16T19:18:00.000Z",
  })),
  nextCursor: null,
};
const accessMembers = [
  { principal: { type: "group", groupId: "00000000-0000-4000-8000-0000000000a1" }, permission: "write", displayName: "Lager-Team" },
  ...(
    [
      ["00000000-0000-4000-8000-000000000002", "Jana Berger", "admin"],
      ["00000000-0000-4000-8000-000000000001", "Anna Becker", "admin"],
      ["00000000-0000-4000-8000-000000000004", "Mira Schulz", "write"],
      ["00000000-0000-4000-8000-000000000003", "Paul Wagner", "read"],
      ["00000000-0000-4000-8000-000000000005", "Tom Krüger", "write"],
    ] as const
  ).map(([userId, displayName, permission]) => ({
    principal: { type: "user", userId },
    permission,
    displayName,
    // One picture and initials for the others, so the access list shows both avatar forms.
    avatarHash: displayName === "Jana Berger" ? "h1" : null,
  })),
  { principal: { type: "authenticated" }, permission: "read" },
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "detail-panel.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    // The PDF dialog includes MapLibre's import.meta worker URLs.
    format: "esm",
    plugins: [
      {
        name: "solid-detail-panel-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail-panel harness.");
  const bundle = await build.outputs[0]!.text();
  // Use the shipped page-head order and cascade, including the responsive switch rule.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")].map(
      async (entry) => {
        const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
        return build.outputs[0]!.text();
      },
    ),
  );
  const v2Css = await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text();
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs, v2Css].join("\n");

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/notebooks/overview/activity") return Response.json(activityPage);
      if (path === "/api/notebooks/book01/access/members") return Response.json(accessMembers);
      if (/^\/api\/accounts\/users\/[^/]+\/avatar$/.test(path))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#247b92"/><circle cx="12" cy="9" r="4" fill="#fff"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(path)) return new Response(Bun.file(resolve(ui, "dist", path.slice(1))));
      if (path.startsWith("/api/")) return new Response("Unexpected harness API", { status: 404 });
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
};
const open = async (width: number, delayActivity = false, state = "many", activityState?: "empty" | "error") => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  try {
    await page.clock.setFixedTime(new Date("2026-10-16T19:30:00.000Z"));
    if (delayActivity || activityState)
      await page.route("**/api/notebooks/overview/activity?*", async (route) => {
        if (delayActivity) {
          requested();
          await gate;
        }
        if (page.isClosed()) return;
        if (activityState === "error") return route.fulfill({ status: 500, json: { error: { message: "Fixture unavailable" } } });
        if (activityState === "empty") return route.fulfill({ json: { data: [], nextCursor: null } });
        await route.continue();
      });
    await page.goto(`${server.url}?state=${state}`);
    await page.waitForFunction(() => Boolean(window.harness));
    if (delayActivity) await request;
    else
      await page.locator('[data-k2-part="Section"]:has(h3:text-is("Aktivität")) [data-k2-part="Loading"]').waitFor({ state: "detached" });
    await settle(page);
    return { page, release };
  } catch (error) {
    release();
    await page.close();
    throw error;
  }
};
const section = (title: string) =>
  `[data-k2-part="Section"]:has(> div h3:text-is("${title}")), [data-k2-part="Section"]:has(h3:text-is("${title}"))`;
const box = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });

for (const width of [1440, 390]) {
  test(`${width}: the details are a clean v2 detail pane`, async () => {
    const { page, release } = await open(width);
    try {
      await page.mouse.move(0, 0);
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
      // nothing in the details is wider than the phone
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally {
      release();
      await page.close();
    }
  }, 60_000);

  test(`${width}: people coming, going, and the connection failing never move what is below`, async () => {
    const { page, release } = await open(width);
    try {
      const below = section("Aufgaben");
      await page.evaluate(() => window.harness.presence(0));
      await page.waitForTimeout(50);
      const alone = await box(page, below);
      const measure = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-k2-part="Pane"][data-detail] [data-k2-part="Section"]')].map(
            (element) => `${element.querySelector("h3")?.textContent}:${Math.round(element.getBoundingClientRect().height)}`,
          ),
        );
      const before = (await measure()).join(" ");
      for (const step of [() => window.harness.presence(5), () => window.harness.presence(1), () => window.harness.offline(true)]) {
        await page.evaluate(step);
        await page.waitForTimeout(50);
        const now = await box(page, below);
        const heights = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '[data-k2-part="Pane"][data-detail] [data-k2-part="Section"], [data-k2-part="Pane"][data-detail] > div > [data-k2-part="Bar"]',
            ),
          ].map(
            (element) =>
              `${element.querySelector("h3")?.textContent ?? element.getAttribute("data-k2-part")}:${Math.round(element.getBoundingClientRect().height)}`,
          ),
        );
        expect(Math.abs(now.y - alone.y), `${before} || ${heights.join(" ")}`).toBeLessThanOrEqual(0.5);
      }
    } finally {
      release();
      await page.close();
    }
  }, 60_000);
}

test("access is a read-only list that public-link readers never see", async () => {
  const members = await open(1440, false, "readonly");
  try {
    const access = members.page.locator(section("Zugriff"));
    await access.getByText("Lager-Team").waitFor();
    expect(await access.getByText("Zugriff verwalten").count()).toBe(0);
  } finally {
    members.release();
    await members.page.close();
  }
  const reader = await open(1440, false, "publiclink");
  try {
    expect(await reader.page.locator(section("Zugriff")).count()).toBe(0);
  } finally {
    reader.release();
    await reader.page.close();
  }
}, 60_000);

test("activity loads after the first picture in its own loading state and keeps what stands above it in place", async () => {
  const { page, release } = await open(1440, true);
  try {
    const activity = page.locator(section("Aktivität"));
    await activity.locator('[data-k2-part="Loading"]').waitFor();
    const above = await box(page, section("Eigenschaften"));
    release();
    await activity.locator('[data-k2-part="Loading"]').waitFor({ state: "detached" });
    await activity.getByText("Jana Berger").first().waitFor();
    const after = await box(page, section("Eigenschaften"));
    expect(Math.abs(after.y - above.y)).toBeLessThanOrEqual(0.5);
  } finally {
    release();
    await page.close();
  }
}, 60_000);

test("an own comment is edited and deleted from its menu, and the list shows each change", async () => {
  const { page, release } = await open(1440, false, "standard");
  try {
    // The fixture's own comment; the server answers each change, then the refreshed page.
    let content = "Ist fett gesetzt.";
    let deleted = false;
    const changes: string[] = [];
    await page.route("**/api/notebooks/book01/notes/*/comments/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/comments/page")) {
        const items = (await page.evaluate(() => window.harness.comments())).filter((item) => !(deleted && item.id === "c3"));
        return route.fulfill({
          json: {
            page: 1,
            perPage: 30,
            total: items.length,
            hasNext: false,
            items: items.map((item) => (item.id === "c3" ? { ...item, content } : item)),
          },
        });
      }
      changes.push(`${request.method()} ${path.split("/").at(-1)}`);
      if (request.method() === "PATCH") {
        content = (request.postDataJSON() as { content: string }).content;
        const item = (await page.evaluate(() => window.harness.comments())).find((entry) => entry.id === "c3")!;
        return route.fulfill({ json: { ...item, content, updatedAt: "2026-10-16T19:30:00.000Z" } });
      }
      if (request.method() === "DELETE") {
        deleted = true;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ status: 404 });
    });
    const comments = page.locator(section("Kommentare"));
    const own = comments.locator('[data-k2-part="Band"]', { hasText: "Ist fett gesetzt." });

    await own.getByRole("button", { name: "Aktionen zum Kommentar" }).click();
    await page.getByRole("menuitem", { name: "Kommentar bearbeiten" }).click();
    const field = comments.getByRole("textbox", { name: "Kommentar bearbeiten" });
    await field.fill("Ist fett gesetzt, und die Grenze steht in der Tabelle.");
    await comments.getByRole("button", { name: "Kommentar speichern" }).click();
    await comments.getByText("Ist fett gesetzt, und die Grenze steht in der Tabelle.").waitFor();
    await field.waitFor({ state: "detached" });

    const edited = comments.locator('[data-k2-part="Band"]', { hasText: "und die Grenze" });
    await edited.getByRole("button", { name: "Aktionen zum Kommentar" }).click();
    await page.getByRole("menuitem", { name: "Kommentar löschen" }).click();
    // The delete asks first, and only Löschen removes it.
    await page.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
    await edited.waitFor({ state: "detached" });

    expect(changes).toEqual(["PATCH c3", "DELETE c3"]);
    expect(await comments.locator('[data-k2-part="Band"]').count()).toBe(2);
  } finally {
    release();
    await page.close();
  }
}, 60_000);
