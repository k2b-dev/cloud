import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as server from "@k2b/cloud/server";
import { accountsAppService, audit, notificationBatches } from "@k2b/cloud/services";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { denseAuditEvents } from "../audit/render-fixture";
import { adminApp, BATCH_ID, batch, recipient } from "../notifications/render-fixture";
import { DELETED, REMINDERS } from "./render-fixture";

// The activity page and a batch's record as the server sends them, inside the Cloud shell (icon rail, tinted page
// ground, app card): the first picture a person sees, before any island comes alive. The pictures are for the design
// review; the test keeps the v2 layout rules on them at 1440 and 390 px.
const root = mkdtempSync(join(tmpdir(), "accounts-activity-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: activityPage } = await import("./page");
const { default: recordPage } = await import("./notification.page");

const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS;
// the samples are relative to now, so the log groups its events into "Heute" and "Gestern" as a person sees them
const now = new Date();
const batches = Array.from({ length: 12 }, (_, index) => batch(index));
const recipients = Array.from({ length: 24 }, (_, index) => {
  const status = (["sent", "sent", "sent", "error", "sent", "pending", "sent", "skipped"] as const)[index % 8]!;
  return recipient(index, status, status === "sent" ? (index % 5 === 0 ? "bounced" : "sent") : status === "error" ? "failed" : null);
});
const spies = [
  stubRailSnapshot(),
  spyOn(server, "resolveDisplayNames").mockImplementation(async (entries) =>
    entries.map((entry) => ({ ...entry, displayName: undefined })),
  ),
  spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(3),
  spyOn(audit, "list").mockResolvedValue({
    items: denseAuditEvents(now, 40),
    page: 1,
    perPage: 100,
    total: 1_284,
    hasNext: true,
    hiddenAutomaticCount: 32,
  }),
  spyOn(notificationBatches, "list").mockResolvedValue({ items: batches, total: batches.length, page: 1, perPage: 50 }),
  spyOn(notificationBatches, "get").mockResolvedValue(batch(2, { selection: { userIds: [], groupIds: [] } })),
  spyOn(notificationBatches, "listRecipients").mockResolvedValue({ items: recipients, total: recipients.length, page: 1, perPage: 100 }),
  spyOn(accountsAppService.lifecycle.reminders, "list").mockResolvedValue({
    items: REMINDERS,
    total: REMINDERS.length,
    page: 1,
    perPage: 100,
  }),
  spyOn(accountsAppService.lifecycle.deletedAccounts, "list").mockResolvedValue({
    items: DELETED,
    total: DELETED.length,
    page: 1,
    perPage: 100,
  }),
];
const app = adminApp();
app.get("/app/accounts/activity", ...activityPage);
app.get("/app/accounts/activity/notifications/:id", ...recordPage);

let browser: Browser;
const styles: Record<string, string> = {};
let iconFont = "";
beforeAll(async () => {
  const sources = {
    "/public/global.css": resolve(import.meta.dir, "../../../../../styles.css"),
    "/public/accounts/app.css": resolve(import.meta.dir, "../../styles/app.css"),
  };
  for (const [path, entry] of Object.entries(sources)) {
    const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!build.success) throw new AggregateError(build.logs, `Could not compile ${path}`);
    styles[path] = await build.outputs[0]!.text();
  }
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  styles["/public/tabler-icons.css"] = iconCss.replace(fontAsset, "/tabler-icons.woff2");
  iconFont = fileURLToPath(new URL(fontAsset, iconCssUrl));
  // v2 styles are loaded by the layout as their own sheet; serve the package's file under whatever name it asks for
  styles.v2 = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const screens = [
  ["audit", "/app/accounts/activity"],
  ["notifications", "/app/accounts/activity?kind=notifications"],
  ["new-batch", "/app/accounts/activity?kind=notifications&new=1"],
  ["reminders", "/app/accounts/activity?kind=reminders"],
  ["deleted", `/app/accounts/activity?kind=deleted&entry=${DELETED[1]!.id}`],
  ["batch", `/app/accounts/activity/notifications/${BATCH_ID}`],
] as const;

describe("the activity page in the Cloud shell", () => {
  test("every screen as the server sends it keeps the v2 rules at 1440 and 390 px", async () => {
    for (const [name, address] of screens) {
      const response = await app.request(address, { headers: { "Accept-Language": "de" } });
      expect(response.status, address).toBe(200);
      const html = await response.text();
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: width > 500 ? 900 : 844 },
          deviceScaleFactor: 1,
          isMobile: width < 500,
          hasTouch: width < 500,
          reducedMotion: "reduce",
          colorScheme: "light",
        });
        const tab = await context.newPage();
        const errors = pageErrors(tab);
        await tab.route(`${origin}/**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.startsWith("/app/accounts/activity"))
            return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
          if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: iconFont });
          if (styles[url.pathname]) return route.fulfill({ contentType: "text/css", body: styles[url.pathname] });
          if (url.pathname.endsWith(".css") && url.pathname.includes("v2"))
            return route.fulfill({ contentType: "text/css", body: styles.v2 });
          // pictures (the app's logo, avatars) stand as an empty square; islands and fonts are not part of the first picture
          if (/\.(svg|png|webp|jpe?g)$/.test(url.pathname) || url.pathname.includes("/avatar"))
            return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
          return route.fulfill({ status: 404, body: "" });
        });
        try {
          await tab.goto(`${origin}${address}`);
          await tab.evaluate(() => document.fonts.ready);
          await settled(tab);
          if (shots) await tab.screenshot({ path: join(shots, `b-shell-${name}-light-${width}.png`) });
          // the shell frames the page: its rail on a desk, the tinted ground around the app card
          expect(await tab.locator("[data-k2-workspace]").count()).toBe(1);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
          expect(errors.filter((error) => !/Failed to load resource|404|MIME|script|dynamically imported module/i.test(error))).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);
});
