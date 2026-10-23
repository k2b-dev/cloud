import { afterAll, beforeAll, test as bunTest, expect, setDefaultTimeout, setSystemTime } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestBrowserSignIn } from "@k2b/cloud/services/session/session.test-fixture";
import { createConfig } from "@k2b/ssr";
import { sql } from "bun";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { databaseSuite } from "../../../../../../../scripts/fixtures/test-infra";
import "../../../../../../../scripts/fixtures/authorization-preload";
import { launchBrowser, pageErrors, settled } from "../../../../../../ui/test/browser";
import { timeBlockScreenshotDirectory } from "../../../../../test/time-blocks-browser-fixture";
import api from "../../../../api";
import { SpaceDetailSchema } from "../../../../contracts";
import { OverviewWorkSchema } from "../../../../overview-contracts";
import { spacesService } from "../../../../service";
import { generate as generateICal } from "../../../../service/ical";
import { loadSpacesSidebar } from "../../../../service/overview";
import { SpaceTimeBlockSchema } from "../../../../time-block-contracts";
import { SpaceItemDetailSchema, SpacesViewSnapshotSchema } from "../workspace/workspace-types";
import type { TimeBlocksFixtureProps } from "./time-blocks.browser-fixture";

const suite = databaseSuite();
let failedCase: string | undefined;
/** Stop expensive follow-on cases after a failure while allowing Bun's fixture afterAll hooks to finish. */
const regression = (name: string, check: () => Promise<void>) =>
  bunTest(name, async () => {
    if (failedCase) throw new Error(`Not run after failed regression: ${failedCase}`);
    try {
      await check();
    } catch (cause) {
      failedCase = name;
      throw cause;
    }
  });
setDefaultTimeout(45_000);
const NOW = new Date("2030-03-14T08:00:00.000Z");
const TODAY = "2030-03-14";
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-time-blocks-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  // The overview and the workspace/detail islands share the production frontend root.
  componentRoots: [resolve(import.meta.dir, "../../..")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Fixture, TimeBlocksOverviewFixture } = await import("./time-blocks.browser-fixture");
const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const shots = timeBlockScreenshotDirectory;
const cases = new Map<string, Scene>();
const runtimeErrors: string[][] = [];
const additionalAccounts: string[] = [];
const cleanup: { spaceUuid: string; ownerId: string; userIds: string[]; accountId?: string }[] = [];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let css = "";
let sequence = 0;
let clientSequence = 0;
type Fault = "none" | "lost-response" | "delay";
type Scene = {
  key: string;
  spaceId: string;
  spaceUuid: string;
  taskId: string;
  taskUuid: string;
  ownerId: string;
  viewerId?: string;
  canWrite?: boolean;
  userIds: string[];
  token: string;
  accountId: string;
  html: string;
  fault: Fault;
  release?: () => void;
  posts: { id: string; status: number }[];
  moves: { status: number }[];
};
const uuid = (n: number) => `17010000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const href = (f: Scene) => `/app/spaces/${f.spaceId}?view=calendar&cv=day&cd=${TODAY}`;
const request = async (f: Scene, path: string, init?: RequestInit) =>
  api.request(path, { ...init, headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", ...init?.headers } });
const json = async (response: Response) => {
  const body: unknown = await response.json();
  expect({ status: response.status, ...(response.ok ? {} : { body }) }).toEqual({ status: 200 });
  return body;
};
const blocks = async (f: Scene) => {
  const body = await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`));
  return SpaceTimeBlockSchema.array().parse(body);
};
const taskState = async (f: Scene) => ({
  task: await sql`SELECT * FROM spaces.items WHERE id = ${f.taskUuid}::uuid`,
  work: await sql`SELECT * FROM spaces.task_work WHERE item_id = ${f.taskUuid}::uuid`,
  checklist: await sql`SELECT * FROM spaces.item_checklist_entries WHERE item_id = ${f.taskUuid}::uuid ORDER BY rank`,
  assignees: await sql`SELECT * FROM spaces.item_assignees WHERE item_id = ${f.taskUuid}::uuid ORDER BY user_id`,
});
const unrelatedSurfaces = async (f: Scene) => {
  const [views, search, ical] = await Promise.all([
    Promise.all(
      (["list", "kanban", "table"] as const).map(async (view) => {
        const source = `/app/spaces/${f.spaceId}?view=${view}`;
        const body = await json(await request(f, `/workspace/view?href=${encodeURIComponent(source)}`));
        const snapshot = SpacesViewSnapshotSchema.parse(body);
        expect(snapshot.kind).toBe(view === "table" ? "list" : view);
        if (snapshot.kind === "calendar") throw new Error("Expected a task view");
        if (snapshot.kind === "list") expect(view).toBe(snapshot.currentView);
        const items = snapshot.kind === "kanban" ? snapshot.buckets.flatMap((bucket) => bucket.items) : snapshot.itemsResult.items;
        expect(items.map((item) => item.id)).toContain(f.taskId);
        // Retain the complete response, including counters and any unexpected fields.
        return body;
      }),
    ),
    request(f, "/overview/search?q=Angebot").then(json),
    generateICal({ spaceId: f.spaceUuid, baseUrl: "https://spaces.example.test", dateConfig: { locale: "de", timeZone: "UTC" } }),
  ]);
  expect(search).toEqual([
    {
      space: expect.objectContaining({ id: f.spaceId }),
      item: expect.objectContaining({ id: f.taskId, title: "Angebot für Stadtwerke prüfen" }),
    },
  ]);
  expect(ical).toContain("BEGIN:VEVENT");
  expect(ical).toContain(`UID:${f.taskId}@spaces.cloud`);
  return { views, search, ical };
};
const scene = async (assigned = true): Promise<Scene> => {
  const n = ++sequence;
  const ownerId = uuid(n * 10 + 1),
    colleagueId = uuid(n * 10 + 2);
  const spaceUuid = uuid(n * 10 + 3),
    columnUuid = uuid(n * 10 + 4),
    taskUuid = uuid(n * 10 + 5);
  const spaceId = `B${String(n).padStart(5, "0")}`,
    columnId = `C${String(n).padStart(5, "0")}`,
    taskId = `T${String(n).padStart(5, "0")}`;
  const owned: (typeof cleanup)[number] = { spaceUuid, ownerId, userIds: [ownerId, colleagueId] };
  cleanup.push(owned);
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name) VALUES
    (${ownerId}::uuid, ${`block-browser-owner-${n}`}, 'local', 'user', 'Mira Sommer'),
    (${colleagueId}::uuid, ${`block-browser-colleague-${n}`}, 'local', 'user', 'Jan Winter')`;
  await sql`INSERT INTO spaces.spaces (id, short_id, name, color) VALUES (${spaceUuid}::uuid, ${spaceId}, 'Produktteam Nord', '#4d7c0f')`;
  await sql`INSERT INTO spaces.columns (id, short_id, space_id, name, rank) VALUES (${columnUuid}::uuid, ${columnId}, ${spaceUuid}::uuid, 'Offen', 1024)`;
  await sql`INSERT INTO spaces.items (id, short_id, space_id, column_id, title, estimated_duration_minutes, deadline, created_at, updated_at)
    VALUES (${taskUuid}::uuid, ${taskId}, ${spaceUuid}::uuid, ${columnUuid}::uuid, 'Angebot für Stadtwerke prüfen', 45, '2030-03-13T09:00:00Z', ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`;
  await sql`INSERT INTO spaces.item_assignees (item_id, user_id) VALUES (${taskUuid}::uuid, ${assigned ? ownerId : colleagueId}::uuid)`;
  const claim = { id: uuid(n * 10 + 6), actor: { kind: "user", id: assigned ? ownerId : colleagueId }, claimedAt: NOW.toISOString() };
  await sql`INSERT INTO spaces.task_work (item_id, claim) VALUES (${taskUuid}::uuid, ${claim}::jsonb)`;
  await sql`INSERT INTO spaces.item_checklist_entries (short_id, item_id, label, completed, rank) VALUES
    (${`K${String(n).padStart(4, "0")}1`}, ${taskUuid}::uuid, 'Preise vergleichen', true, 1024),
    (${`K${String(n).padStart(4, "0")}2`}, ${taskUuid}::uuid, 'Rückfragen notieren', false, 2048)`;
  const [access] = await sql<
    { id: string }[]
  >`INSERT INTO auth.access (user_id, permission) VALUES (${ownerId}::uuid, 'write') RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceUuid}::uuid, ${access!.id}::uuid)`;
  const user = await accounts.users.get({ id: ownerId });
  if (!user) throw new Error("Missing browser fixture user");
  const credential = await serviceAccountCredentials.createUserApiToken({
    user,
    browserSignIn: await createTestBrowserSignIn(ownerId),
    name: "Time block browser",
  });
  if (!credential.ok) throw new Error(credential.error.message);
  owned.accountId = credential.data.credential.serviceAccountId;
  const f: Scene = {
    key: `case${n}`,
    spaceId,
    spaceUuid,
    taskId,
    taskUuid,
    ownerId,
    userIds: [ownerId, colleagueId],
    token: credential.data.token,
    accountId: credential.data.credential.serviceAccountId,
    html: "",
    fault: "none",
    posts: [],
    moves: [],
  };
  cases.set(f.key, f);
  return f;
};
const viewAsColleague = async (f: Scene) => {
  const id = f.userIds[1]!;
  const [access] = await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${id}::uuid, 'read') RETURNING id`;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${f.spaceUuid}::uuid, ${access!.id}::uuid)`;
  const user = await accounts.users.get({ id });
  if (!user) throw new Error("Missing colleague fixture");
  const credential = await serviceAccountCredentials.createUserApiToken({
    user,
    browserSignIn: await createTestBrowserSignIn(id),
    name: "Time block reader browser",
  });
  if (!credential.ok) throw new Error(credential.error.message);
  additionalAccounts.push(credential.data.credential.serviceAccountId);
  f.token = credential.data.token;
  f.viewerId = id;
  f.canWrite = false;
};
const documentHtml = (body: string) =>
  `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style><style>solid-island,solid-client{display:contents}</style></head><body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh;box-sizing:border-box">${body}</main><script type="module">await Promise.all(Array.from(document.querySelectorAll('solid-island'),e=>import('/_ssr/'+e.dataset.id+'.js')));document.documentElement.dataset.timeBlocksFixtureReady='true'</script></body></html>`;
const render = async (f: Scene, detail = false, route = href(f)) => {
  const target = new URL(route, "http://spaces.local");
  if (detail) target.searchParams.set("item", f.taskId);
  const source = `${target.pathname}${target.search}`;
  const view = SpacesViewSnapshotSchema.parse(await json(await request(f, `/workspace/view?href=${encodeURIComponent(source)}`)));
  if (view.kind !== "calendar") throw new Error("Expected calendar snapshot");
  const { columns } = SpaceDetailSchema.parse(await json(await request(f, `/${f.spaceId}`)));
  const itemDetail = detail
    ? SpaceItemDetailSchema.parse(await json(await request(f, `/${f.spaceId}/items/${f.taskId}/detail`)))
    : undefined;
  const props: TimeBlocksFixtureProps = {
    spaceId: f.spaceId,
    baseUrl: source,
    columns,
    tags: [],
    initialState: view,
    selectedItemId: detail ? f.taskId : "",
    dateConfig: { locale: "de", timeZone: "UTC", firstDayOfWeek: 1 },
    canWrite: f.canWrite ?? true,
    currentUserId: f.viewerId ?? f.ownerId,
    detail: itemDetail,
  };
  const body = renderToString(() => createComponent(Fixture, props));
  f.html = documentHtml(body);
};
const renderOverview = async (f: Scene, url: URL) => {
  const initialView = url.searchParams.get("view") === "upcoming" ? "upcoming" : "today";
  const dateConfig = { locale: "de", timeZone: "UTC", firstDayOfWeek: 1 as const };
  const [sidebar, initialWork, activity] = await Promise.all([
    // The production SSR readers provide sidebar and activity; selected work comes through the real API.
    loadSpacesSidebar({ userId: f.ownerId, dateConfig }),
    request(f, `/overview/work?view=${initialView}`)
      .then(json)
      .then((body) => OverviewWorkSchema.parse(body)),
    spacesService.activity.list({ subject: { type: "user", userId: f.ownerId }, limit: 30 }),
  ]);
  f.html = documentHtml(
    renderToString(() =>
      createComponent(TimeBlocksOverviewFixture, {
        spaces: sidebar.spaces,
        canCreate: true,
        sidebarHint: false,
        initialView,
        initialPinnedSpaceIds: sidebar.pinnedSpaceIds,
        initialWork,
        initialActivity: {
          items: activity.items.map((item) => ({
            ...item,
            space: { id: item.space.shortId, name: item.space.name, color: item.space.color },
            item: item.item ? { id: item.item.shortId, title: item.item.title } : null,
          })),
          nextCursor: activity.nextCursor,
        },
        initialActivityError: null,
        dateConfig,
      }),
    ),
  );
};
const open = async (f: Scene, detail = false, width = 1440, view: "day" | "week" = "day", path?: string): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 760 },
    locale: "de-DE",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-case": f.key },
  });
  // Pin Date only; real timers, animation frames and performance remain available.
  await context.addInitScript((at) => {
    const RealDate = Date;
    const offset = at - RealDate.now();
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(RealDate.now() + offset);
        else super(...(args as ConstructorParameters<DateConstructor>));
      }
      static override now() {
        return RealDate.now() + offset;
      }
    }
    globalThis.Date = PinnedDate as DateConstructor;
  }, NOW.getTime());
  // Stable UUIDs for client mutation intents; real auth/session randomness stays untouched.
  await context.addInitScript((seed) => {
    let n = seed;
    crypto.randomUUID = () => `1701bbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  }, ++clientSequence * 1000);
  const page = await context.newPage();
  runtimeErrors.push(pageErrors(page));
  await page.goto(`${server.url.origin}${path ?? `${href(f).replace("cv=day", `cv=${view}`)}${detail ? `&item=${f.taskId}` : ""}`}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.documentElement.dataset.timeBlocksFixtureReady === "true");
  return page;
};
const waitFor = async (condition: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("Time block condition did not settle");
};
const shot = async (page: Page, motif: string) => {
  await settled(page);
  mkdirSync(shots, { recursive: true });
  const fonts = await page.evaluate(() => {
    const label = document.querySelector(".k2b-calendar-days__hour, .k2b-calendar-week__hour, .k2b-calendar-time-grid__hour");
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      body: body.fontFamily,
      calendarLabel: label ? getComputedStyle(label).fontFamily : null,
      rootFontSans: root.getPropertyValue("--font-sans"),
      rootK2bFontSans: root.getPropertyValue("--k2b-font-sans"),
      bodyK2bFontSans: body.getPropertyValue("--k2b-font-sans"),
      plexSans: [...document.fonts]
        .filter((font) => font.family.includes("IBM Plex Sans"))
        .map((font) => ({ family: font.family, weight: font.weight, status: font.status })),
    };
  });
  // Diagnostic evidence stays outside the published image set.
  appendFileSync(join(shots, "..", "browser-font-audit.jsonl"), `${JSON.stringify({ motif, width: page.viewportSize()!.width, fonts })}\n`);
  await page.screenshot({ path: join(shots, `${motif}-light-${page.viewportSize()!.width}.png`), animations: "disabled" });
};
const drop = async (page: Page, f: Scene) => {
  const source = page.locator(`[data-spaces-tray-item="${f.taskId}"] a`);
  const target = page.locator(`[data-calendar-body="${TODAY}"]`);
  try {
    await target.scrollIntoViewIfNeeded();
  } catch (cause) {
    await shot(page, "diagnostic-drop-target");
    throw new Error(
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText,
          days: [...document.querySelectorAll("[data-calendar-body]")].map((el) => el.getAttribute("data-calendar-body")),
          islands: [...document.querySelectorAll("solid-island")].map((el) => el.outerHTML.slice(0, 200)),
        })),
      ),
      { cause },
    );
  }
  const from = await source.boundingBox(),
    to = await target.boundingBox(),
    scroll = await page.locator(".k2b-calendar-days__scroll").boundingBox();
  if (!from || !to || !scroll) throw new Error("Calendar drop target is missing");
  // The calendar scrolls to the current time, so the day's top can be above the viewport.
  const top = Math.max(to.y + 20, scroll.y + 70);
  const bottom = Math.min(to.y + to.height - 20, scroll.y + scroll.height - 70);
  if (bottom <= top) throw new Error("No visible free time for the browser drop");
  const y = (top + bottom) / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
  await page.waitForSelector(".k2b-calendar-ghost[data-live]");
  await page.mouse.up();
};

suite("Task time blocks through real SSR islands and Spaces API", () => {
  beforeAll(async () => {
    setSystemTime(NOW);
    const builds = await Promise.all(
      ["../../../../styles/app.css", "../../../../../../cloud/src/styles/global.css"].map((entry) =>
        Bun.build({ entrypoints: [resolve(import.meta.dir, entry)], plugins: [tailwind] }),
      ),
    );
    for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not build fixture CSS");
    css = [
      "@layer properties,theme,base,components,utilities;",
      ...(await Promise.all(builds.map((build) => build.outputs[0]!.text()))),
    ].join("\n");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
        if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
        const f = cases.get(req.headers.get("x-case") ?? "");
        if (!f) return new Response("Fixture not found", { status: 404 });
        if (url.pathname.startsWith("/api/spaces/")) {
          url.pathname = url.pathname.slice("/api/spaces".length);
          const headers = new Headers(req.headers);
          headers.set("authorization", `Bearer ${f.token}`);
          const response = await api.fetch(
            new Request(url, {
              method: req.method,
              headers,
              ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: await req.arrayBuffer() }),
            }),
          );
          if (req.method === "PATCH" && url.pathname.startsWith("/blocks/")) f.moves.push({ status: response.status });
          if (req.method === "POST" && url.pathname.endsWith("/time-blocks")) {
            const saved = response.ok ? SpaceTimeBlockSchema.parse(await response.clone().json()) : null;
            f.posts.push({ id: saved?.id ?? "failed", status: response.status });
            if (f.fault === "delay")
              await new Promise<void>((done) => {
                f.release = done;
              });
            // Transport fault AFTER the real handler committed: no fake create endpoint or fake persisted block.
            if (f.fault === "lost-response") {
              f.fault = "none";
              return new Response("response lost", { status: 502 });
            }
          }
          return response;
        }
        if (url.pathname === "/app/spaces") await renderOverview(f, url);
        else if (url.pathname.startsWith("/app/spaces/")) {
          await render(f, url.searchParams.get("item") === f.taskId, `${url.pathname}${url.search}`);
        }
        return new Response(f.html, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    browser = await launchBrowser();
  }, 120_000);
  afterAll(async () => {
    for (const f of cases.values()) f.release?.();
    await browser?.close();
    await server?.stop(true);
    for (const id of additionalAccounts) {
      await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    }
    for (const f of cleanup) {
      await sql`DELETE FROM spaces.time_blocks WHERE owner_id = ${f.ownerId}::uuid`;
      await sql`DELETE FROM spaces.spaces WHERE id = ${f.spaceUuid}::uuid`;
      if (f.accountId) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${f.accountId}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${f.accountId}::uuid`;
      }
      for (const id of f.userIds) {
        await sql`DELETE FROM auth.access WHERE user_id = ${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
      }
    }
    setSystemTime();
    expect(runtimeErrors.flat()).toEqual([]);
  });

  for (const width of [1440, 390])
    regression(`#1701: assigned estimated and claimed task drop + unchanged checklist + Undo at ${width}px`, async () => {
      const f = await scene(),
        before = await taskState(f),
        surfacesBefore = width === 1440 ? await unrelatedSurfaces(f) : null,
        page = await open(f, false, width);
      const errors = pageErrors(page);
      try {
        await drop(page, f);
        await waitFor(async () => (await blocks(f)).length === 1);
        const saved = (await blocks(f))[0]!;
        expect(f.posts).toEqual([{ id: saved.id, status: 200 }]);
        expect(Date.parse(saved.endsAt) - Date.parse(saved.startsAt)).toBe(45 * 60_000);
        expect(await taskState(f)).toEqual(before);
        if (surfacesBefore) expect(await unrelatedSurfaces(f)).toEqual(surfacesBefore);
        expect(await page.locator(".spaces-time-block-dialog").count()).toBe(0);
        await page.getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
        await shot(page, "10-calendar-drop-undo");
        await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
        await waitFor(async () => (await blocks(f)).length === 0);
        expect(await taskState(f)).toEqual(before);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

  regression("a lost drop response retries the same saved block and Undo still removes only that block", async () => {
    const f = await scene();
    f.fault = "lost-response";
    const before = await taskState(f),
      page = await open(f);
    try {
      await drop(page, f);
      await page.getByRole("button", { name: "Erneut versuchen", exact: true }).waitFor();
      expect(await blocks(f)).toHaveLength(1);
      expect(f.posts).toHaveLength(1);
      await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await page.getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
      expect(await blocks(f)).toHaveLength(1);
      expect(f.posts).toHaveLength(1);
      expect(await taskState(f)).toEqual(before);
      await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
      await waitFor(async () => (await blocks(f)).length === 0);
      expect(await taskState(f)).toEqual(before);
    } finally {
      await page.context().close();
    }
  });

  regression("non-assignee drop opens the task first without creating a block or changing assignment", async () => {
    const f = await scene(false),
      before = await taskState(f),
      page = await open(f);
    try {
      await page.evaluate(() => {
        window.addEventListener(
          "spaces-detail-navigation",
          (event) => (document.documentElement.dataset.openedTask = (event as CustomEvent<{ itemId: string }>).detail.itemId),
        );
      });
      await drop(page, f);
      await page.waitForFunction((id) => document.documentElement.dataset.openedTask === id, f.taskId);
      expect(f.posts).toEqual([]);
      expect(await blocks(f)).toEqual([]);
      expect(await taskState(f)).toEqual(before);
      expect(await page.getByRole("alert").textContent()).toContain("Weise dir die Aufgabe zu");
      await page.getByRole("button", { name: "Mir zuweisen", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Zeit blocken", exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  for (const width of [1440, 390])
    regression(`dialog validates input, locks saving, retains inputs and reconciles a lost response at ${width}px`, async () => {
      const f = await scene(),
        page = await open(f, true, width);
      try {
        await page.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        const dialog = page.locator(".spaces-time-block-dialog");
        await dialog.waitFor();
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).inputValue()).toBe("");
        expect(await dialog.getByLabel("Dauer", { exact: true }).inputValue()).toBe("45");
        await dialog.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        expect(await dialog.textContent()).toContain("Wähle einen Beginn");
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).evaluate((el) => el === document.activeElement)).toBe(
          true,
        );
        expect(f.posts).toEqual([]);
        await shot(page, "11-dialog-validation");
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).fill("10:");
        await page.getByRole("option", { name: "10:15", exact: true }).click();
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).press("Tab");
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).inputValue()).toBe("10:15");
        expect(await dialog.textContent()).toContain("bis 11:00");
        expect(f.posts).toEqual([]);
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).fill("10:07");
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).press("Tab");
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).inputValue()).toBe("10:07");
        await dialog.getByLabel("Dauer", { exact: true }).fill("0");
        await dialog.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        expect(await dialog.textContent()).toContain("Gib eine Dauer größer als 0 Minuten ein");
        expect(f.posts).toEqual([]);
        await dialog.getByLabel("Dauer", { exact: true }).fill("45");
        expect(await dialog.textContent()).toContain("Liegt nach der Frist");
        // Measure saving from a valid form; validation/deadline hints may legitimately change its earlier height.
        await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        await dialog.waitFor();
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).fill("10:00");
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).press("Tab");
        await settled(page);
        const beforeHeight = (await dialog.boundingBox())!.height;
        f.fault = "delay";
        await dialog.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        await waitFor(async () => f.posts.length === 1);
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).isDisabled()).toBe(true);
        expect(await dialog.getByLabel("Dauer", { exact: true }).isDisabled()).toBe(true);
        expect(await dialog.getByRole("button", { name: "Abbrechen", exact: true }).isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        expect(await dialog.count()).toBe(1);
        await settled(page);
        expect(Math.abs((await dialog.boundingBox())!.height - beforeHeight)).toBeLessThanOrEqual(1);
        await shot(page, "03-dialog-saving");
        f.fault = "lost-response";
        f.release?.();
        await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).waitFor();
        expect(await dialog.getByRole("combobox", { name: "Beginn", exact: true }).inputValue()).toBe("10:00");
        expect(await dialog.getByLabel("Dauer", { exact: true }).inputValue()).toBe("45");
        await shot(page, "04-dialog-recovery");
        await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        expect(await blocks(f)).toHaveLength(1);
        expect(f.posts).toHaveLength(1);
      } finally {
        f.release?.();
        await page.context().close();
      }
    });

  regression("only the assigned owner can move or resize an existing block; task fields and checklist stay unchanged", async () => {
    const f = await scene();
    const input = { id: uuid(9101), startsAt: "2030-03-14T10:00:00.000Z", endsAt: "2030-03-14T10:45:00.000Z" };
    await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`, { method: "POST", body: JSON.stringify(input) }));
    const beforeTask = await taskState(f);
    let page = await open(f);
    const band = () => page.locator(`[data-calendar-entry="${input.id}"]`);
    const drag = async (readonly: boolean) => {
      const chip = band().locator("[data-calendar-event]");
      await chip.scrollIntoViewIfNeeded();
      const box = (await chip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 56, { steps: 10 });
      if (!readonly) await page.waitForSelector(".k2b-calendar-ghost[data-live]");
      else expect(await page.locator(".k2b-calendar-ghost[data-live]").count()).toBe(0);
      await page.mouse.up();
    };
    try {
      await band().waitFor();
      expect(await band().locator("[data-calendar-event]").getAttribute("data-editable")).not.toBe("false");
      expect(await band().locator(".k2b-calendar-band__grip").count()).toBe(2);
      await drag(false);
      await waitFor(async () => f.moves.length === 1 && (await blocks(f))[0]!.startsAt !== input.startsAt);
      const moved = (await blocks(f))[0]!;
      await page.waitForFunction(
        ({ id, time }) =>
          document.querySelector(`[data-calendar-entry="${id}"] [data-calendar-event]`)?.getAttribute("aria-label")?.includes(time),
        { id: input.id, time: moved.startsAt.slice(11, 16) },
      );
      expect(Date.parse(moved.endsAt) - Date.parse(moved.startsAt)).toBe(45 * 60_000);
      expect(await taskState(f)).toEqual(beforeTask);
      const grip = band().locator('.k2b-calendar-band__grip[data-edge="end"]');
      await grip.scrollIntoViewIfNeeded();
      const box = (await grip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 28, { steps: 8 });
      await page.mouse.up();
      await waitFor(async () => f.moves.length === 2 && (await blocks(f))[0]!.endsAt !== moved.endsAt);
      const resized = (await blocks(f))[0]!;
      expect(resized.startsAt).toBe(moved.startsAt);
      expect(Date.parse(resized.endsAt)).toBeGreaterThan(Date.parse(moved.endsAt));
      expect(await taskState(f)).toEqual(beforeTask);
      expect(f.moves).toEqual([{ status: 200 }, { status: 200 }]);
      const keyboardRefresh = page.waitForResponse(async (response) => {
        if (new URL(response.url()).pathname !== "/api/spaces/workspace/view" || response.status() !== 200) return false;
        const snapshot = SpacesViewSnapshotSchema.parse(await response.json());
        return (
          snapshot.kind === "calendar" &&
          Boolean(snapshot.timeBlocks?.some((block) => block.id === input.id && block.startsAt !== resized.startsAt))
        );
      });
      await band().locator("[data-calendar-event]").focus();
      await Promise.all([keyboardRefresh, page.keyboard.press("Alt+ArrowDown")]);
      await waitFor(async () => f.moves.length === 3 && (await blocks(f))[0]!.startsAt !== resized.startsAt);
      const keyboardMoved = (await blocks(f))[0]!;
      expect(Date.parse(keyboardMoved.endsAt) - Date.parse(keyboardMoved.startsAt)).toBe(
        Date.parse(resized.endsAt) - Date.parse(resized.startsAt),
      );
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-calendar-event-id"))).toBe(input.id);
      expect(new URL(page.url()).pathname).toBe(`/app/spaces/${f.spaceId}`);
      expect(await taskState(f)).toEqual(beforeTask);
      expect(f.moves).toEqual([{ status: 200 }, { status: 200 }, { status: 200 }]);
      await page.context().close();
      await viewAsColleague(f);
      page = await open(f);
      await band().waitFor();
      expect(await band().locator("[data-calendar-event]").getAttribute("data-editable")).toBe("false");
      expect(await band().locator(".k2b-calendar-band__grip").count()).toBe(0);
      await drag(true);
      expect((await blocks(f))[0]).toMatchObject({ startsAt: keyboardMoved.startsAt, endsAt: keyboardMoved.endsAt, canWrite: false });
      expect(f.moves).toHaveLength(3);
      expect(await taskState(f)).toEqual(beforeTask);
    } finally {
      await page.context().close();
    }
  });

  regression("clicking a calendar block selects it in the real detail, and reload/Back preserve task and block selection", async () => {
    const f = await scene();
    const input = { id: uuid(9201), startsAt: "2030-03-14T10:00:00.000Z", endsAt: "2030-03-14T10:45:00.000Z" };
    await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`, { method: "POST", body: JSON.stringify(input) }));
    const page = await open(f);
    try {
      await page.locator(`[data-calendar-entry="${input.id}"] [data-calendar-event]`).click();
      const selected = page.locator(`#time-block-${input.id}[data-selected]`);
      await selected.waitFor();
      expect(new URL(page.url()).searchParams.get("block")).toBe(input.id);
      expect(new URL(page.url()).searchParams.get("item")).toBe(f.taskId);
      await page.reload();
      await selected.waitFor();
      expect(new URL(page.url()).searchParams.get("block")).toBe(input.id);
      await page.goBack();
      await selected.waitFor({ state: "detached" });
      expect(new URL(page.url()).searchParams.has("item")).toBe(false);
      expect(new URL(page.url()).searchParams.has("block")).toBe(false);
      expect(await blocks(f)).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  });

  for (const width of [1440, 390])
    regression(`60-minute suggestion and assignment-first detail at ${width}px`, async () => {
      const f = await scene();
      await sql`UPDATE spaces.items SET estimated_duration_minutes = NULL WHERE id = ${f.taskUuid}::uuid`;
      let page = await open(f, true, width);
      try {
        await page.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        const dialog = page.locator(".spaces-time-block-dialog");
        await dialog.waitFor();
        expect(await dialog.getByLabel("Dauer", { exact: true }).inputValue()).toBe("60");
        expect(await dialog.textContent()).toContain("Vorschlag");
        await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
        expect(await blocks(f)).toEqual([]);
        await page.context().close();
        const unassigned = await scene(false);
        page = await open(unassigned, true, width);
        expect(await page.getByRole("button", { name: "Mir zuweisen", exact: true }).count()).toBe(1);
        expect(await page.getByRole("button", { name: "Zeit blocken", exact: true }).count()).toBe(0);
        await shot(page, "07-task-assignment-first");
      } finally {
        await page.context().close();
      }
    });

  for (const width of [1440, 390])
    regression(`done/reopened/deleted tasks preserve a readable, deletable calendar block at ${width}px`, async () => {
      const f = await scene();
      const input = { id: uuid(9000 + Number(f.key.slice(4))), startsAt: "2030-03-14T10:00:00.000Z", endsAt: "2030-03-14T10:45:00.000Z" };
      await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`, { method: "POST", body: JSON.stringify(input) }));
      await json(
        await request(f, `/${f.spaceId}/items/${f.taskId}/completed`, {
          method: "POST",
          body: JSON.stringify({ completed: true, claimId: uuid(Number(f.key.slice(4)) * 10 + 6) }),
        }),
      );
      expect((await blocks(f))[0]?.taskState).toBe("done");
      let page = await open(f, false, width);
      try {
        const event = () =>
          page.locator(`[data-calendar-body="${TODAY}"] [data-calendar-event]`, { hasText: "Angebot für Stadtwerke prüfen" });
        await event().waitFor();
        expect(await event().locator(".ti-circle-check").count()).toBeGreaterThan(0);
        await shot(page, "08-calendar-task-done");
        await json(
          await request(f, `/${f.spaceId}/items/${f.taskId}/completed`, { method: "POST", body: JSON.stringify({ completed: false }) }),
        );
        expect((await blocks(f))[0]?.taskState).toBe("open");
        await json(await request(f, `/${f.spaceId}/items/${f.taskId}`, { method: "DELETE" }));
        const orphan = SpaceTimeBlockSchema.parse(await json(await request(f, `/blocks/${input.id}`)));
        expect(orphan).toMatchObject({
          title: "Angebot für Stadtwerke prüfen",
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          taskState: "deleted",
          itemId: null,
          canWrite: false,
          canDelete: true,
        });
        await page.context().close();
        page = await open(f, false, width);
        await event().waitFor();
        expect(await event().textContent()).toContain("Aufgabe gelöscht");
        expect(await event().getAttribute("data-editable")).toBe("false");
        expect(await page.locator(`[data-calendar-entry="${input.id}"] .k2b-calendar-band__grip`).count()).toBe(0);
        await event().click();
        await page.getByRole("button", { name: "Termin löschen", exact: true }).waitFor();
        expect(await page.getByText("Die Aufgabe wurde gelöscht.", { exact: false }).count()).toBeGreaterThan(0);
        await shot(page, "09-calendar-task-deleted");
        await page.getByRole("button", { name: "Termin löschen", exact: true }).click();
        await waitFor(async () => (await request(f, `/blocks/${input.id}`)).status === 404);
      } finally {
        await page.context().close();
      }
    });

  for (const width of [1440, 390])
    regression(`real task detail, multiple blocks and dialog screenshots at ${width}px`, async () => {
      const f = await scene();
      let page = await open(f, true, width);
      try {
        await settled(page);
        if (width === 1440) {
          const detail = await page.locator(".k2b-app-workspace__detail").boundingBox();
          expect(Math.round(detail!.width)).toBe(400);
        }
        await shot(page, "01-task-unplanned");
        await page.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        const dialog = page.locator(".spaces-time-block-dialog");
        await dialog.waitFor();
        const dialogBounds = (await dialog.boundingBox())!;
        if (width === 1440) expect(Math.round(dialogBounds.width)).toBe(440);
        else expect(dialogBounds.width).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await shot(page, "02-dialog-open");
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).fill("10:00");
        await dialog.getByRole("combobox", { name: "Beginn", exact: true }).press("Tab");
        await shot(page, "02-dialog-after-deadline");
        await dialog.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        expect(await blocks(f)).toHaveLength(1);
        await page.context().close();
        page = await open(f, true, width);
        await page.getByRole("button", { name: "Zeit blocken", exact: true }).click();
        await page.locator(".spaces-time-block-dialog").getByRole("combobox", { name: "Beginn", exact: true }).fill("13:00");
        await page.locator(".spaces-time-block-dialog").getByRole("button", { name: "Zeit blocken", exact: true }).click();
        await page.locator(".spaces-time-block-dialog").waitFor({ state: "detached" });
        expect(await blocks(f)).toHaveLength(2);
        await page.context().close();
        page = await open(f, true, width);
        expect(await page.locator(".spaces-time-block-row").count()).toBe(2);
        await shot(page, "05-task-multiple-blocks");
        await page.context().close();
        page = await open(f, false, width, "week");
        await shot(page, "06-calendar-blocks");
      } finally {
        await page.context().close();
      }
    });

  for (const width of [1440, 390])
    regression(`My work Today and Upcoming show own blocks through the real API, navigation and reload at ${width}px`, async () => {
      const f = await scene();
      const n = Number(f.key.slice(4));
      const today = { id: uuid(9400 + n), startsAt: "2030-03-14T10:00:00.000Z", endsAt: "2030-03-14T10:45:00.000Z" };
      const upcoming = { id: uuid(9500 + n), startsAt: "2030-03-15T13:00:00.000Z", endsAt: "2030-03-15T13:45:00.000Z" };
      for (const block of [today, upcoming])
        await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`, { method: "POST", body: JSON.stringify(block) }));
      for (const [view, block] of [
        ["today", today],
        ["upcoming", upcoming],
      ] as const) {
        const data = OverviewWorkSchema.parse(await json(await request(f, `/overview/work?view=${view}`)));
        expect(data.timeBlocks?.map((item) => item.id)).toEqual([block.id]);
        expect(data.timeBlockCounts).toEqual({ today: 1, upcoming: 1 });
      }
      const page = await open(f, false, width, "day", "/app/spaces?view=today");
      const row = (id: string) => page.locator(`.spaces-overview-work-row[href$="block=${id}"]`);
      try {
        await row(today.id).waitFor();
        expect(await row(upcoming.id).count()).toBe(0);
        expect(await row(today.id).textContent()).toContain("Zeitblöcke");
        await shot(page, "12-my-work-today");
        const upcomingTab = page.locator('[data-view-tab="upcoming"] a');
        if (await upcomingTab.isVisible()) await upcomingTab.click();
        else {
          await page.getByRole("button", { name: "Weitere Ansichten", exact: true }).click();
          await page.getByRole("menuitem", { name: /^Demnächst/ }).click();
        }
        await row(upcoming.id).waitFor();
        expect(new URL(page.url()).searchParams.get("view")).toBe("upcoming");
        expect(await row(today.id).count()).toBe(0);
        await page.reload();
        await row(upcoming.id).waitFor();
        expect(new URL(page.url()).searchParams.get("view")).toBe("upcoming");
        await shot(page, "13-my-work-upcoming");
        await page.goBack();
        await row(today.id).waitFor();
        expect(new URL(page.url()).searchParams.get("view")).toBe("today");
        expect(await blocks(f)).toHaveLength(2);
      } finally {
        await page.context().close();
      }
    });

  regression("tablet dark tokens, overflow and keyboard editing use the real dialog and API", async () => {
    const f = await scene();
    const input = { id: uuid(9301), startsAt: "2030-03-14T10:00:00.000Z", endsAt: "2030-03-14T10:45:00.000Z" };
    await json(await request(f, `/${f.spaceId}/items/${f.taskId}/time-blocks`, { method: "POST", body: JSON.stringify(input) }));
    const page = await open(f, true, 820);
    try {
      const lightSurface = await page.locator("body").evaluate((el) => getComputedStyle(el).getPropertyValue("--k2b-surface"));
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => document.body.setAttribute("data-theme", "dark"));
      const edit = page.getByRole("button", { name: "Ändern", exact: true });
      await edit.focus();
      await page.keyboard.press("Enter");
      const dialog = page.locator(".spaces-time-block-dialog");
      await dialog.waitFor();
      await settled(page);
      expect(await page.locator("body").evaluate((el) => getComputedStyle(el).getPropertyValue("--k2b-surface"))).not.toBe(lightSurface);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(820);
      const start = dialog.getByRole("combobox", { name: "Beginn", exact: true });
      expect(await start.inputValue()).toBe("10:00");
      await start.focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("11:15");
      await page.keyboard.press("Tab");
      const save = dialog.getByRole("button", { name: "Speichern", exact: true });
      await save.focus();
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "detached" });
      const saved = await blocks(f);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.startsAt).toBe("2030-03-14T11:15:00.000Z");
      expect(f.moves).toEqual([{ status: 200 }]);
    } finally {
      await page.context().close();
    }
  });
});
