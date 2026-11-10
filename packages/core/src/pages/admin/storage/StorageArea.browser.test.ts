import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { STORAGE_FIXTURE_IDS, storageAreaBrowserFixture } from "./StorageArea.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof storageAreaBrowserFixture>>;
beforeAll(async () => {
  fixture = await storageAreaBrowserFixture();
  browser = await launchBrowser();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const open = async (query: string, view: { width: number; height: number } = desktop) => {
  const page = await browser.newPage({ viewport: view, reducedMotion: "reduce", isMobile: view.width < 600, hasTouch: view.width < 600 });
  const errors = pageErrors(page);
  await page.goto(`${fixture.url}?${query}`);
  await page.locator('body[data-ready="true"]').waitFor();
  return { page, errors };
};
/** The page after a save or test navigated to the bucket's address. */
const settledOn = async (page: Page, id: string) => {
  await page.waitForURL((url) => url.searchParams.get("bucket") === id);
  await page.locator('body[data-ready="true"]').waitFor();
};
const detail = (page: Page) => page.locator("[data-workspace-level-id='detail'], [data-storage-detail]").last();
const headAction = (page: Page, action: string) => page.locator(`.hidden.md\\:block [data-storage-action="${action}"]`);
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const archive = STORAGE_FIXTURE_IDS.archive;
const fixtureReset = () => {
  fixture.control.conflictNext = false;
  fixture.control.failUsage = false;
  fixture.control.failingTests.clear();
  fixture.control.requests.length = 0;
};

test("every state fits a desktop and a phone and says what happened", async () => {
  const cases = [
    {
      query: "state=liste",
      expect: ["Standard", "Weitere Buckets", "Archiv", "Test fehlgeschlagen", "Entfernt", "Den Standard-Bucket gibt es immer"],
    },
    { query: `state=liste&bucket=${archive}`, expect: ["Erreichbar · getestet", archive, "Sicherung"] },
    {
      query: `state=liste&bucket=${STORAGE_FIXTURE_IDS.customer}`,
      expect: ["Test fehlgeschlagen beim Schreiben.", "Erst lesbar, wenn die Verbindung steht."],
    },
    { query: `state=liste&bucket=${STORAGE_FIXTURE_IDS.backup}`, expect: ["Entfernt am", "storage_bucket_disconnected", "Letztes Ziel"] },
    { query: "state=liste&bucket=new", expect: ["Neuer Bucket", "Entwurf", "Wird beim Anlegen vergeben."] },
    { query: "state=liste&bucket=00000000-0000-4000-8000-000000000000", expect: ["Diesen Bucket gibt es nicht"] },
    { query: "state=leer", expect: ["Noch keine weiteren Buckets."] },
    { query: "state=fehler", expect: ["Speicher konnte nicht geladen werden"] },
  ];
  for (const view of [desktop, phone])
    for (const item of cases) {
      fixtureReset();
      const { page, errors } = await open(item.query, view);
      try {
        await page.waitForFunction(() => !document.querySelector('[data-storage-usage="loading"]'));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect({ query: item.query, width: view.width, overflow: Math.max(0, overflow) }).toEqual({
          query: item.query,
          width: view.width,
          overflow: 0,
        });
        // On a phone the list and the detail are separate levels; the bucket's own texts show in the detail.
        const text = await page.locator("main, body").first().innerText();
        for (const expected of item.expect)
          if (view === desktop || !["Weitere Buckets", "Den Standard-Bucket gibt es immer", "Entwurf"].includes(expected))
            expect(text).toContain(expected);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
}, 120_000);

test("renaming keeps the ID, sends no keys and shows the new name in the list", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    const save = headAction(page, "save");
    expect(await save.isDisabled()).toBe(true);
    await settled(page);
    const before = await save.boundingBox();
    await field(page, "Name").fill("Archiv 2026");
    expect(await save.isEnabled()).toBe(true);
    await settled(page);
    // Getting dirty changes paint only: the head buttons stay where they were.
    expect(await save.boundingBox()).toEqual(before);
    await save.click();
    await settledOn(page, archive);
    const put = fixture.control.requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(`/buckets/${archive}`);
    const body = JSON.parse(put?.body ?? "{}");
    expect(body).toMatchObject({ access: "own", revision: 3, name: "Archiv 2026", bucket: "cloud-archiv" });
    expect(body.accessKeyId).toBeUndefined();
    expect(body.secretAccessKey).toBeUndefined();
    expect(await page.locator(`[data-storage-row="${archive}"]`).innerText()).toBe("Archiv 2026");
    expect(await page.locator("[data-storage-bucket-id]").innerText()).toBe(archive);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("adding a bucket like Default tests it at once; a failed test stays visible with Test again", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await headAction(page, "save").click();
    expect(await page.getByText("Pflichtfeld.").count()).toBeGreaterThan(0);
    await field(page, "Name").fill("Rechnungen");
    await field(page, "Bucket").fill("cloud-rechnungen");
    await headAction(page, "save").click();
    await settledOn(page, STORAGE_FIXTURE_IDS.created);
    expect(JSON.parse(fixture.control.requests.find((request) => request.method === "POST")?.body ?? "{}")).toEqual({
      access: "inherit",
      name: "Rechnungen",
      bucket: "cloud-rechnungen",
    });
    expect(await page.locator('[data-storage-check="ok"]').isVisible()).toBe(true);
    expect(await page.locator(`[data-storage-row="${STORAGE_FIXTURE_IDS.created}"]`).innerText()).toBe("Rechnungen");

    fixture.control.failingTests.add(STORAGE_FIXTURE_IDS.created);
    await headAction(page, "test").click();
    await settledOn(page, STORAGE_FIXTURE_IDS.created);
    expect(await page.locator('[data-storage-check="failed"]').innerText()).toContain("Test fehlgeschlagen beim Schreiben.");
    expect(await headAction(page, "test").innerText()).toBe("Erneut testen");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("own keys are required for a new own bucket; a taken name shows at the field", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await field(page, "Name").fill("archiv");
    await page.getByRole("radio", { name: /Eigener Server oder Schlüssel/ }).click();
    await field(page, "S3-Endpunkt").fill("https://s3.example.org");
    await field(page, "Signaturregion").fill("garage");
    await field(page, "Bucket").fill("cloud-belege");
    await headAction(page, "save").click();
    // The keys are still empty: nothing is sent.
    expect(fixture.control.requests.some((request) => request.method === "POST")).toBe(false);
    await field(page, "Access-Key-ID").fill("GKexample");
    await field(page, "Secret-Access-Key").fill("not-a-real-secret");
    await headAction(page, "save").click();
    await page.getByText("Ein anderer Bucket hat schon diesen Namen.").waitFor();
    expect(page.url()).toContain("bucket=new");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a conflict offers the other version or mine", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    fixture.control.conflictNext = true;
    await field(page, "Name").fill("Archiv neu");
    await headAction(page, "save").click();
    await page.locator("[data-storage-conflict]").waitFor();
    expect(await page.locator("[data-storage-conflict]").innerText()).toContain("Mara Beispiel hat diesen Bucket inzwischen geändert");
    await page.getByRole("button", { name: "Andere Fassung laden" }).click();
    expect(await field(page, "Name").inputValue()).toBe("Archiv (Mara)");
    expect(await page.locator("[data-storage-conflict]").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("removing names the apps with data; restoring needs the keys again", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    await page.locator('[data-storage-usage="ready"]').waitFor();
    await headAction(page, "remove").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("rechnungen, warenfluss");
    await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
    await page.locator("[data-storage-removed]").waitFor();
    expect(fixture.control.requests.some((request) => request.method === "DELETE" && request.path === `/buckets/${archive}`)).toBe(true);
    expect(await page.locator(`[data-storage-row="${archive}"]`).getAttribute("class")).toContain("muted");

    await headAction(page, "restore").click();
    expect(await page.getByText("Pflichtfeld.").count()).toBe(2);
    expect(fixture.control.requests.some((request) => request.path.endsWith("/restore"))).toBe(false);
    await field(page, "Access-Key-ID").fill("GKexample");
    await field(page, "Secret-Access-Key").fill("not-a-real-secret");
    await headAction(page, "restore").click();
    await page.locator('[data-storage-check="ok"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("restoring a bucket whose name a connected bucket took says what to rename", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await field(page, "Name").fill("Backup");
    await field(page, "Bucket").fill("cloud-backup-neu");
    await headAction(page, "save").click();
    await settledOn(page, STORAGE_FIXTURE_IDS.created);
    await page.goto(`${fixture.url}?bucket=${STORAGE_FIXTURE_IDS.backup}`);
    await page.locator('body[data-ready="true"]').waitFor();
    await field(page, "Access-Key-ID").fill("GKexample");
    await field(page, "Secret-Access-Key").fill("not-a-real-secret");
    await headAction(page, "restore").click();
    await page.getByText("Ein verbundener Bucket hat schon diesen Namen.", { exact: false }).waitFor();
    expect(page.url()).toContain(`bucket=${STORAGE_FIXTURE_IDS.backup}`);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("usage that cannot be read says so and reads again on request", async () => {
  fixtureReset();
  fixture.control.failUsage = true;
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    await page.locator('[data-storage-usage="failed"]').waitFor();
    fixture.control.failUsage = false;
    await page.getByRole("button", { name: "Erneut lesen" }).click();
    await page.locator('[data-storage-usage="ready"]').waitFor();
    expect(await page.locator('[data-storage-usage="ready"]').innerText()).toContain("warenfluss");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("on a phone the list leads to the bucket and its actions stay at hand below", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste", phone);
  try {
    await page.locator(`[data-storage-row="${archive}"]`).click();
    await settledOn(page, archive);
    const save = page.locator(`.md\\:hidden [data-storage-action="save"]`);
    expect(await save.isVisible()).toBe(true);
    const box = await save.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(phone.height);
    expect(await detail(page).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
