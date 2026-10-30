import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";
import { observabilityAreaBrowserFixture } from "./ObservabilityArea.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof observabilityAreaBrowserFixture>>;
let page: Page;
let errors: string[];
const BEREITSCHAFT = "aaaaaaaa-0000-4000-8000-000000000001";

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=en`);
  await page.waitForSelector('body[data-ready="true"]');
};
const visible = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true });
const status = () => page.locator('.k2b-save-status__state[role="status"]').filter({ visible: true }).first();

beforeAll(async () => {
  fixture = await observabilityAreaBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
  errors = pageErrors(page);
});
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

test("the admin sidebar shows Observability as one area entry and the area lists its sections", async () => {
  await goto("/admin/observability/alerts");
  const current = page.locator('a[aria-current="page"]').filter({ visible: true });
  expect(await current.filter({ hasText: /^Observability$/ }).count()).toBe(1);
  // The Gateway and Observability groups are gone from the admin sidebar.
  expect(await page.getByRole("link", { name: "Routes", exact: true }).count()).toBe(0);
  const sections = page.getByRole("navigation", { name: "Observability sections" }).getByRole("link");
  expect((await sections.allInnerTexts()).map((text) => text.trim().split("\n")[0])).toEqual([
    "Overview",
    "Logs",
    "Jobs",
    "Workflows",
    "Capabilities",
    "Telemetry",
    "Metrics",
    "Deliveries",
    "Gateway & routes",
    "Postgres",
    "Valkey",
    "NATS & sync",
    "Alerts & webhooks",
    "Health check",
    "Retention",
  ]);
  expect(await page.getByTitle("Needs attention").count()).toBe(2);
  expect(errors).toEqual([]);
}, 30_000);

test("an open log entry pushes the first column aside at 1440 px and keeps it on a phone behind a back step", async () => {
  await goto("/admin/observability/logs");
  await page.getByRole("row", { name: /IMAP-Abruf/ }).click();
  await page.waitForURL(/entry=9000/);
  await page.waitForSelector('body[data-ready="true"]');
  expect(await page.getByRole("navigation", { name: "Observability sections" }).isVisible()).toBe(false);
  // The row link keeps the filters, not the fixture's locale parameter.
  expect(
    await page
      .getByRole("link", { name: /^(Back to|Zurück zu) Observability$/ })
      .filter({ visible: true })
      .count(),
  ).toBe(1);
  expect(await page.getByText("mbx_info", { exact: true }).isVisible()).toBe(true);

  await goto("/admin/observability/logs?entry=9000", 390);
  expect(await page.getByText("mbx_info", { exact: true }).isVisible()).toBe(true);
  expect(await page.getByRole("row", { name: /IMAP-Abruf/ }).isVisible()).toBe(false);
  expect(errors).toEqual([]);
}, 30_000);

test("an alert saves with the button in the level head, and a refused save keeps the draft", async () => {
  await goto(`/admin/observability/alerts?webhook=${BEREITSCHAFT}`);
  expect(await status().innerText()).toBe("Saved");
  expect(await visible("Save").isDisabled()).toBe(true);
  const name = page.getByRole("textbox", { name: /^Name/ });
  await name.fill("Bereitschaft Nacht");
  expect(await status().innerText()).toBe("Draft");
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT" && candidate.url().includes(BEREITSCHAFT));
  await visible("Save").click();
  expect((await request).postDataJSON()).toEqual(expect.objectContaining({ name: "Bereitschaft Nacht" }));
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
  expect(await status().innerText()).toMatch(/^Saved \d{1,2}:\d\d/);

  await goto(`/admin/observability/alerts?webhook=${BEREITSCHAFT}&state=savefail`);
  const stored = await page.getByRole("textbox", { name: /^Name/ }).inputValue();
  await page.getByRole("textbox", { name: /^Name/ }).fill("Anders");
  await visible("Save").click();
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="failed"]'));
  expect(await page.getByText("Not saved.").isVisible()).toBe(true);
  expect(await page.getByRole("textbox", { name: /^Name/ }).inputValue()).toBe("Anders");
  await visible("Discard").click();
  expect(await page.getByRole("textbox", { name: /^Name/ }).inputValue()).toBe(stored);
  expect(errors).toEqual([]);
}, 30_000);

test("an empty schedule is invalid at its field and blocks Save; an unreadable value says what applies", async () => {
  await goto("/admin/observability/health-check");
  await page.getByRole("textbox", { name: /^Check schedule/ }).fill("");
  expect(await status().innerText()).toBe("Check 1 entry");
  expect(await visible("Save").isDisabled()).toBe(true);
  expect(await page.getByText("Enter a schedule.").isVisible()).toBe(true);

  await goto("/admin/observability/health-check?state=unreadable");
  expect(await page.getByRole("textbox", { name: /^Check schedule/ }).isDisabled()).toBe(true);
  expect(await visible("Save").isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value: Check schedule" }).check();
  // The displayed fallback can be saved as it is once the replacement is confirmed.
  expect(await visible("Save").isDisabled()).toBe(false);

  await goto("/admin/observability/retention?state=unreadable");
  expect(await page.getByText("Stored settings cannot be read").isVisible()).toBe(true);
  expect(await visible("Save").isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value: Request events" }).check();
  expect(await visible("Save").isDisabled()).toBe(false);
  expect(errors).toEqual([]);
}, 30_000);

test("health webhook targets are edited as a list, and a target the server refuses stays marked at its field", async () => {
  const shots = process.env.ADMIN_SETTINGS_SHOTS;
  for (const width of [1440, 390]) {
    await goto("/admin/observability/health-check", width);
    const targets = page.getByRole("textbox", { name: /^Health webhook allowed targets/ });
    expect(await page.getByText("Changes apply to new deliveries.").isVisible()).toBe(true);
    expect(await targets.inputValue()).toBe("alerts.internal, 10.20.0.0/16");
    if (shots) await page.screenshot({ path: `${shots}/gateway-health-check-${width}.png`, fullPage: true, animations: "disabled" });
  }

  await goto("/admin/observability/health-check");
  const targets = page.getByRole("textbox", { name: /^Health webhook allowed targets/ });
  await targets.fill("alerts.internal, 10.20.0.0/16, 0.0.0.0/0");
  await targets.blur();
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT" && candidate.url().includes("webhook_allowed_targets"));
  await visible("Save").click();
  expect((await request).postDataJSON()).toEqual({ value: ["alerts.internal", "10.20.0.0/16", "0.0.0.0/0"] });
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="failed"]'));
  expect(await page.getByText(/\/0 is forbidden/).isVisible()).toBe(true);
  expect(await page.getByText("Check the marked field.").isVisible()).toBe(true);
  expect(await targets.getAttribute("aria-invalid")).toBe("true");
  if (shots) await page.screenshot({ path: `${shots}/gateway-health-check-refused-1440.png`, fullPage: true, animations: "disabled" });

  await targets.fill("alerts.internal, 10.20.0.0/16, 10.30.0.5");
  await targets.blur();
  expect(await page.getByText(/\/0 is forbidden/).count()).toBe(0);
  await visible("Save").click();
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
  expect(errors).toEqual([]);
}, 30_000);

test("lists without entries and lists that fail to load show a way on", async () => {
  await goto("/admin/observability/alerts?state=empty");
  expect(await page.getByText("No alerts yet").isVisible()).toBe(true);
  expect(await visible("Add alert").isVisible()).toBe(true);
  await goto("/admin/observability/alerts?state=loadfail");
  expect(await page.getByText("This section could not be loaded.").isVisible()).toBe(true);
  expect(await page.getByRole("link", { name: "Try again" }).isVisible()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test("NATS access preserves pasted content, saves and recovers from refused writes on desktop and phone", async () => {
  for (const [width, theme] of [
    [1440, "light"],
    [390, "light"],
    [1440, "dark"],
    [390, "dark"],
  ] as const) {
    await goto(`/admin/observability/nats/access?theme=${theme}`, width);
    const access = page.getByRole("textbox", { name: /^System access/ });
    expect(await access.inputValue()).toBe("");
    expect(await access.getAttribute("spellcheck")).toBe("false");
    const content = "-----BEGIN NATS USER JWT-----\nsynthetic fixture\n------END NATS USER JWT------";
    await access.fill(content);
    const request = page.waitForRequest(
      (candidate) => candidate.method() === "PUT" && candidate.url().endsWith("gateway.nats_admin_access"),
    );
    await visible("Save").click();
    expect((await request).postDataJSON()).toEqual({ value: content, replaceUnreadable: false });
    await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
    expect(await access.inputValue()).toBe("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await goto("/admin/observability/nats/access");
  const format = page.getByRole("combobox", { name: "System access format", exact: true });
  expect(await format.innerText()).toContain(".creds file content");
  await format.click();
  await page.getByRole("option", { name: "NKey seed", exact: true }).click();
  expect(await page.getByText(/^Paste access in the new format too/).isVisible()).toBe(true);
  const kindRequest = page.waitForRequest(
    (candidate) => candidate.method() === "PUT" && candidate.url().endsWith("gateway.nats_admin_access_kind"),
  );
  await visible("Save").click();
  expect((await kindRequest).postDataJSON()).toEqual({ value: "nkey", replaceUnreadable: false });
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
  expect(await format.innerText()).toContain("NKey seed");
  expect(await page.getByText(/^Paste access in the new format too/).count()).toBe(0);

  await goto("/admin/observability/nats/access?state=savefail", 390);
  const access = page.getByRole("textbox", { name: /^System access/ });
  await access.fill("synthetic replacement");
  await visible("Save").click();
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="failed"]'));
  expect(await access.inputValue()).toBe("synthetic replacement");
  await visible("Discard").click();
  expect(await access.inputValue()).toBe("");
  await goto("/admin/observability/nats/access?state=unreadable");
  expect(await page.getByRole("textbox", { name: /^System access/ }).isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value: System access" }).check();
  expect(await visible("Save").isDisabled()).toBe(true);
  await page.getByRole("textbox", { name: /^System access/ }).fill("synthetic replacement");
  expect(await visible("Save").isDisabled()).toBe(false);
  expect(errors).toEqual([]);
}, 30_000);
