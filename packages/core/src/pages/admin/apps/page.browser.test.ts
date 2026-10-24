import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appAccess } from "@k2b/cloud";
import type { RuntimeAppMeta } from "@k2b/cloud/contracts";
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

test("the repair page stays available without overview counts and names its way back", async () => {
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
  try {
    const response = await new Hono()
      .get("/admin/apps", ...handler)
      .request("https://cloud.example.test/admin/apps?app=invoices", { headers: { "Accept-Language": "de" } });
    expect(response.status).toBe(200);
    expect(counts).not.toHaveBeenCalled();
    const html = /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(
          `<html lang="de"><head><style>${css}</style></head><body class="k2b-ui"><main style="padding:16px">${html}</main></body></html>`,
        );
        await settled(page);
        expect(await page.getByRole("link", { name: "Zurück zu Apps", exact: true }).getAttribute("href")).toBe("/admin/apps");
        const heading = page.getByRole("heading", { name: "Invoices · Zugriff", exact: true });
        expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe(width >= 640 ? "20px" : "18px");
      } finally {
        await page.close();
      }
    }
  } finally {
    read.mockRestore();
    counts.mockResolvedValue(new Map([["invoices", 4]]));
  }
}, 30_000);

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
