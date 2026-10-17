import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { type ItemListResult, SetCompletedSchema, type Space, type SpaceColumn, type SpaceItem } from "@/contracts";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { spaceMessages } from "../../messages";
import { defaultFilter } from "../filter/types";

// Whether a tap beside the completion box ticks it is a layout question, so the List route renders on the server and
// then runs its real island bundle in a real browser, as the workspace page does.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-list-browser-"));
const workspaceDir = resolve(import.meta.dir, "../workspace");
const { plugin } = createConfig({ dev: false, verbose: false, rootDir: root, componentRoots: [workspaceDir] });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: ListFixture } = await import("./item-list.browser-fixture");

const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];

const space: Space = {
  id: "Space1",
  name: "Spring fair",
  description: null,
  color: "#3b82f6",
  icalToken: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: space.id, name: "To do", color: "#3b82f6", rank: "1", isDone: false },
  { id: "Col002", spaceId: space.id, name: "Done", color: null, rank: "2", isDone: true },
];
const item = (id: string, title: string): SpaceItem => ({
  id,
  spaceId: space.id,
  columnId: "Col001",
  title,
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: id,
  completedAt: null,
  createdBy: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: new Date().toISOString(),
  assignees: [],
  tags: [],
});
const currentUserId = "11111111-1111-4111-8111-111111111111";
const tasks = [item("Item01", "Order banners"), item("Item02", "Ask the bakery"), item("Item03", "Draft the schedule")];
let items = [...tasks];
const result = (): ItemListResult => ({ items, total: items.length, page: 1, pageSize: 30, totalPages: 1 });
const baseUrl = `/app/spaces/${space.id}?view=list&status=all&groupBy=none`;
const { t } = spaceMessages.resolve(["en"]);
const serverBody = () =>
  renderToString(() =>
    createComponent(ListFixture, {
      locale: "en",
      spaceId: space.id,
      currentView: "list",
      columns,
      tags: [],
      filter: { ...defaultFilter, status: "all", groupBy: "none" },
      initialItemsResult: result(),
      initialSelectedItemId: "",
      itemLinkBaseUrl: baseUrl,
      paginationBaseUrl: `${baseUrl}&page=`,
      canWrite: true,
      currentUserId,
    }),
  );
let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const pages = new Map<string, string>();
const requests: { path: string; method: string; body: unknown }[] = [];

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
      const completion = /^\/api\/spaces\/Space1\/items\/(\w+)\/completed$/.exec(url.pathname);
      if (completion && request.method === "POST") {
        const body: unknown = await request.json();
        requests.push({ path: url.pathname, method: request.method, body });
        const parsed = SetCompletedSchema.safeParse(body);
        if (!parsed.success) return Response.json({ message: "Invalid completion" }, { status: 400 });
        const previous = items.find((task) => task.id === completion[1]);
        if (!previous) return Response.json({ message: "Item not found" }, { status: 404 });
        const changed = {
          ...previous,
          completedAt: parsed.data.completed ? new Date().toISOString() : null,
          columnId: parsed.data.completed ? "Col002" : "Col001",
        };
        items = items.map((task) => (task.id === changed.id ? changed : task));
        return Response.json(changed);
      }
      if (url.pathname === "/api/spaces/workspace/view" && request.method === "GET") {
        requests.push({ path: url.pathname, method: request.method, body: null });
        return Response.json({ kind: "list", currentView: "list", itemsResult: result() });
      }
      const html = url.pathname === `/app/spaces/${space.id}` ? pages.get(url.searchParams.get("case") ?? "") : undefined;
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

const pageHtml = () =>
  `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
  "<style>solid-client,solid-island{display:contents}</style></head>" +
  `<body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box;padding:var(--ui-space-shell)">${serverBody()}</main>` +
  `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`;
let caseCounter = 0;
type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const tablet: View = { width: 820, height: 1180, touch: true };
const open = async (view: View, list: SpaceItem[] = tasks) => {
  items = [...list];
  requests.splice(0);
  const id = `case${++caseCounter}`;
  pages.set(id, pageHtml());
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  const page = await context.newPage();
  await page.goto(`${server.url.toString().replace(/\/$/, "")}${baseUrl}&case=${id}`);
  await page.evaluate(() => document.fonts.ready);
  // Solid replaces server field IDs with client IDs when the route mounts.
  await page.waitForSelector('[data-space-list-row] .k2b-check input[id^="k2b-field-cl-"]', { timeout: 15_000 });
  return page;
};

describe("Spaces List completion in a browser", () => {
  for (const [name, view] of [
    ["phone", phone],
    ["tablet", tablet],
  ] as const) {
    test(`${name}: taps beside the 16 px checkbox complete only that task without opening it`, async () => {
      const page = await open(view);
      try {
        const errors: string[] = [];
        page.on("response", (response) => {
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
        });
        for (const [task, dx, dy] of [
          [tasks[0]!, 0, 12],
          [tasks[1]!, -10, 0],
        ] as const) {
          const checkbox = page.getByRole("checkbox", { name: `${t.markComplete}: ${task.title}`, exact: true });
          const box = await checkbox.locator("..").locator(".k2b-check__control").boundingBox();
          if (!box) throw new Error("Missing checkbox visual box");
          expect([box.width, box.height]).toEqual([16, 16]);
          const point = { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
          // Chromium's touch adjustment would snap a near miss onto the box, so the hit test proves the touch area itself.
          expect(
            await checkbox.evaluate(
              (input, { x, y }) => document.elementFromPoint(x, y)?.closest(".k2b-check") === input.closest(".k2b-check"),
              point,
            ),
          ).toBe(true);
          const refreshed = page.waitForResponse((response) => response.url().includes("/api/spaces/workspace/view"));
          await page.touchscreen.tap(point.x, point.y);
          await page.waitForFunction((label) => {
            const input = document.querySelector(`input[aria-label="${label}"]`);
            return input instanceof HTMLInputElement && input.checked;
          }, `${t.markComplete}: ${task.title}`);
          await refreshed;
          expect(await checkbox.isChecked()).toBe(true);
          expect(requests.filter((request) => request.path.endsWith("/completed"))).toEqual(
            tasks.slice(0, task === tasks[0] ? 1 : 2).map((entry) => ({
              path: `/api/spaces/${space.id}/items/${entry.id}/completed`,
              method: "POST",
              body: { completed: true },
            })),
          );
          expect(page.url()).not.toContain("item=");
        }
        expect(await page.getByRole("checkbox", { name: `${t.markComplete}: ${tasks[2]!.title}`, exact: true }).isChecked()).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a row puts the working assignee first in its avatar stack with one ring, in the server frame and hydrated", async () => {
    const kim = { id: "22222222-2222-4222-8222-222222222222", kind: "user" as const, displayName: "Kim Example", avatarHash: null };
    const robin = { id: currentUserId, kind: "user" as const, displayName: "Robin Example", avatarHash: null };
    const claimed: SpaceItem = {
      ...tasks[1]!,
      assignees: [robin, kim],
      claim: {
        id: "44444444-4444-4444-8444-444444444444",
        actor: { kind: "user", id: kim.id },
        displayName: kim.displayName,
        avatarHash: null,
        claimedAt: "2026-10-01T08:00:00.000Z",
      },
    };
    const page = await open(phone, [tasks[0]!, claimed, tasks[2]!]);
    try {
      const row = page.locator("[data-space-list-row]", { hasText: claimed.title });
      await row.screenshot({ path: `/tmp/spaces-list-${browserName}-claimed-row-${phone.width}-light.png`, animations: "disabled" });
      const avatars = await row
        .locator(".k2b-avatar")
        .evaluateAll((list) => list.map((avatar) => [avatar.getAttribute("aria-label"), avatar.getAttribute("data-ring")]));
      expect(avatars).toEqual([
        ["Kim Example is on it", "success"],
        ["Robin Example avatar", null],
      ]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
