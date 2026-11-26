import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { auth } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { serveCoreV2Sheet } from "@k2b/cloud/testing";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { authMessages } from "./auth/messages";
import { corePageMessages } from "./messages";

// Core's other visitor pages on v2, beside the sign-in page (auth/page.browser.test.ts): the terms consent, a legal
// text with and without content, the password reset and the expired password. Each is one centred column on the page
// background from the tablet up and the whole width on a phone; only a real engine lays that out.
const root = mkdtempSync(join(tmpdir(), "core-visitor-pages-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: consent } = await import("./auth/consent.page");
const { makeLegalPage } = await import("./legal/page-handler");
const { default: passwordReset } = await import("./auth/password-reset/page");
const { default: newPassword } = await import("./auth/new-password/page");
const { buildFontAssets } = await import("../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../scripts/tabler-assets");
const origin = "https://cloud.example.test";

// An invented privacy text: headings, a list, a link and a paragraph long enough to wrap.
// The operator wrote it in German, as a venue in Germany does; the page shows it as written in every language.
const privacyText = [
  "## Wer verantwortlich ist",
  "Kulturhaus Beispiel e. V., Musterweg 1, 12345 Beispielstadt.",
  "## Was diese Cloud speichert",
  "- deinen Namen und deine E-Mail-Adresse, um dich anzumelden",
  "- die Dateien und Notizen, die du anlegst, bis du sie löschst",
  "- Anmeldezeiten für 30 Tage, zum Schutz deines Kontos",
  "Diese Cloud läuft auf den eigenen Servern des Vereins. Nichts wird an Werbende weitergegeben oder verkauft, und jede Person kann unter [datenschutz@example.org](mailto:datenschutz@example.org) eine Kopie oder die Löschung ihrer Daten verlangen.",
].join("\n\n");

const pendingUser: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "consent-reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Reader",
  displayName: "Ada Reader",
  mail: "ada@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

let legalContent = privacyText;
// Core serves v2.css, so the pages link it alone (restored after this file).
serveCoreV2Sheet();
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  legalContent = privacyText;
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) =>
        (key === "app.name"
          ? "Kulturhaus Cloud"
          : key === "legal.privacy.mode"
            ? "local"
            : key === "legal.privacy.content"
              ? legalContent
              : undefined) as never,
    ),
    spyOn(auth.session, "getToken").mockReturnValue(null),
    spyOn(services.legalConsent, "pending").mockResolvedValue({ user: pendingUser, sid: "consent-session", authEpoch: 0 }),
    spyOn(services.legalConsent, "documents").mockResolvedValue({
      documents: [
        { kind: "terms", mode: "local", value: "Terms" },
        { kind: "privacy", mode: "local", value: "Privacy" },
      ],
      version: "a".repeat(64),
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let browser: Browser;
let css: string;
beforeAll(async () => {
  // As the page template links them on a v2 visitor page: Core's own stylesheet, then Core's v2.css.
  const built = await Promise.all([
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/app.css")], plugins: [tailwind] }),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../cloud/src/styles/v2-page.css")] }),
  ]);
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = (await Promise.all(built.map((build) => build.outputs[0]!.text()))).join("\n");
  await buildFontAssets(join(root, "public"));
  await buildTablerIconAssets(join(root, "public"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type Locale = "en" | "de";
type Visit = { path: string; handlers: typeof consent };
const pages = {
  consent: { path: "/auth/continue", handlers: consent },
  legal: { path: "/legal/privacy", handlers: makeLegalPage("privacy") },
  "legal-empty": { path: "/legal/privacy", handlers: makeLegalPage("privacy") },
  "reset-request": { path: "/auth/password-reset", handlers: passwordReset },
  "reset-complete": { path: "/auth/password-reset?token=fixture-reset-token", handlers: passwordReset },
  "new-password": { path: "/auth/new-password?ipa-uid=mira", handlers: newPassword },
} satisfies Record<string, Visit>;
type Name = keyof typeof pages;

const headings = (locale: Locale): Record<Name, string> => {
  const t = authMessages.resolve([locale]).t;
  const legal = corePageMessages.resolve([locale]).t.privacy;
  return {
    consent: t.consentTitle,
    legal,
    "legal-empty": legal,
    "reset-request": t.resetPassword,
    "reset-complete": t.setNewPassword,
    "new-password": t.setNewPassword,
  };
};
// The field that takes the focus when the page opens; the consent and the legal text have none.
const focused: Record<Name, string[]> = {
  consent: [],
  legal: [],
  "legal-empty": [],
  "reset-request": ["input email"],
  "reset-complete": ["input password"],
  "new-password": ["input password"],
};

/** The server-rendered page body, its attributes (the v2 scope) and its content. */
const render = async (visit: Visit, locale: Locale) => {
  const legalLinks = (locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"]).map(
    (label, index) => ({ label, href: ["/impressum", "/legal/privacy", "/legal/terms"][index]! }),
  );
  const pathname = visit.path.split("?")[0]!;
  const app = new Hono()
    .use((c, next) => {
      c.set("runtime" as never, { apps: [{ id: "legal-probe", legalLinks }] } as never);
      return next();
    })
    .get(pathname, ...visit.handlers);
  const response = await app.request(`${origin}${visit.path}`, { headers: { Cookie: `cloud.locale=${locale}` } });
  expect(response.status).toBe(200);
  const [, attributes, content] = /<body([^>]*)>([\s\S]*)<\/body>/.exec(await response.text())!;
  return { attributes: attributes!, content: content! };
};

/**
 * One page as the server sends it, measured: its own scripts never run (the content security policy allows none),
 * Playwright still measures it. With `CLOUD_VISITOR_SHOTS` set, a full-page image lands in that folder.
 */
const measure = async (name: Name, width: number, locale: Locale) => {
  const view = width < 768 ? { width, height: 844, touch: true } : { width, height: 900, touch: false };
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  try {
    await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
    await tab.route(`${origin}/branding/logo`, (route) =>
      route.fulfill({ path: resolve(import.meta.dir, "../../../cloud/public/logo.svg") }),
    );
    const page = await render(pages[name], locale);
    await tab.setContent(
      `<!doctype html><html lang="${locale}" class="light"><head><meta http-equiv="Content-Security-Policy" content="script-src &#39;none&#39;"><base href="${origin}/"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style><style>solid-client,solid-island{display:contents}</style></head>` +
        `<body${page.attributes}>${page.content}</body></html>`,
    );
    await tab.evaluate(() => document.fonts.ready);
    await settled(tab);
    const outline = await describeV2Page(tab, "main");
    const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
    const shots = process.env.CLOUD_VISITOR_SHOTS;
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await tab.screenshot({ path: join(shots, `${name}-${locale}-${width}.png`), fullPage: true });
    }
    const boxes = await tab.evaluate(() => {
      const box = (element: Element | null) => {
        if (!element) return undefined;
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      return {
        column: box(document.querySelector(".minimal-layout-main[data-measure] > :only-child")),
        footer: box(document.querySelector("footer")),
        heading: document.querySelector("main h1")?.textContent?.trim(),
        autofocus: Array.from(document.querySelectorAll("main [autofocus]")).map(
          (element) => `${element.tagName.toLowerCase()} ${element.getAttribute("type") ?? "text"}`,
        ),
        legal: Array.from(document.querySelectorAll("footer nav a")).map((link) => link.textContent?.trim()),
        // v1 parts and Tailwind's sign-in frame; the v2 scope on the body is the only k2b- class left. Prose keeps the
        // link hooks of the shared Markdown renderer.
        v1: Array.from(document.body.querySelectorAll("[class*='k2b-'], [class*='standalone-'], [class*='auth-']"))
          .filter((element) => !element.closest("[data-k2-prose]"))
          .map((element) => element.className),
        // a field or a send button outside any form would send nothing on Enter or press
        unbound: Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("main input:not([type=checkbox]), main button[type=submit]"),
        )
          .filter((element) => !element.form)
          .map((element) => element.outerHTML.slice(0, 80)),
        scrollWidth: document.documentElement.scrollWidth,
        // Controls and words the column cuts off at its edge (it clips, so the page itself never scrolls sideways).
        cut: (() => {
          const column = document.querySelector(".minimal-layout-main[data-measure] > :only-child")!.getBoundingClientRect();
          return Array.from(
            document.querySelectorAll(".minimal-layout-main[data-measure] > :only-child :is(a, button, input, label, h1, [role=tab])"),
          )
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && (box.left < column.left - 0.5 || box.right > column.right + 0.5);
            })
            .map((element) => element.textContent?.trim() || element.tagName.toLowerCase());
        })(),
        // Buttons keep the column's 16 px gutter on both sides: a full line wraps instead of squeezing to the edge.
        gutter: (() => {
          const column = document.querySelector(".minimal-layout-main[data-measure] > :only-child")!.getBoundingClientRect();
          return Array.from(document.querySelectorAll(".minimal-layout-main[data-measure] > :only-child [data-k2-part=Button]"))
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && (box.left < column.left + 15.5 || box.right > column.right - 15.5);
            })
            .map((element) => element.textContent?.trim() || element.getAttribute("aria-label"));
        })(),
        legalVersion: document.querySelector("[data-legal-version]")?.getAttribute("data-legal-version"),
        // what prints: the legal text alone, without the page around it
        printed: Array.from(document.querySelectorAll("[data-print-region]")).map((region) => region.textContent?.trim().slice(0, 20)),
      };
    });
    return { outline, problems: layout.problems, ...boxes };
  } finally {
    await tab.close();
  }
};

describe("Core visitor pages on v2", () => {
  for (const name of Object.keys(pages) as Name[])
    test(`${name}: one centred column at 1440 and the whole width at 390, clean in v2, in English and German`, async () => {
      if (name === "legal-empty") legalContent = "";
      for (const locale of ["en", "de"] as const)
        for (const width of [390, 1440]) {
          const context = `${name} ${locale} ${width}`;
          const page = await measure(name, width, locale);
          expect(page.outline.includes("Problems (") ? page.outline : "", context).toBe("");
          expect(page.problems, context).toEqual([]);
          expect(page.v1, context).toEqual([]);
          expect(page.scrollWidth, context).toBeLessThanOrEqual(width);
          expect(page.cut, context).toEqual([]);
          expect(page.unbound, context).toEqual([]);
          expect(page.gutter, context).toEqual([]);
          const column = page.column!;
          if (width === 1440) {
            expect(column.width, context).toBeLessThanOrEqual(560);
            expect(column.width, context).toBeGreaterThan(480);
            expect(Math.abs(column.left - (width - column.right)), context).toBeLessThanOrEqual(1);
            expect(column.top, context).toBeGreaterThanOrEqual(24);
          } else {
            expect([column.left, column.width], context).toEqual([0, width]);
          }
          expect(page.heading, context).toBe(headings(locale)[name]);
          expect(page.autofocus, context).toEqual(focused[name]);
          expect(page.legal, context).toEqual(
            locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"],
          );
          expect(page.footer!.top, context).toBeGreaterThanOrEqual(column.bottom);
          // The smokes accept the terms by the version on the consent form.
          if (name === "consent") expect(page.legalVersion, context).toBe("a".repeat(64));
          expect(page.printed.length, context).toBe(name === "legal" ? 1 : 0);
        }
    }, 60_000);
});
