import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appAccess } from "@k2b/cloud";
import type { AppDetails, RuntimeAppMeta } from "@k2b/cloud/contracts";
import { auth, getLocale } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser, settled } from "../../../../../ui/test/browser";

// Exercise the page's real SSR output and CSS; identity, counts and the surrounding shell are fixtures.
const root = mkdtempSync(join(tmpdir(), "core-app-access-overview-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const cloudSsr = await import("@k2b/cloud/ssr");
const { ssr } = await import("../../../config");
const { default: handler } = await import("./page");
const apps: RuntimeAppMeta[] = [
  {
    id: "invoices",
    name: "Invoices",
    icon: "ti ti-receipt",
    description: "Demo invoices",
    routes: ["/invoices"],
    access: appAccess.grants(),
    appearance: { accent: "#16a34a" },
  },
  {
    id: "journal",
    name: "Journal",
    icon: "ti ti-notebook",
    description: "Demo journal",
    routes: ["/journal"],
    access: appAccess.signedIn(),
    appearance: { accent: "#a855f7" },
  },
];
const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });
const spies: Array<{ mockRestore(): void }> = [];
let browser: Browser;
let css: string;
beforeAll(async () => {
  spies.push(
    spyOn(cloudSsr, "AdminLayout").mockImplementation((props) =>
      createComponent(LocaleProvider, {
        locale: getLocale(props.c),
        get children() {
          return props.children;
        },
      }),
    ),
    spyOn(cloudSsr, "getLocalizedRuntimeContext").mockReturnValue({ apps }),
    spyOn(auth, "getAuthority").mockReturnValue({
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
      credentialKind: "session",
      scopes: [],
    }),
    spyOn(services, "appAccessGrantCounts").mockResolvedValue(new Map([["invoices", 4]])),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the overview stylesheet");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("the overview aligns headers, keeps phone counts and short Repair, and uses each app's icon color", async () => {
  const app = new Hono().get("/admin/apps", ...handler);
  for (const locale of ["en", "de"]) {
    const response = await app.request("https://cloud.example.test/admin/apps", { headers: { "Accept-Language": locale } });
    expect(response.status).toBe(200);
    const html = /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<html lang="${locale}"><head><style>${css}</style></head><body class="k2b-ui"><main style="padding:16px">${html}</main></body></html>`,
        );
        for (const dark of [false, true]) {
          await page.evaluate((enabled) => document.documentElement.classList.toggle("dark", enabled), dark);
          await settled(page);
          const link = page.getByRole("link", {
            name: `Invoices: ${locale === "de" ? "Zugriff reparieren" : "Repair access"}`,
            exact: true,
          });
          expect(await link.getAttribute("href")).toBe("/admin/apps?app=invoices");
          expect((await link.innerText()).trim()).toBe(
            width < 640 ? (locale === "de" ? "Reparieren" : "Repair") : locale === "de" ? "Zugriff reparieren" : "Repair access",
          );
          const count = page.getByText(`${width < 640 ? "· " : ""}${locale === "de" ? "4 Freigaben" : "4 grants"}`, { exact: true });
          expect(await count.isVisible()).toBe(true);
          const tiles = page.locator(".k2b-icon-tile");
          const colors = await tiles.evaluateAll((elements) => elements.map((tile) => getComputedStyle(tile).color));
          expect(colors).toHaveLength(2);
          expect(colors[0]).not.toBe(colors[1]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (width >= 640) {
            const header = page.getByText("App", { exact: true });
            expect(await header.isVisible()).toBe(true);
            const ruleHeader = page.getByText(locale === "de" ? "Wer nutzt die App" : "Who uses the app", { exact: true });
            const rule = page.getByText(locale === "de" ? "Einstellbar in der App" : "Configured in the app", { exact: true });
            expect((await rule.boundingBox())!.x).toBe((await ruleHeader.boundingBox())!.x);
            const icon = (await tiles.first().boundingBox())!;
            expect(icon.x).toBe((await header.boundingBox())!.x);
          }
        }
      } finally {
        await page.close();
      }
    }
  }
}, 30_000);

const details: AppDetails = {
  app: { id: "invoices", name: "Invoices", description: "Demo invoices", icon: "ti ti-receipt", accent: "#16a34a", online: true },
  access: { kind: "grants", roles: [], grantCount: 4, platformPermissions: ["mail:send"] },
  sends: [
    {
      type: "invoices.invoice.paid",
      version: 1,
      title: "Invoice paid",
      description: "An invoice was marked as paid.",
      subject: "invoices.invoice",
      place: null,
      automation: true,
      subscriberCount: 2,
    },
  ],
  hears: [
    {
      subscriptionId: "invoices:core.user.created@1",
      eventType: "core.user.created",
      version: 1,
      publisherAppId: "journal",
      title: "Account created",
      state: "active",
      reason: null,
      firstSeenAt: "2026-10-27T08:00:00.000Z",
      isNew: true,
      counts: { pending: 1, retrying: 0, done: 12, failed: 1, cancelled: 0 },
      failedDeliveries: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          eventId: "33333333-3333-4333-8333-333333333333",
          code: "handler_timeout",
          lastError: "The handler did not answer in time.",
          attempts: 8,
          lastAttemptAt: "2026-10-27T09:00:00.000Z",
        },
      ],
    },
    {
      subscriptionId: "invoices:journal.entry.changed@1",
      eventType: "journal.entry.changed",
      version: 1,
      publisherAppId: "journal",
      title: "Entry changed",
      state: "blocked",
      reason: "resource_events_unsupported",
      firstSeenAt: "2026-09-01T08:00:00.000Z",
      isNew: false,
      counts: { pending: 0, retrying: 0, done: 0, failed: 1, cancelled: 0 },
      failedDeliveries: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          eventId: "55555555-5555-4555-8555-555555555555",
          code: "attempts_exhausted",
          lastError: null,
          attempts: 8,
          lastAttemptAt: "2026-10-20T09:00:00.000Z",
        },
      ],
    },
  ],
  notifications: [],
  totals: { sends: 1, hears: 2, notifications: 0 },
};

test("the detail page keeps access repair at its address and shows what the app hears, sends and notifies about", async () => {
  const counts = spyOn(services, "appAccessGrantCounts").mockRejectedValue(new Error("Overview counts unavailable"));
  counts.mockClear();
  const read = spyOn(services, "readAppAccess").mockResolvedValue({
    appId: "invoices",
    name: "Invoices",
    entries: [],
    ownEntryIds: [],
    configured: true,
    hasEffectiveManager: false,
    inheritedSignedIn: false,
    canUse: false,
  });
  const detail = spyOn(services, "appDetails").mockResolvedValue(details);
  try {
    for (const locale of ["de", "en"]) {
      const response = await new Hono()
        .get("/admin/apps", ...handler)
        .request("https://cloud.example.test/admin/apps?app=invoices", { headers: { "Accept-Language": locale } });
      expect(response.status).toBe(200);
      expect(counts).not.toHaveBeenCalled();
      const html = /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
      const de = locale === "de";
      for (const width of [390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.setContent(
            `<html lang="${locale}"><head><style>${css}</style></head><body class="k2b-ui"><main style="padding:16px">${html}</main></body></html>`,
          );
          await settled(page);
          const shots = process.env.CORE_APP_DETAILS_SHOTS;
          if (shots) await page.screenshot({ path: `${shots}/app-details-${locale}-${width}.png`, fullPage: true });
          expect(await page.getByRole("link", { name: de ? "Zurück zu Apps" : "Back to Apps", exact: true }).getAttribute("href")).toBe(
            "/admin/apps",
          );
          const heading = page.getByRole("heading", { name: "Invoices", exact: true });
          expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe(width >= 640 ? "20px" : "18px");
          const titles = await page.getByRole("heading", { level: 2 }).allInnerTexts();
          expect(titles.map((title) => title.trim())).toEqual(
            de ? ["Wer Invoices nutzt", "Hört", "Sendet", "Benachrichtigungen"] : ["Who uses Invoices", "Hears", "Sends", "Notifications"],
          );
          const text = await page.locator("main").innerText();
          expect(text).toContain(de ? "Mail senden" : "Send mail");
          expect(text).toContain(de ? "Neu" : "New");
          expect(text).toContain(de ? "12 zugestellt · 1 wartet · 1 fehlgeschlagen" : "12 delivered · 1 waiting · 1 failed");
          expect(text).toContain(
            de ? "Apps erhalten nur Dienstereignisse; Ressourcenereignisse gehen nur an Abos, hinter denen eine Person steht." : "Apps receive service events only; resource events go to subscriptions a person stands behind.",
          );
          expect(text).toContain(de ? "2 Abonnenten" : "2 subscribers");
          // Only an active subscription can deliver again; each button names its event.
          const again = page.getByRole("button", { name: de ? /erneut zustellen$/ : /^Deliver .* again$/ });
          expect(await again.count()).toBe(1);
          expect(await again.getAttribute("aria-label")).toContain("Account created");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    detail.mockRestore();
    read.mockRestore();
    counts.mockResolvedValue(new Map([["invoices", 4]]));
  }
}, 60_000);

test("a failed details read keeps the access repair of a running app and shows the failure in place of the events", async () => {
  const read = spyOn(services, "readAppAccess").mockResolvedValue({
    appId: "invoices",
    name: "Invoices",
    entries: [],
    ownEntryIds: [],
    configured: true,
    hasEffectiveManager: false,
    inheritedSignedIn: false,
    canUse: false,
  });
  const detail = spyOn(services, "appDetails").mockRejectedValue(new Error("Event tables unavailable"));
  try {
    const response = await new Hono()
      .get("/admin/apps", ...handler)
      .request("https://cloud.example.test/admin/apps?app=invoices", { headers: { "Accept-Language": "en" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Who uses Invoices");
    expect(html).toContain("Events and notifications of this app could not be loaded.");
    expect(html).not.toContain("Hears");
  } finally {
    detail.mockRestore();
    read.mockRestore();
  }
});

test("an app that is not running shows its access rule as unknown, not as legacy checks", async () => {
  const detail = spyOn(services, "appDetails").mockResolvedValue({
    ...details,
    app: { ...details.app, id: "archive", name: "Archive", online: false },
    access: { kind: null, roles: [], grantCount: null, platformPermissions: [] },
    hears: [],
  });
  try {
    const response = await new Hono()
      .get("/admin/apps", ...handler)
      .request("https://cloud.example.test/admin/apps?app=archive", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Läuft nicht");
    expect(html).toContain("Unbekannt, solange die App nicht läuft.");
    expect(html).not.toContain("Bisherige Zugriffsprüfungen");
  } finally {
    detail.mockRestore();
  }
});

test("an app id Cloud cannot register answers 404 without reading details", async () => {
  const detail = spyOn(services, "appDetails");
  detail.mockClear();
  const missing = spyOn(ssr, "error").mockResolvedValue(new Response("Not found", { status: 404 }));
  try {
    const response = await new Hono().get("/admin/apps", ...handler).request("https://cloud.example.test/admin/apps?app=..%2Fcore");
    expect(response.status).toBe(404);
    expect(detail).not.toHaveBeenCalled();
  } finally {
    missing.mockRestore();
    detail.mockRestore();
  }
});

test("an unknown app id answers 404 instead of an empty detail page", async () => {
  const detail = spyOn(services, "appDetails").mockResolvedValue(null);
  const missing = spyOn(ssr, "error").mockResolvedValue(new Response("Not found", { status: 404 }));
  try {
    const response = await new Hono().get("/admin/apps", ...handler).request("https://cloud.example.test/admin/apps?app=unknown");
    expect(response.status).toBe(404);
    expect(missing).toHaveBeenCalledWith(expect.anything(), 404);
  } finally {
    missing.mockRestore();
    detail.mockRestore();
  }
});

test("an admin with a read-only OAuth credential gets 403 before the repair overview reads lists", async () => {
  const authority = spyOn(auth, "getAuthority").mockReturnValue({
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "oauth",
    scopes: ["read"],
  });
  const denied = spyOn(ssr, "error").mockResolvedValue(new Response("Forbidden", { status: 403 }));
  const counts = spyOn(services, "appAccessGrantCounts");
  counts.mockClear();
  try {
    const response = await new Hono().get("/admin/apps", ...handler).request("https://cloud.example.test/admin/apps");
    expect(response.status).toBe(403);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(counts).not.toHaveBeenCalled();
  } finally {
    counts.mockRestore();
    denied.mockRestore();
    authority.mockRestore();
  }
});
