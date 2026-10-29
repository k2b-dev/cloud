import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import type { AccessEntry } from "../contracts/shared";
import type { AppAccessChange } from "../services/app-access-management";
import { appAccessBrowserFixture, fixtureEntity, fixtureSnapshot } from "./AppAccessEditor.browser-fixture";

let fixture: Awaited<ReturnType<typeof appAccessBrowserFixture>>;
let browser: Browser;
beforeAll(async () => {
  fixture = await appAccessBrowserFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

/**
 * Pins only `Date` to the fixtures' instant and lets it flow from there. Playwright's `clock` would also replace timers,
 * animation frames and `performance`, which the editor's debounce, dialogs and settled waits rely on.
 */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

type Transport = {
  state: ReturnType<typeof fixtureSnapshot>;
  requests: { method: string; repair: string | null; change?: AppAccessChange }[];
  readError: boolean;
  readDenied?: boolean;
  change?: (change: AppAccessChange) => Promise<"reject" | "bad-input" | "last-manager" | "lost" | "lost-applied" | undefined>;
};
const open = async (
  width = 1440,
  mode = "normal",
  setup?: (transport: Transport) => void,
  appearance: { theme?: "light" | "dark"; locale?: "de" | "en" } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5_000);
  const errors = pageErrors(page);
  await page.addInitScript(pinPageClock, Date.parse("2026-10-22T12:00:00.000Z"));
  // The same mode data the fixture renders on the server, so the first canonical read matches the page.
  const transport: Transport = { state: fixtureSnapshot(mode), requests: [], readError: false };
  setup?.(transport);
  const endpoint = new URL("/_cloud/app-access/invoices", fixture.url);
  await page.route(`${endpoint.href}*`, async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(url.pathname).toBe(endpoint.pathname);
    expect(url.origin).toBe(endpoint.origin);
    expect([...url.searchParams.keys()]).toEqual(mode === "repair" || mode === "no-manager" ? ["repair"] : []);
    const change: AppAccessChange | undefined = request.method() === "POST" ? request.postDataJSON() : undefined;
    transport.requests.push({ method: request.method(), repair: url.searchParams.get("repair"), change });
    if (!change)
      return route.fulfill({
        status: transport.readDenied ? 403 : transport.readError ? 503 : 200,
        json: transport.readDenied ? { code: "FORBIDDEN" } : transport.readError ? { code: "OFFLINE" } : transport.state,
      });
    const result = await transport.change?.(change);
    if (result === "reject")
      return route.fulfill({ status: 409, json: { code: "CONFLICT", message: "Diese Freigabe wurde inzwischen geändert." } });
    if (result === "bad-input")
      return route.fulfill({ status: 400, json: { code: "BAD_INPUT", message: "Signed-in identities may only receive Use." } });
    if (result === "last-manager")
      return route.fulfill({ status: 409, json: { code: "LAST_MANAGER", message: "At least one person must manage access." } });
    if (result === "lost") return route.abort("failed");
    let entry: AccessEntry | undefined;
    if (change.action === "grant") {
      entry = {
        id: "00000005-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: change.principal,
        displayName: fixtureEntity.user.displayName,
        permission: change.permission,
        createdAt: "2026-10-22T12:00:00.000Z",
      };
      transport.state.entries.push(entry);
    } else if (change.action === "update") {
      entry = transport.state.entries.find((entry) => entry.id === change.accessId);
      if (entry) {
        entry.permission = change.permission;
        const presented = transport.state.entries.find((candidate) => candidate.id === entry!.id)!;
        presented.effectiveManager = change.permission === "admin";
      }
    } else transport.state.entries = transport.state.entries.filter((entry) => entry.id !== change.accessId);
    transport.state.hasEffectiveManager = transport.state.entries.some((entry) => entry.permission === "admin");
    if (result === "lost-applied") return route.abort("failed");
    return route.fulfill({ json: { entry, canUse: change.action !== "revoke" || !transport.state.ownEntryIds.includes(change.accessId) } });
  });
  const query = new URLSearchParams({ state: mode, theme: appearance.theme ?? "light", locale: appearance.locale ?? "de" });
  const response = await page.goto(`${fixture.url}?${query}`);
  if (!mode.startsWith("denied"))
    await page
      .locator(`${mode.startsWith("discovery-") ? "#app-access-discovery-fixture" : "#app-access-fixture"}[data-ready=true]`)
      .waitFor({ state: "attached" });
  return { page, transport, errors, response };
};
const row = (page: Page, name: string) => page.locator(".group\\/access-row").filter({ hasText: name });
const level = (page: Page, name = "Buchhaltung") => page.getByRole("combobox", { name: `Berechtigung für ${name}`, exact: true });
const changeLevel = async (page: Page, name = "Buchhaltung", label = "Zugriff verwalten") => {
  await level(page, name).click();
  await page.getByRole("option", { name: label, exact: true }).click();
};
const posts = (transport: Transport) => transport.requests.filter((request) => request.method === "POST");

describe("App access through real browser controls and same-origin transport", () => {
  for (const width of [390, 768, 1440]) {
    test(`${width}px: add a fictional person with an explicit level`, async () => {
      const { page, transport, errors } = await open(width);
      try {
        await settled(page);
        const section = page.getByRole("region", { name: "Zugriff", exact: true });
        expect((await section.boundingBox())!.width).toBeLessThanOrEqual(720);
        expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).isDisabled()).toBe(true);
        const picker = page.getByRole("combobox").first();
        const searchRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/accounts/entities");
        await picker.fill("Lea");
        const searched = new URL((await searchRequest).url());
        expect(searched.origin).toBe(new URL(fixture.url).origin);
        expect(Object.fromEntries(searched.searchParams)).toEqual({
          search: "Lea",
          kinds: "user,group,service_account",
          per_page: "10",
          service_account_status: "active",
          exclude_user_ids: transport.state.entries
            .flatMap((entry) => (entry.principal.type === "user" ? [entry.principal.userId] : []))
            .join(","),
          exclude_group_ids: "33333333-3333-4333-8333-333333333333",
          exclude_service_account_ids: "44444444-4444-4444-8444-444444444444",
        });
        await page.getByRole("option", { name: /Lea Fiktiv/ }).click();
        expect(posts(transport)).toHaveLength(0);
        await page.getByRole("combobox", { name: "Recht für neuen Eintrag", exact: true }).click();
        expect(await page.getByRole("option").allTextContents()).toEqual(["Nutzen", "Zugriff verwalten"]);
        await page.getByRole("option", { name: "Zugriff verwalten", exact: true }).click();
        await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
        await row(page, "Lea Fiktiv").getByText("Gespeichert", { exact: true }).waitFor();
        expect(posts(transport).map((request) => request.change)).toEqual([
          { action: "grant", principal: { type: "user", userId: fixtureEntity.user.id }, permission: "admin" },
        ]);
        expect(await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20_000);
  }

  for (const width of [390, 768, 1440]) {
    test(`${width}px: expanded rows match the approved geometry`, async () => {
      const { page } = await open(width);
      try {
        await settled(page);
        // Every control in the add row has the 36px field height, also once a selection replaces the search.
        const addRow = async () =>
          Promise.all([
            page.locator("input[role=combobox]").or(page.getByRole("button", { name: /^Auswahl entfernen:/ })),
            page.getByRole("combobox", { name: "Recht für neuen Eintrag", exact: true }),
            page.getByRole("button", { name: "Hinzufügen", exact: true }),
          ]);
        const heights = async () =>
          Promise.all(
            (await addRow()).map(async (control) =>
              control.evaluate((element) => (element.closest(".k2b-combobox__input") ?? element).getBoundingClientRect().height),
            ),
          );
        expect(await heights()).toEqual([36, 36, 36]);
        const picker = page.locator("input[role=combobox]");
        expect(await picker.getAttribute("placeholder")).toBe("Person, Gruppe oder Dienstkonto hinzufügen");
        expect(await picker.evaluate((element) => getComputedStyle(element).textOverflow)).toBe("ellipsis");
        expect(await picker.evaluate((element) => getComputedStyle(element).fontSize)).toBe("15px");
        await picker.fill("Lea");
        await page.getByRole("option", { name: /Lea Fiktiv/ }).click();
        await settled(page);
        expect(await heights()).toEqual([36, 36, 36]);
        expect(await row(page, "Buchhaltung").getByText("Gruppe · 4 Personen", { exact: true }).count()).toBe(1);
        expect(await row(page, "Monatsabschluss").getByText("Dienstkonto", { exact: true }).count()).toBe(1);
        expect(await row(page, "Anna Muster").getByText("Person · du", { exact: true }).count()).toBe(1);
        const geometry = await row(page, "Buchhaltung").evaluate((element) => {
          const avatar = element.children[0]!.getBoundingClientRect();
          const name = element.children[1]!.getBoundingClientRect();
          const select = element.querySelector("[role=combobox]")!.getBoundingClientRect();
          return {
            rowHeight: element.getBoundingClientRect().height,
            avatarWidth: avatar.width,
            avatarHeight: avatar.height,
            permissionWidth: select.width,
            permissionFontSize: getComputedStyle(element.querySelector("[role=combobox]")!).fontSize,
            borderVisible: getComputedStyle(element.querySelector("[role=combobox]")!).borderTopColor !== "rgba(0, 0, 0, 0)",
            twoRows: select.top >= name.bottom,
          };
        });
        expect(geometry).toMatchObject({
          avatarWidth: 32,
          avatarHeight: 32,
          permissionFontSize: "15px",
          borderVisible: true,
          twoRows: width === 390,
          ...(width >= 768 ? { permissionWidth: 176 } : {}),
        });
        expect(geometry.rowHeight).toBeGreaterThanOrEqual(52);
      } finally {
        await page.close();
      }
    }, 20_000);
  }

  test("a failed initial read shows recovery and reloads the canonical list", async () => {
    const { page, transport, errors } = await open(390, "load", (transport) => {
      transport.readError = true;
    });
    try {
      await page.getByRole("alert").getByText("Die Liste lädt gerade nicht. Es hat sich nichts geändert.").waitFor();
      expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).count()).toBe(0);
      transport.readError = false;
      await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
      await level(page).waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('input[role="combobox"]'));
      expect(transport.requests.map((request) => request.method)).toEqual(["GET", "GET"]);
      // announce() installs a persistent empty assertive region outside the editor.
      expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("saving disables repeat writes; a concurrent change requires canonical reload before another edit", async () => {
    const gate = Promise.withResolvers<void>();
    const { page, transport, errors } = await open(1440, "normal", (transport) => {
      transport.change = async () => {
        await gate.promise;
        return "reject";
      };
    });
    try {
      await changeLevel(page);
      await row(page, "Buchhaltung").getByText("Wird gespeichert", { exact: true }).waitFor();
      expect(await level(page).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).isDisabled()).toBe(true);
      expect(await level(page).textContent()).toBe("Zugriff verwalten");
      expect(posts(transport)).toHaveLength(1);
      gate.resolve();
      await page.getByRole("alert").getByText("Diese Freigabe wurde inzwischen geändert.", { exact: false }).first().waitFor();
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
      transport.change = undefined;
      await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
      await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
      // announce() installs a persistent empty assertive region outside the editor.
      expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
      expect(await level(page).textContent()).toBe("Nutzen");
      await changeLevel(page);
      await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
      expect(posts(transport).map((request) => request.change)).toEqual(
        Array(2).fill({ action: "update", accessId: "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa", permission: "admin" }),
      );
      expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
      expect(errors).toEqual([]);
    } finally {
      gate.resolve();
      await page.close();
    }
  }, 20_000);

  test("a lost response after commit reconciles without a duplicate write", async () => {
    const { page, transport, errors } = await open(1440, "normal", (transport) => {
      transport.change = async () => "lost-applied";
    });
    try {
      await changeLevel(page);
      await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
      expect(posts(transport)).toHaveLength(1);
      expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
      expect(await level(page).textContent()).toBe("Zugriff verwalten");
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("a confirmed write with a failed refresh stays saved and offers a safe reload", async () => {
    const { page, transport, errors } = await open(390, "normal", (transport) => {
      transport.change = async () => {
        transport.readError = true;
        return undefined;
      };
    });
    try {
      await changeLevel(page);
      await page.getByText("Gespeichert. Die Liste konnte nicht aktualisiert werden.", { exact: false }).waitFor();
      await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
      expect(await page.getByText("Die Änderung konnte nicht bestätigt werden.", { exact: false }).count()).toBe(0);
      expect(posts(transport)).toHaveLength(1);
      expect(await level(page).isDisabled()).toBe(true);
      transport.readError = false;
      await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
      await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
      expect(await level(page).isDisabled()).toBe(false);
      expect(posts(transport)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("an unresolved response blocks another POST until a canonical read succeeds", async () => {
    const { page, transport, errors } = await open(390, "normal", (transport) => {
      transport.change = async () => {
        transport.readError = true;
        return "lost";
      };
    });
    try {
      await changeLevel(page);
      await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor();
      expect(
        await page
          .getByText("Die Änderung konnte nicht bestätigt werden. Lade die Liste vor einem neuen Versuch erneut.", { exact: false })
          .count(),
      ).toBeGreaterThan(0);
      // An uncertain write has no row retry until a successful canonical reload unblocks editing.
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
      expect(await level(page).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).count()).toBe(0);
      expect(posts(transport)).toHaveLength(1);
      expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
      transport.readError = false;
      transport.change = undefined;
      await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
      await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
      // The canonical list replaces the uncertain attempt: no stale error, no retry that replays it.
      // announce() installs a persistent empty assertive region outside the editor.
      expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
      expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
      expect(await level(page).isDisabled()).toBe(false);
      expect(posts(transport)).toHaveLength(1);
      await changeLevel(page);
      await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
      expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  for (const mode of ["sole-manager", "sole-effective-manager"])
    test(`${mode}: the only effective manager cannot be removed or downgraded`, async () => {
      const { page, transport, errors } = await open(390, mode);
      try {
        const remove = page.getByRole("button", { name: "Anna Muster entfernen", exact: true });
        expect(await remove.isDisabled()).toBe(true);
        expect(await remove.getAttribute("aria-description")).toContain("Zugriff verwalten");
        await level(page, "Anna Muster").click();
        expect(await page.getByRole("option", { name: "Nutzen", exact: true }).isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        expect(posts(transport)).toHaveLength(0);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20_000);

  for (const [width, mode, ownName] of [
    [1440, "normal", "Anna Muster"],
    [390, "self-group", "Finanzteam"],
  ] as const) {
    test(`${width}px: self removal via ${mode} confirms, cancel keeps access and confirm reports access lost`, async () => {
      const { page, transport, errors } = await open(width, mode);
      try {
        const remove = page.getByRole("button", { name: `${ownName} entfernen`, exact: true });
        await remove.click();
        const dialog = page.getByRole("alertdialog", { name: "Eigenen Zugriff entfernen?", exact: true });
        await dialog.waitFor();
        expect(await dialog.getAttribute("aria-describedby")).toBeTruthy();
        expect(
          await dialog
            .getByRole("button", { name: "Abbrechen", exact: true })
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(36);
        expect(await dialog.textContent()).toContain("Eva Beispiel");
        expect(posts(transport)).toHaveLength(0);
        await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        expect(await remove.isEnabled()).toBe(true);
        await page.waitForFunction(() => document.activeElement?.hasAttribute("data-access-remove"));
        expect(await remove.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(posts(transport)).toHaveLength(0);
        await remove.click();
        await dialog.waitFor();
        await page.goBack();
        await dialog.waitFor({ state: "hidden" });
        expect(posts(transport)).toHaveLength(0);
        await remove.click();
        await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
        await page.locator("#app-access-fixture[data-access-lost=true]").waitFor();
        expect(posts(transport).map((request) => request.change)).toEqual([
          { action: "revoke", accessId: "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        ]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20_000);
  }

  test("downgrading your manager grant explains the loss of management, not removal", async () => {
    const { page, transport, errors } = await open(390);
    try {
      await changeLevel(page, "Anna Muster", "Nutzen");
      const dialog = page.getByRole("alertdialog", { name: "Eigenen Zugriff ändern?", exact: true });
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Du kannst Rechnungen weiter nutzen, aber diese Liste nicht mehr ändern.");
      expect(await dialog.getByRole("button", { name: "Ändern", exact: true }).count()).toBe(1);
      await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(posts(transport)).toHaveLength(0);
      expect(await level(page, "Anna Muster").textContent()).toBe("Zugriff verwalten");
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
      expect(await level(page, "Anna Muster").evaluate((element) => document.activeElement === element)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("removing the signed-in audience explains who loses access", async () => {
    const { page, transport, errors } = await open(390, "inherited");
    try {
      await page.getByRole("button", { name: "Alle angemeldeten Personen entfernen", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Zugriff für alle angemeldeten Personen entfernen?", exact: true });
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain("Personen ohne weitere Freigabe können Rechnungen danach nicht mehr nutzen.");
      await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(posts(transport)).toHaveLength(0);
      await row(page, "Alle angemeldeten Personen").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("admin repair states its limits under Core's header and uses repair transport", async () => {
    const { page, transport, errors, response } = await open(1440, "repair");
    try {
      expect(new URL(response!.url()).pathname).toBe("/admin/apps");
      await page.getByRole("heading", { name: "Rechnungen · Zugriff", exact: true }).waitFor();
      expect(await page.getByRole("link", { name: "Zurück zu Apps", exact: true }).getAttribute("href")).toBe("/admin/apps");
      expect(await page.locator('a[href="/admin/apps"][aria-current="page"]').count()).toBe(1);
      await page.getByText("Du bearbeitest den Zugriff als Cloud-Admin.", { exact: false }).waitFor();
      expect(await page.getByText("Niemand verwaltet den Zugriff.", { exact: false }).count()).toBe(0);
      await changeLevel(page);
      await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
      expect(transport.requests.map((request) => request.repair)).toEqual(["1", "1"]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  test("managerless transition repair shows the approved notices and the signed-in row", async () => {
    const { page, errors } = await open(1440, "no-manager");
    try {
      const notices = page.locator("article.k2b-notice-card");
      await notices.first().waitFor();
      // Repair and the missing manager, each with its tone icon; the transition note belongs to the app's managers.
      expect(await notices.evaluateAll((elements) => elements.map((element) => element.querySelector("i")?.className))).toEqual([
        "ti ti-shield-check k2b-notice-card__icon",
        "ti ti-alert-triangle k2b-notice-card__icon",
      ]);
      expect(await notices.nth(1).locator("strong").textContent()).toBe("Niemand verwaltet den Zugriff.");
      const colors = await notices.nth(1).evaluate((element) => ({
        text: getComputedStyle(element.querySelector("p")!).color,
        body: getComputedStyle(document.body).color,
      }));
      expect(colors.text).not.toBe(colors.body);
      expect(await page.getByText("Bisher nutzten alle angemeldeten Personen", { exact: false }).count()).toBe(0);
      const signedIn = row(page, "Alle angemeldeten Personen");
      await signedIn.getByText("Jede Person mit Konto in dieser Cloud", { exact: true }).waitFor();
      expect(await level(page, "Alle angemeldeten Personen").isDisabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);

  for (const width of [390, 768, 1440]) {
    test(`${width}px: self-removal dialog matches the approved desktop frame or phone bottom sheet`, async () => {
      const { page } = await open(width);
      try {
        await page.getByRole("button", { name: "Anna Muster entfernen", exact: true }).click();
        const dialog = page.getByRole("alertdialog", { name: "Eigenen Zugriff entfernen?", exact: true });
        await dialog.waitFor();
        expect(await dialog.getAttribute("aria-describedby")).toBeTruthy();
        await settled(page);
        const geometry = await dialog.evaluate((element) => {
          const frame = element.getBoundingClientRect();
          const content = element.querySelector("h2")!.parentElement!.getBoundingClientRect();
          return { bottom: frame.bottom, width: frame.width, contentWidth: content.width, viewportHeight: innerHeight };
        });
        if (width >= 768) expect(geometry.contentWidth).toBe(440);
        else {
          expect(geometry.width).toBe(width);
          expect(geometry.bottom).toBe(geometry.viewportHeight);
        }
      } finally {
        await page.close();
      }
    }, 20_000);
  }

  for (const width of [390, 768, 1440]) {
    test(`${width}px: denial exposes only the app and managers, no request control or domain content`, async () => {
      const { page, transport, errors } = await open(width, "denied-admin");
      try {
        const heading = page.getByRole("heading", { name: "Rechnungen ist für dich nicht freigegeben", exact: true });
        await heading.waitFor();
        expect(await heading.evaluate((element) => getComputedStyle(element).fontSize)).toBe("22px");
        const geometry = await heading.evaluate((element) => {
          const container = element.parentElement!,
            icon = container.firstElementChild!.getBoundingClientRect();
          return { width: container.getBoundingClientRect().width, iconWidth: icon.width, iconHeight: icon.height };
        });
        expect(geometry.width).toBeLessThanOrEqual(460);
        expect(geometry.iconWidth).toBe(48);
        expect(geometry.iconHeight).toBe(48);
        await page.getByText("Anna Muster", { exact: true }).waitFor();
        expect(await page.getByText("Buchhaltung", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: /anfrag|request|zugang|access/i }).count()).toBe(0);
        expect(await page.locator("main input, main textarea, main table").count()).toBe(0);
        expect(await page.getByRole("link", { name: "Zur Startseite", exact: true }).count()).toBe(1);
        expect(await page.getByRole("link", { name: "Zur Startseite", exact: true }).getAttribute("href")).toBe("/");
        const repairLink = page.getByRole("link", { name: "Verwaltung → Apps", exact: true });
        expect(await repairLink.getAttribute("href")).toBe("/admin/apps?app=invoices");
        // Only the destination is the link, and it reads as one: the action colour and weight, not the hint's grey.
        const link = await repairLink.evaluate((element) => ({
          color: getComputedStyle(element).color,
          weight: getComputedStyle(element).fontWeight,
          hint: getComputedStyle(element.parentElement!).color,
        }));
        expect(link.color).not.toBe(link.hint);
        expect(link.weight).toBe("500");
        // The page sits on the app work surface with the approved inset, not on the bare canvas.
        const frame = await heading.evaluate((element) => {
          let node = element.parentElement;
          const painted = (candidate: HTMLElement) =>
            getComputedStyle(candidate).backgroundColor !== "rgba(0, 0, 0, 0)" || getComputedStyle(candidate).backgroundImage !== "none";
          while (node && !painted(node)) node = node.parentElement;
          return {
            canvas: !!node?.classList.contains("cloud-app-canvas"),
            inset: getComputedStyle(element.closest(".k2b-app-workspace__main")!).paddingLeft,
          };
        });
        expect(frame).toEqual({ canvas: false, inset: width === 390 ? "16px" : "24px" });
        expect(transport.requests).toHaveLength(0);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20_000);
  }
});

test("committed self-removal with a lost response returns through authorization without a duplicate write", async () => {
  const { page, transport } = await open(390, "normal", (transport) => {
    transport.change = async () => {
      transport.readDenied = true;
      return "lost-applied";
    };
  });
  try {
    await page.getByRole("button", { name: "Anna Muster entfernen", exact: true }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "Entfernen", exact: true }).click();
    await page.locator('#app-access-fixture[data-access-lost="true"]').waitFor();
    expect(posts(transport)).toHaveLength(1);
  } finally {
    await page.close();
  }
});

test("a forbidden initial management read is a terminal visible state without an endless retry", async () => {
  const { page, transport } = await open(390, "load", (transport) => {
    transport.readDenied = true;
  });
  try {
    await page.getByRole("alert").getByText("Du darfst diese Liste nicht verwalten.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Erneut laden", exact: true }).count()).toBe(0);
    expect(transport.requests).toHaveLength(1);
  } finally {
    await page.close();
  }
});

// Compare computed foregrounds from the real stylesheet, keeping the requested theme after the probe.
const expectDarkForeground = async (element: ReturnType<Page["locator"]>) => {
  const colors = await element.evaluate((target) => {
    const html = document.documentElement;
    const dark = getComputedStyle(target).color;
    html.classList.replace("dark", "light");
    const light = getComputedStyle(target).color;
    html.classList.replace("light", "dark");
    return { dark, light, theme: html.className };
  });
  expect(colors.theme).toContain("dark");
  expect(colors.dark).not.toBe(colors.light);
};
const expectFits = async (page: Page) => {
  expect(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth)).toBe(true);
};

for (const width of [390, 768, 1440]) {
  test(`${width}px dark: actual editor, confirmation and denial retain their layout and theme`, async () => {
    const { page, errors, transport } = await open(width, "normal", undefined, { theme: "dark" });
    try {
      await settled(page);
      const editor = page.getByRole("region", { name: "Zugriff", exact: true });
      expect((await editor.boundingBox())!.width).toBeLessThanOrEqual(720);
      await expectDarkForeground(editor.getByRole("heading", { name: "Wer Rechnungen nutzt", exact: true }));
      await expectFits(page);
      await page.getByRole("button", { name: "Anna Muster entfernen", exact: true }).click();
      const dialog = page.getByRole("alertdialog", { name: "Eigenen Zugriff entfernen?", exact: true });
      await dialog.waitFor();
      await settled(page);
      await dialog
        .getByText(
          "Danach kannst du Rechnungen nicht mehr öffnen und diese Liste nicht mehr ändern. Eva Beispiel verwaltet den Zugriff weiter.",
          { exact: true },
        )
        .waitFor();
      await expectDarkForeground(dialog.getByRole("heading"));
      const geometry = await dialog.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        return {
          width: frame.width,
          bottom: frame.bottom,
          contentWidth: element.querySelector("h2")!.parentElement!.getBoundingClientRect().width,
          height: innerHeight,
        };
      });
      if (width >= 768) expect(geometry.contentWidth).toBe(440);
      else expect(geometry).toMatchObject({ width, bottom: geometry.height });
      await expectFits(page);
      await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(posts(transport)).toHaveLength(0);
      await page.goto(`${fixture.url}?state=denied&theme=dark`);
      const heading = page.getByRole("heading", { name: "Rechnungen ist für dich nicht freigegeben", exact: true });
      await heading.waitFor();
      await settled(page);
      await expectDarkForeground(heading);
      expect((await heading.locator("..").boundingBox())!.width).toBeLessThanOrEqual(460);
      await page.getByText("Eva Beispiel", { exact: true }).waitFor();
      expect(await page.getByText("Buchhaltung", { exact: true }).count()).toBe(0);
      expect(await page.locator("main input, main textarea, main table").count()).toBe(0);
      await expectFits(page);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);
}

test("bootstrap shows the inherited signed-in grant, dismisses its notice and handles an empty principal search", async () => {
  const { page, transport, errors } = await open(768, "inherited");
  try {
    const notice = page.getByText("Bisher nutzten alle angemeldeten Personen Rechnungen. Das bleibt so, bis du es änderst.", {
      exact: true,
    });
    await notice.waitFor();
    // The approved term for the signed-in audience, the same one the notice uses, and nobody's own marker.
    await row(page, "Alle angemeldeten Personen").getByText("Jede Person mit Konto in dieser Cloud", { exact: true }).waitFor();
    expect(await level(page, "Alle angemeldeten Personen").textContent()).toBe("Nutzen");
    await page.getByRole("button", { name: "Hinweis schließen", exact: true }).click();
    expect(await notice.count()).toBe(0);
    await page.waitForFunction(() => document.activeElement?.matches('input[role="combobox"]'));
    await row(page, "Alle angemeldeten Personen").waitFor();
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/accounts/entities");
    const picker = page.locator("input[role=combobox]");
    await picker.fill("Niemandgefunden");
    expect((await response).status()).toBe(200);
    await page.locator(".k2b-combobox .k2b-spin").waitFor({ state: "hidden" });
    await page.getByRole("listbox").getByText("Keine Ergebnisse gefunden", { exact: true }).waitFor();
    expect(await page.getByRole("option").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).isDisabled()).toBe(true);
    await picker.press("Enter");
    expect(posts(transport)).toHaveLength(0);
    await picker.press("Escape");
    // A different query recovers through the same real picker.
    await picker.fill("Lea");
    await page.getByRole("option", { name: /Lea Fiktiv/ }).waitFor();
    expect(posts(transport)).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

for (const [mode, heading, explanation] of [
  [
    "denied-fixed",
    "Rechnungen ist für dich nicht freigegeben",
    "Rechnungen nutzen nur Cloud-Admins. Wenn du die App brauchst, wende dich an die Cloud-Verwaltung.",
  ],
  ["denied-revoked", "Dein Zugriff auf Rechnungen wurde entfernt", "Du hattest bis eben Zugriff. Wenn das ein Versehen ist, frag:"],
] as const) {
  test(`${mode}: exact recovery wording and no request or domain controls`, async () => {
    const { page, transport, errors } = await open(768, mode, undefined, { theme: "dark" });
    try {
      await page.getByRole("heading", { name: heading, exact: true }).waitFor();
      await page.getByText(explanation, { exact: true }).waitFor();
      if (mode === "denied-fixed") {
        // The sentence already names the Cloud administration; no second contact repeats it.
        expect(await page.getByText("Cloud-Verwaltung", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Anna Muster", { exact: true }).count()).toBe(0);
      } else await page.getByText("Eva Beispiel", { exact: true }).waitFor();
      const denial = page.getByRole("heading", { name: heading, exact: true }).locator("..");
      expect(await denial.locator("button, input, textarea, table").count()).toBe(0);
      expect(await page.getByRole("link", { name: /reparier|repair/i }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "Zur Startseite", exact: true }).getAttribute("href")).toBe("/");
      expect(transport.requests).toHaveLength(0);
      await expectFits(page);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 20_000);
}

test("a fixed rule renders its explanation without a permission editor or management request", async () => {
  const { page, transport, errors } = await open(768, "fixed");
  try {
    await page.getByText("Nur Cloud-Admins. Das legt die App fest; hier gibt es dazu nichts einzustellen.", { exact: true }).waitFor();
    expect(await page.getByRole("combobox").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).count()).toBe(0);
    expect(transport.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

// These are discovery/display checks, not direct-request enforcement tests. Fixed rules are resolved on the server
// before Layout serializes its catalog. The real launcher and shell navigation search consume that exact payload.
for (const width of [390, 768, 1440]) {
  for (const allowed of [true, false]) {
    test(`${width}px: authoritative shell catalog ${allowed ? "includes" : "omits"} the app in nav, launcher and search`, async () => {
      const { page, transport, errors } = await open(width, allowed ? "discovery-allowed" : "discovery-denied", undefined, {
        theme: "dark",
        locale: "en",
      });
      try {
        // Inspect a same-session SSR response independently of the shell navigation bootstrap.
        const html = await (await page.request.get(page.url())).text();
        expect(html).not.toContain("Geheimarchiv");
        expect(html).not.toContain("Verborgene Belege");
        expect(html).not.toContain("/fictional/hidden");
        if (!allowed) {
          expect(html).not.toContain("Rechnungen");
          expect(html).not.toContain("Invoices");
          expect(html).not.toContain("Open receipts");
          expect(html).not.toContain("Buchhaltung");
        }
        const shell = await page.locator("#cloud-shell-data").textContent();
        expect(shell).not.toContain("Geheimarchiv");
        expect(shell).not.toContain("/fictional/hidden");
        expect(shell).not.toContain("Verborgene Belege");
        const data = JSON.parse(shell!);
        // Administration stays available for repair; its presence never grants application use.
        expect(data.apps.map((app: { id: string }) => app.id).sort()).toEqual(allowed ? ["admin", "home", "invoices"] : ["admin", "home"]);
        expect(data.theme).toBe("dark");
        const navigation = page.locator(width >= 768 ? ".layout-rail" : ".cloud-tab-bar");
        expect(await navigation.getByRole("link", { name: "Invoices", exact: true }).count()).toBe(allowed ? 1 : 0);
        expect(await navigation.locator('a[href^="/fictional/hidden"]').count()).toBe(0);
        // Open via the real shell control, including the phone menu variant.
        const chrome = page.locator(width >= 768 ? ".layout-rail" : ".layout-header");
        await chrome.getByRole("button", { name: "Open apps", exact: true }).click();
        const launcher = page.locator("dialog[open]");
        await launcher.waitFor();
        await launcher.locator('a[href="/fixture"]').first().waitFor();
        // Decorative icon glyphs are part of this shared link's accessible name.
        expect(await launcher.getByRole("link", { name: /Invoices/ }).count()).toBe(allowed ? 1 : 0);
        expect(await launcher.locator('a[href^="/fictional/hidden"]').count()).toBe(0);
        expect(await launcher.textContent()).not.toContain("Geheimarchiv");
        if (width === 390) {
          const find = launcher.getByRole("textbox", { name: "Find an app…", exact: true });
          await find.fill("Geheimarchiv");
          await launcher.getByText("No matching apps.", { exact: true }).waitFor();
          expect(await launcher.locator(".launchpad-app").count()).toBe(0);
        }
        await page.keyboard.press("Escape");
        await launcher.waitFor({ state: "hidden" });
        await chrome.getByRole("button", { name: "Open global search", exact: true }).click();
        const search = page.locator(".cloud-global-search");
        await search.waitFor();
        const input = search.getByRole("combobox");
        await input.fill("Invoices");
        if (allowed) await search.getByRole("option").filter({ hasText: "Invoices" }).waitFor();
        else await search.getByText("No matches. Try another search term.", { exact: true }).waitFor();
        expect(await search.getByRole("option").count()).toBe(allowed ? 1 : 0);
        await input.fill("Open receipts");
        if (allowed) await search.getByRole("option").filter({ hasText: "Open receipts" }).waitFor();
        else await search.getByText("No matches. Try another search term.", { exact: true }).waitFor();
        expect(await search.getByRole("option").count()).toBe(allowed ? 1 : 0);
        for (const query of ["Geheimarchiv", "Verborgene Belege", "Buchhaltung"]) {
          await input.fill(query);
          if (allowed && query === "Buchhaltung") await search.getByRole("option").filter({ hasText: "Open receipts" }).waitFor();
          else await search.getByText("No matches. Try another search term.", { exact: true }).waitFor();
          expect(await search.getByRole("option").count()).toBe(allowed && query === "Buchhaltung" ? 1 : 0);
          expect(await search.textContent()).not.toContain("Geheimarchiv");
          expect(await search.textContent()).not.toContain("Verborgene Belege");
        }
        expect(await page.locator("html").getAttribute("lang")).toBe("en");
        expect(await page.locator("html").getAttribute("class")).toContain("dark");
        expect(transport.requests).toHaveLength(0);
        await expectFits(page);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 20_000);
  }
}

test("canonical reload removes a vanished uncertain row without offering its stale retry", async () => {
  const { page, transport, errors } = await open(768, "normal", (transport) => {
    transport.change = async () => {
      transport.readError = true;
      return "lost";
    };
  });
  try {
    await changeLevel(page);
    await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    transport.state.entries = transport.state.entries.filter((entry) => entry.id !== "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    transport.readError = false;
    transport.change = undefined;
    await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
    await row(page, "Buchhaltung").waitFor({ state: "hidden" });
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    expect(posts(transport)).toHaveLength(1);
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

test("managerless repair preselects Manage access, so the first add makes an admin", async () => {
  const { page, transport, errors } = await open(1440, "no-manager");
  try {
    await page.getByText("Niemand verwaltet den Zugriff.", { exact: false }).waitFor();
    await page.getByRole("combobox").first().fill("Lea");
    await page.getByRole("option", { name: /Lea Fiktiv/ }).click();
    expect(await page.getByRole("combobox", { name: "Recht für neuen Eintrag", exact: true }).textContent()).toBe("Zugriff verwalten");
    await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
    await row(page, "Lea Fiktiv").getByText("Gespeichert", { exact: true }).waitFor();
    expect(posts(transport).map((request) => request.change)).toEqual([
      { action: "grant", principal: { type: "user", userId: fixtureEntity.user.id }, permission: "admin" },
    ]);
    expect(transport.requests.map((request) => request.repair)).toEqual(["1", "1"]);
    expect(await page.getByText("Niemand verwaltet den Zugriff.", { exact: false }).count()).toBe(0);
    // announce() installs a persistent empty assertive region outside the editor.
    expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

test("a rejected change on a remaining row loses its stale error and retry after canonical reload", async () => {
  const { page, transport, errors } = await open(1440, "normal");
  try {
    await changeLevel(page);
    await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
    transport.change = async () => "last-manager";
    await changeLevel(page, "Eva Beispiel", "Nutzen");
    const evaRow = row(page, "Eva Beispiel").locator("..");
    await page
      .getByRole("region", { name: "Zugriff", exact: true })
      .getByRole("alert")
      .getByText("Mindestens eine Person muss den Zugriff verwalten.", { exact: false })
      .waitFor();
    expect(await evaRow.getByRole("alert").count()).toBe(0);
    await row(page, "Eva Beispiel").evaluate((element) => {
      element.dataset.probe = "mounted";
    });
    transport.change = undefined;
    await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
    await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
    // The same canonical entries come back; the row stays mounted, its stale error and retry do not.
    expect(await row(page, "Eva Beispiel").getAttribute("data-probe")).toBe("mounted");
    // announce() installs a persistent empty assertive region outside the editor.
    expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    expect(await level(page, "Eva Beispiel").textContent()).toBe("Zugriff verwalten");
    // A confirmed change elsewhere keeps its confirmation.
    await row(page, "Buchhaltung").getByText("Gespeichert", { exact: true }).waitFor();
    await changeLevel(page, "Eva Beispiel", "Nutzen");
    await row(page, "Eva Beispiel").getByText("Gespeichert", { exact: true }).waitFor();
    expect(posts(transport).map((request) => request.change)).toEqual([
      { action: "update", accessId: "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa", permission: "admin" },
      { action: "update", accessId: "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa", permission: "read" },
      { action: "update", accessId: "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa", permission: "read" },
    ]);
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST", "GET", "GET", "POST", "GET"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

test("an add that someone else already saved recovers through canonical reload without a stale retry", async () => {
  const { page, transport, errors } = await open(768, "normal", (transport) => {
    transport.change = async (change) => {
      if (change.action !== "grant") return undefined;
      transport.state.entries.push({
        id: "00000006-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: change.principal,
        displayName: fixtureEntity.user.displayName,
        permission: "read",
        createdAt: "2026-10-22T12:00:00.000Z",
      });
      return "reject";
    };
  });
  try {
    await page.getByRole("combobox").first().fill("Lea");
    await page.getByRole("option", { name: /Lea Fiktiv/ }).click();
    await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
    await page.getByRole("alert").getByText("Dieser Eintrag hat schon Zugriff.", { exact: false }).first().waitFor();
    await row(page, "Lea Fiktiv").waitFor();
    transport.change = undefined;
    await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
    await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
    // announce() installs a persistent empty assertive region outside the editor.
    expect(await page.getByRole("region", { name: "Zugriff", exact: true }).getByRole("alert").allTextContents()).toEqual([]);
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    // The stale selection is gone with it; the search is ready for the next person.
    expect(await page.getByRole("button", { name: /^Auswahl entfernen:/ }).count()).toBe(0);
    expect(await page.locator("input[role=combobox]").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Hinzufügen", exact: true }).isDisabled()).toBe(true);
    expect(await row(page, "Lea Fiktiv").count()).toBe(1);
    expect(posts(transport)).toHaveLength(1);
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

test("a refused request offers the canonical list instead of repeating itself", async () => {
  const { page, transport, errors } = await open(1440, "normal", (transport) => {
    transport.change = async () => "bad-input";
  });
  try {
    await changeLevel(page);
    await page.getByRole("alert").getByText("Nicht gespeichert.", { exact: false }).first().waitFor();
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    transport.change = undefined;
    await page.getByRole("button", { name: "Erneut laden", exact: true }).click();
    await page.getByRole("button", { name: "Erneut laden", exact: true }).waitFor({ state: "hidden" });
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(0);
    expect(await level(page).textContent()).toBe("Nutzen");
    expect(posts(transport)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);

test("removing a row moves focus to the next row instead of the page", async () => {
  const { page, transport, errors } = await open(1440, "normal");
  try {
    const remove = page.getByRole("button", { name: "Buchhaltung entfernen", exact: true });
    await remove.focus();
    await page.keyboard.press("Enter");
    await row(page, "Buchhaltung").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Monatsabschluss entfernen");
    expect(posts(transport).map((request) => request.change)).toEqual([
      { action: "revoke", accessId: "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 20_000);
