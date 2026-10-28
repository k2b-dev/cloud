import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import type { AccessEntry } from "../contracts/shared";

// Whether a long name and its kind label share one line depends on the real layout engine.
const root = mkdtempSync(resolve(tmpdir(), "cloud-permission-editor-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: PermissionEditor } = await import("./PermissionEditor");
const { LocaleProvider } = await import("@k2b/ui");

const longName = "Nightly release and dependency update agent";
const entries = (
  [
    { principal: { type: "user", userId: "user" }, displayName: longName },
    { principal: { type: "service_account", serviceAccountId: "agent" }, displayName: longName, serviceAccountKind: "agent" },
    { principal: { type: "service_account", serviceAccountId: "bound" }, displayName: longName, serviceAccountKind: "resource_bound" },
    { principal: { type: "public" } },
  ] satisfies Omit<AccessEntry, "id" | "permission" | "createdAt">[]
).map((entry, index): AccessEntry => ({ id: `access-${index}`, permission: "read", createdAt: "2026-09-30T00:00:00.000Z", ...entry }));

const render = (locale: string, initialEntries: AccessEntry[] = entries, expanded = false) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PermissionEditor, {
          expanded,
          ownEntryIds: expanded ? [initialEntries[0]!.id] : undefined,
          initialEntries,
          allowPublic: true,
          allowServiceAccounts: true,
          grantAccess: async () => {
            throw new Error("Not used by this layout test.");
          },
          updateAccess: async () => {},
          revokeAccess: async () => {},
        });
      },
    }),
  );

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };

const buildHarness = async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "PermissionEditor.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-permission-editor-test",
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
  if (!build.success) throw new AggregateError(build.logs, "PermissionEditor harness build failed");
  return build.outputs[0]!.text();
};
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  harness = await buildHarness();
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  icons = { css: source.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, locale: string, initialEntries?: AccessEntry[], expanded = false) => {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  await tab.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div style="padding:16px">${render(locale, initialEntries, expanded)}</div></body></html>`,
  );
  await settled(tab);
  return tab;
};

const measure = async (width: number, locale: string) => {
  const tab = await open(width, locale);
  try {
    return await tab.evaluate(() =>
      Array.from(document.querySelectorAll(".group\\/access-row")).map((row) => {
        const texts = Array.from(row.children[1]!.children) as HTMLElement[];
        return {
          height: row.getBoundingClientRect().height,
          overflow: row.children[1]!.scrollWidth - row.children[1]!.clientWidth,
          parts: texts.map((text) => ({ text: text.textContent, whole: text.scrollWidth <= text.clientWidth })),
        };
      }),
    );
  } finally {
    await tab.close();
  }
};

describe("PermissionEditor rows in a browser", () => {
  test("keep name and kind on one line on the narrowest phone", async () => {
    const rows = await measure(320, "de");
    expect(rows).toHaveLength(entries.length);
    for (const row of rows) {
      expect(row.height).toBe(rows[0]!.height);
      expect(row.overflow).toBeLessThanOrEqual(0);
    }
    // A short label stays whole next to a long name.
    expect(rows[1]!.parts).toEqual([
      { text: longName, whole: false },
      { text: "(Agent)", whole: true },
    ]);
  });

  test("show every name and label in full when there is room", async () => {
    for (const row of await measure(1024, "de")) {
      for (const part of row.parts) expect(part).toMatchObject({ whole: true });
    }
  });
});

describe("PermissionEditor last manager in a browser", () => {
  const manager = (id: string, displayName: string): AccessEntry => ({
    id,
    principal: { type: "user", userId: id },
    permission: "admin",
    createdAt: "2026-10-06T00:00:00.000Z",
    displayName,
  });
  const firstRow = async (width: number, initialEntries: AccessEntry[]) => {
    const tab = await open(width, "de", initialEntries);
    try {
      return await tab.evaluate(() => {
        const row = document.querySelector(".group\\/access-row")!;
        const rect = (element: Element | null) => {
          const box = element!.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        const remove = row.querySelector<HTMLButtonElement>("button[aria-label$='entfernen']");
        return { row: rect(row), level: rect(row.querySelector("[aria-haspopup=menu]")), remove: rect(remove), disabled: remove!.disabled };
      });
    } finally {
      await tab.close();
    }
  };

  test("locks the only manager's row without moving anything", async () => {
    for (const width of [320, 1024]) {
      const locked = await firstRow(width, [manager("qdt", "Quentin Dorn")]);
      const free = await firstRow(width, [manager("qdt", "Quentin Dorn"), manager("lym", "Lya Meyer")]);
      expect(locked.disabled).toBe(true);
      expect(free.disabled).toBe(false);
      expect({ ...locked, disabled: undefined }).toEqual({ ...free, disabled: undefined });
    }
  });

  for (const width of [320, 390, 768, 1440]) {
    test(`${width}px: expanded rows explain the last-manager lock and keep a 36px remove control with status before the desktop select`, async () => {
      const tab = await open(width, "de", [manager("qdt", "Quentin Dorn"), entries[1]!], true);
      try {
        for (const dark of [false, true]) {
          await tab.evaluate((enabled) => document.documentElement.classList.toggle("dark", enabled), dark);
          await settled(tab);
          const row = tab.locator(".group\\/access-row").first();
          const remove = row.getByRole("button", { name: "Quentin Dorn entfernen", exact: true });
          expect(await remove.isDisabled()).toBe(true);
          const box = await remove.boundingBox();
          expect(box?.width).toBe(36);
          expect(box?.height).toBe(36);
          expect(await row.textContent()).toContain("Person · du");
          const explanation = row
            .locator("..")
            .getByRole("paragraph")
            .filter({ hasText: /Gib zuerst einer anderen Person oder Gruppe/ });
          expect(await explanation.isVisible()).toBe(true);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const status = (await row.getByRole("status").boundingBox())!;
          const select = (await row.getByRole("combobox").boundingBox())!;
          if (width >= 640) expect(status.x + status.width).toBeLessThanOrEqual(select.x);
          else expect(status.y).toBeGreaterThan(box!.y);
        }
      } finally {
        await tab.close();
      }
    });
  }
});

describe("PermissionEditor group coverage in a browser", () => {
  const groupEntries = (name: string): AccessEntry[] => [
    {
      id: "user",
      principal: { type: "user", userId: "user" },
      permission: "admin",
      createdAt: "2026-10-07T00:00:00.000Z",
      displayName: "Quentin Dorn",
    },
    {
      id: "group",
      principal: { type: "group", groupId: "33333333-3333-4333-8333-333333333333" },
      permission: "read",
      createdAt: "2026-10-07T00:00:00.000Z",
      displayName: name,
    },
  ];

  // Loading the members changes nothing in the row (see the behavior test), so the server-rendered layout is final.
  for (const [nameKind, name] of [
    ["long group", "Studierendenvertretung Vorstand"],
    ["unbroken group", longName],
  ] as const) {
    for (const [width, locale] of [
      [320, "de"],
      [375, "de"],
      [390, "en"],
      [1024, "de"],
    ] as const) {
      test(`${nameKind}, ${width}px, ${locale}: the members toggle stays whole`, async () => {
        const tab = await open(width, locale, groupEntries(name));
        try {
          const layout = await tab.evaluate(() => {
            const rows = Array.from(document.querySelectorAll(".group\\/access-row"));
            const group = rows[1]!;
            const texts = group.children[1]!;
            const toggle = group.querySelector<HTMLElement>("button[aria-controls]:not([aria-haspopup])")!;
            const label = toggle.querySelector("span")!;
            const nameElement = texts.children[0]!;
            return {
              heights: rows.map((row) => row.getBoundingClientRect().height),
              entry: group.parentElement!.getBoundingClientRect().height,
              overflow: texts.scrollWidth - texts.clientWidth,
              label: label.textContent,
              labelWhole: label.scrollWidth <= label.clientWidth,
              toggleInside: toggle.getBoundingClientRect().right <= texts.getBoundingClientRect().right,
              nameWhole: nameElement.scrollWidth <= nameElement.clientWidth,
            };
          });
          expect(layout.heights[1]).toBe(layout.heights[0]!);
          // The collapsed member list takes no room.
          expect(layout.entry).toBe(layout.heights[1]!);
          expect(layout.overflow).toBeLessThanOrEqual(0);
          expect(layout.label).toBe(locale === "de" ? "Mitglieder" : "Members");
          expect(layout).toMatchObject({ labelWhole: true, toggleInside: true });
          if (width === 1024) expect(layout.nameWhole).toBe(true);
        } finally {
          await tab.close();
        }
      });
    }
  }
});

const openHarness = async (width: number, confirmation?: "immediate" | "delayed") => {
  const tab = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  // Confirmation cases observe native focus-return frames and use only fixed fixture timestamps.
  if (!confirmation) await tab.clock.setFixedTime(new Date("2026-10-17T12:00:00.000Z"));
  const origin = "https://permission-editor.test";
  await tab.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/tabler.woff2") return route.fulfill({ path: icons.font });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: icons.css });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui"><div id="root" style="padding:16px;max-width:48rem"></div></body></html>`,
    });
  });
  await tab.goto(confirmation ? `${origin}/?confirmation=${confirmation}` : origin);
  await tab.addScriptTag({ content: harness });
  await settled(tab);
  return tab;
};

describe("PermissionEditor pending layout and focus", () => {
  for (const confirmation of ["immediate", "delayed"] as const) {
    test(`${confirmation} confirmation: cancellation returns focus while beforeChange is still pending`, async () => {
      const tab = await openHarness(390, confirmation);
      try {
        const opener = tab.getByRole("button", { name: "Remove Lea Sommer", exact: true });
        await opener.focus();
        await opener.press("Enter");
        await tab.waitForFunction(() => document.documentElement.dataset.confirming === "true");
        expect(await opener.isEnabled()).toBe(true);
        if (confirmation === "delayed") {
          expect(await tab.locator("dialog[open]").count()).toBe(0);
          expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
          await tab.evaluate(() => document.dispatchEvent(new Event("open-access-confirmation")));
        }
        const dialog = tab.getByRole("dialog", { name: "Confirm access", exact: true });
        await dialog.waitFor();
        expect(await opener.isEnabled()).toBe(true);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await tab.waitForFunction(() => document.documentElement.dataset.confirmationClosed === "true");
        // Dialog close schedules focus once. The callback must remain unresolved across that actual frame.
        await tab.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        expect(await opener.isEnabled()).toBe(true);
        expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await tab.evaluate(() => document.documentElement.dataset.confirming)).toBe("true");
        expect(await tab.evaluate(() => Number(document.documentElement.dataset.writes ?? 0))).toBe(0);
        await tab.evaluate(() => document.dispatchEvent(new Event("settle-access-confirmation")));
        await tab.waitForFunction(() => document.documentElement.dataset.confirming === undefined);
        expect(await tab.evaluate(() => Number(document.documentElement.dataset.writes ?? 0))).toBe(0);
        expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
      } finally {
        await tab.close();
      }
    });
  }

  for (const width of [390, 1280]) {
    test(`${width} px: a pending update keeps every control, box, and keyboard return target`, async () => {
      const tab = await openHarness(width);
      try {
        const controls = tab.locator("button.k2b-select-chip");
        await controls.first().waitFor();
        await tab.evaluate(() => document.fonts.ready);
        const originals = await controls.elementHandles();
        const measure = () =>
          tab.evaluate(() =>
            Array.from(document.querySelectorAll(".group\\/access-row"), (row) => {
              // A badge in place of a picker is deliberately measured too, so the old implementation fails.
              const control = row.querySelector("button.k2b-select-chip, span.cursor-default")!;
              const box = (element: Element) => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              };
              return { tag: control.tagName, class: control.className, row: box(row), control: box(control) };
            }),
          );
        const before = await measure();
        expect(before).toHaveLength(3);
        await controls.nth(1).focus();
        await tab.keyboard.press("Enter");
        await tab.getByRole("menuitemradio", { name: "Level 2", exact: true }).press("Enter");
        await tab.waitForFunction(() => document.documentElement.dataset.saving === "true");
        expect(await measure()).toEqual(before);
        expect(await controls.nth(1).textContent()).toBe("Level 2");
        expect(await controls.evaluateAll((elements) => elements.every((element) => (element as HTMLButtonElement).disabled))).toBe(true);
        for (let index = 0; index < originals.length; index++) {
          expect(
            await originals[index]!.evaluate((element, i) => element === document.querySelectorAll("button.k2b-select-chip")[i], index),
          ).toBe(true);
        }
        await tab.evaluate(() => document.dispatchEvent(new Event("settle-access")));
        await tab.waitForFunction(() => document.querySelector(".group\\/access-row[aria-busy]") === null);
        expect(await measure()).toEqual(before);
        expect(await controls.evaluateAll((elements) => elements.every((element) => !(element as HTMLButtonElement).disabled))).toBe(true);
        expect(await controls.nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
        for (let index = 0; index < originals.length; index++) {
          expect(
            await originals[index]!.evaluate((element, i) => element === document.querySelectorAll("button.k2b-select-chip")[i], index),
          ).toBe(true);
        }
      } finally {
        await tab.close();
      }
    }, 20_000);
  }
});

describe("PermissionEditor consumer refetch focus", () => {
  for (const width of [390, 1280]) {
    test(`${width} px: keyboard focus survives a consumer refetch with an external change`, async () => {
      const tab = await openHarness(width);
      try {
        const chips = tab.locator("button.k2b-select-chip");
        await chips.nth(1).focus();
        await chips.nth(1).evaluate((chip) => {
          chip.setAttribute("data-original-chip", "true");
        });
        await tab.keyboard.press("Enter");
        await tab.keyboard.press("End");
        await tab.keyboard.press("Enter");
        await tab.waitForFunction(() => document.documentElement.dataset.saving === "true");
        await tab.evaluate(() => document.dispatchEvent(new Event("settle-access")));
        await tab.waitForFunction(() => document.querySelector(".group\\/access-row[aria-busy]") === null);
        await tab.waitForFunction(() => document.activeElement?.hasAttribute("data-original-chip") === true);
        await tab.evaluate(() => document.dispatchEvent(new Event("refetch-access")));
        await tab.waitForFunction(() => document.querySelectorAll("button.k2b-select-chip")[2]?.textContent === "Level 2");
        expect(await chips.nth(1).textContent()).toBe("Level 2");
        expect(await tab.evaluate(() => document.activeElement === document.querySelector("[data-original-chip]"))).toBe(true);
        expect(await chips.nth(1).getAttribute("data-original-chip")).toBe("true");
      } finally {
        await tab.close();
      }
    }, 20_000);
  }
});
