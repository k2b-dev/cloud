#!/usr/bin/env bun
/**
 * Grids browser regression smoke.
 *
 * This intentionally stays small: fixtures are created through the API,
 * then a real browser checks the routes and interactions most likely to
 * regress during v1 polish. Avoid golden screenshots and fragile full-app
 * snapshots; assert visible user-facing behaviour.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type Browser, type BrowserContext, type BrowserContextOptions, chromium, type Page, type Request } from "playwright";

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "base-url": { type: "string", default: "http://localhost:3000" },
    "admin-token-file": { type: "string" },
    "session-token-file": { type: "string" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "20000" },
    help: { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Usage: bun packages/grids/scripts/browser-smoke.ts [options]

Options:
  --base-url <url>             Running Cloud dev server (default http://localhost:3000)
  --admin-token-file <path>    File containing the dev admin token (default token "dev-admin")
  --session-token-file <path>  File containing an existing session token (skips admin login)
  --headed                     Show the browser window
  --keep                       Keep the fixture after the run
  --timeout-ms <n>             Per-step timeout in milliseconds (default 20000)
  --help                       Show this help
`);
  process.exit(0);
}
const readSecret = async (path: string | undefined): Promise<string | undefined> =>
  path ? (await readFile(path, "utf8")).trim() : undefined;
const BASE_URL = options["base-url"];
const ADMIN_TOKEN = (await readSecret(options["admin-token-file"])) ?? "dev-admin";
const SESSION_TOKEN = await readSecret(options["session-token-file"]);
const HEADLESS = !options.headed;
const KEEP = options.keep;
const TIMEOUT = Number(options["timeout-ms"]);

type ApiError = Error & { status?: number; body?: string };

type Fixture = {
  sessionToken: string;
  base: { id: string };
  table: { id: string };
  view: { id: string };
  statView: { id: string };
  pagedView: { id: string };
  form: { id: string; publicToken: string };
  records: {
    first: string;
  };
  fields: {
    title: string;
    amount: string;
    status: string;
    notes: string;
    due: string;
  };
};

const log = (message: string) => console.log(message);
const ok = (message: string) => log(`✓ ${message}`);

const fail = (message: string): never => {
  throw new Error(message);
};

const api = async <T>(
  method: string,
  path: string,
  body?: unknown,
  sessionToken?: string,
  expected = method === "DELETE" ? 204 : 200,
): Promise<T> => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== expected) {
    const err = new Error(`${method} ${path} expected ${expected}, got ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = text.slice(0, 800);
    throw err;
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
};

const login = async (): Promise<string> => {
  if (SESSION_TOKEN) {
    ok("session-token supplied");
    return SESSION_TOKEN;
  }
  const result = await api<{ session_token: string }>("POST", "/api/auth/admin-login", { token: ADMIN_TOKEN }, undefined, 200);
  if (!result.session_token) fail("admin-login returned no session token");
  ok("admin-login");
  return result.session_token;
};

const createFixture = async (): Promise<Fixture> => {
  const sessionToken = await login();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;

  const base = await api<{ id: string }>(
    "POST",
    "/api/grids/bases",
    { name: `browser-smoke-${suffix}`, description: "Browser regression smoke fixture" },
    sessionToken,
    201,
  );
  const table = await api<{ id: string }>(
    "POST",
    `/api/grids/tables/by-base/${base.id}`,
    { name: "Tasks", icon: "ti ti-checklist" },
    sessionToken,
    201,
  );

  const title = await api<{ id: string }>(
    "POST",
    `/api/grids/fields/by-table/${table.id}`,
    { name: "Title", type: "text", required: true },
    sessionToken,
    201,
  );
  const amount = await api<{ id: string }>(
    "POST",
    `/api/grids/fields/by-table/${table.id}`,
    {
      name: "Amount",
      type: "number",
      config: { precision: 16, decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" },
    },
    sessionToken,
    201,
  );
  const status = await api<{ id: string }>(
    "POST",
    `/api/grids/fields/by-table/${table.id}`,
    {
      name: "Status",
      type: "select",
      config: {
        options: [
          { id: "open", label: "Open", color: "#3b82f6", description: "Needs work" },
          { id: "done", label: "Done", color: "#10b981", description: "Finished" },
        ],
      },
    },
    sessionToken,
    201,
  );
  const notes = await api<{ id: string }>(
    "POST",
    `/api/grids/fields/by-table/${table.id}`,
    { name: "Notes", type: "longtext", config: { markdown: true } },
    sessionToken,
    201,
  );
  const due = await api<{ id: string }>(
    "POST",
    `/api/grids/fields/by-table/${table.id}`,
    { name: "Due", type: "date", config: { defaultMode: "now" } },
    sessionToken,
    201,
  );

  const firstRecord = await api<{ id: string }>(
    "POST",
    `/api/grids/records/by-table/${table.id}`,
    {
      [title.id]: "Review invoices",
      [amount.id]: "99.99",
      [status.id]: ["open"],
      [notes.id]: "## Checklist\n\n- verify amount\n- send update",
      [due.id]: "2026-05-26",
    },
    sessionToken,
    201,
  );
  await api(
    "POST",
    `/api/grids/records/by-table/${table.id}`,
    {
      [title.id]: "Close month",
      [amount.id]: "150.00",
      [status.id]: ["done"],
      [notes.id]: "Done in accounting.",
      [due.id]: "2026-05-27",
    },
    sessionToken,
    201,
  );

  const view = await api<{ id: string }>(
    "POST",
    `/api/grids/views/by-table/${table.id}`,
    {
      name: "Open task amounts",
      shared: true,
      source: `from table {${table.id}}\nselect {${title.id}}, {${status.id}}, {${amount.id}}\nsort {${title.id}} asc`,
      ui: {
        columns: [
          { fieldId: title.id },
          { fieldId: status.id },
          { fieldId: amount.id, format: { kind: "decimal", precision: 2, thousandsSeparator: true } },
        ],
      },
    },
    sessionToken,
    201,
  );
  const statView = await api<{ id: string }>(
    "POST",
    `/api/grids/views/by-table/${table.id}`,
    {
      name: "Total amount",
      shared: true,
      source: `from table {${table.id}}\naggregate sum({${amount.id}}) as total_amount`,
    },
    sessionToken,
    201,
  );
  const pagedView = await api<{ id: string }>(
    "POST",
    `/api/grids/views/by-table/${table.id}`,
    {
      name: "Doubled amounts",
      shared: true,
      source: `from table {${table.id}}\nselect formula({${amount.id}} * 2) as doubled\nsort doubled desc`,
    },
    sessionToken,
    201,
  );

  const form = await api<{ id: string; publicToken: string | null }>(
    "POST",
    `/api/grids/forms/by-table/${table.id}`,
    {
      name: "Task intake",
      isPublic: true,
      config: {
        title: "Task intake",
        description: "Browser smoke public form",
        submitLabel: "Send task",
        successMessage: "Task saved",
        fields: [
          { kind: "user_input", fieldId: title.id, label: "Task title", required: true },
          { kind: "user_input", fieldId: amount.id, label: "Budget", defaultValue: "12.50" },
          { kind: "form_value", fieldId: status.id, value: ["open"] },
        ],
      },
    },
    sessionToken,
    201,
  );
  const publicToken = form.publicToken ?? fail("public form was created without a public token");

  ok("fixture created");
  return {
    sessionToken,
    base,
    table,
    view,
    statView,
    pagedView,
    form: { id: form.id, publicToken },
    records: { first: firstRecord.id },
    fields: { title: title.id, amount: amount.id, status: status.id, notes: notes.id, due: due.id },
  };
};

const addSessionCookie = async (context: BrowserContext, sessionToken: string) => {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: "session_token",
      value: sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
  ]);
};

const watchPage = (page: Page, errors: string[]) => {
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource:")) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && /\.js(\?|$)/.test(url)) {
      errors.push(`asset ${status}: ${url}`);
      return;
    }
    if (status >= 500 && !url.includes("/favicon")) {
      errors.push(`http ${status}: ${url}`);
    }
  });
};

const createWatchedPages = async (browser: Browser, options: BrowserContextOptions & { sessionToken?: string; pageCount?: number }) => {
  const { sessionToken, pageCount = 1, ...contextOptions } = options;
  const context = await browser.newContext({ baseURL: BASE_URL, ...contextOptions });
  if (sessionToken) await addSessionCookie(context, sessionToken);
  const errors: string[] = [];
  const pages = await Promise.all(Array.from({ length: pageCount }, () => context.newPage()));
  for (const page of pages) {
    page.setDefaultTimeout(TIMEOUT);
    watchPage(page, errors);
  }
  return { context, pages, errors };
};

type VisibleTextExpectation = {
  value: string;
  pattern: boolean;
  present: boolean;
};

const waitForVisibleText = (page: Page, expectation: VisibleTextExpectation) =>
  page.waitForFunction(
    ({ value, pattern, present }) => {
      if (!document.body) return false;
      const regex = pattern ? new RegExp(value) : null;
      const found = Array.from(document.body.querySelectorAll("*")).some((el) => {
        const text = el.textContent ?? "";
        if (regex ? !regex.test(text) : !text.includes(value)) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return el.getClientRects().length > 0;
      });
      return present ? found : !found;
    },
    expectation,
    { timeout: TIMEOUT },
  );

const expectVisibleText = async (page: Page, text: string, label = text) => {
  await waitForVisibleText(page, { value: text, pattern: false, present: true });
  ok(label);
};

const assertNoBrowserErrors = (errors: string[]) => {
  if (errors.length > 0) {
    fail(`browser errors:\n${errors.slice(0, 8).join("\n")}`);
  }
};

const browserMutation = async <T>(page: Page, config: { method: string; path: string; body?: unknown; expected?: number }): Promise<T> => {
  const response = await page.context().request.fetch(config.path, {
    method: config.method,
    headers: config.body === undefined ? undefined : { "Content-Type": "application/json" },
    data: config.body === undefined ? undefined : JSON.stringify(config.body),
  });
  const text = await response.text();
  const expected = config.expected ?? (config.method === "DELETE" ? 204 : 200);
  if (response.status() !== expected) fail(`${config.method} ${config.path} failed with ${response.status()}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
};

const expectNoVisibleText = async (page: Page, text: string, label = text) => {
  await waitForVisibleText(page, { value: text, pattern: false, present: false });
  ok(label);
};

const runLiveRefresh = async (browser: Browser, fixture: Fixture) => {
  const { context, pages, errors } = await createWatchedPages(browser, {
    viewport: { width: 1440, height: 900 },
    sessionToken: fixture.sessionToken,
    pageCount: 2,
  });
  const [pageA, pageB] = pages as [Page, Page];
  const requests: string[] = [];
  for (const page of [pageA, pageB]) {
    page.on("request", (request) => requests.push(request.url()));
  }

  const tablePath = `/app/grids/${fixture.base.id}/table/${fixture.table.id}`;
  await Promise.all([pageA.goto(tablePath, { waitUntil: "domcontentloaded" }), pageB.goto(tablePath, { waitUntil: "domcontentloaded" })]);
  await expectVisibleText(pageB, "Review invoices", "live tab B table route renders");

  const suffix = `${Date.now()}`;
  const metadataTableName = `Live metadata ${suffix}`;
  await browserMutation<{ id: string }>(pageA, {
    method: "POST",
    path: `/api/grids/tables/by-base/${fixture.base.id}`,
    expected: 201,
    body: { name: metadataTableName, icon: "ti ti-table-plus" },
  });
  await expectVisibleText(pageB, metadataTableName, "live metadata table appears in second tab sidebar");

  const createdTitle = `Live create ${suffix}`;
  const updatedTitle = `Live update ${suffix}`;
  const created = await browserMutation<{ id: string; version: number }>(pageA, {
    method: "POST",
    path: `/api/grids/records/by-table/${fixture.table.id}`,
    expected: 201,
    body: {
      [fixture.fields.title]: createdTitle,
      [fixture.fields.amount]: "12.34",
      [fixture.fields.status]: ["open"],
      [fixture.fields.notes]: "Created from live smoke",
      [fixture.fields.due]: "2026-05-29",
    },
  });
  await expectVisibleText(pageB, createdTitle, "live create appears in second tab");

  await browserMutation(pageA, {
    method: "PATCH",
    path: `/api/grids/records/${fixture.table.id}/${created.id}`,
    body: {
      values: {
        [fixture.fields.title]: updatedTitle,
        [fixture.fields.amount]: "12.34",
        [fixture.fields.status]: ["open"],
        [fixture.fields.notes]: "Updated from live smoke",
        [fixture.fields.due]: "2026-05-29",
      },
    },
  });
  await expectVisibleText(pageB, updatedTitle, "live update appears in second tab");

  const filterTitle = `Live filtered ${suffix}`;
  await pageB.goto(`${tablePath}?q=${encodeURIComponent(filterTitle)}&qFields=${fixture.fields.title}`, { waitUntil: "domcontentloaded" });
  await expectNoVisibleText(pageB, filterTitle, "filtered live row starts absent");
  await browserMutation(pageA, {
    method: "POST",
    path: `/api/grids/records/by-table/${fixture.table.id}`,
    expected: 201,
    body: {
      [fixture.fields.title]: filterTitle,
      [fixture.fields.amount]: "1.00",
      [fixture.fields.status]: ["open"],
      [fixture.fields.notes]: "Filtered live smoke",
      [fixture.fields.due]: "2026-05-29",
    },
  });
  await expectVisibleText(pageB, filterTitle, "live create respects active search SQL query");

  await pageB.goto(`${tablePath}?record=${created.id}`, { waitUntil: "domcontentloaded" });
  await expectVisibleText(pageB, "History", "live detail panel route opens");
  await browserMutation(pageA, {
    method: "POST",
    path: `/api/grids/records/${fixture.table.id}/${created.id}/trash`,
    expected: 204,
    body: {},
  });
  await expectNoVisibleText(pageB, updatedTitle, "live delete removes record from second tab");

  if (requests.some((url) => /events\/by-table|text\/event-stream/i.test(url))) fail("live smoke observed legacy SSE request");
  assertNoBrowserErrors(errors);
  ok("websocket live refresh create/update/delete flow works");
  await context.close();
};

const smokeTableWorkbench = async (page: Page, fixture: Fixture) => {
  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}`, { waitUntil: "domcontentloaded" });
  await expectVisibleText(page, "Tasks", "table route renders");
  await expectVisibleText(page, "Review invoices", "record row renders");
  await expectVisibleText(page, "Open", "select badge renders");
  const filterButton = page.locator("button", { hasText: "Filter" }).first();
  const filterDeadline = Date.now() + TIMEOUT;
  do {
    await filterButton.click();
    if (await page.getByText("where", { exact: true }).first().isVisible()) break;
    await page.waitForTimeout(250);
  } while (Date.now() < filterDeadline);
  await expectVisibleText(page, "where", "filter toolbar opens a draft row");
  await page.getByRole("button", { name: "Query" }).click();
  await page.getByLabel("GQL query").waitFor({ state: "visible", timeout: TIMEOUT });
  ok("table query panel opens");
  await expectVisibleText(page, "Sources", "table query panel source catalog renders");
  const queryEditorValue = await page.getByLabel("GQL query").inputValue();
  if (!queryEditorValue.includes(`from table {${fixture.table.id}}`)) {
    fail(`table query panel did not start from the active table source: ${queryEditorValue}`);
  }
  ok("table query panel initializes from active table");
  await page.getByRole("button", { name: "Done" }).click();
  await expectNoVisibleText(page, "Full workspace", "table query panel closes");
  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}/formula-reference`, {
    waitUntil: "domcontentloaded",
  });
  await expectVisibleText(page, "Formula reference", "formula reference route renders");
  await expectVisibleText(page, "Fields", "formula reference fields section renders");
  await expectVisibleText(page, "Functions", "formula reference functions section renders");
  await expectVisibleText(page, "Amount", "formula reference lists fields");
  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}`, { waitUntil: "domcontentloaded" });
};

const smokeEnhancedNavigation = async (page: Page, fixture: Fixture) => {
  const navigationCountBeforeEnhanced = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  const sidebarScrollBeforeView = await page.locator('[data-scroll-preserve="grids-sidebar"]').evaluate((el) => {
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(32, maxScroll);
    return el.scrollTop;
  });
  await page
    .locator(`[data-scroll-preserve="grids-sidebar"] a[href$="/table/${fixture.table.id}/view/${fixture.view.id}"]`)
    .first()
    .click();
  await page.waitForURL(`**/app/grids/${fixture.base.id}/table/${fixture.table.id}/view/${fixture.view.id}`, {
    timeout: TIMEOUT,
  });
  await expectVisibleText(page, "Open task amounts", "enhanced view sidebar navigation renders");
  const viewUrl = new URL(page.url());
  if (!viewUrl.pathname.endsWith(`/table/${fixture.table.id}/view/${fixture.view.id}`)) {
    fail(`enhanced view navigation wrote wrong URL: ${viewUrl.pathname}`);
  }
  const sidebarScrollAfterView = await page.locator('[data-scroll-preserve="grids-sidebar"]').evaluate((el) => el.scrollTop);
  if (sidebarScrollBeforeView > 0 && sidebarScrollAfterView !== sidebarScrollBeforeView) {
    fail(`sidebar scroll was not preserved after enhanced navigation: ${sidebarScrollAfterView}`);
  }
  const navigationCountAfterEnhanced = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  if (navigationCountAfterEnhanced !== navigationCountBeforeEnhanced) {
    fail("enhanced sidebar navigation performed a document navigation");
  }
  ok("enhanced view sidebar navigation updates URL and preserves scroll");

  await page.locator(`[data-scroll-preserve="grids-sidebar"] a[href$="/table/${fixture.table.id}"]`).first().click();
  await page.waitForURL(`**/app/grids/${fixture.base.id}/table/${fixture.table.id}`, { timeout: TIMEOUT });
  await expectVisibleText(page, "Review invoices", "enhanced table sidebar navigation renders");
  const tableUrl = new URL(page.url());
  if (!tableUrl.pathname.endsWith(`/table/${fixture.table.id}`)) {
    fail(`enhanced table navigation wrote wrong URL: ${tableUrl.pathname}`);
  }
  ok("enhanced table sidebar navigation updates URL");

  await page.locator(`[data-scroll-preserve="grids-sidebar"] a[href$="/table/${fixture.table.id}"]`).first().click();
  await page.waitForURL(`**/app/grids/${fixture.base.id}/table/${fixture.table.id}`, { timeout: TIMEOUT });
  await page.getByRole("link", { name: "Edit mode" }).click();
  await page.waitForURL(/edit=true/, { timeout: TIMEOUT });
  await expectVisibleText(page, "Done editing", "enhanced edit-mode navigation renders");
  await page.getByRole("link", { name: "Done editing" }).click();
  await page.waitForURL((url) => !url.searchParams.has("edit"), { timeout: TIMEOUT });
  ok("enhanced edit-mode navigation updates URL");
};

const smokeRecordAndViews = async (page: Page, fixture: Fixture) => {
  let initialRecordDetailRequests = 0;
  const countInitialRecordDetailRequest = (request: Request) => {
    if (new URL(request.url()).pathname === "/api/grids/workspace/record-detail") initialRecordDetailRequests += 1;
  };
  page.on("request", countInitialRecordDetailRequest);
  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}?record=${fixture.records.first}`, {
    waitUntil: "domcontentloaded",
  });
  await expectVisibleText(page, "History", "record detail opens");
  await page.waitForTimeout(250);
  page.off("request", countInitialRecordDetailRequest);
  if (initialRecordDetailRequests !== 0) fail("record detail refetched during initial hydration");
  ok("record detail hydrates from server data without refetching");

  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}/view/${fixture.view.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expectVisibleText(page, "Open task amounts", "view route renders");
  await expectVisibleText(page, "Review invoices", "view rows render");

  const firstViewPage = await api<{ ok: boolean; page?: { nextCursor: string | null } }>(
    "POST",
    `/api/grids/gql/by-base/${fixture.base.id}/views/${fixture.pagedView.id}/execute`,
    { pageSize: 1, surface: "records-view" },
    fixture.sessionToken,
  );
  const secondPageCursor =
    (firstViewPage.ok ? firstViewPage.page?.nextCursor : null) ?? fail("saved view did not return a pagination cursor");
  const secondViewPage = await api<{ ok: boolean; rows?: Array<{ values: Record<string, unknown> }> }>(
    "POST",
    `/api/grids/gql/by-base/${fixture.base.id}/views/${fixture.pagedView.id}/execute`,
    { pageSize: 1, cursor: secondPageCursor, surface: "records-view" },
    fixture.sessionToken,
  );
  if (!secondViewPage.ok || secondViewPage.rows?.length !== 1) {
    const payload = secondPageCursor.split(".")[0];
    const decoded = payload ? Buffer.from(payload, "base64url").toString("utf8") : "missing cursor payload";
    fail(`saved view API cursor page failed: ${JSON.stringify(secondViewPage)}; cursor=${decoded}`);
  }
  await page.goto(
    `/app/grids/${fixture.base.id}/table/${fixture.table.id}/view/${fixture.pagedView.id}?cursor=${encodeURIComponent(secondPageCursor)}`,
    { waitUntil: "domcontentloaded" },
  );
  const cursorPageText = await page.locator("body").innerText();
  if (!cursorPageText.includes("199.98")) {
    fail(`query-result cursor page did not render the second row: ${cursorPageText.slice(0, 800)}`);
  }
  if (!cursorPageText.includes("First page")) {
    fail(`query-result cursor page did not render backward navigation at ${page.url()}: ${cursorPageText.slice(-800)}`);
  }
  await expectVisibleText(page, "199.98", "query-result cursor page SSR renders");
  await page.waitForTimeout(250);
  const firstPageButton = page.getByRole("button", { name: "First page" });
  if ((await firstPageButton.count()) !== 1) fail("query-result backward navigation did not survive hydration");
  const firstPageResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/grids/gql/by-base/${fixture.base.id}/views/${fixture.pagedView.id}/execute`,
    { timeout: TIMEOUT },
  );
  await firstPageButton.click();
  const firstPageResponse = await firstPageResponsePromise;
  if (!firstPageResponse.ok()) fail(`query-result first-page request returned ${firstPageResponse.status()}`);
  await expectVisibleText(page, "300", "query-result pager returns to first page");

  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}/view/${fixture.statView.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expectVisibleText(page, "Total amount", "aggregate-only view route renders");
  await expectVisibleText(page, "249.99", "aggregate-only view result renders");
};

const smokeExport = async (page: Page, fixture: Fixture) => {
  const exportResult = await page.evaluate(
    async ({ tableId, titleFieldId }) => {
      const res = await fetch(`/api/grids/records/by-table/${tableId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "csv", fields: [{ fieldId: titleFieldId, label: "Title" }] }),
      });
      return {
        ok: res.ok,
        status: res.status,
        disposition: res.headers.get("content-disposition"),
        body: await res.text(),
      };
    },
    { tableId: fixture.table.id, titleFieldId: fixture.fields.title },
  );
  if (!exportResult.ok || !exportResult.disposition?.includes("attachment") || !exportResult.body.includes("Review invoices")) {
    fail(`export failed: ${JSON.stringify(exportResult).slice(0, 400)}`);
  }
  ok("authenticated export works in browser context");
};

const runAuthedDesktop = async (browser: Browser, fixture: Fixture) => {
  const {
    context,
    pages: [page],
    errors,
  } = await createWatchedPages(browser, {
    viewport: { width: 1440, height: 900 },
    sessionToken: fixture.sessionToken,
  });
  if (!page) throw new Error("Could not create browser page");

  await smokeTableWorkbench(page, fixture);
  await smokeEnhancedNavigation(page, fixture);
  await smokeRecordAndViews(page, fixture);
  await smokeExport(page, fixture);
  assertNoBrowserErrors(errors);
  await context.close();
};

const runPublicForm = async (browser: Browser, fixture: Fixture) => {
  const {
    context,
    pages: [page],
    errors,
  } = await createWatchedPages(browser, { viewport: { width: 1200, height: 800 } });
  if (!page) throw new Error("Could not create browser page");

  await page.goto(`/share/grids/forms/${fixture.form.publicToken}`, { waitUntil: "domcontentloaded" });
  await expectVisibleText(page, "Task intake", "public form route renders");
  await page.locator('[data-grids-public-form-ready="true"]').waitFor({ state: "attached", timeout: TIMEOUT });
  const titleBox = page.getByLabel(/task title/i).first();
  await titleBox.fill("Public smoke task");
  const budget = page.getByLabel(/budget/i).first();
  if (await budget.count()) await budget.fill("42.42");
  const textboxValues = await page
    .getByRole("textbox")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : (node.textContent ?? ""),
      ),
    );
  if (!textboxValues.includes("Public smoke task")) {
    fail(`public form title textbox was not filled. Textbox values: ${JSON.stringify(textboxValues)}`);
  }
  await page.getByRole("button", { name: /send task/i }).click();
  await page
    .getByText("Task saved", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: TIMEOUT })
    .catch(async () => {
      const visibleText = (await page.locator("body").innerText({ timeout: 2_000 })).slice(0, 1_000);
      fail(`public form submit did not show success. Visible page text:\n${visibleText}`);
    });
  ok("public form submit succeeds");

  const query = await api<{ items?: Array<{ data: Record<string, unknown> }> }>(
    "POST",
    `/api/grids/tables/${fixture.table.id}/query`,
    { query: { search: { q: "Public smoke task", fieldIds: [fixture.fields.title] } } },
    fixture.sessionToken,
    200,
  );
  if (!query.items?.some((record) => record.data[fixture.fields.title] === "Public smoke task")) {
    fail("public form submission was not persisted");
  }
  ok("public form submission persisted");

  assertNoBrowserErrors(errors);
  await context.close();
};

const runResponsive = async (browser: Browser, fixture: Fixture) => {
  const {
    context,
    pages: [page],
    errors,
  } = await createWatchedPages(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    sessionToken: fixture.sessionToken,
  });
  if (!page) throw new Error("Could not create browser page");

  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}`, { waitUntil: "domcontentloaded" });
  await expectVisibleText(page, "Tasks", "mobile table route renders");
  await expectVisibleText(page, "Review invoices", "mobile table content renders");
  assertNoBrowserErrors(errors);
  await context.close();
};

const cleanup = async (fixture: Fixture | null) => {
  if (!fixture || KEEP) return;
  await api("DELETE", `/api/grids/bases/${fixture.base.id}`, undefined, fixture.sessionToken, 204).catch((err) => {
    console.warn(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
};

const runFormulaPreviewSmoke = async (fixture: Fixture) => {
  const preview = await api<{
    ok: boolean;
    diagnostics: { message: string }[];
    fields: { id: string; name: string }[];
    rows: { values: Record<string, unknown>; result: unknown }[];
  }>(
    "POST",
    `/api/grids/formulas/by-table/${fixture.table.id}/check`,
    { expression: `{${fixture.fields.amount}} + {${fixture.fields.amount}}` },
    fixture.sessionToken,
    200,
  );
  if (!preview.ok) fail(`formula preview returned diagnostics: ${preview.diagnostics.map((d) => d.message).join(", ")}`);
  if (preview.fields.length !== 1 || preview.fields[0]?.id !== fixture.fields.amount) fail("formula preview referenced fields mismatch");
  if (preview.rows.length !== 2) fail(`formula preview row count mismatch: ${preview.rows.length}`);
  if (!preview.rows.some((row) => row.result === "199.98")) fail("formula preview did not preserve decimal precision");
  ok("formula preview endpoint preserves decimal values");
};

const runRecordAuditSmoke = async (browser: Browser, fixture: Fixture) => {
  const questionId = crypto.randomUUID();
  await api(
    "PATCH",
    `/api/grids/tables/${fixture.table.id}`,
    {
      icon: "ti ti-checklist",
      auditPolicy: {
        update: {
          enabled: true,
          scope: "selected",
          fieldIds: [fixture.fields.title],
          questions: [{ id: questionId, label: "Change reason", type: "longtext", required: true }],
        },
      },
    },
    fixture.sessionToken,
  );

  const rejected = await api<{ message: string }>(
    "PATCH",
    `/api/grids/records/${fixture.table.id}/${fixture.records.first}`,
    { values: { [fixture.fields.title]: "Blocked audit update" } },
    fixture.sessionToken,
    400,
  );
  if (!rejected.message.toLowerCase().includes("change reason")) {
    fail(`protected update returned an unclear error: ${rejected.message}`);
  }
  ok("record audit policy rejects missing answers");

  const {
    context,
    pages: [page],
    errors,
  } = await createWatchedPages(browser, {
    viewport: { width: 1440, height: 900 },
    sessionToken: fixture.sessionToken,
  });
  if (!page) throw new Error("Could not create browser page");

  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}?edit=true`, {
    waitUntil: "domcontentloaded",
  });
  await expectVisibleText(page, "Done editing", "audit policy route enters edit mode");
  const generalButton = page.getByText("General", { exact: true }).first();
  try {
    await generalButton.waitFor({ state: "visible", timeout: TIMEOUT });
  } catch {
    fail(`table admin toolbar missing in edit mode: ${(await page.locator("body").innerText()).slice(0, 1_200)}`);
  }
  const tableSettings = page.getByRole("dialog").filter({ hasText: "Data integrity" });
  const settingsHydrationDeadline = Date.now() + TIMEOUT;
  do {
    await generalButton.click();
    await page.waitForTimeout(100);
    if ((await tableSettings.count()) > 0) break;
  } while (Date.now() < settingsHydrationDeadline);
  if ((await tableSettings.count()) === 0) fail("table settings action did not hydrate");
  await tableSettings.getByRole("button").filter({ hasText: "Audit requirements" }).click();
  const auditSettings = page.getByRole("dialog").filter({ hasText: "Audit requirements" }).last();
  await auditSettings.getByText("Change reason", { exact: true }).waitFor({ state: "visible", timeout: TIMEOUT });
  ok("table settings expose configured audit requirements");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.goto(`/app/grids/${fixture.base.id}/table/${fixture.table.id}?record=${fixture.records.first}`, {
    waitUntil: "domcontentloaded",
  });
  const editDialog = page.getByRole("dialog").filter({ hasText: "Edit record · Tasks" });
  const editHydrationDeadline = Date.now() + TIMEOUT;
  do {
    await page.getByRole("button", { name: "Edit record" }).click();
    await page.waitForTimeout(100);
    if ((await editDialog.count()) > 0) break;
  } while (Date.now() < editHydrationDeadline);
  if ((await editDialog.count()) === 0) fail("record edit action did not hydrate");
  await editDialog.getByRole("textbox", { name: "Title", exact: true }).fill("Review audited invoices");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();

  let auditDialog = page.getByRole("dialog").filter({ hasText: "Explain record changes" });
  await auditDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const titleInput = editDialog.getByRole("textbox", { name: "Title", exact: true });
  await titleInput.waitFor({ state: "visible", timeout: TIMEOUT });
  if ((await titleInput.inputValue()) !== "Review audited invoices") {
    fail("cancelled audit prompt discarded the record draft");
  }
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  auditDialog = page.getByRole("dialog").filter({ hasText: "Explain record changes" });
  await auditDialog.getByRole("textbox", { name: "Change reason", exact: true }).fill("Quarter-end review");
  const updateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/grids/records/${fixture.table.id}/${fixture.records.first}`,
    { timeout: TIMEOUT },
  );
  await auditDialog.getByRole("button", { name: "Save changes" }).click();
  if (!(await updateResponse).ok()) fail("audited record update failed");
  await expectVisibleText(page, "Review audited invoices", "audited record update renders");
  await expectVisibleText(page, "Change reason", "audit history renders question label");
  await expectVisibleText(page, "Quarter-end review", "audit history renders answer");

  assertNoBrowserErrors(errors);
  ok("record audit prompt and history flow works");
  await context.close();
};

let fixture: Fixture | null = null;
let browser: Browser | null = null;

try {
  fixture = await createFixture();
  await runFormulaPreviewSmoke(fixture);
  browser = await chromium.launch({ headless: HEADLESS });
  await runAuthedDesktop(browser, fixture);
  await runLiveRefresh(browser, fixture);
  await runPublicForm(browser, fixture);
  await runResponsive(browser, fixture);
  await runRecordAuditSmoke(browser, fixture);
  ok("browser smoke complete");
} catch (err) {
  if (err instanceof Error) {
    console.error(`\nBrowser smoke failed: ${err.message}`);
    const apiErr = err as ApiError;
    if (apiErr.body) console.error(apiErr.body);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await cleanup(fixture);
}
