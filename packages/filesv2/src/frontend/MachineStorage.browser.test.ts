import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Route } from "playwright";

type Fixture = (route: Route) => Promise<void>;

import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";

const ui = new URL("../../../ui/", import.meta.url).pathname;
const hostCss = await appHostCss(new URL("../styles/app.css", import.meta.url).pathname);

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MachineStorage.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-machine-storage-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Machine storage harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // Compile the app and root shell in the same order as a Cloud page.
  "/styles.css": ["text/css", hostCss],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1366, height: 768 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, theme: "light" | "dark", lang: string, fixture: Fixture) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://machine-storage.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) return fixture(route);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://machine-storage.test/");
  await tab.getByText(lang === "de" ? "Maschinenablagen" : "Machine storage", { exact: true }).waitFor();
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const owner = { id: "10000000-0000-4000-8000-000000000001", name: "Atlas document processing agent", kind: "agent" as const };
const storage = { id: "20000000-0000-4000-8000-000000000001", baseId: `cloud:users:${owner.id}`, owner, area: "cloud", state: "active" };
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const entities = { items: [{ kind: "service_account", serviceAccount: { ...owner, appId: null, resourceType: null, resourceId: null } }] };
describe("Machine storage settings", () => {
  for (const mode of ["picker", "button"] as const) {
    test(`a Code handle through the storage share ${mode} uses the exact managed storage target`, async () => {
      const handle = "code-7k2q9m4xwt",
        accountId = "40000000-0000-4000-8000-000000000001";
      const requests: URL[] = [];
      let granted = false;
      let attempts = 0;
      const saving = Promise.withResolvers<void>();
      const entry = {
        id: "50000000-0000-4000-8000-000000000001",
        principal: { type: "service_account", serviceAccountId: accountId },
        permission: "read",
        path: "",
        displayName: "Code of Snapshot",
        serviceAccountKind: "code",
      };
      const { context, tab } = await open(
        mode === "button" ? phone : desktop,
        mode === "button" ? "dark" : "light",
        mode === "button" ? "de" : "en",
        async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/api/accounts/entities") {
            requests.push(url);
            return json(route, {
              items: [{ kind: "service_account", serviceAccount: { id: accountId, name: entry.displayName, kind: "code", handle } }],
            });
          }
          if (url.pathname.endsWith("/grants")) {
            if (route.request().method() === "POST") {
              expect(route.request().postDataJSON()).toEqual({ principal: entry.principal, path: "", permission: "read" });
              if (++attempts === 1 && mode === "button") {
                await saving.promise;
                return json(route, { code: "unavailable", message: "Grant fixture unavailable" }, 503);
              }
              granted = true;
              return json(route, entry);
            }
            return json(route, { items: granted ? [entry] : [], next: null });
          }
          return json(route, { items: [storage], next: null });
        },
      );
      try {
        await tab.locator("summary").filter({ hasText: owner.name }).click();
        if (mode === "button") {
          const add = tab.getByRole("button", { name: "Dienstkonto hinzufügen", exact: true });
          await add.waitFor();
          expect(await add.count()).toBe(1);
          await add.click();
          // As in the shared dialog: the complete handle is looked up as it is pasted, without a search step.
          await tab.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true }).fill(handle);
          const hit = tab.locator("button", { hasText: entry.displayName });
          await hit.waitFor();
          expect(await tab.getByRole("button", { name: "Suchen", exact: true }).count()).toBe(0);
          expect(await tab.getByRole("button", { name: "Hinzufügen", exact: true }).count()).toBe(0);
          // Enter in the field adds the hit, as in the dialog.
          await tab.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true }).press("Enter");
          // While the grant saves, the field holds, so a second handle cannot replace the first.
          await tab.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true, disabled: true }).waitFor();
          expect(await hit.isDisabled()).toBe(true);
          saving.resolve();
          await tab.getByRole("alert").filter({ hasText: "Grant fixture unavailable" }).waitFor();
          // A failed save keeps the handle and the hit and returns focus to the field, so Enter retries.
          await tab.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Kennung des Dienstkontos");
          expect(await tab.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true }).inputValue()).toBe(handle);
          await tab.keyboard.press("Enter");
        } else {
          await tab.getByRole("combobox").last().fill(handle);
          await tab.getByRole("option").filter({ hasText: entry.displayName }).click();
        }
        // The added Code account lands in its own section, not among the folder grants.
        const accounts = tab.locator("section.k2b-panel-dialog__section", {
          has: tab.locator("h3", { hasText: mode === "button" ? "Dienstkonten" : "Service accounts" }),
        });
        await accounts.locator("li[data-access-key]", { hasText: entry.displayName }).waitFor();
        expect(await accounts.locator("h3").textContent()).toBe(mode === "button" ? "Dienstkonten 1" : "Service accounts 1");
        expect(await tab.getByRole("button", { name: mode === "button" ? "Entziehen" : "Revoke", exact: true }).count()).toBe(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.searchParams.get("target_type")).toBe("filesv2.storage");
        expect(requests[0]!.searchParams.get("target_id")).toBe(storage.id);
        expect(granted).toBe(true);
        expect(attempts).toBe(mode === "button" ? 2 : 1);
        expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
      } finally {
        saving.resolve();
        await context.close();
      }
    });
  }
  for (const [width, options] of [
    [1280, { viewport: { width: 1280, height: 800 } }],
    [390, phone],
  ] as const) {
    test(`de ${width}px: the handle hit shows the Code icon, its description and the Dienstkonto mark, as in the shared dialog`, async () => {
      const handle = "code-7k2q9m4xwt";
      const { context, tab } = await open(options, "light", "de", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/accounts/entities")
          return json(route, {
            items: [
              {
                kind: "service_account",
                serviceAccount: {
                  id: "40000000-0000-4000-8000-000000000001",
                  name: "Code von info@beispiel.de",
                  kind: "code",
                  handle,
                  description: "Dienstkonto eines Postfachs",
                },
              },
            ],
          });
        if (url.pathname.endsWith("/grants")) return json(route, { items: [], next: null });
        return json(route, { items: [storage], next: null });
      });
      try {
        await tab.locator("summary").filter({ hasText: owner.name }).click();
        await tab.getByRole("button", { name: "Dienstkonto hinzufügen", exact: true }).click();
        const field = tab.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true });
        expect(await field.getAttribute("placeholder")).toBe("Kennung von der Code-Seite, etwa code-7k2q9m4xwt");
        // The field carries the Code icon, like the dialog's.
        expect(await field.evaluate((input) => Boolean(input.closest(".k2b-input-shell")?.querySelector(".ti-code")))).toBe(true);
        await field.fill(handle);
        const hit = tab.locator("button", { hasText: "Code von info@beispiel.de" });
        await hit.waitFor();
        expect(await hit.locator(".ti-code").count()).toBe(1);
        await hit.getByText("Dienstkonto eines Postfachs", { exact: true }).waitFor();
        await hit.getByText("Dienstkonto", { exact: true }).waitFor();
        const box = await hit.boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
        expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
        if (process.env.SHOTS) {
          await hit.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-dienst-hinzu-${width}.png` });
        }
      } finally {
        await context.close();
      }
    });
  }
  // Mockup v31 `editor · A`, the section Dienstkonten as in every share dialog (concept v28 9.1, 9.4, 14 W14).
  const accountsSection = (tab: import("playwright").Page) =>
    tab.locator("section.k2b-panel-dialog__section", { has: tab.locator("h3", { hasText: "Dienstkonten" }) });
  const mailboxCode = {
    id: "60000000-0000-4000-8000-000000000001",
    principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000011" },
    permission: "write",
    path: "berichte",
    displayName: "Code von einkauf@beispiel.de",
    serviceAccountKind: "code",
    serviceAccountDescription: "Dienstkonto eines Postfachs",
    serviceAccountHref: "/app/mail/Mb4kd2/code",
  };
  const appCode = {
    id: "60000000-0000-4000-8000-000000000002",
    principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000012" },
    permission: "read",
    path: "",
    displayName: "Code von Werkstatt",
    serviceAccountKind: "code",
    serviceAccountDescription: "Dienstkonto einer App",
  };
  const agentGrant = {
    id: "30000000-0000-4000-8000-000000000001",
    principal: { type: "service_account", serviceAccountId: owner.id },
    permission: "write",
    path: "reports",
    displayName: owner.name,
    serviceAccountKind: "agent",
  };
  /** Row tops within the page, so scrolling a control into view does not count as a move. */
  const rowTops = (tab: import("playwright").Page, names: string[]) =>
    tab.evaluate(
      (texts) =>
        texts.map((text) => {
          const page = document.querySelector(".k2b-settings-section")!.getBoundingClientRect().top;
          const row = Array.from(document.querySelectorAll("li, .rounded.border")).find((item) => item.textContent?.includes(text));
          return row ? Math.round(row.getBoundingClientRect().top - page) : -1;
        }),
      names,
    );
  for (const [width, options] of [
    [1280, { viewport: { width: 1280, height: 800 } }],
    [390, phone],
  ] as const) {
    test(`de ${width}px normal: Code accounts have their own section with count, rows as the server says, and the note`, async () => {
      let grants: Record<string, unknown>[] = [agentGrant, mailboxCode, appCode];
      const saving = Promise.withResolvers<void>();
      const posts: unknown[] = [];
      const { context, tab } = await open(options, "light", "de", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/grants") && route.request().method() === "POST") {
          const input = route.request().postDataJSON();
          posts.push(input);
          await saving.promise;
          grants = grants.map((grant) => (grant.id === appCode.id ? { ...grant, permission: input.permission } : grant));
          return json(
            route,
            grants.find((grant) => grant.id === appCode.id),
          );
        }
        if (url.pathname.endsWith("/grants")) return json(route, { items: grants, next: null });
        return json(route, { items: [storage], next: null });
      });
      try {
        await tab.locator("summary").filter({ hasText: owner.name }).click();
        const section = accountsSection(tab);
        await section.locator("li[data-access-key]", { hasText: mailboxCode.displayName }).waitFor();
        expect(await section.locator("h3").textContent()).toBe("Dienstkonten 2");
        // The button stands beside the title, as in the dialog.
        expect(await section.locator("header button").innerText()).toBe("Dienstkonto hinzufügen");
        const mailbox = section.locator("li[data-access-key]", { hasText: mailboxCode.displayName });
        // The dialog's line from the server's description, then the path the grant covers.
        expect(await mailbox.getByText("Dienstkonto eines Postfachs · darf bearbeiten · berichte", { exact: true }).count()).toBe(1);
        expect(
          await mailbox
            .getByText("Dienstkonto eines Postfachs", { exact: false })
            .evaluate((line) => line.scrollWidth <= line.clientWidth + 1),
        ).toBe(true);
        expect(await mailbox.getByRole("link", { name: mailboxCode.displayName }).getAttribute("href")).toBe(
          mailboxCode.serviceAccountHref,
        );
        expect(await section.locator("li[data-access-key]", { hasText: appCode.displayName }).textContent()).toContain(
          "Dienstkonto einer App · darf ansehen · /",
        );
        expect(await section.locator("li[data-access-key]", { hasText: appCode.displayName }).getByRole("link").count()).toBe(0);
        // The whole level word fits its slot at every width, as in the dialog.
        for (const trigger of await section.locator("li[data-access-key] button[aria-haspopup]").all())
          expect(await trigger.locator(".k2b-choice-trigger__value").evaluate((value) => value.scrollWidth <= value.clientWidth)).toBe(
            true,
          );
        await section
          .getByText(
            `Code läuft als Dienstkonto seines Objekts. Wer „Ablage von ${owner.name}“ verwaltet, gibt ihm hier Zugriff wie einer Person. Wer den Code bearbeitet, handelt mit diesem Recht.`,
            { exact: true },
          )
          .waitFor();
        // The folder grants keep people, groups and agents only, without a Dienstkonto mark.
        expect(await tab.getByRole("button", { name: "Entziehen", exact: true }).count()).toBe(1);
        expect(await tab.locator(".k2b-status-badge", { hasText: "Dienstkonto" }).count()).toBe(0);
        if (process.env.SHOTS) {
          await section.scrollIntoViewIfNeeded();
          await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-dienst-normal-${width}.png` });
        }

        // The level menu offers View and Edit in the dialog's words, never Manage, and saving moves no row.
        const names = [owner.name, mailboxCode.displayName, appCode.displayName];
        await settled(tab);
        const before = await rowTops(tab, names);
        const trigger = section
          .locator("li[data-access-key]", { hasText: appCode.displayName })
          .getByRole("button", { name: `Stufe für ${appCode.displayName}` });
        await trigger.click();
        const choices = tab.locator('[role="dialog"] [role="radio"]');
        await choices.first().waitFor();
        expect(await choices.allInnerTexts()).toEqual([expect.stringContaining("Ansehen"), expect.stringContaining("Bearbeiten")]);
        expect(await tab.locator('[role="dialog"]').textContent()).not.toContain("Verwalten");
        await choices.filter({ hasText: "Bearbeiten" }).click();
        await tab.locator("[role=status]", { hasText: "Maschinenablagen werden geladen…" }).waitFor();
        await settled(tab);
        expect(await rowTops(tab, names)).toEqual(before);
        saving.resolve();
        await section
          .locator("li[data-access-key]", { hasText: appCode.displayName })
          .getByText("darf bearbeiten", { exact: false })
          .waitFor();
        await tab.locator("[role=status]", { hasText: "Maschinenablagen werden geladen…" }).waitFor({ state: "detached" });
        await settled(tab);
        expect(await rowTops(tab, names)).toEqual(before);
        expect(posts).toEqual([{ principal: appCode.principal, path: "", permission: "write" }]);
        // The row keeps its controls across the save, and focus returns to its level.
        await tab.waitForFunction(
          (label) => document.activeElement?.getAttribute("aria-label") === label,
          `Stufe für ${appCode.displayName}`,
        );
        expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
      } finally {
        saving.resolve();
        await context.close();
      }
    });

    test(`de ${width}px leer, dienst-neu: the empty text, then a handle adds the account under Dienstkonten`, async () => {
      const handle = "code-7k2q9m4xwt";
      const added = {
        id: "60000000-0000-4000-8000-000000000003",
        principal: { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000013" },
        permission: "write",
        path: "",
        displayName: "Code von info@beispiel.de",
        serviceAccountKind: "code",
        serviceAccountDescription: "Dienstkonto eines Postfachs",
      };
      let grants: Record<string, unknown>[] = [agentGrant];
      const posts: unknown[] = [];
      const { context, tab } = await open(options, "light", "de", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/accounts/entities")
          return json(route, {
            items: [
              {
                kind: "service_account",
                serviceAccount: {
                  id: added.principal.serviceAccountId,
                  name: added.displayName,
                  kind: "code",
                  handle,
                  description: "Dienstkonto eines Postfachs",
                },
              },
            ],
          });
        if (url.pathname.endsWith("/grants") && route.request().method() === "POST") {
          posts.push(route.request().postDataJSON());
          grants = [...grants, added];
          return json(route, added);
        }
        if (route.request().method() === "DELETE") {
          grants = grants.filter((grant) => !url.pathname.endsWith(`/${grant.id}`));
          return json(route, { deleted: true });
        }
        if (url.pathname.endsWith("/grants")) return json(route, { items: grants, next: null });
        return json(route, { items: [storage], next: null });
      });
      try {
        await tab.locator("summary").filter({ hasText: owner.name }).click();
        const section = accountsSection(tab);
        await section.waitFor();
        expect(await section.locator("h3").textContent()).toBe("Dienstkonten 0");
        await section
          .getByText("Noch kein Dienstkonto. Code eines Postfachs oder einer Base bekommt hier Zugriff wie eine Person.", { exact: true })
          .waitFor();
        expect(await section.locator("li[data-access-key]").count()).toBe(0);
        if (process.env.SHOTS) {
          await section.scrollIntoViewIfNeeded();
          await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-dienst-leer-${width}.png` });
        }
        // Share chosen above stops at write for a service account, which never manages.
        await tab.getByRole("combobox", { name: "Berechtigung" }).click();
        await tab.getByRole("option", { name: "Lesen, schreiben und freigeben" }).click();
        await settled(tab);
        const before = await rowTops(tab, [owner.name]);
        await section.getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
        await section.getByRole("textbox", { name: "Kennung des Dienstkontos", exact: true }).fill(handle);
        const hit = section.locator("li button", { hasText: added.displayName });
        await hit.waitFor();
        // Opening the field moves no row above it.
        await settled(tab);
        expect(await rowTops(tab, [owner.name])).toEqual(before);
        if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-dienst-hinzu-feld-${width}.png` });
        await hit.click();
        const row = section.locator("li[data-access-key]", { hasText: added.displayName });
        await row.getByText("Dienstkonto eines Postfachs · darf bearbeiten · /", { exact: true }).waitFor();
        expect(await section.locator("h3").textContent()).toBe("Dienstkonten 1");
        expect(await section.getByRole("textbox", { name: "Kennung des Dienstkontos" }).count()).toBe(0);
        await section.getByText("Code läuft als Dienstkonto seines Objekts.", { exact: false }).waitFor();
        await settled(tab);
        expect(await rowTops(tab, [owner.name])).toEqual(before);
        expect(posts).toEqual([{ principal: added.principal, path: "", permission: "write" }]);
        expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
        if (process.env.SHOTS) {
          await section.scrollIntoViewIfNeeded();
          await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-dienst-neu-${width}.png` });
        }

        // Remove takes the grant away at once, as Revoke does; the section is empty again and focus stays in it.
        await row.getByRole("button", { name: `${added.displayName} entfernen` }).click();
        await row.waitFor({ state: "detached" });
        expect(await section.locator("h3").textContent()).toBe("Dienstkonten 0");
        await tab.waitForFunction(() => document.activeElement?.textContent?.includes("Dienstkonto hinzufügen"));
      } finally {
        await context.close();
      }
    });
  }
  test("loading, failure and retry preserve a working recovery path", async () => {
    const waiting = Promise.withResolvers<void>();
    let failed = true;
    const { context, tab } = await open(desktop, "light", "en", async (route) => {
      await waiting.promise;
      return failed ? json(route, { code: "unavailable", message: "Fixture unavailable" }, 503) : json(route, { items: [], next: null });
    });
    try {
      await tab.getByText("Loading machine storage…", { exact: true }).waitFor();
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-loading-desktop-light.png`, fullPage: true });
      waiting.resolve();
      await tab.getByText("Machine storage could not be loaded.", { exact: true }).waitFor();
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-error-desktop-light.png`, fullPage: true });
      failed = false;
      await tab.getByRole("button", { name: "Try again", exact: true }).click();
      await tab.getByText("No machine storage", { exact: true }).waitFor();
      expect(await tab.getByRole("button", { name: "Create storage", exact: true }).isDisabled()).toBe(true);
      if (process.env.SHOTS) await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-empty-desktop-light.png`, fullPage: true });
    } finally {
      waiting.resolve();
      await context.close();
    }
  });
  for (const action of ["create", "grant", "revoke"] as const) {
    test(`machine storage ${action} keeps its own pending, failure and success state`, async () => {
      let created = action !== "create";
      let createAttempts = 0,
        grantAttempts = 0;
      const creating = Promise.withResolvers<void>();
      let grants: {
        id: string;
        principal: { type: "service_account"; serviceAccountId: string };
        permission: string;
        path: string;
        displayName: string;
        serviceAccountKind: "agent";
      }[] =
        action === "revoke"
          ? [
              {
                id: "30000000-0000-4000-8000-000000000001",
                principal: { type: "service_account", serviceAccountId: owner.id },
                permission: "read",
                path: "reports",
                displayName: owner.name,
                serviceAccountKind: "agent",
              },
            ]
          : [];
      const { context, tab } = await open(phone, "dark", "en", async (route) => {
        const path = new URL(route.request().url()).pathname,
          method = route.request().method();
        if (path === "/api/accounts/entities") return json(route, entities);
        if (path.endsWith("/grants") && method === "POST") {
          if (++grantAttempts === 1) return json(route, { code: "unavailable", message: "Grant fixture unavailable" }, 503);
          const input = route.request().postDataJSON();
          expect(input).toEqual({
            principal: { type: "service_account", serviceAccountId: owner.id },
            path: "reports",
            permission: "read",
          });
          grants = [{ ...input, id: "30000000-0000-4000-8000-000000000001", displayName: owner.name, serviceAccountKind: "agent" }];
          return json(route, grants[0]);
        }
        if (method === "DELETE") {
          grants = [];
          return json(route, { deleted: true });
        }
        if (path.endsWith("/grants")) return json(route, { items: grants, next: null });
        if (method === "POST") {
          if (++createAttempts === 1) {
            await creating.promise;
            return json(route, { code: "unavailable", message: "Create fixture unavailable" }, 503);
          }
          expect(route.request().postDataJSON()).toEqual({ ownerId: owner.id, area: "cloud" });
          created = true;
          return json(route, storage);
        }
        return json(route, { items: created ? [storage] : [], next: null });
      });
      try {
        if (action === "create") {
          await tab.getByText("No machine storage", { exact: true }).waitFor();
          await tab.getByRole("combobox").first().fill("Atlas");
          await tab.getByRole("option").filter({ hasText: owner.name }).click();
          await tab.getByRole("button", { name: "Create storage", exact: true }).click();
          await tab.locator('button[aria-busy="true"]').waitFor();
          expect(await tab.getByRole("combobox").first().isDisabled()).toBe(true);
          creating.resolve();
          await tab.getByRole("alert").filter({ hasText: "Create fixture unavailable" }).waitFor();
          await tab.getByRole("button", { name: "Create storage", exact: true }).click();
          await tab.getByText("Storage created. Add an explicit grant below.", { exact: true }).waitFor();
          return;
        }
        await tab.locator("summary").filter({ hasText: owner.name }).click();
        if (action === "grant") {
          await tab.getByText("No access granted", { exact: true }).waitFor();
          await tab.getByRole("textbox", { name: "Relative path", exact: true }).fill("reports");
          await tab.getByRole("combobox").last().fill("Atlas");
          await tab.getByRole("option").filter({ hasText: owner.name }).click();
          await tab.getByRole("alert").filter({ hasText: "Grant fixture unavailable" }).waitFor();
          expect(await tab.getByRole("textbox", { name: "Relative path", exact: true }).inputValue()).toBe("reports");
          await tab.getByRole("combobox").last().fill("Atlas");
          await tab.getByRole("option").filter({ hasText: owner.name }).click();
          await tab.getByRole("button", { name: "Revoke", exact: true }).waitFor();
          expect(grantAttempts).toBe(2);
          return;
        }
        await tab.getByRole("button", { name: "Revoke", exact: true }).waitFor();
        await tab.getByRole("button", { name: "Revoke", exact: true }).click();
        await tab.getByText("No access granted", { exact: true }).waitFor();
      } finally {
        creating.resolve();
        await context.close();
      }
    });
  }
  test("ownership and grant states fit desktop, tablet and phone in both themes", async () => {
    for (const [device, options] of [
      ["desktop", desktop],
      ["tablet", { viewport: { width: 768, height: 1024 } }],
      ["phone", phone],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        const { context, tab } = await open(options, theme, "en", async (route) =>
          json(
            route,
            new URL(route.request().url()).pathname.endsWith("/grants")
              ? {
                  items: [
                    {
                      id: "30000000-0000-4000-8000-000000000001",
                      principal: { type: "service_account", serviceAccountId: owner.id },
                      displayName: owner.name,
                      serviceAccountKind: "agent",
                      permission: "write",
                      path: "reports/monthly/2026",
                    },
                  ],
                  next: null,
                }
              : {
                  items: [
                    storage,
                    {
                      ...storage,
                      id: "20000000-0000-4000-8000-000000000002",
                      owner: {
                        id: "10000000-0000-4000-8000-000000000002",
                        name: "Meridian scheduled export service account",
                        kind: "standalone",
                      },
                    },
                  ],
                  next: null,
                },
          ),
        );
        try {
          await tab.locator("summary").filter({ hasText: owner.name }).click();
          const revoke = tab.getByRole("button", { name: "Revoke", exact: true });
          await revoke.waitFor();
          const layout = await revoke.evaluate((button) => {
            const style = getComputedStyle(button.parentElement!);
            return { display: style.display, gap: Number.parseFloat(style.rowGap) };
          });
          // The captured app layout must include its compiled utilities.
          expect(layout.display).toBe("flex");
          expect(layout.gap).toBeGreaterThan(0);
          expect(await tab.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
          if (process.env.SHOTS)
            await tab.screenshot({ path: `${process.env.SHOTS}/files-machine-${device}-${theme}.png`, fullPage: true });
        } finally {
          await context.close();
        }
      }
    }
  }, 90000);
});
