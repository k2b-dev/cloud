import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import type { SpaceItemDetail } from "../workspace/workspace-types";

// Whether a property row keeps its boxes while hovered, edited, or open, and whether the claim ring and labels line up,
// are layout questions, so the route renders on the server and then runs its real island bundle in a real browser, as
// the workspace page does.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-detail-browser-"));
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [import.meta.dir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: DetailFixture } = await import("./item-detail.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];

const spaceId = "Space1";
const now = "2026-10-02T08:00:00.000Z";
const me = "11111111-1111-4111-8111-111111111111";
const lena = { id: "22222222-2222-4222-8222-222222222222", displayName: "Lena Example", avatarHash: null };
const tom = { id: me, displayName: "Tom Sample", avatarHash: null };
const columns: SpaceColumn[] = [{ id: "Col001", spaceId, name: "To do", color: "#3b82f6", rank: "1", isDone: false }];
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId, name: "Hardware", color: "#2563eb" },
  { id: "Tag002", spaceId, name: "Office", color: "#16a34a" },
  { id: "Tag003", spaceId, name: "Network", color: "#9333ea" },
];
const task: SpaceItem = {
  id: "Item01",
  spaceId,
  columnId: "Col001",
  title: "Print asset labels",
  description: "One label with the new name and inventory number for every computer in the office.",
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: "2026-10-06T15:00:00.000Z",
  estimatedDurationMinutes: 45,
  activeBlockerCount: 1,
  priority: "medium",
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: me,
  createdAt: "2026-09-28T09:00:00.000Z",
  updatedAt: now,
  assignees: [lena, tom],
  tags: tags.slice(0, 2),
  claim: {
    id: "33333333-3333-4333-8333-333333333333",
    actor: { kind: "user", id: lena.id },
    displayName: lena.displayName,
    avatarHash: null,
    claimedAt: "2026-10-02T07:12:00.000Z",
  },
};
const dependency = (id: string, title: string, completedAt: string | null = null) => ({ id, spaceId, title, completedAt });
const detail = (item: SpaceItem): SpaceItemDetail => ({
  item,
  comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
  commentTarget: { itemId: item.id, recurrenceId: null },
  recurringContext: null,
  references: [],
  links: [],
  attachments: [],
  checklist: [],
  blockedBy: [
    { blocker: dependency("Itm002", "Rename the computers"), createdAt: now },
    { blocker: dependency("Itm005", "Order toner", now), createdAt: now },
  ],
  blocks: [
    { dependent: dependency("Itm003", "Hand out the devices"), createdAt: now },
    { dependent: dependency("Itm004", "Close the inventory list"), createdAt: now },
  ],
});

type Scenario = { locale: "en" | "de"; canWrite?: boolean; item?: SpaceItem };
const serverBody = (scenario: Scenario) =>
  renderToString(() =>
    createComponent(DetailFixture, {
      locale: scenario.locale,
      spaceId,
      initialSource: `/app/spaces/${spaceId}?item=Item01`,
      currentUserId: me,
      columns,
      tags,
      wormholes: [],
      initialDetail: detail(scenario.item ?? task),
      dateConfig: { locale: scenario.locale, timeZone: "Europe/Berlin" },
      canWrite: scenario.canWrite ?? true,
      isAdmin: false,
      mailIntegrationAvailable: false,
    }),
  );

let css = "";
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, string>();
const writes: Array<{ method: string; path: string; body: unknown }> = [];
/** What the server holds: saved properties come back with the next detail snapshot, as from the real route. */
let stored: SpaceItem = task;
let browser: Browser;

beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === `/api/spaces/${spaceId}/items/filter`)
        return Response.json({
          items: [{ ...task, id: "Itm009", title: "Buy label tape", claim: null }],
          total: 1,
          page: 1,
          pageSize: 50,
          totalPages: 1,
        });
      if (url.pathname === `/api/spaces/${spaceId}/items/Item01/detail`) return Response.json(detail(stored));
      if (url.pathname === `/api/spaces/${spaceId}/items/Item01/comments/page`) return Response.json(detail(stored).comments);
      if (url.pathname.startsWith("/api/")) {
        if (request.method === "GET") return Response.json([]);
        const body = request.headers.get("content-type")?.includes("json") ? await request.json() : null;
        writes.push({ method: request.method, path: url.pathname, body });
        if (url.pathname === `/api/spaces/${spaceId}/items/Item01` && request.method === "PATCH") {
          stored = { ...stored, ...(body as Partial<SpaceItem>) };
          return Response.json(stored);
        }
        return Response.json({ message: "ok" });
      }
      const html = pages.get(url.searchParams.get("case") ?? "");
      return html
        ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (scenario: Scenario, theme: "light" | "dark") =>
  `<!doctype html><html lang="${scenario.locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody(scenario)}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;

let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (view: View, scenario: Scenario, theme: "light" | "dark" = "light") => {
  const id = `case${++caseCounter}`;
  pages.set(id, pageHtml(scenario, theme));
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${server.url}app/spaces/${spaceId}?item=Item01&case=${id}`);
  await page.evaluate(() => window.document.fonts.ready);
  // Hydrated icon buttons drop their server-only native title.
  await page.waitForSelector('[aria-label="Close item details"]:not([title]), [aria-label="Eintragsdetails schließen"]:not([title])', {
    timeout: 15_000,
  });
  await page.mouse.move(view.width - 2, view.height - 2);
  return page;
};

/** Every box in the detail panel, except pickers that open in the top layer. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(window.document.querySelectorAll(".k2b-detail-panel *"))
      .filter((element) => !element.closest(".k2b-choice-popover, .k2b-date-popover, .k2b-tooltip, [hidden]"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        // Class names change with state (a chevron flips while open); position and size are the contract.
        return `${element.tagName} ${[box.x, box.y, box.width, box.height].map((value) => value.toFixed(1)).join(" ")}`;
      }),
  );
const planningRow = (page: Page, term: string) =>
  page.locator(".k2b-detail-panel__summary .k2b-description-list__item", { has: page.locator("dt", { hasText: new RegExp(`^${term}$`) }) });
const clickLabel = async (page: Page, term: string) => {
  const label = (await planningRow(page, term).locator("dt").boundingBox())!;
  await page.mouse.click(label.x + 4, label.y + label.height / 2);
};
const surface = (page: Page, term: string) =>
  planningRow(page, term).evaluate((row) => {
    const control = row.querySelector(
      ":scope > dd > .k2b-field > [data-appearance] > :first-child, :scope > dd > .k2b-field > .k2b-number-input",
    );
    return control ? getComputedStyle(control, "::before").backgroundColor : "none";
  });
const transparent = "rgba(0, 0, 0, 0)";
const writesReach = async (count: number) => {
  for (let attempt = 0; attempt < 100 && writes.length < count; attempt += 1) await Bun.sleep(20);
  expect(writes.length).toBe(count);
};
const shot = (page: Page, name: string) =>
  page.locator(".k2b-detail-panel").screenshot({ path: `/tmp/spaces-detail-${browserName}-${name}.png`, animations: "disabled" });

describe("Spaces item detail in a browser", () => {
  for (const [name, view] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${name} ${theme}: property rows, blockers, and the worker line up and keep every box while hovered and open`, async () => {
        const page = await open(view, { locale: "de" }, theme);
        try {
          await shot(page, `${name}-${theme}`);
          const rest = await boxes(page);

          // Labels and values each keep one column through the planning block, controls and the blocker list included.
          const columns = await page.evaluate(() => {
            const rows = Array.from(window.document.querySelectorAll(".k2b-detail-panel__summary .k2b-description-list__item"));
            const left = (element: Element | null) => Math.round(element!.getBoundingClientRect().left);
            return {
              terms: rows.map((row) => left(row.querySelector("dt"))),
              values: rows.map((row) =>
                left(
                  row.querySelector(
                    ".k2b-date-trigger__value, .k2b-number-input__sizer, .k2b-choice-dot, .k2b-choice-pill, .spaces-dependency__icon",
                  ),
                ),
              ),
            };
          });
          expect(new Set(columns.terms).size).toBe(1);
          expect(new Set(columns.values).size).toBe(1);

          // At rest the estimate reads at the row's size, on touch screens too, where its input edits at 16 px.
          const type = await page.evaluate(() => {
            const rows = Array.from(window.document.querySelectorAll(".k2b-detail-panel__summary .k2b-description-list__item"));
            const value = (term: string) => rows.find((row) => row.querySelector("dt")?.textContent === term)!;
            const sizer = value("Schätzung").querySelector(".k2b-number-input__sizer")!;
            const input = sizer.querySelector("input")!;
            return {
              estimate: getComputedStyle(sizer, "::after").fontSize,
              text: getComputedStyle(sizer, "::after").content,
              unit: value("Schätzung").querySelector(".k2b-input-shell__affix")?.textContent ?? null,
              due: getComputedStyle(value("Fällig").querySelector(".k2b-date-trigger__value")!).fontSize,
              input: { size: getComputedStyle(input).fontSize, opacity: getComputedStyle(input).opacity },
            };
          });
          expect(type.estimate).toBe(type.due);
          expect(type.text).toContain("45 min");
          expect(type.unit).toBeNull();
          expect(type.input).toEqual({ size: view.touch ? "16px" : type.due, opacity: "0" });

          // The collapsed details row starts where every other section heading starts.
          const headings = await page.evaluate(() =>
            Array.from(
              window.document.querySelectorAll(
                ".k2b-detail-panel__group .k2b-detail-panel__section-header, .k2b-detail-panel__group .k2b-detail-panel__section-summary",
              ),
            )
              .filter((element) => !element.closest("[hidden]"))
              .map((element) => {
                const icon = element.querySelector(".k2b-detail-panel__section-icon")!.getBoundingClientRect();
                const title = element.querySelector("h3, .k2b-detail-panel__section-title")!.getBoundingClientRect();
                return [Math.round(icon.left), Math.round(title.left)].join(" ");
              }),
          );
          expect(new Set(headings).size).toBe(1);

          // Hovering a row paints its quiet surface and moves nothing; the blocker's remove button only fades in.
          for (const term of ["Fällig", "Schätzung", "Priorität", "Tags"]) {
            expect(await surface(page, term)).toBe(transparent);
            if (view.touch) continue;
            const label = (await planningRow(page, term).locator("dt").boundingBox())!;
            await page.mouse.move(label.x + 4, label.y + label.height / 2);
            expect(await surface(page, term)).not.toBe(transparent);
            expect(await boxes(page)).toEqual(rest);
          }
          const blocker = page.locator(".spaces-dependency", { hasText: "Rename the computers" });
          const remove = blocker.getByRole("button", { name: "Blockierung durch Rename the computers entfernen" });
          if (!view.touch) {
            expect(await remove.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
            await blocker.hover();
            expect(await remove.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
            expect(await boxes(page)).toEqual(rest);
          } else expect(await remove.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

          // Opening a picker from its label leaves the panel where it was.
          for (const term of ["Priorität", "Tags", "Fällig"]) {
            await clickLabel(page, term);
            expect(await planningRow(page, term).locator('[aria-expanded="true"]').count()).toBe(1);
            expect(await boxes(page)).toEqual(rest);
            if (term === "Priorität") await shot(page, `${name}-${theme}-priority-open`);
            await page.keyboard.press("Escape");
          }

          // The worker: an outer ring with a gap and a label that says it, beside the same-sized avatar as the others.
          const worker = await page.evaluate(() => {
            const holder = window.document.querySelector("[data-spaces-claim-holder]")!;
            const avatar = holder.querySelector(".k2b-avatar")!;
            const other = window.document.querySelectorAll(".k2b-detail-panel .k2b-avatar")[1]!;
            return {
              ring: (({ outlineStyle, outlineWidth, outlineOffset, boxShadow }) =>
                [outlineStyle, outlineWidth, outlineOffset, boxShadow].join(" "))(getComputedStyle(avatar)),
              size: avatar.getBoundingClientRect().width,
              otherSize: other.getBoundingClientRect().width,
              label: holder.querySelector(".k2b-status-badge")?.textContent,
            };
          });
          expect(worker.ring).toBe("solid 2px 2px none");
          expect(worker.size).toBe(worker.otherSize);
          expect(worker.label).toBe("arbeitet daran");
        } finally {
          await page.context().close();
        }
      }, 60_000);
    }
  }

  test("editing a property saves it in place, and the blocker list adds and removes", async () => {
    const page = await open(desktop, { locale: "en" });
    try {
      writes.splice(0);
      stored = task;
      await clickLabel(page, "Priority");
      await page.getByRole("option", { name: "Low" }).click();
      await writesReach(1);
      expect(writes[0]).toEqual({ method: "PATCH", path: `/api/spaces/${spaceId}/items/Item01`, body: { priority: "low" } });
      expect(await planningRow(page, "Priority").locator(".k2b-choice-trigger__value").textContent()).toBe("Low");

      await clickLabel(page, "Estimate");
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("90");
      // Counts the item snapshots the panel has applied: a task after their body is read, so after the render.
      await page.evaluate(() => {
        const state = window as unknown as { __detailLoads: number };
        state.__detailLoads = 0;
        const json = Response.prototype.json;
        Response.prototype.json = async function (this: Response) {
          const body = await json.call(this);
          if (this.url.includes("/items/Item01/detail"))
            setTimeout(() => {
              state.__detailLoads += 1;
            });
          return body;
        };
      });
      await page.keyboard.press("Enter");
      await writesReach(2);
      expect(writes[1]?.body).toEqual({ estimatedDurationMinutes: 90 });
      // Enter keeps focus in the field, also once the panel shows the reloaded item; once focus leaves, the estimate
      // reads as a duration.
      await page.waitForFunction(() => (window as unknown as { __detailLoads: number }).__detailLoads > 0);
      expect(await page.evaluate(() => window.document.activeElement?.getAttribute("role"))).toBe("spinbutton");
      await page.getByRole("spinbutton", { name: "Estimate" }).blur();
      expect(
        await planningRow(page, "Estimate")
          .locator(".k2b-number-input__sizer")
          .evaluate((sizer) => (sizer as HTMLElement).dataset.value),
      ).toBe("1 h 30 min");

      await clickLabel(page, "Priority");
      await page.getByRole("option", { name: "No priority" }).click();
      await writesReach(3);
      expect(writes[2]?.body).toEqual({ priority: null });
      expect(await planningRow(page, "Priority").locator(".k2b-choice-trigger__value").textContent()).toBe("No priority");

      await page.getByRole("combobox", { name: "Add task blocker" }).click();
      await page.getByRole("option", { name: "Buy label tape" }).click();
      await writesReach(4);
      expect(writes[3]).toEqual({
        method: "POST",
        path: `/api/spaces/${spaceId}/items/Item01/blockers`,
        body: { blockerItemId: "Itm009" },
      });

      await page.locator(".spaces-dependency", { hasText: "Rename the computers" }).hover();
      await page.getByRole("button", { name: "Remove blocker Rename the computers" }).click();
      await writesReach(5);
      expect(writes[4]).toEqual({
        method: "DELETE",
        path: `/api/spaces/${spaceId}/items/Item01/blockers`,
        body: { blockerItemId: "Itm002" },
      });
      // Every save refreshed the panel without an error.
      expect(await page.locator("dialog[open]").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("readers see the same values as text without hover surfaces or edit controls", async () => {
    const page = await open(desktop, { locale: "en", canWrite: false });
    try {
      await shot(page, "reader");
      expect(await page.locator(".k2b-detail-panel [data-appearance]").count()).toBe(0);
      expect(await page.locator(".spaces-dependency__remove").count()).toBe(0);
      expect(await page.getByText("Rename the computers").count()).toBe(1);
      const rest = await boxes(page);
      await planningRow(page, "Priority").hover();
      expect(await boxes(page)).toEqual(rest);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
