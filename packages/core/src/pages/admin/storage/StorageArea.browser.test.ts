import { afterAll, beforeAll, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { STORAGE_FIXTURE_IDS, storageAreaBrowserFixture } from "./StorageArea.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof storageAreaBrowserFixture>>;
beforeAll(async () => {
  fixture = await storageAreaBrowserFixture();
  browser = await launchBrowser();
  // Warm-up outside the tests: the first page and the first bucket render compile the development SSR, which the
  // per-test budget must not pay (#4189).
  const page = await browser.newPage();
  for (const query of ["state=liste", "state=liste&bucket=3f0c2a54-8f1e-4c3b-9a0d-6b1e2c3d4e5f", "state=liste&bucket=new"]) {
    await page.goto(`${fixture.url}?${query}`);
    await page.waitForFunction(() => document.body?.dataset.ready === "true");
  }
  await page.close();
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
  await page.waitForFunction(() => document.body?.dataset.ready === "true");
  return { page, errors };
};
/**
 * Runs an action that loads the bucket's page and waits for the new document. A save or test reloads the same address,
 * where the old document already matches the URL and is ready; a mark on the old document tells the two apart.
 */
const loadsBucket = async (page: Page, id: string, action: () => Promise<void>) => {
  await page.evaluate(() => {
    document.documentElement.dataset.previousDocument = "true";
  });
  await action();
  await page.waitForFunction(
    (bucket) =>
      document.documentElement.dataset.previousDocument === undefined &&
      new URL(location.href).searchParams.get("bucket") === bucket &&
      document.body?.dataset.ready === "true",
    id,
  );
};
const detail = (page: Page) => page.locator('main [data-k2-part="Pane"]').last();
const WORDS: Record<string, RegExp> = {
  save: /^(Speichern|Anlegen)$/,
  test: /^(Verbindung testen|Erneut testen)$/,
  remove: /^Entfernen$/,
  restore: /^Wiederherstellen$/,
};
/** A deed of the open bucket by its words, wherever the form puts it. */
const headAction = (page: Page, action: string) =>
  page.locator("main").getByRole("button", { name: WORDS[action] }).filter({ visible: true }).last();
const row = (page: Page, name: string) =>
  page
    .locator("main")
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .first();
const field = (page: Page, label: string) =>
  page
    .locator("main")
    .getByRole("textbox", { name: new RegExp(`^${label}( |$)`) })
    .first();
const name = (page: Page) => field(page, "Name");
const archive = STORAGE_FIXTURE_IDS.archive;
const fixtureReset = () => {
  fixture.control.conflictNext = false;
  fixture.control.failUsage = false;
  fixture.control.failingTests.clear();
  fixture.control.requests.length = 0;
};

const cases = [
  {
    query: "state=liste",
    expect: ["Standard", "Weitere Buckets", "Archiv", "Test fehlgeschlagen", "Entfernt"],
  },
  { query: `state=liste&bucket=${archive}`, expect: ["Erreichbar · getestet", archive] },
  {
    query: `state=liste&bucket=${STORAGE_FIXTURE_IDS.customer}`,
    expect: ["Test fehlgeschlagen beim Schreiben."],
  },
  { query: `state=liste&bucket=${STORAGE_FIXTURE_IDS.backup}`, expect: ["Entfernt am", "storage_bucket_disconnected", "Letztes Ziel"] },
  { query: "state=liste&bucket=new", expect: ["Neuer Bucket", "Wird beim Anlegen vergeben."] },
  { query: "state=liste&bucket=00000000-0000-4000-8000-000000000000", expect: ["Diesen Bucket gibt es nicht"] },
  { query: "state=leer", expect: ["Noch keine weiteren Buckets."] },
  { query: "state=fehler", expect: ["Speicher konnte nicht geladen werden"] },
];
for (const view of [desktop, phone])
  for (const item of cases)
    test(`${item.query} fits at ${view.width}px and says what happened`, async () => {
      fixtureReset();
      const { page, errors } = await open(item.query, view);
      try {
        // The first picture never waits: usage is read on request.
        expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect({ query: item.query, width: view.width, overflow: Math.max(0, overflow) }).toEqual({
          query: item.query,
          width: view.width,
          overflow: 0,
        });
        // On a phone the list and the detail are separate levels; the bucket's own texts show in the detail.
        const text = await page.locator("main").first().innerText();
        for (const expected of item.expect)
          if (view === desktop || !["Weitere Buckets"].includes(expected)) expect(text).toContain(expected);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });

test("editing the name enables Save without moving the form's buttons", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    const save = headAction(page, "save");
    expect(await save.isDisabled()).toBe(true);
    await settled(page);
    const before = await save.boundingBox();
    await name(page).fill("Archiv 2026");
    expect(await save.isEnabled()).toBe(true);
    await settled(page);
    // Getting dirty changes paint only: the head buttons stay where they were.
    expect(await save.boundingBox()).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("renaming keeps the ID, sends no keys and shows the new name in the list", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    await field(page, "Name").fill("Archiv 2026");
    await loadsBucket(page, archive, () => headAction(page, "save").click());
    const put = fixture.control.requests.find((request) => request.method === "PUT");
    expect(put?.path).toBe(`/buckets/${archive}`);
    const body = JSON.parse(put?.body ?? "{}");
    expect(body).toMatchObject({ access: "own", revision: 3, name: "Archiv 2026", bucket: "cloud-archiv" });
    expect(body.accessKeyId).toBeUndefined();
    expect(body.secretAccessKey).toBeUndefined();
    expect(await row(page, "Archiv 2026").isVisible()).toBe(true);
    expect(await page.locator("main").innerText()).toContain(archive);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("adding a bucket requires a name and bucket before sending a request", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await headAction(page, "save").click();
    expect(await page.getByText("Pflichtfeld.").count()).toBeGreaterThan(0);
    expect(fixture.control.requests.some((request) => request.method === "POST")).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("adding a bucket like Default tests it at once", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await field(page, "Name").fill("Rechnungen");
    await field(page, "Bucket").fill("cloud-rechnungen");
    await loadsBucket(page, STORAGE_FIXTURE_IDS.created, () => headAction(page, "save").click());
    expect(JSON.parse(fixture.control.requests.find((request) => request.method === "POST")?.body ?? "{}")).toEqual({
      access: "inherit",
      name: "Rechnungen",
      bucket: "cloud-rechnungen",
    });
    expect(await page.getByText("Erreichbar · getestet", { exact: false }).first().isVisible()).toBe(true);
    expect(await row(page, "Rechnungen").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a failed test stays visible with Test again", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    fixture.control.failingTests.add(archive);
    await loadsBucket(page, archive, () => headAction(page, "test").click());
    expect(await page.locator('main [data-k2-part="Notice"]').first().innerText()).toContain("Test fehlgeschlagen beim Schreiben.");
    expect(await headAction(page, "test").innerText()).toBe("Erneut testen");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("own keys are required for a new own bucket", async () => {
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
    expect(await page.getByText("Pflichtfeld.").count()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a taken name shows at the field when adding a bucket with own keys", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste&bucket=new");
  try {
    await field(page, "Name").fill("archiv");
    await page.getByRole("radio", { name: /Eigener Server oder Schlüssel/ }).click();
    await field(page, "S3-Endpunkt").fill("https://s3.example.org");
    await field(page, "Signaturregion").fill("garage");
    await field(page, "Bucket").fill("cloud-belege");
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
    const conflict = page.locator('main [data-k2-part="Notice"]', { hasText: "Mara Beispiel hat diesen Bucket inzwischen geändert" });
    await conflict.waitFor();
    await conflict.getByRole("button", { name: "Andere Fassung laden" }).click();
    expect(await field(page, "Name").inputValue()).toBe("Archiv (Mara)");
    expect(await conflict.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("removing names the apps with data and mutes the removed bucket in the list", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${archive}`);
  try {
    await page.getByRole("button", { name: "Belegung anzeigen" }).click();
    await page.locator("main").getByText("warenfluss").first().waitFor();
    await headAction(page, "remove").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    expect(await dialog.innerText()).toContain("rechnungen, warenfluss");
    await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
    await page.locator('main [data-k2-part="Notice"]', { hasText: "Entfernt am" }).waitFor();
    expect(fixture.control.requests.some((request) => request.method === "DELETE" && request.path === `/buckets/${archive}`)).toBe(true);
    expect(await page.locator("main").innerText()).toContain("Entfernt");
    expect(await field(page, "Access-Key-ID").inputValue()).toBe("");
    expect(await field(page, "Secret-Access-Key").inputValue()).toBe("");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("restoring an own bucket needs the keys again", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${STORAGE_FIXTURE_IDS.backup}`);
  try {
    await headAction(page, "restore").click();
    expect(await page.getByText("Pflichtfeld.").count()).toBe(2);
    expect(fixture.control.requests.some((request) => request.path.endsWith("/restore"))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("restoring with fresh keys tests the bucket again", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${STORAGE_FIXTURE_IDS.backup}`);
  try {
    await field(page, "Access-Key-ID").fill("GKexample");
    await field(page, "Secret-Access-Key").fill("not-a-real-secret");
    await loadsBucket(page, STORAGE_FIXTURE_IDS.backup, () => headAction(page, "restore").click());
    await page.getByText("Erreichbar · getestet", { exact: false }).first().waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("restoring a bucket whose name a connected bucket took says what to rename", async () => {
  fixtureReset();
  const { page, errors } = await open(`state=liste&bucket=${STORAGE_FIXTURE_IDS.backup}`);
  try {
    // Set up the collision through the fixture API; creating a bucket is covered separately.
    const created = await page.request.post(fixture.url.replace("/admin/storage", "/api/admin/core/storage/buckets"), {
      data: { access: "inherit", name: "Backup", bucket: "cloud-backup-neu" },
    });
    expect(created.status()).toBe(201);
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
    await page.getByRole("button", { name: "Belegung anzeigen" }).click();
    await page.locator('main [data-k2-part="Failed"]').waitFor();
    fixture.control.failUsage = false;
    await page.locator('main [data-k2-part="Failed"]').getByRole("button").click();
    await page.locator("main").getByText("warenfluss").first().waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("on a phone the list leads to the bucket and its actions follow its fields", async () => {
  fixtureReset();
  const { page, errors } = await open("state=liste", phone);
  try {
    await loadsBucket(page, archive, () => row(page, "Archiv").click());
    const save = headAction(page, "save");
    await save.scrollIntoViewIfNeeded();
    expect(await save.isVisible()).toBe(true);
    expect(await detail(page).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("the list and an open bucket keep the v2 layout rules at every width", async () => {
  fixtureReset();
  for (const query of ["state=liste", `state=liste&bucket=${archive}`, "state=liste&bucket=new"])
    for (const width of [1440, 1024, 390]) {
      const { page, errors } = await open(query, { width, height: 900 });
      try {
        expect({ query, width, problems: (await measureV2Layout(page, { root: "main.k2-ui" })).problems }).toEqual({
          query,
          width,
          problems: [],
        });
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
}, 60_000);
