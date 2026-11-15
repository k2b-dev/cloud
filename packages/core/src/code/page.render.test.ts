import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCodePage } from "@k2b/cloud/code";
import { type CodeCheckedVersionManifest, UserSchema } from "@k2b/cloud/contracts";
import * as server from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CodePageLabel } from "./page-provenance-contracts";

const root = mkdtempSync(join(tmpdir(), "core-code-page-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const { default: Page } = await import("./PageTree.island");
const { createCodeHostingRoutes } = await import("./hosting");
const { codePageFixture } = await import("./page.test-fixture");
const { CODE_INITIAL_PAGE_SOURCE } = await import("./authoring-contracts");
const { CODE_NEWSLETTER_DEMO_SOURCE } = await import("./page.newsletter-demo");
const { buildCodePage } = await import("./page.test-source");
const { Layout } = await import("@k2b/cloud/ssr");
const { ssr } = await import("../config");
const railSnapshot = await import("@k2b/cloud/services/rail-snapshot");
const settingsMiddleware = await import("@k2b/cloud/server/middleware/settings");
const layoutHelp = await import("@k2b/cloud/ssr/help");
const panelConsent = await import("@k2b/cloud/ssr/panel-consent");
const adminStatus = await import("@k2b/cloud/ssr/admin-status");
const { defaultRailPreferences } = await import("@k2b/cloud/contracts/rail-preferences");
const tree = validateCodePage(
  {
    version: 1,
    kind: "Page",
    title: "<script>Workshop</script>",
    children: [
      { kind: "Text", text: "<svg onload=alert(1)>" },
      { kind: "Table", title: "Items", columns: [{ key: "title", label: "Title" }], rows: [{ title: "One" }] },
      {
        kind: "Form",
        title: "Find",
        action: "/find",
        submit: "Find",
        fields: [
          { type: "scan", name: "barcode", label: "Barcode" },
          { type: "select", name: "status", label: "Status", value: "open", options: [{ label: "Open", value: "open" }] },
        ],
      },
      { kind: "Button", label: "Save", action: "/save", values: { id: "one" } },
      { kind: "Chart", description: { kind: "bar", title: "Count", data: [{ label: "One", value: 2 }] } },
      { kind: "Link", label: "Next", href: "/next" },
      { kind: "Detail", title: "Info", items: [{ label: "Code", value: "one" }] },
      { kind: "Notice", tone: "success", title: "Saved" },
    ],
  },
  "c_page",
);
test("SSR renders escaped content, own links, chart data and usable form controls with CSRF", () => {
  const html = renderToString(() =>
    createComponent(Page, { tree, codeId: "c_page", csrf: "session-bound", locale: "en", timeZone: "UTC" }),
  );
  expect(html).toContain("&lt;script>Workshop&lt;/script>");
  expect(html).not.toContain("<svg onload");
  expect(html).toContain('action="/code/c_page/find"');
  expect(html).toContain('method="post"');
  expect(html).toContain('name="_csrf" value="session-bound"');
  expect(html).toContain('name="barcode"');
  expect(html).toContain('name="status"');
  expect(html).toContain('href="/code/c_page/next"');
  expect(html).toContain("Count");
  expect(html).toContain("Info");
});
test("public page forms and buttons render without an empty CSRF field", () => {
  const html = renderToString(() => createComponent(Page, { tree, codeId: "c_page", csrf: null, locale: "en", timeZone: "UTC" }));
  expect(html).toContain('action="/code/c_page/find"');
  expect(html).toContain('action="/code/c_page/save"');
  expect(html).toContain('method="post"');
  expect(html).not.toContain('name="_csrf"');
});
test("the server draws every block with shared components, including the chart and the scan control", () => {
  const full = validateCodePage(codePageFixture, "c_page");
  const html = renderToString(() =>
    createComponent(Page, { tree: full, codeId: "c_page", csrf: "session-bound", locale: "en", timeZone: "UTC" }),
  );
  for (const kind of ["Notice", "Text", "Form", "Heading", "Actions", "Button", "Link"])
    expect(html).toContain(`data-code-block="${kind}"`);
  // Data blocks are the shared description panels: key figures, sections, chart and table frames, details.
  for (const part of [
    "k2b-stat-grid",
    "k2b-dashboard-section",
    "k2b-chart-explorer",
    "k2b-dashboard-frame",
    "k2b-description-list",
    "<table",
  ])
    expect(html).toContain(part);
  // A drawn chart, not only its data table.
  expect(html).toMatch(/<svg[^>]*stdlib-chart|class="[^"]*k2b-chart/);
  expect(html).toContain("Items per status");
  // The empty table names its state; the field shows the Code's validation message.
  expect(html).toContain("Nothing waits.");
  expect(html).toContain("No item has this code.");
  expect(html).toContain('aria-label="Scan"');
  // Detail values in the reader's language; both actions share one row.
  expect(html).toContain("1,200");
  expect(html).toContain("Yes");
  expect(html.match(/data-code-block="Actions"/g)).toHaveLength(1);
  // The page head, key figures with change and comparison, section symbols and panel widths.
  expect(html).toContain("Repair shop");
  expect(html).toContain("As of Nov 7, 2026, 9:40");
  expect(html).toContain('class="ti ti-tool"');
  expect(html).toContain("+12.3%");
  expect(html).toContain("Last week €4,002.00");
  expect(html).toContain("2.4 d");
  expect(html).toContain("95.50");
  expect(html).toContain('class="k2b-dashboard-section__icon ti ti-calendar-event"');
  expect(html).toMatch(/data-width="twoThirds"/);
  // A chart with nothing to draw keeps its frame and title and says why.
  const waiting = validateCodePage(
    { version: 1, kind: "Page", title: "Empty", children: [{ kind: "Chart", title: "Items per status", empty: "No item arrived today." }] },
    "c_page",
  );
  const empty = renderToString(() =>
    createComponent(Page, { tree: waiting, codeId: "c_page", csrf: "session-bound", locale: "en", timeZone: "UTC" }),
  );
  expect(empty).toContain("Items per status");
  expect(empty).toContain("No item arrived today.");
  const german = renderToString(() =>
    createComponent(Page, { tree: full, codeId: "c_page", csrf: "session-bound", locale: "de", timeZone: "UTC" }),
  );
  expect(german).toContain("1.200");
  expect(german).toContain('aria-label="Scannen"');
});
test("Core hosts a complete page document and rejects invalid trees before rendering", async () => {
  const rate = spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
    id,
    check: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
    checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
  }));
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.tsx",
    entrypoints: [
      {
        kind: "route",
        entrypoint: "route:GET:/",
        route: { method: "GET", path: "/", public: true },
        cron: null,
        file: "code.tsx",
        line: 1,
      },
    ],
    permissions: [],
    ai: false,
    policyRows: ["public_routes"],
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
  };
  let returned: unknown = tree;
  const router = new Hono()
    .use("*", async (c, next) => {
      c.set("runtime" as never, { apps: [] } as never);
      await next();
    })
    .route(
      "/",
      createCodeHostingRoutes({
        version: async () => ({ versionId: "version", manifest, personalOwner: null }),
        request: async () => ({ kind: "page", status: 200, tree: returned }),
      }),
    );
  try {
    const response = await router.request("https://cloud.test/code/c_page/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("data-code-page-version");
    expect(html).toContain("PageTree.island.tsx");
    expect(html).not.toContain('name="_csrf"');
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Code-CSRF")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const head = await router.request("https://cloud.test/code/c_page/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    returned = { ...tree, children: [{ kind: "HTML", html: "<script>bad</script>" }] };
    const invalid = await router.request("https://cloud.test/code/c_page/");
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).not.toContain("<script>");
  } finally {
    rate.mockRestore();
  }
});

test("the cld code init page runs through the SDK blocks and Core draws it", async () => {
  const source = CODE_INITIAL_PAGE_SOURCE.replace(
    "const allowedGroupIds: string[] = [];",
    'const allowedGroupIds: string[] = ["fixture-group"];',
  );
  const page = await buildCodePage(source, "c_init", {
    id: "visitor",
    username: "visitor",
    groupIds: ["fixture-group"],
    groupNames: ["Team"],
    kind: "user",
    name: "Visitor",
  });
  const html = renderToString(() =>
    createComponent(Page, { tree: page, codeId: "c_init", csrf: "session-bound", locale: "en", timeZone: "UTC" }),
  );
  for (const part of ["k2b-stat-grid", "k2b-dashboard-section", "k2b-chart-explorer", 'data-code-block="Form"', "<table"])
    expect(html).toContain(part);
  expect(html).toContain("Orders per month");
  expect(html).toContain('name="customer"');
  expect(html).toContain("Lindner GmbH");
});
test("the Newsletter demo page from Code data draws every panel through the shared description panels", async () => {
  const page = await buildCodePage(CODE_NEWSLETTER_DEMO_SOURCE, "c_newsletter");
  const html = renderToString(() =>
    createComponent(Page, { tree: page, codeId: "c_newsletter", csrf: "session-bound", locale: "en", timeZone: "Europe/Berlin" }),
  );
  expect(html).toContain("Pulse · Website");
  expect(html).toContain("As of Nov 6, 2026, 10:40");
  for (const title of ["Effect", "After the click", "Campaigns", "Audience", "Opens per day", "From sending to buying", "Weekly letter 44"])
    expect(html).toContain(title);
  // Four key-figure tiles, one per Stat, with change and comparison.
  expect(html.match(/class="k2b-stat-cell"/g)).toHaveLength(4);
  expect(html).toContain("+8.2%");
  expect(html).toContain("Last month");
  expect(html).toContain("Delivered");
});

describe("Code pages in the Cloud layout", () => {
  const person = UserSchema.parse({
    id: "22222222-2222-4222-8222-222222222222",
    uid: "mmuster",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Mia",
    sn: "Muster",
    displayName: "Mia Muster",
    mail: "mia.muster@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  // Invented installation: Core with the Code routes and the legal pages, an app every visitor may open, and one
  // only signed-in people see.
  const runtime = {
    apps: [
      {
        id: "core",
        name: "Core",
        routes: ["/code", "/impressum"],
        legalLinks: [{ label: "Imprint", href: "/impressum" }],
      },
      {
        id: "faq-probe",
        name: "Questions probe",
        icon: "ti ti-help",
        routes: ["/app/faq-probe"],
        nav: { href: "/app/faq-probe", section: "primary" },
      },
      {
        id: "payroll-probe",
        name: "Payroll probe",
        icon: "ti ti-cash",
        routes: ["/app/payroll-probe"],
        nav: { href: "/app/payroll-probe", section: "primary", requiresAuth: true },
        searchLinks: [{ label: "Salaries", href: "/app/payroll-probe/search" }],
      },
    ],
  };
  const route = (layout?: "plain") => ({ method: "GET" as const, path: "/", public: true, ...(layout ? { layout } : {}) });
  const host = (signedIn: boolean, layout?: "plain") => {
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.tsx",
      entrypoints: [{ kind: "route", entrypoint: "route:GET:/", route: route(layout), cron: null, file: "code.tsx", line: 1 }],
      permissions: [],
      ai: false,
      policyRows: ["public_routes"],
      hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    };
    return new Hono<server.AuthContext>()
      .use("*", async (c, next) => {
        c.set("runtime" as never, runtime as never);
        c.set("settings" as never, { app: { name: "Probe Cloud" } } as never);
        if (signedIn) {
          c.set("user", person);
          c.set("actor", { kind: "user", user: person });
          c.set("accessSubject", { type: "user", userId: person.id });
          c.set("credentialKind", "session");
          c.set("sessionToken", "fixture-session");
        }
        await next();
      })
      .get("/impressum", ...ssr((c) => () => createComponent(Layout, { c, title: "Imprint", children: "Imprint text" })))
      .route(
        "/",
        createCodeHostingRoutes({
          version: async () => ({ versionId: "v_hidden", manifest, personalOwner: "owner-hidden" }),
          request: async () => ({ kind: "page", status: 200, tree }),
        }),
      );
  };
  const shellData = (html: string) => {
    const json = html.match(/<script id="cloud-shell-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
  };
  const withRateLimit = async (run: () => Promise<void>) => {
    const spies = [
      spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
        id,
        check: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
        checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
      })),
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null),
      spyOn(panelConsent, "preloadPanelConsent").mockResolvedValue(undefined),
      spyOn(adminStatus, "preloadAdminCodeApprovals").mockResolvedValue(undefined),
    ];
    try {
      await run();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  };

  /** The feat/code label: the footer right after the tree's container, never inside it, with the pill in the first HTML. */
  const expectLabelOutsideTree = (html: string, pill = "Self-built page", madeWith = "Made with") => {
    expect(html).toMatch(/<\/solid-island><\/div><div class="code-page-provenance" data-code-provenance><solid-island/);
    expect(html.match(/data-code-provenance(?![-\w])/g)).toHaveLength(1);
    const label = html.slice(html.indexOf("data-code-provenance"));
    expect(label).toContain(pill);
    // The card is a closed dialog beside the pill; a press opens it once the island runs.
    expect(label).toContain('aria-haspopup="dialog"');
    expect(label).toContain('popover="manual"');
    expect(label).toContain(madeWith);
    // Printing keeps the label: the print region is the host around tree and label.
    expect(html.match(/data-print-region/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="code-page-host" data-code-page-host[^>]*data-print-region/);
  };
  /** The props of every island in the page, as the browser receives them. */
  const islandProps = (html: string) =>
    [...html.matchAll(/<solid-island[^>]*data-props="([^"]*)"/g)].map(
      (match) =>
        JSON.parse(match[1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as {
          t: { p?: { k?: string[]; v?: unknown[] } };
        },
    );

  test("every variant carries the feat/code label outside the page tree, in the reader's language", () =>
    withRateLimit(async () => {
      for (const [signedIn, layout] of [
        [true, undefined],
        [false, undefined],
        [false, "plain"],
        [true, "plain"],
      ] as const) {
        const html = await (await host(signedIn, layout).request("https://cloud.test/code/c_page/")).text();
        // A member reads whose page it is (F26); a visitor without an account only that someone built it.
        expectLabelOutsideTree(html, signedIn ? "Page of " : "Self-built page");
      }
      const german = await (await host(false).request("https://cloud.test/code/c_page/", { headers: { "Accept-Language": "de" } })).text();
      expectLabelOutsideTree(german, "Selbst gebaute Seite", "Erstellt mit");
      expect(german).toContain("Gib hier nie ein Passwort oder einen Wiederherstellungscode ein.");
    }));

  test("signed-in people see the page in the workspace with their rail and profile", () =>
    withRateLimit(async () => {
      const html = await (await host(true).request("https://cloud.test/code/c_page/")).text();
      expect(html).toContain('data-layout-authenticated="true"');
      expect(html).toContain("layout-rail");
      expect(html).toContain("data-code-page-version");
      // One main landmark: the page sits in the layout's.
      expect(html.match(/<main\b/g)).toHaveLength(1);
      expect(shellData(html)?.profile).toMatchObject({ name: "Mia Muster" });
    }));

  test("anonymous visitors get the signed-out layout that reveals nothing beyond the legal pages, and sign-in returns", () =>
    withRateLimit(async () => {
      const router = host(false);
      const html = await (await router.request("https://cloud.test/code/c_page/?week=45")).text();
      const legal = await (await router.request("https://cloud.test/impressum")).text();
      expect(html).toContain("data-layout-header");
      expect(html).toContain("data-code-page-version");
      expect(html).not.toContain("data-layout-authenticated");
      expect(html).not.toContain("layout-rail");
      expect(html).toContain(`href="/auth/login?redirectTo=${encodeURIComponent("/code/c_page/?week=45")}"`);
      for (const secret of ["Payroll probe", "payroll-probe", "Salaries", "Mia", "fixture-session", "v_hidden", "owner-hidden"])
        expect(html).not.toContain(secret);
      // The shell data is the legal page's, apart from where it is.
      const data = shellData(html);
      const legalData = shellData(legal);
      expect(data).toBeDefined();
      expect(Object.keys(data!).sort()).toEqual(Object.keys(legalData!).sort());
      for (const key of ["apps", "legalLinks", "searchLinks", "profile", "rail", "home", "panel"])
        expect(data![key]).toEqual(legalData![key]);
      expect(data!.profile).toBeUndefined();
      // The island receives the checked tree and what it needs to send it back, nothing else.
      const islands = islandProps(html);
      const page = islands.filter((island) => island.t.p?.k?.includes("tree"));
      expect(page).toHaveLength(1);
      expect(page[0]!.t.p!.k).toEqual(["tree", "codeId", "csrf", "locale", "timeZone"]);
      // The label's island gets exactly the contract's seed and what the pill needs. For a visitor without an account
      // the seed names nobody: no owner, automation title, version number or account appears in it or in the HTML.
      const label = islands.filter((island) => island.t.p?.k?.includes("provenance"));
      expect(label).toHaveLength(1);
      expect(label[0]!.t.p!.k).toEqual(["provenance", "codeId", "form", "locale"]);
      const seed = JSON.stringify(label[0]!.t.p!.v);
      for (const key of ["label", "version", "path", "cloudName"]) expect(seed).toContain(`"${key}"`);
      expect(seed).toContain('"anonymous"');
      expect(seed).toContain("Probe Cloud");
      for (const secret of ["owner-hidden", "v_hidden", "Mia", "Payroll probe"]) {
        expect(seed).not.toContain(secret);
        expect(html).not.toContain(secret);
      }
      // Nothing beyond the seed: no owner kind, automation, report or viewer travels to the island.
      for (const key of ["person", "resource", "owner", "automation", "report", "viewer"]) expect(seed).not.toContain(`"${key}"`);
      // The pill says only that someone built the page; the card's facts load per viewer on its first opening.
      expect(html).toContain("Self-built page");
      expect(html).toContain("Someone built this page themselves");
      expect(html).not.toContain("This page belongs to");
    }));

  test("a route with layout plain renders the page alone, as before", () =>
    withRateLimit(async () => {
      for (const signedIn of [false, true]) {
        const html = await (await host(signedIn, "plain").request("https://cloud.test/code/c_page/")).text();
        expect(html).toContain("data-code-page-version");
        expect(html).not.toContain("data-layout-header");
        expect(html).not.toContain("layout-rail");
        expect(html).not.toContain("cloud-shell-data");
        expect(html.match(/<main\b/g)).toHaveLength(1);
      }
    }));
});

test("a page cannot reach the feat/code label: no block accepts a class, style or markup", () => {
  // Every object in a page with every block, with each way a page could name or style an element added once.
  const attempts: unknown[] = [];
  const visit = (value: unknown, replace: (next: unknown) => unknown) => {
    if (Array.isArray(value))
      value.forEach((item, index) => visit(item, (next) => replace(value.map((old, i) => (i === index ? next : old)))));
    else if (value && typeof value === "object") {
      for (const key of ["class", "className", "style", "css", "html", "id"])
        attempts.push(replace({ ...value, [key]: key === "style" ? "position:fixed;inset:0;z-index:99999" : "code-page-provenance" }));
      // A button's `values` are form data it sends back to the Code (hidden fields), never attributes on the page.
      for (const [key, child] of Object.entries(value)) if (key !== "values") visit(child, (next) => replace({ ...value, [key]: next }));
    }
  };
  visit(codePageFixture, (next) => next);
  expect(attempts.length).toBeGreaterThan(100);
  for (const attempt of attempts) expect(() => validateCodePage(attempt, "c_page")).toThrow();
});

describe("the feat/code label in the first HTML", () => {
  const seed = (label: CodePageLabel) => ({ label, version: "v".repeat(32), path: "/", cloudName: "Möbel Beispiel Cloud" });
  const render = async (page: typeof tree, label: CodePageLabel, locale = "en") => {
    const { default: CodePageHost } = await import("./PageHost");
    return renderToString(() =>
      createComponent(CodePageHost, {
        tree: page,
        codeId: "c_page",
        csrf: "session-bound",
        locale,
        timeZone: "UTC",
        provenance: seed(label),
      }),
    );
  };
  /** The pill: the trigger button of the label's card. */
  const pill = (html: string) => html.match(/<button[^>]*code-page-provenance__pill[\s\S]*?<\/button>/)?.[0] ?? "";
  const password = (html: string) => html.match(/<span class="code-page-provenance__password"[^>]*>/)?.[0];
  const noForm = validateCodePage({ version: 1, kind: "Page", title: "Plain", children: [{ kind: "Text", text: "Hello" }] }, "c_page");

  test("the pill names the page for each label, grammar-free for a resource, in both languages", async () => {
    const cases: [CodePageLabel, string, string, string, string][] = [
      [
        { kind: "anonymous" },
        "Self-built page",
        "Someone built this page themselves",
        "Selbst gebaute Seite",
        "Diese Seite hat jemand selbst gebaut",
      ],
      [
        { kind: "person", name: "Lea Muster" },
        "Page of Lea Muster",
        "This page belongs to Lea Muster",
        "Seite von Lea Muster",
        "Diese Seite gehört zu Lea Muster",
      ],
      [{ kind: "app", name: "Mail" }, "Page of Mail", "This page belongs to Mail", "Seite von Mail", "Diese Seite gehört zu Mail"],
      [
        { kind: "resource", type: "Postfach" },
        "Page · Postfach",
        "This page belongs to: Postfach",
        "Seite · Postfach",
        "Diese Seite gehört zu: Postfach",
      ],
    ];
    for (const [label, en, enTitle, de, deTitle] of cases) {
      const english = await render(noForm, label);
      expect(pill(english)).toContain(en);
      expect(english).toContain(enTitle);
      const german = await render(noForm, label, "de");
      expect(pill(german)).toContain(de);
      expect(german).toContain(deTitle);
      expect(german).toContain("in Möbel Beispiel Cloud");
      // The card's facts are not in the first HTML; only its placeholders and the three promises are.
      expect(german).toContain("Von Cloud geprüft:");
      expect(german).not.toContain("Automation öffnen");
      expect(german).not.toContain("Seite melden");
    }
  });

  test("with a form the pill leads with no passwords, without a press; without one the part waits for CSS", async () => {
    // The fixture has a form inside a section; this page's form sits at the top level.
    for (const page of [validateCodePage(codePageFixture, "c_page"), tree]) {
      const html = await render(page, { kind: "person", name: "Lea Muster" });
      expect(password(html)).toContain("data-form");
      expect(pill(html)).toContain("Do not enter passwords here");
      expect(pill(html).indexOf("Do not enter passwords here")).toBeLessThan(pill(html).indexOf("Page of Lea Muster"));
    }
    expect(pill(await render(tree, { kind: "anonymous" }, "de"))).toContain("Hier keine Passwörter eingeben");
    expect(pill(await render(tree, { kind: "anonymous" }, "de"))).toContain("Keine Passwörter");
    expect(password(await render(noForm, { kind: "anonymous" }))).not.toContain("data-form");
  });
});

test("no block asks for a secret: no password or masked field type and no credential autocomplete", () => {
  const form = (field: Record<string, unknown>) => ({
    version: 1,
    kind: "Page",
    title: "Sign in",
    children: [{ kind: "Form", title: "Sign in", action: "/in", submit: "Send", fields: [{ name: "secret", label: "Secret", ...field }] }],
  });
  for (const type of ["password", "secret", "masked", "hidden", "pin", "otp", "one-time-code"])
    expect(() => validateCodePage(form({ type }), "c_page")).toThrow();
  for (const key of ["autocomplete", "autoComplete", "inputmode", "inputMode", "masked", "secret", "sensitive"])
    for (const value of ["current-password", "new-password", "one-time-code", true])
      expect(() => validateCodePage(form({ type: "text", [key]: value }), "c_page")).toThrow();
  // Every field the contract allows renders without a password input or a credential autocomplete.
  const fields = validateCodePage(codePageFixture, "c_page");
  const html = renderToString(() =>
    createComponent(Page, { tree: fields, codeId: "c_page", csrf: "session-bound", locale: "en", timeZone: "UTC" }),
  );
  expect(html).toContain("<input");
  expect(html).not.toMatch(/type="password"/);
  expect(html).not.toMatch(/autocomplete="(current-password|new-password|one-time-code)"/);
});
