import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import {
  KEPT_NOW,
  keptAdminNav,
  keptDateConfig,
  keptPerDay,
  keptRecord,
  keptRows,
  keptWorstRecord,
  keptWorstRows,
} from "../../../../test/fixtures/mail-admin-kept";
import {
  mailboxesEmptyProps,
  mailboxesHugeProps,
  mailboxesProps,
  mailboxesWorstProps,
} from "../../../../test/fixtures/mail-admin-mailboxes";
import { securityProps, securityWorstProps } from "../../../../test/fixtures/mail-admin-security";
import type { KeptHarnessOptions } from "./mail-admin.browser-harness";

// Cloud administration › Mail › Kept on v2: the list selects and downloads, searches and pages through addresses, and
// keeps its shape with the worst data and a full page; the record shows kept mail without loading anything from the
// network, and stops keeping with a reason, a refusal staying visible in the dialog.
const ui = resolve(import.meta.dir, "../../../../../ui");
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "mail-admin.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "mail-admin-kept",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Kept admin harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../../../cloud")))).default;
  const builds = await Promise.all(
    [resolve(import.meta.dir, "../../../../../../styles.css"), resolve(import.meta.dir, "../../../styles/app.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Kept admin CSS failed");
  return (await Promise.all(builds.flatMap((build) => build.outputs.map((output) => output.text())))).join("\n");
};

type Recorded = { method: string; path: string; body: unknown };
const requests: Recorded[] = [];
let refuseNext = false;
let harness: string;
let css: string;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
const uiDist = resolve(ui, "dist");

// The frame the v2 Mail tests measure in: a 56 px rail and an 8 px card inset from 768 px, the phone bar above.
const frame = `html,body{margin:0;height:100%}
.v2-shell{position:fixed;inset:8px 8px 8px 56px;display:flex}
.v2-shell>main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}
@media (max-width:767px){.v2-shell{inset:52px 0 0 0}}`;

beforeAll(async () => {
  [harness, css] = await Promise.all([buildHarness(), buildCss()]);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (url.pathname.startsWith("/ui/") && !url.pathname.includes(".."))
        return new Response(Bun.file(resolve(uiDist, url.pathname.slice(4))));
      // Security: every change is recorded; a value the server refuses comes back with its reason
      if (url.pathname.startsWith("/api/mail/admin/security")) {
        const text = await request.text();
        const body = text ? JSON.parse(text) : null;
        requests.push({ method: request.method, path: url.pathname, body });
        if (body?.value === "nicht gültig" || body?.name === "Ab" || body?.trustedAuthservIds?.includes("abgelehnt"))
          return Response.json({ message: "Der Server lehnt diesen Wert ab." }, { status: 400 });
        return Response.json({});
      }
      // Mailboxes: the storage refresh is queued, a mailbox's access loads for its dialog
      if (url.pathname === "/api/mail/admin/storage/reconcile") {
        requests.push({ method: request.method, path: url.pathname, body: null });
        return Response.json({ queued: true });
      }
      if (/^\/api\/mail\/admin\/mailboxes\/[^/]+\/access$/.test(url.pathname)) {
        requests.push({ method: request.method, path: url.pathname, body: null });
        return Response.json([]);
      }
      if (url.pathname.startsWith("/api/mail/admin/kept")) {
        const text = await request.text();
        requests.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : null });
        if (refuseNext) {
          refuseNext = false;
          return Response.json(
            { code: "FORBIDDEN", message: "Only a Cloud administrator can stop keeping a conversation" },
            { status: 403 },
          );
        }
        if (request.method === "DELETE") return Response.json({ conversationId: "Con0001", released: true });
        return new Response(JSON.stringify({ schema: "cloud.mail.kept-conversations/v1", conversations: [] }), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="kept-conversations-2026-11-26.json"',
          },
        });
      }
      // every page of the admin area answers with the same empty frame: a link or a search that opens one lands here
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><link rel="stylesheet" href="/styles.css"><style>${frame}</style></head><body class="k2b-ui" data-theme="light"><div class="v2-shell"><main class="k2-ui" id="root"></main></div><script src="/harness.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, acceptDownloads: true };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true };

const open = async (context: BrowserContextOptions, options: KeptHarnessOptions, before?: (page: Page) => Promise<unknown>) => {
  requests.length = 0;
  const page = await (await browser.newContext(context)).newPage();
  await page.clock.install({ time: new Date(KEPT_NOW) });
  await before?.(page);
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  await page.goto(`${server.url.href}admin/mail/kept`);
  await page.evaluate((harnessOptions) => window.mountKept(harnessOptions), options);
  await settled(page);
  return Object.assign(page, { errors });
};

const list = (overrides: Partial<NonNullable<KeptHarnessOptions["list"]>> = {}): KeptHarnessOptions => ({
  locale: "de",
  list: {
    nav: keptAdminNav(),
    rows: keptRows(),
    total: 214,
    perDay: keptPerDay(),
    failure: null,
    query: "",
    cursor: null,
    nextCursor: "c2",
    ...overrides,
  },
});
const record = (overrides: Partial<NonNullable<KeptHarnessOptions["record"]>> = {}): KeptHarnessOptions => ({
  locale: "de",
  record: { nav: keptAdminNav(), record: keptRecord(), dateConfig: keptDateConfig, ...overrides },
});

/** How far the page reaches beyond its window sideways; 0 when nothing scrolls the page itself. */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe("Admin › Mail › Kept on v2", () => {
  test("downloads a selection as one JSON file, and a failed download stays visible with a retry", async () => {
    const page = await open(desktop, list());
    try {
      const table = page.getByRole("table", { name: "Aufbewahrte Unterhaltungen" });
      await table.waitFor();
      // a column head's name also carries the grip beside it, so its words are read as text
      const heads = (await table.getByRole("columnheader").allInnerTexts()).map((text) => text.trim()).filter(Boolean);
      expect(heads).toEqual(["Unterhaltung", "Postfach", "Aufbewahrt von", "Absender", "Datum", "Aufbewahrt seit"]);
      await page.getByText("214 aufbewahrte Unterhaltungen").waitFor();
      await page.getByText("2 aus gelöschten Postfächern").waitFor();

      await page.getByRole("checkbox", { name: "„Gewährleistung Lastenrad LR-2207“ auswählen" }).check();
      await page.getByRole("checkbox", { name: "„Mahnung Rechnung 2026-0412, dritte Stufe“ auswählen" }).check();
      await page.getByText("2 ausgewählt").waitFor();
      const saved = page.waitForEvent("download");
      await page.getByRole("button", { name: "Auswahl als JSON herunterladen" }).click();
      expect((await saved).suggestedFilename()).toBe("kept-conversations-2026-11-26.json");
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/mail/admin/kept/export",
          body: {
            items: [
              { mailboxId: "Box002", conversationId: "Con0002" },
              { mailboxId: "Box003", conversationId: "Con0003" },
            ],
          },
        },
      ]);

      // all of the page, then a refusal: the server's reason stays in a toast that offers to try again
      await page.getByRole("checkbox", { name: "Alle Unterhaltungen dieser Seite auswählen" }).first().check();
      await page.getByText("18 ausgewählt").waitFor();
      refuseNext = true;
      await page.getByRole("button", { name: "Auswahl als JSON herunterladen" }).click();
      await page.getByText("Only a Cloud administrator can stop keeping a conversation").waitFor();
      await page.getByRole("button", { name: "Erneut versuchen" }).waitFor();
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("searches and pages through addresses, and every row opens its record", async () => {
    const page = await open(desktop, list({ query: "", cursor: null }));
    try {
      const row = page.getByRole("link", { name: "Kündigung Mietvertrag Lindenstraße 14" }).first();
      expect(await row.getAttribute("href")).toBe("/admin/mail/kept/Box001/Con0001");
      expect(await page.getByRole("link", { name: "Nächste Seite" }).getAttribute("href")).toBe("/admin/mail/kept?cursor=c2");

      const searched = page.waitForURL("**/admin/mail/kept?q=Lindenstra%C3%9Fe");
      const search = page.getByRole("searchbox", { name: "Aufbewahrte Unterhaltungen durchsuchen" });
      await search.fill("  Lindenstraße ");
      await search.press("Enter");
      await searched;
      // The harness page has no page swap, so the search is a document load, which aborts the view transition the
      // stylesheet opts into; the Cloud shell swaps the page in place instead.
      expect(page.errors.filter((error) => !error.startsWith("InvalidStateError: Transition was aborted"))).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("says when nothing is kept, when nothing matches, and when the list failed", async () => {
    const empty = await open(desktop, list({ rows: [], total: 0, nextCursor: null }));
    try {
      await empty
        .getByText("Keine Unterhaltung wird aufbewahrt. Wenn jemand in Mail eine Unterhaltung aufbewahrt, erscheint sie hier.")
        .waitFor();
      expect(await empty.getByRole("checkbox", { name: "Alle Unterhaltungen dieser Seite auswählen" }).count()).toBe(0);
    } finally {
      await empty.context().close();
    }
    const none = await open(desktop, list({ rows: [], total: 214, query: "Nordpol", nextCursor: null }));
    try {
      await none.getByText("Keine aufbewahrte Unterhaltung passt zu „Nordpol“.").waitFor();
      expect(await none.getByRole("link", { name: "Suche leeren" }).getAttribute("href")).toBe("/admin/mail/kept");
    } finally {
      await none.context().close();
    }
    const failed = await open(
      desktop,
      list({
        rows: [],
        total: null,
        failure: "Aufbewahrte Unterhaltungen konnten nicht geladen werden: Zeitüberschreitung",
        nextCursor: null,
      }),
    );
    try {
      await failed.getByText("Aufbewahrte Unterhaltungen konnten nicht geladen werden: Zeitüberschreitung").waitFor();
      await failed.getByRole("button", { name: "Erneut versuchen" }).waitFor();
      expect(failed.errors).toEqual([]);
    } finally {
      await failed.context().close();
    }
  }, 30_000);

  test("keeps its shape with the worst data and a full page, on the desktop and the phone", async () => {
    for (const context of [desktop, phone]) {
      const worst = await open(context, list({ rows: keptWorstRows() }));
      try {
        await worst.getByText("关于合同续签的通知").filter({ visible: true }).first().waitFor();
        expect(await overflow(worst)).toBeLessThanOrEqual(0);
        expect(worst.errors).toEqual([]);
      } finally {
        await worst.context().close();
      }
      // a page holds at most 50 rows (the service's page), whatever the total
      const full = await open(context, list({ rows: keptRows(50), total: 12_840 }));
      try {
        await full.getByText("12.840 aufbewahrte Unterhaltungen").filter({ visible: true }).first().waitFor();
        expect(await overflow(full)).toBeLessThanOrEqual(0);
        expect(await full.evaluate(() => document.querySelectorAll("#root *").length)).toBeLessThan(context === phone ? 4_000 : 6_000);
        expect(full.errors).toEqual([]);
      } finally {
        await full.context().close();
      }
    }
  }, 60_000);

  test("on the phone the table becomes rows, and a box takes a tap", async () => {
    const page = await open(phone, list());
    try {
      const rows = page.getByRole("list", { name: "Aufbewahrte Unterhaltungen" });
      await rows.getByText("Kündigung Mietvertrag Lindenstraße 14").waitFor();
      expect(await page.getByRole("table").isVisible()).toBe(false);
      await rows.getByRole("checkbox", { name: "Gewährleistung Lastenrad LR-2207" }).tap();
      await page.getByText("1 ausgewählt").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("shows the record without loading remote content, with its figures, delivery states and history", async () => {
    const tracker: string[] = [];
    const page = await open(desktop, record(), (page) =>
      page.route("https://tracker.example.org/**", (route) => {
        tracker.push(route.request().url());
        return route.fulfill({ status: 204 });
      }),
    );
    try {
      await page.getByText("Kündigung Mietvertrag Lindenstraße 14").first().waitFor();
      await page.getByText("von Jana Berger").waitFor();
      await page.getByText("Box001/Con0001").waitFor();
      await page.getByText("Übergabeprotokoll-Entwurf.pdf").waitFor();
      await page.frameLocator("iframe").first().getByText("fristgerecht zum 31. Dezember 2026").waitFor();
      // a cancelled outgoing copy never reads as sent; a refusal in the history is marked
      await page.getByText("Nicht gesendet (abgebrochen)").waitFor();
      await page.getByText("Gesendet", { exact: true }).waitFor();
      await page.getByText("wollte die Aufbewahrung aufheben (abgelehnt)").waitFor();
      // nothing needs attention: no band above the figures
      expect(await page.getByRole("note").count()).toBe(0);
      expect(tracker).toEqual([]);
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("warns when the record shows fewer messages than are kept, and says when it is not kept", async () => {
    const long = await open(desktop, record({ record: { ...keptRecord(), messageCount: 64 } }));
    try {
      await long.getByText("Die neuesten 3 von 64 Nachrichten werden angezeigt.", { exact: false }).waitFor();
    } finally {
      await long.context().close();
    }
    const gone = await open(desktop, record({ record: undefined, missing: { notFound: true } }));
    try {
      await gone.getByText("Diese Unterhaltung wird nicht aufbewahrt oder existiert nicht mehr.").waitFor();
      expect(await gone.getByRole("link", { name: "Aufbewahrte Unterhaltungen" }).getAttribute("href")).toBe("/admin/mail/kept");
      expect(gone.errors).toEqual([]);
    } finally {
      await gone.context().close();
    }
  }, 30_000);

  test("stops keeping with a reason; a refusal stays in the dialog", async () => {
    for (const context of [desktop, phone]) {
      const page = await open(context, record());
      try {
        // the download stays in the head on the phone too
        await page.getByRole("button", { name: "Als JSON herunterladen" }).waitFor();
        refuseNext = true;
        await page.getByRole("button", { name: "Weitere Aktionen" }).click();
        await page.getByRole("menuitem", { name: "Aufbewahrung aufheben" }).click();
        const dialog = page.getByRole("dialog", { name: "Aufbewahrung aufheben?" });
        await dialog.getByRole("button", { name: "Aufbewahrung aufheben" }).click();
        await dialog.getByText("Only a Cloud administrator can stop keeping a conversation").waitFor();
        expect(requests.at(-1)).toEqual({ method: "DELETE", path: "/api/mail/admin/kept/Box001/Con0001", body: {} });

        await dialog.getByLabel("Begründung (optional)").fill("  Frist abgelaufen  ");
        const left = page.waitForURL("**/admin/mail/kept");
        await dialog.getByRole("button", { name: "Aufbewahrung aufheben" }).click();
        await left;
        expect(requests.at(-1)).toEqual({
          method: "DELETE",
          path: "/api/mail/admin/kept/Box001/Con0001",
          body: { reason: "Frist abgelaufen" },
        });
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);
});

describe("Admin › Mail › Mailboxes on v2", () => {
  const mailboxes = (overrides: Parameters<typeof mailboxesProps>[0] = {}): KeptHarnessOptions => ({
    locale: "de",
    mailboxes: mailboxesProps(overrides),
  });

  test("shows the figures and every mailbox without sideways scroll, on the desktop and the phone", async () => {
    for (const context of [desktop, phone]) {
      const page = await open(context, mailboxes());
      try {
        await page.getByText("12 von 12 Postfächern").waitFor();
        await page.getByText("Ohne Verwaltung").filter({ visible: true }).first().waitFor();
        await page.getByText("Rechnungseingang").filter({ visible: true }).first().waitFor();
        await page.getByText("Kontakte", { exact: true }).waitFor();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  test("opens a mailbox's access, also from its row on the phone, and queues the storage refresh", async () => {
    for (const context of [desktop, phone]) {
      const page = await open(context, mailboxes());
      try {
        await page.getByRole("button", { name: "Personal" }).filter({ visible: true }).first().click();
        await page.getByRole("dialog").waitFor();
        expect(requests.at(-1)).toEqual({ method: "GET", path: "/api/mail/admin/mailboxes/Mbx005/access", body: null });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Weitere Aktionen" }).click();
        await page.getByRole("menuitem", { name: "Speicherbestand aktualisieren" }).click();
        await page.getByText("Speicherabgleich eingeplant").waitFor();
        expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/mail/admin/storage/reconcile", body: null });
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 60_000);

  test("says when nothing matches, and keeps the page when a part could not load", async () => {
    const none = await open(desktop, mailboxes({ rows: [], query: "Nordpol" }));
    try {
      await none
        .getByText("Keine Postfächer passend zu „Nordpol“.", { exact: false })
        .or(none.getByText("Nordpol", { exact: false }))
        .first()
        .waitFor();
      expect(await none.getByRole("link", { name: "Suche leeren" }).getAttribute("href")).toBe("/admin/mail");
    } finally {
      await none.context().close();
    }
    const partial = await open(
      desktop,
      mailboxes({
        failure: "Der Speicher ist nicht erreichbar.",
        figures: { mailboxes: 12, withoutAdministrator: 2, attention: 16, storage: null },
      }),
    );
    try {
      await partial.getByText("Der Speicher ist nicht erreichbar.").waitFor();
      await partial.getByText("Verwaltung").filter({ visible: true }).first().waitFor();
      expect(partial.errors).toEqual([]);
    } finally {
      await partial.context().close();
    }
  }, 30_000);
});

describe("Admin › Mail › Security on v2", () => {
  const security = (...args: Parameters<typeof securityProps>): KeptHarnessOptions => ({ locale: "de", security: securityProps(...args) });
  const reloaded = (page: Page) => page.waitForURL("**/admin/mail/kept", { waitUntil: "load" });
  /** Opens a dialog from "+" or "⋯" in the head, as a person does. */
  const fromHead = async (page: Page, menu: string, item: string) => {
    await page.getByRole("button", { name: menu, exact: true }).click();
    await page.getByRole("menuitem", { name: item }).click();
    return page.getByRole("dialog");
  };
  /** Cancel closes the dialog without a request, and the focus goes back to the button that opened its menu. */
  const cancelReturnsFocus = async (page: Page, menu: string, item: string) => {
    const before = requests.length;
    const dialog = await fromHead(page, menu, item);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction((name) => document.activeElement?.getAttribute("aria-label") === name, menu);
    expect(requests.length).toBe(before);
  };

  test("shows the figures and the three lists as tabs, each in its own address", async () => {
    for (const context of [desktop, phone]) {
      const page = await open(context, security());
      try {
        await page.getByText("Gemeldete E-Mails").filter({ visible: true }).first().waitFor();
        await page.getByText("rechnung@paypal-konto-sicherheit.example.org").filter({ visible: true }).first().waitFor();
        // every report shows its state as dot and word (a cell that returned nothing once left the column empty)
        await page.getByText("In Prüfung", { exact: true }).filter({ visible: true }).first().waitFor();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
    const rules = await open(desktop, security("rules", { searches: { reports: "paypal", rules: "", identities: "" } }));
    try {
      await rules.getByText("login-microsoft-verify.example.org").filter({ visible: true }).first().waitFor();
      // the tabs keep the other lists' searches in their addresses
      expect(await rules.locator('a[href="/admin/mail/security?reports=paypal"]').count()).toBe(1);
      expect(await rules.locator('a[href="/admin/mail/security?view=identities&reports=paypal"]').count()).toBe(1);
    } finally {
      await rules.context().close();
    }
  }, 60_000);

  test("the rule dialog asks for a value, shows the server's refusal, saves, and gives the focus back on cancel", async () => {
    const page = await open(desktop, security());
    try {
      await cancelReturnsFocus(page, "Regel hinzufügen", "Regel hinzufügen");
      const dialog = await fromHead(page, "Regel hinzufügen", "Regel hinzufügen");
      await dialog.getByRole("button", { name: "Regel hinzufügen" }).click();
      await dialog.getByText("Bitte ausfüllen").waitFor();
      expect(requests.filter((entry) => entry.path.startsWith("/api/mail/admin/security"))).toEqual([]);

      await dialog.getByLabel("Adresse oder Domain").fill("nicht gültig");
      await dialog.getByRole("button", { name: "Regel hinzufügen" }).click();
      await dialog.getByText("Der Server lehnt diesen Wert ab.").waitFor();
      expect(await dialog.getByLabel("Adresse oder Domain").inputValue()).toBe("nicht gültig");

      await dialog.getByLabel("Adresse oder Domain").fill("phish.example.org");
      await dialog.getByLabel("Begründung").fill("  Welle vom Montag  ");
      const done = reloaded(page);
      await dialog.getByRole("button", { name: "Regel hinzufügen" }).click();
      await done;
      expect(requests.at(-1)).toEqual({
        method: "POST",
        path: "/api/mail/admin/security/policies",
        body: { disposition: "deny", target: "sender_domain", value: "phish.example.org", note: "Welle vom Montag", enabled: true },
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the identity dialog needs a name and domains, keeps a refusal, and saves the domains as a list", async () => {
    const page = await open(desktop, security("identities"));
    try {
      await cancelReturnsFocus(page, "Regel hinzufügen", "Identität schützen");
      const dialog = await fromHead(page, "Regel hinzufügen", "Identität schützen");
      await dialog.getByRole("button", { name: "Identität schützen" }).click();
      expect(await dialog.getByText("Bitte ausfüllen").count()).toBe(2);

      await dialog.getByLabel("Sichtbarer Absendername").fill("Ab");
      await dialog.getByLabel("Zulässige Absender-Domains").fill("werkstatt.example.org");
      await dialog.getByRole("button", { name: "Identität schützen" }).click();
      await dialog.getByText("Der Server lehnt diesen Wert ab.").waitFor();

      await dialog.getByLabel("Sichtbarer Absendername").fill("Mira Solberg");
      await dialog.getByLabel("Zulässige Absender-Domains").fill("werkstatt.example.org, , lohn.example.org ");
      const done = reloaded(page);
      await dialog.getByRole("button", { name: "Identität schützen" }).click();
      await done;
      expect(requests.at(-1)).toEqual({
        method: "POST",
        path: "/api/mail/admin/security/protected-identities",
        body: { name: "Mira Solberg", allowedDomains: ["werkstatt.example.org", "lohn.example.org"], note: null, enabled: true },
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the authentication dialog starts from the saved names, refuses more than 20, and saves", async () => {
    const page = await open(desktop, security());
    try {
      await cancelReturnsFocus(page, "Weitere Aktionen", "Authentifizierung");
      const dialog = await fromHead(page, "Weitere Aktionen", "Authentifizierung");
      const field = dialog.getByLabel("Namen der Authentifizierungsserver");
      expect(await field.inputValue()).toBe("mx.werkstatt.example.org");
      await field.fill(Array.from({ length: 21 }, (_, index) => `mx${index}.example.org`).join(", "));
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await dialog.getByText("Höchstens 20 Einträge").waitFor();

      await field.fill("abgelehnt");
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await dialog.getByText("Der Server lehnt diesen Wert ab.").waitFor();

      await field.fill("mx.werkstatt.example.org, mx2.werkstatt.example.org");
      const done = reloaded(page);
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await done;
      expect(requests.at(-1)).toEqual({
        method: "PATCH",
        path: "/api/mail/admin/security/settings",
        body: { trustedAuthservIds: ["mx.werkstatt.example.org", "mx2.werkstatt.example.org"] },
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a report's decision keeps its note and gives the focus back, and deleting a rule asks first", async () => {
    const page = await open(desktop, security());
    try {
      const deeds = page.getByRole("button", { name: "Weitere Aktionen für ceo@werkstatt-mail.example.org" }).filter({ visible: true });
      // cancel gives the focus back to the row's "⋯"
      await deeds.click();
      await page.getByRole("menuitem", { name: "Phishing bestätigen" }).click();
      let dialog = page.getByRole("dialog", { name: "Phishing-Meldung bestätigen" });
      expect(await dialog.getByLabel("Interne Notiz").inputValue()).toBe("Rückfrage bei der Buchhaltung läuft");
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Weitere Aktionen für ceo@werkstatt-mail.example.org",
      );

      await deeds.click();
      await page.getByRole("menuitem", { name: "Phishing bestätigen" }).click();
      dialog = page.getByRole("dialog", { name: "Phishing-Meldung bestätigen" });
      await dialog.getByLabel("Interne Notiz").fill("Bestätigt: gefälschte Geschäftsführung");
      const done = reloaded(page);
      await dialog.getByRole("button", { name: "Bestätigen" }).click();
      await done;
      expect(requests.at(-1)).toEqual({
        method: "PATCH",
        path: "/api/mail/admin/security/reports/00000000-0000-4000-8000-000000000002",
        body: { status: "confirmed", resolutionNote: "Bestätigt: gefälschte Geschäftsführung" },
      });
    } finally {
      await page.context().close();
    }

    const rules = await open(desktop, security("rules"));
    try {
      await rules
        .getByRole("button", { name: "Weitere Aktionen für login-microsoft-verify.example.org" })
        .filter({ visible: true })
        .click();
      await rules.getByRole("menuitem", { name: "Regel löschen" }).click();
      const question = rules.getByRole("alertdialog");
      await question.getByText("login-microsoft-verify.example.org löschen?").waitFor();
      const done = reloaded(rules);
      await question.getByRole("button", { name: "Regel löschen" }).click();
      await done;
      expect(requests.at(-1)).toEqual({
        method: "DELETE",
        path: "/api/mail/admin/security/policies/00000000-0000-4000-8000-000000000102",
        body: null,
      });
      expect(rules.errors.filter((error) => !error.startsWith("InvalidStateError: Transition was aborted"))).toEqual([]);
    } finally {
      await rules.context().close();
    }
  }, 60_000);
});

describe("Admin › Mail at its limits (break-ui)", () => {
  // The worst data each page meets (the fixtures name the limits they come from): the page never scrolls sideways,
  // nothing throws, and the long values stay readable where they stand.
  const states: [string, KeptHarnessOptions, string][] = [
    ["mailboxes at their limits", { locale: "de", mailboxes: mailboxesWorstProps() }, "客户服务 · 售后支持"],
    ["500 mailboxes, a full page", { locale: "de", mailboxes: mailboxesHugeProps() }, "50 von 500 Postfächern"],
    ["no mailbox", { locale: "de", mailboxes: mailboxesEmptyProps() }, "0 von 0 Postfächern"],
    ["security reports at their limits", { locale: "de", security: securityWorstProps("reports") }, "j@x.de"],
    ["security rules at their limits", { locale: "de", security: securityWorstProps("rules") }, "Aktive Regeln"],
    ["protected identities at their limits", { locale: "de", security: securityWorstProps("identities") }, "Ö"],
    [
      "a kept record at its limits",
      { locale: "de", record: { nav: keptAdminNav(), record: keptWorstRecord(), dateConfig: keptDateConfig } },
      "王秀英",
    ],
  ];
  for (const [name, options, text] of states)
    test(name, async () => {
      for (const context of [desktop, phone]) {
        const page = await open(context, options);
        try {
          await page.getByText(text, { exact: true }).filter({ visible: true }).first().waitFor();
          expect(await overflow(page)).toBeLessThanOrEqual(0);
          expect(page.errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }, 60_000);
});
