import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-confirm-island.entry";
import type {} from "../../test/v2-page-hosts.entry";
import type {} from "../../test/v2-toast-island.entry";

// A frame whose Workspace the server renders without a script (Cloud's app frame) mounts `PageHosts` once: the toasts
// and the questions of every island on the page answer there, so no island brings hosts of its own.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");

let browser: Browser;
let hosts: string;
let confirmIsland: string;
let toastIsland: string;
beforeAll(async () => {
  [hosts, confirmIsland, toastIsland, browser] = await Promise.all([
    demoBundle("../v2-page-hosts"),
    demoBundle("../v2-confirm-island"),
    demoBundle("../v2-toast-island"),
    launchBrowser(),
  ]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The hosts a toast or a question brings to the end of the page when nothing on the page answers. */
const ownHosts = (page: Page) => page.evaluate(() => document.querySelectorAll("body > .k2-ui[style]").length);

const open = async (withHosts: boolean) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  // the server's Workspace: its markup only, no script makes it live
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui"><div class="k2-ws" data-k2-workspace="">Seite</div><span id="hosts"></span></body></html>`,
  );
  if (withHosts) {
    await page.addScriptTag({ content: hosts });
    await page.waitForFunction(() => window.__hostsMounted === true);
  }
  await page.addScriptTag({ content: confirmIsland });
  await page.addScriptTag({ content: toastIsland });
  await settled(page);
  return { page, errors };
};

test("with the page's hosts, a question and a toast from islands answer there, without hosts of their own", async () => {
  const { page, errors } = await open(true);
  try {
    await page.evaluate(() => window.__k2AskOther?.());
    const dialog = page.getByRole("alertdialog", { name: "Aus der Insel?" });
    await dialog.waitFor();
    expect(await page.locator(".k2-page-hosts .k2-dialog").count()).toBe(1);
    expect(await ownHosts(page)).toBe(0);
    await dialog.getByRole("button", { name: "Ja" }).click();
    await page.waitForFunction(() => document.body.dataset.other === "true");
    await page.evaluate(() => window.__k2ToastOther?.("Gespeichert"));
    await page.locator(".k2-page-hosts .k2-toast", { hasText: "Gespeichert" }).waitFor();
    expect(await ownHosts(page)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("without them, an island's toast brings its own region (the case the hosts take away)", async () => {
  const { page, errors } = await open(false);
  try {
    await page.evaluate(() => window.__k2ToastOther?.("Gespeichert"));
    await page.locator(".k2-toast", { hasText: "Gespeichert" }).waitFor();
    expect(await ownHosts(page)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
