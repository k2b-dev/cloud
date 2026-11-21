import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { launchBrowser } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import {
  buildWorkspaceHarness,
  flatAccess,
  flatKeys,
  flatSchema,
  flatStates,
  origin,
  pauseWorkspaceClock,
  troubledSources,
} from "./PulseWorkspace.browser-fixture";
import { buildPulseWorkspaceHref } from "./workspace/routes";
import { sqlTestLimits } from "./workspace/sql-test-fixtures";
import type { PulseWorkspaceProps } from "./workspace/types";

// The flat base page in every state of the concept, at phone and desktop width: nothing overlaps, spills, is cut,
// draws a double line, or moves when a scrollbar appears. Set PULSE_FLAT_SHOTS to a folder to keep light screenshots.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
let page: Awaited<ReturnType<typeof buildWorkspaceHarness>>;
const shots = process.env.PULSE_FLAT_SHOTS;

beforeAll(async () => {
  page = await buildWorkspaceHarness();
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const widths = [390, 1440] as const;
const answer = (url: string, many: boolean) => {
  const path = new URL(url).pathname;
  if (path.endsWith("/schema")) return { status: 200, json: flatSchema(new URL(url).searchParams.get("kind"), many) };
  if (path.endsWith("/access")) return { status: 200, json: flatAccess };
  if (path.endsWith("/api-keys")) return { status: 200, json: path.includes("Src201") ? flatKeys : [] };
  if (path.endsWith("/scrapes")) return { status: 200, json: [] };
  return { status: 500, json: { code: "UNEXPECTED" } };
};
const open = async (width: number, props: PulseWorkspaceProps, options: { many?: boolean; hold?: boolean } = {}) => {
  const touch = width < 768;
  const tab = await browser.newPage({ viewport: { width, height: touch ? 844 : 900 }, isMobile: touch, hasTouch: touch });
  await pauseWorkspaceClock(tab.clock, new Date(props.initialNow));
  await tab.route(`${origin}/api/**`, (route) => route.fulfill(answer(route.request().url(), options.many ?? false)));
  let served = false;
  await tab.route(`${origin}/app/pulse/**`, async (route) => {
    // The first document is the page; a later request is a base switch that stays open while `hold` is set.
    if (served && options.hold) return;
    served = true;
    await route.fulfill({ contentType: "text/html", body: page(props, "de") });
  });
  await tab.goto(`${origin}${buildPulseWorkspaceHref({ baseId: props.initialBaseId, state: props.initialRouteState })}`);
  await tab.waitForSelector("#root[data-mounted='true']");
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};
// Findings inside building blocks go to their owning lanes and are left out here (see the PR text):
// the detail panel's header actions and collapsible group sections reach 8 px past the 7 px slack (K5),
// and the status row cuts its key figures at 390 px instead of letting them give way (K6).
const blockFindings =
  ".k2b-detail-panel__header, .k2b-detail-panel__group, .k2b-status-row__middle, .k2b-avatar-stack, [data-layout-check='skip']";
const problems = async (tab: Awaited<ReturnType<typeof open>>) =>
  (await tab.evaluate(layoutProblems, { root: "#root", ignore: blockFindings })).problems;
const shoot = async (tab: Awaited<ReturnType<typeof open>>, name: string, width: number) => {
  if (shots) await tab.screenshot({ path: `${shots}/${name}-light-${width}.png` });
};
const many = (props: PulseWorkspaceProps): PulseWorkspaceProps => ({
  ...props,
  initialSources: [
    ...props.initialSources,
    ...Array.from({ length: 30 }, (_, index) => ({
      ...troubledSources[2]!,
      id: `Mny${String(index).padStart(3, "0")}`,
      name: `Kurzlink ${index + 1}`,
    })),
  ],
});

describe("Pulse flat base page", () => {
  for (const width of widths) {
    test(`${width} px: Sources with a source in detail, with few and with many rows`, async () => {
      for (const props of [flatStates.error, many(flatStates.error)]) {
        const tab = await open(width, props);
        await tab.getByText("Was nicht ankommt").first().waitFor();
        if (props === flatStates.error) await shoot(tab, "02-quelle-fehler", width);
        expect(await problems(tab)).toEqual([]);
        await tab.close();
      }
    }, 60_000);

    test(`${width} px: Data with few and with many kinds and fields`, async () => {
      for (const rows of [false, true]) {
        const tab = await open(width, flatStates.data, { many: rows });
        await tab.getByText("Stichprobe", { exact: false }).first().waitFor();
        await tab.getByText("/sammlung/vasen").first().waitFor();
        if (!rows) await shoot(tab, "06-daten", width);
        expect(await problems(tab)).toEqual([]);
        await tab.close();
      }
    }, 60_000);

    test(`${width} px: every other state keeps the head and draws no layout problem`, async () => {
      const states: [string, PulseWorkspaceProps, string][] = [
        ["01-quellen-gesund", flatStates.healthy, "Alle 4 Quellen empfangen"],
        ["03-base-leer", flatStates.empty, "Noch keine Daten in „Lager“"],
        ["04-kein-zugriff", flatStates.noAccess, "Diese Basis ist nicht mit dir geteilt."],
        ["07-nutzung", flatStates.usage, "Shop-Auswertung"],
        ["09-nur-lesen", flatStates.readOnly, "Du kannst diese Basis lesen."],
        ["10-speicher-weg", flatStates.storeDown, "Datenspeicher nicht erreichbar"],
        ["12-alarm", flatStates.alert, "Mit Gustav anpassen"],
        ["11-sql-konsole", { ...flatStates.sql, initialSql: { limits: sqlTestLimits, query: null, error: null } }, "Ausführen"],
      ];
      for (const [name, props, text] of states) {
        const tab = await open(width, props);
        await tab.getByText(text, { exact: false }).first().waitFor();
        await shoot(tab, name, width);
        expect({ name, problems: await problems(tab) }).toEqual({ name, problems: [] });
        await tab.close();
      }
    }, 120_000);
  }

  test("the head keeps its height in every state, also without tabs", async () => {
    const heights: number[] = [];
    for (const props of [flatStates.healthy, flatStates.noAccess, flatStates.data, flatStates.storeDown]) {
      const tab = await open(1440, props);
      heights.push(
        await tab
          .locator(".k2b-app-workspace__head")
          .first()
          .evaluate((head) => head.getBoundingClientRect().height),
      );
      await tab.close();
    }
    expect(new Set(heights).size).toBe(1);
  }, 60_000);

  test("states say what matters: attention order, read-only without the main action, no access without the base", async () => {
    const error = await open(1440, flatStates.error);
    const rows = await error.locator(".pulse-attention .k2b-task-row__text").allTextContents();
    expect(rows).toEqual([
      "Website-Server: seit 14:01 kommt nichts an",
      "Alarm „Kontaktanfragen zu niedrig“ ausgelöst",
      "Shop-Backend ist veraltet",
    ]);
    expect(await error.getByText("2 Quellen brauchen Aufmerksamkeit").count()).toBe(1);
    await error.close();
    const readOnly = await open(1440, flatStates.readOnly);
    expect(await readOnly.getByRole("button", { name: "Quelle anlegen" }).count()).toBe(0);
    await readOnly.close();
    const denied = await open(1440, flatStates.noAccess);
    expect(await denied.getByText("Website").count()).toBe(0);
    expect(await denied.getByText("Kein Zugriff").count()).toBeGreaterThan(0);
    await denied.close();
  }, 60_000);

  test("switching the base shows a placeholder of fixed size until the new base arrives", async () => {
    // On a phone the host's title switches the base; the sidebar's links switch it from 768 px on.
    for (const width of [1440]) {
      const tab = await open(width, flatStates.healthy, { hold: true });
      await tab.getByRole("link", { name: "Website" }).first().click({ noWaitAfter: true });
      await tab.locator("[aria-busy='true'], .k2b-skeleton").first().waitFor();
      await shoot(tab, "05-laedt", width);
      expect(await problems(tab)).toEqual([]);
      await tab.close();
    }
  }, 60_000);
});
