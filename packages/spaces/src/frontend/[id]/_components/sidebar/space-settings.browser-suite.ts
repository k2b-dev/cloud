import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { ServerWebSocket } from "bun";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { z } from "zod";
import type { AccessEntry } from "@/contracts";
import { SpaceSettingsContextSchema } from "@/settings-context";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";

// Keep the island plugin in the child process, with a scratch root that resolves this package's dependencies.
const packageCache = resolve(import.meta.dir, "../../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "spaces-settings-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [import.meta.dir, resolve(import.meta.dir, "../workspace")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpaceSettingsFixture } = await import("./space-settings.browser-fixture");

const TIME = "2026-10-15T09:00:00+02:00";
const TIME_ZONE = "Europe/Berlin";
const ui = resolve(import.meta.dir, "../../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../../cloud/src/styles/global.css"),
];
/** Light screenshots of pending and completed grants, kept for review. */
const shots = join(tmpdir(), "spaces-space-settings", browserName);
const settings = SpaceSettingsContextSchema.parse({
  space: {
    id: "Space1",
    name: "Team planning",
    description: null,
    color: "#8b5cf6",
    icalToken: null,
    createdAt: TIME,
    updatedAt: TIME,
    columns: [],
    virtualColumns: [],
    tags: [],
    templates: [],
  },
  settings: { view: "list", hideSettings: false },
  permission: "admin",
  accessEntries: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      principal: { type: "user", userId: "11111111-1111-4111-8111-111111111111" },
      permission: "admin",
      displayName: "Mara Lind",
      createdAt: TIME,
    },
  ],
  apiKeys: [],
  wormholes: [],
  githubTokenConfigured: false,
});
const added: AccessEntry = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  principal: { type: "user", userId: "22222222-2222-4222-8222-222222222222" },
  permission: "read",
  displayName: "Jonas Weber",
  createdAt: TIME,
};

// The live wire frames this flow uses. Apps reach the protocol only through `@k2b/cloud/browser/live`, so the
// fake server spells out its side here.
const LiveClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id: z.string(), channel: z.string(), scope: z.unknown(), after: z.string().optional() }),
  z.object({ t: z.literal("unsub"), id: z.string() }),
]);
type LiveServerFrame = { t: "ready"; id: string; cursor: string } | { t: "event"; id: string; cursor: string; data: unknown };

type SocketData = { subscription?: string };
const sockets = new Set<ServerWebSocket<SocketData>>();
const send = (socket: ServerWebSocket<SocketData>, frame: LiveServerFrame) => socket.send(JSON.stringify(frame));
let grant = Promise.withResolvers<void>();
let postHeld = false;
let eventsSent = 0;
let subscriptions = 0;
let css = "";
let server: ReturnType<typeof Bun.serve<SocketData>>;
const pushAccessChanged = () => {
  for (const socket of sockets) {
    if (!socket.data.subscription) continue;
    send(socket, { t: "event", id: socket.data.subscription, cursor: "c1", data: { type: "access.changed" } });
    eventsSent += 1;
  }
};
let browser: Browser;

beforeAll(async () => {
  const built = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      if (url.pathname === "/api/spaces/live" && server.upgrade(request, { data: {} })) return;
      if (url.pathname === "/api/spaces/Space1/settings-context" && request.method === "GET") return Response.json(settings);
      if (url.pathname === "/api/accounts/entities" && request.method === "GET")
        return Response.json({
          items: [
            { kind: "user", user: { id: "22222222-2222-4222-8222-222222222222", uid: "jonas", displayName: "Jonas Weber", mail: null } },
          ],
        });
      if (url.pathname === "/api/spaces/Space1/access" && request.method === "POST") {
        expect(await request.json()).toEqual({ principal: added.principal, permission: "read" });
        postHeld = true;
        await grant.promise;
        pushAccessChanged();
        return Response.json(added);
      }
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Not part of the settings flow" }, { status: 404 });
      if (url.pathname !== "/app/spaces/Space1") return new Response("Not found", { status: 404 });
      const locale = url.searchParams.get("lang") === "de" ? "de" : "en";
      return new Response(pageHtml(locale), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, data) {
        const frame = LiveClientFrame.parse(JSON.parse(String(data)));
        if (frame.t === "unsub") {
          delete socket.data.subscription;
          return;
        }
        expect(frame.channel).toBe("space");
        expect(frame.scope).toEqual({ space: "Space1" });
        expect(frame.after).toBe("c0");
        socket.data.subscription = frame.id;
        subscriptions += 1;
        send(socket, { t: "ready", id: frame.id, cursor: "c0" });
      },
    },
  });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  grant.resolve();
  await browser?.close();
  server?.stop(true);
});

const pageHtml = (locale: "en" | "de") => {
  const body = renderToString(() => createComponent(SpaceSettingsFixture, { locale, snapshotTime: TIME }));
  return (
    `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style>` +
    "<style>solid-client,solid-island{display:contents}</style></head>" +
    `<body class="k2b-ui" style="margin:0"><main style="padding:24px">${body}</main>` +
    `<script type="module">document.querySelectorAll('solid-island').forEach((e)=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>`
  );
};
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 80))));
const focusedPicker = (page: Page) =>
  page.evaluate(() => document.activeElement === document.querySelector('dialog[open] input[role="combobox"]'));
const pageMarker = (page: Page) => page.evaluate(() => Reflect.get(window, "__page"));
const shoot = async (page: Page, name: string) => {
  mkdirSync(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: join(shots, `${name}.png`) });
};
const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe(`Space settings survive access changes in ${browserName}`, () => {
  for (const [label, width, height, touch, locale] of [
    ["desktop-en", 1440, 900, false, "en"],
    ["phone-en", 390, 844, true, "en"],
    ["phone-de", 390, 844, true, "de"],
  ] as const) {
    test(`${label}: the grant keeps the dialog and focus, and a live change offers the reload after closing`, async () => {
      grant = Promise.withResolvers<void>();
      postHeld = false;
      eventsSent = 0;
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: touch,
        hasTouch: touch,
        reducedMotion: "reduce",
        timezoneId: TIME_ZONE,
      });
      const page = await context.newPage();
      try {
        await page.clock.install({ time: new Date(TIME) });
        const connection = page.waitForEvent("websocket", (socket) => socket.url().endsWith("/api/spaces/live"));
        await page.goto(`${server.url}app/spaces/Space1?lang=${locale}`);
        const socket = await connection;
        await waitFor(() => [...sockets].some((socket) => Boolean(socket.data.subscription)), "the live subscription");
        await page.evaluate(() => {
          Reflect.set(window, "__page", "first");
          return document.fonts.ready;
        });
        await page.waitForFunction(() => Boolean(Reflect.get(document.querySelector("main button") ?? {}, "$$click")));
        const settingsLabel = locale === "de" ? "Space-Einstellungen" : "Space settings";
        const closeLabel = locale === "de" ? "Einstellungen schließen" : "Close settings";
        await page.getByRole("button", { name: settingsLabel, exact: true }).click();
        const dialog = page.locator("dialog[open]");
        await dialog.getByRole("tab", { name: locale === "de" ? "Zugriff" : "Access", exact: true }).click();
        const input = dialog.getByRole("combobox");
        await input.waitFor();
        await settle(page);
        const before = await dialog.boundingBox();
        expect(before).not.toBeNull();
        await input.fill("Jo");
        await dialog.getByRole("option", { name: /Jonas Weber/ }).click();
        await waitFor(() => postHeld, "the held access POST");
        const row = dialog.locator(".group\\/access-row").filter({ hasText: "Jonas Weber" });
        expect(await dialog.count()).toBe(1);
        expect(await row.getAttribute("aria-busy")).toBe("true");
        expect(await focusedPicker(page)).toBe(true);
        await shoot(page, `${label}-pending`);

        const event = socket.waitForEvent(
          "framereceived",
          (frame) => typeof frame.payload === "string" && JSON.parse(frame.payload).t === "event",
        );
        grant.resolve();
        await event;
        expect(eventsSent).toBeGreaterThan(0);
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".group\\/access-row")].some(
            (row) => row.textContent?.includes("Jonas Weber") && !row.hasAttribute("aria-busy"),
          ),
        );
        await settle(page);
        expect(await dialog.count()).toBe(1);
        expect(await pageMarker(page)).toBe("first");
        expect(await row.getAttribute("aria-busy")).toBeNull();
        expect(await focusedPicker(page)).toBe(true);
        expect(await dialog.boundingBox()).toEqual(before);
        await shoot(page, `${label}-added`);

        // The person changed access, so Spaces itself loads the page again once they close the settings.
        const subscribedBefore = subscriptions;
        let loaded = page.waitForEvent("load");
        const reconnection = page.waitForEvent("websocket", (socket) => socket.url().endsWith("/api/spaces/live"));
        await dialog.getByRole("button", { name: closeLabel, exact: true }).click();
        await loaded;
        const secondSocket = await reconnection;
        await page.waitForFunction(() => Reflect.get(window, "__page") === undefined);

        // Someone else's change while the settings are open: the page neither reloads under the dialog nor
        // after it closes, because the person may have confirmed work there; it offers the reload instead.
        await waitFor(() => subscriptions > subscribedBefore, "the second live subscription");
        await page.evaluate(() => {
          sessionStorage.clear();
          Reflect.set(window, "__page", "second");
        });
        await page.waitForFunction(() => Boolean(Reflect.get(document.querySelector("main button") ?? {}, "$$click")));
        await page.getByRole("button", { name: settingsLabel, exact: true }).click();
        await dialog.waitFor();
        await settle(page);
        const othersChange = secondSocket.waitForEvent(
          "framereceived",
          (frame) => typeof frame.payload === "string" && JSON.parse(frame.payload).t === "event",
        );
        pushAccessChanged();
        await othersChange;
        await settle(page);
        expect(await dialog.count()).toBe(1);
        expect(await pageMarker(page)).toBe("second");
        const notice = page.locator("[data-k2b-toast]:not([data-closing])");
        expect(await notice.count()).toBe(0);
        await dialog.getByRole("button", { name: closeLabel, exact: true }).click();
        await notice.waitFor();
        expect(await dialog.count()).toBe(0);
        expect(await notice.textContent()).toContain(locale === "de" ? "Diese Seite hat sich geändert." : "This page changed.");
        expect(await pageMarker(page)).toBe("second");
        await shoot(page, `${label}-reload-offered`);
        loaded = page.waitForEvent("load");
        await notice.getByRole("button", { name: locale === "de" ? "Neu laden" : "Reload", exact: true }).click();
        await loaded;
        await page.waitForFunction(() => Reflect.get(window, "__page") === undefined);
      } finally {
        grant.resolve();
        await context.close();
      }
    }, 60_000);
  }
});
