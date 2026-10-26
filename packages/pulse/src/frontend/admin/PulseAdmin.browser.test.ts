import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AdminBaseRow, AdminBasesPage, InternalTarget, InternalTargetsPage, PulsePolicy } from "../../store/admin-contracts";
import { pauseWorkspaceClock } from "../PulseWorkspace.browser-fixture";

// Administration -> Pulse -> Bases and Internal targets: ClickHouse-backed parts load after the first frame
// without moving anything above them, every action ends in a visible result, and both tabs fit a phone and a
// desktop in light and dark.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const ui = new URL("../../../../ui/", import.meta.url).pathname;
const origin = "https://cloud.example.test";
const measuredAt = "2026-10-17T12:30:00.000Z";
const limits = {
  queriesPerHour: 600,
  valuesPerMinute: 2000,
  bytesPerMinute: 5_242_880,
  storageBytes: 5_000_000_000,
  maxSeries: 50_000,
  maxEventKinds: 2000,
  maxStateKeys: 2000,
};
const policy: PulsePolicy = {
  baseCreation: "everyone",
  maxBases: 200,
  maxRawRetentionDays: 730,
  defaultProfile: "normal",
  defaultLimits: limits,
};
const row = (id: string, name: string, store: Partial<AdminBaseRow["store"]> = {}): AdminBaseRow => ({
  rollupLag: false,
  id,
  name,
  admins: ["Jana Berger"],
  adminCount: 1,
  rawRetentionDays: 30,
  rollupRetentionDays: 800,
  sensitiveRetentionHours: 24,
  createdAt: "2026-10-01T08:00:00.000Z",
  store: {
    state: "active",
    operation: null,
    errorCode: null,
    errorAt: null,
    writeBlockReason: null,
    profile: "normal",
    limits,
    usage: { bytes: 1_800_000_000, rows: 1_200_000, measuredAt },
    ...store,
  },
});
const basesPage: AdminBasesPage = {
  items: [
    row("Bet001", "Betrieb"),
    row("Lad001", "Laden", { state: "failed", operation: "provision", errorCode: "STORE_UNREACHABLE", usage: null }),
    row("Web001", "Website", { writeBlockReason: "checkpoint_mismatch", usage: { bytes: 400_000_000, rows: 10, measuredAt } }),
  ],
  total: 3,
  nextOffset: null,
  usedBytes: 2_200_000_000,
  disk: { freeBytes: 41_000_000_000, totalBytes: 100_000_000_000, measuredAt },
};
const target = (id: string, entry: string, scope: InternalTarget["scope"], port: number | null, baseName: string): InternalTarget => ({
  id,
  baseId: "Bet001",
  baseName,
  entry,
  scope,
  port,
  createdAt: "2026-10-01T08:00:00.000Z",
});
const targetsPage: InternalTargetsPage = {
  items: [
    target("t1", "web-01", "host", null, "Betrieb"),
    target("t2", "shop-01:9100", "host_port", 9100, "Laden"),
    target("t3", "10.20.0.0/24", "network", null, "Betrieb"),
  ],
  total: 3,
  nextOffset: null,
};

let browser: Browser;
let bundle: string;
let css: string;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./PulseAdmin.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pulse-admin-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Pulse admin harness failed");
  bundle = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const result of built) if (!result.success) throw new AggregateError(result.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((result) => result.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };
type Snapshot =
  | { view: "bases"; policy: PulsePolicy | null; page: AdminBasesPage | null }
  | { view: "targets"; page: InternalTargetsPage | null };
type Answer = { status?: number; json: unknown };

/**
 * Opens one tab. `answer` maps "METHOD /path" to a response; orphans wait for `release()` so a test can measure
 * the frame before ClickHouse answered.
 */
const open = async (
  view: View,
  snapshot: Snapshot,
  options: { dark?: boolean; locale?: string; answer?: Record<string, Answer>; frozenAt?: Date } = {},
) => {
  const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  // A frozen clock runs status refreshes only when the test advances it.
  if (options.frozenAt) {
    await pauseWorkspaceClock(page.clock, options.frozenAt);
  }
  let release = () => {};
  const released = new Promise<void>((done) => {
    release = done;
  });
  const calls: { call: string; body: unknown }[] = [];
  await page.route(`${origin}/api/pulse/admin/**`, async (route) => {
    const url = new URL(route.request().url());
    const call = `${route.request().method()} ${url.pathname}`;
    calls.push({ call, body: route.request().postDataJSON() });
    if (url.pathname === "/api/pulse/admin/orphans") {
      await released;
      return route.fulfill({
        json: options.answer?.[call]?.json ?? { items: [{ database: "pulse_0f3c2b1a9d8e4f7a6b5c4d3e2f1a0b9c" }], nextCursor: null },
      });
    }
    const answer = options.answer?.[call];
    return route.fulfill(
      answer ? { status: answer.status ?? 200, json: answer.json } : { status: 500, json: { code: "ADMIN_REQUEST_FAILED" } },
    );
  });
  await page.route(`${origin}/admin/pulse`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="${options.locale ?? "en"}" class="${options.dark ? "dark" : "light"}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" data-app-id="pulse">` +
        `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div id="root"></div></main></div>` +
        `<script>window.__admin=${JSON.stringify({ ...snapshot, locale: options.locale ?? "en" })}</script></body></html>`,
    }),
  );
  await page.goto(`${origin}/admin/pulse`);
  await page.addScriptTag({ content: bundle });
  return { page, release, calls };
};

const layout = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return rect
        ? { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
        : null;
    };
    return {
      rows: [...document.querySelectorAll("tbody tr")].map(box),
      terms: [...document.querySelectorAll("dl > div")].map(box),
      orphans: box(document.querySelector("#pulse-orphans")),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

describe("Pulse administration tabs in a browser", () => {
  test("the bases tab keeps policy, blocked notice and table in place while orphaned databases load", async () => {
    for (const view of [phone, desktop]) {
      const { page, release } = await open(view, { view: "bases", policy, page: basesPage }, { locale: "de" });
      try {
        await page.getByText("ClickHouse wird geprüft …").waitFor();
        const waiting = await layout(page);
        release();
        await page.getByText("verwaist", { exact: true }).waitFor();
        const done = await layout(page);
        expect(done.rows).toEqual(waiting.rows);
        expect(done.terms).toEqual(waiting.terms);
        expect(done.orphans).toEqual(waiting.orphans);
        expect(done.overflow).toBeLessThanOrEqual(0);
        expect(await page.getByText("1 Base ist für Schreiben gesperrt").count()).toBe(1);
        if (view === desktop) expect(await page.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
        else {
          // A phone hides the action column; tapping the row opens its dialog with the same state action.
          expect(await page.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(0);
          await page.getByRole("row", { name: /Laden/ }).click();
          await page.getByRole("dialog").getByRole("button", { name: "Erneut versuchen" }).waitFor();
        }
      } finally {
        await page.close();
      }
    }
  }, 60_000);

  test("a refused policy change puts the saved choice back and says so", async () => {
    const { page, release, calls } = await open(
      desktop,
      { view: "bases", policy, page: basesPage },
      {
        answer: { "PUT /api/pulse/admin/policy": { status: 403, json: { code: "ACCESS_DENIED" } } },
      },
    );
    try {
      release();
      await page.getByRole("combobox", { name: "New bases" }).click();
      await page.getByRole("option", { name: "People only" }).click();
      await page.getByText("Only Cloud admins can do this.").waitFor();
      expect(await page.getByRole("combobox", { name: "New bases" }).textContent()).toContain("All people and agents");
      expect(calls.find((call) => call.call === "PUT /api/pulse/admin/policy")?.body).toEqual({ baseCreation: "people" });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("retry resumes a failed base and limits save through the dialog", async () => {
    const retried = row("Lad001", "Laden", { state: "provisioning", operation: "provision", usage: null });
    const limited = row("Bet001", "Betrieb", { profile: "large", limits: { ...limits, valuesPerMinute: 5000 } });
    const { page, release, calls } = await open(
      desktop,
      { view: "bases", policy, page: basesPage },
      {
        answer: {
          "POST /api/pulse/admin/bases/Lad001/retry": { json: retried },
          "PUT /api/pulse/admin/bases/Bet001/limits": { json: limited },
        },
      },
    );
    try {
      release();
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Being set up").waitFor();
      expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
      await page
        .getByRole("row", { name: /Betrieb/ })
        .getByRole("button", { name: "Limits" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("spinbutton", { name: "Values per minute" }).fill("5000");
      await dialog.getByRole("button", { name: "Save" }).click();
      await page
        .getByRole("row", { name: /Betrieb/ })
        .getByText("5,000")
        .waitFor();
      const saved = calls.find((call) => call.call === "PUT /api/pulse/admin/bases/Bet001/limits")?.body as {
        limits: { valuesPerMinute: number };
      };
      expect(saved.limits.valuesPerMinute).toBe(5000);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the targets tab names a refused entry at its field and removes a target after confirmation", async () => {
    const created = target("t4", "db-02:5432", "host_port", 5432, "Betrieb");
    const { page, calls } = await open(
      desktop,
      { view: "targets", page: targetsPage },
      {
        answer: {
          "GET /api/pulse/admin/bases": { json: basesPage },
          "DELETE /api/pulse/admin/targets/t2": { json: { ok: true } },
        },
      },
    );
    try {
      await page.getByRole("button", { name: "Release target" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox", { name: "Base" }).click();
      await page.getByRole("option", { name: "Betrieb" }).click();
      await dialog.getByRole("textbox", { name: /Target/ }).fill("0.0.0.0/0");
      // The server list the tab reloads after every change: a change shifts the offsets of later pages.
      let listed = [...targetsPage.items];
      await page.route(`${origin}/api/pulse/admin/targets**`, (route) => {
        const method = route.request().method();
        if (method === "POST") {
          if ((route.request().postDataJSON() as { entry: string }).entry === "0.0.0.0/0")
            return route.fulfill({ status: 400, json: { code: "TARGET_TOO_BROAD" } });
          listed = [created, ...listed];
          return route.fulfill({ status: 201, json: created });
        }
        if (method === "DELETE") listed = listed.filter((item) => !route.request().url().endsWith(`/${item.id}`));
        if (method === "GET") return route.fulfill({ json: { items: listed, total: listed.length, nextOffset: null } });
        return route.fallback();
      });
      await dialog.getByRole("button", { name: "Release target" }).click();
      await dialog.getByText("A /0 network would allow every address.", { exact: false }).waitFor();
      await dialog.getByRole("textbox", { name: /Target/ }).fill("db-02:5432");
      await dialog.getByRole("button", { name: "Release target" }).click();
      await page.getByRole("row", { name: /db-02:5432/ }).waitFor();
      expect(
        await page
          .getByRole("row", { name: /db-02:5432/ })
          .getByRole("cell", { name: "port 5432", exact: true })
          .count(),
      ).toBe(1);
      await page.getByRole("button", { name: "Remove shop-01:9100?" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
      await page.getByRole("row", { name: /shop-01:9100/ }).waitFor({ state: "detached" });
      expect(calls.some((call) => call.call === "DELETE /api/pulse/admin/targets/t2")).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("both tabs fit a phone and a desktop in light and dark, with data, empty and failed reads", async () => {
    const snapshots: Snapshot[] = [
      { view: "bases", policy, page: basesPage },
      { view: "bases", policy, page: { ...basesPage, items: [], total: 0, usedBytes: 0 } },
      { view: "bases", policy: null, page: null },
      { view: "targets", page: targetsPage },
      { view: "targets", page: { items: [], total: 0, nextOffset: null } },
      { view: "targets", page: null },
    ];
    for (const view of [phone, desktop])
      for (const dark of [false, true])
        for (const snapshot of snapshots) {
          const { page, release } = await open(view, snapshot, { dark });
          try {
            release();
            await page.locator("#root > *").first().waitFor();
            expect((await layout(page)).overflow).toBeLessThanOrEqual(0);
          } finally {
            await page.close();
          }
        }
  }, 120_000);

  test("running operations are followed to a failure, to the end, and to a deleted base, without moving rows", async () => {
    const failedAgain = row("Lad001", "Laden", { state: "failed", operation: "provision", errorCode: "STORE_UNREACHABLE", usage: null });
    const deleting = row("Alt001", "Altbestand", { state: "deleting", operation: "delete" });
    const page0: AdminBasesPage = { ...basesPage, items: [...basesPage.items, deleting], total: 4 };
    const answer: Record<string, Answer> = {
      "POST /api/pulse/admin/bases/Lad001/retry": {
        json: row("Lad001", "Laden", { state: "provisioning", operation: "provision", usage: null }),
      },
    };
    const { page, release } = await open(desktop, { view: "bases", policy, page: page0 }, { answer, frozenAt: new Date(measuredAt) });
    const lookups: string[] = [];
    // Status refreshes look up each running base by its ID.
    await page.route(`${origin}/api/pulse/admin/bases?*`, (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") ?? "";
      lookups.push(q);
      const items = q === "Lad001" ? [failedAgain] : [];
      return route.fulfill({ json: { ...basesPage, items, total: items.length } });
    });
    try {
      release();
      const laden = page.getByRole("row", { name: /Laden/ });
      const alt = page.getByRole("row", { name: /Altbestand/ });
      await alt.getByText("Being deleted").waitFor();
      const before = await layout(page);
      await laden.getByRole("button", { name: "Retry" }).click();
      await laden.getByText("Being set up").waitFor();
      await page.clock.runFor(5_100);
      // The retried base failed again: Retry is back in place; the deleted one says so and keeps its row.
      await laden.getByRole("button", { name: "Retry" }).waitFor();
      await alt.getByText("Deleted", { exact: true }).waitFor();
      expect(await alt.getByRole("button", { name: "Limits" }).isDisabled()).toBe(true);
      expect(lookups.sort()).toEqual(["Alt001", "Lad001"]);
      // Nothing is running any more, so nothing is asked again.
      await page.clock.runFor(10_100);
      expect(lookups).toHaveLength(2);
      expect((await layout(page)).rows).toEqual(before.rows);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a failed status lookup marks running rows as unknown, and Retry asks again at once, without moving rows", async () => {
    const deleting = row("Alt001", "Altbestand", { state: "deleting", operation: "delete" });
    const page0: AdminBasesPage = { ...basesPage, items: [...basesPage.items, deleting], total: 4 };
    const { page, release } = await open(desktop, { view: "bases", policy, page: page0 }, { frozenAt: new Date(measuredAt) });
    let lookups = 0;
    let fail = true;
    await page.route(`${origin}/api/pulse/admin/bases?*`, (route) => {
      lookups++;
      return fail
        ? route.fulfill({ status: 500, json: { code: "ADMIN_REQUEST_FAILED" } })
        : route.fulfill({ json: { ...basesPage, items: [deleting], total: 1 } });
    });
    try {
      release();
      const alt = page.getByRole("row", { name: /Altbestand/ });
      await alt.getByText("Being deleted").waitFor();
      const before = await layout(page);
      expect(await alt.getByRole("button", { name: "Retry" }).count()).toBe(0);
      await page.clock.runFor(5_100);
      // The row keeps its last state as "unknown", with Retry where a failed row has it.
      await alt.getByText("Status unknown").waitFor();
      const retry = alt.getByRole("button", { name: "Retry" });
      expect(await retry.isEnabled()).toBe(true);
      expect((await layout(page)).rows).toEqual(before.rows);
      fail = false;
      await retry.click();
      await page.clock.runFor(100);
      await alt.getByText("Being deleted").waitFor();
      expect(await retry.count()).toBe(0);
      expect(lookups).toBe(2);
      expect((await layout(page)).rows).toEqual(before.rows);
    } finally {
      await page.close();
    }
  }, 30_000);
});
