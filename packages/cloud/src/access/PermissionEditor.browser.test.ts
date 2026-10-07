import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../ui/test/browser";
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

const render = (locale: string, initialEntries: AccessEntry[] = entries) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PermissionEditor, {
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
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, locale: string, initialEntries?: AccessEntry[]) => {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  await tab.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><div style="padding:16px">${render(locale, initialEntries)}</div></body></html>`,
  );
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
});

describe("PermissionEditor group coverage in a browser", () => {
  const groupEntries: AccessEntry[] = [
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
      displayName: longName,
    },
  ];

  test("the member count arrives without moving the row or its controls", async () => {
    for (const [width, locale] of [
      [320, "de"],
      [1024, "en"],
    ] as const) {
      const tab = await open(width, locale, groupEntries);
      try {
        const layout = () =>
          tab.evaluate(() => {
            const rows = Array.from(document.querySelectorAll(".group\\/access-row"));
            const rect = (element: Element | null) => {
              const box = element!.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            };
            const group = rows[1]!;
            return {
              heights: rows.map((row) => row.getBoundingClientRect().height),
              entry: rect(group.parentElement),
              level: rect(group.querySelector("[aria-haspopup=menu]")),
              remove: rect(group.querySelector("button[aria-label]:not([aria-haspopup]):not([aria-controls])")),
              overflow: group.children[1]!.scrollWidth - group.children[1]!.clientWidth,
            };
          });
        const before = await layout();
        // The server renders the plain label; the browser replaces it with the count once loaded.
        const label = await tab.evaluate(() => document.querySelector("button[aria-controls]:not([aria-haspopup]) span")!.textContent);
        expect(label).toBe(locale === "de" ? "Mitglieder" : "Members");
        await tab.evaluate(() => {
          document.querySelector("button[aria-controls]:not([aria-haspopup]) span")!.textContent = "1,234 members";
        });
        const after = await layout();
        expect(before.heights[1]).toBe(before.heights[0]!);
        // The collapsed member list takes no room.
        expect(before.entry.height).toBe(before.heights[1]!);
        expect(before.overflow).toBeLessThanOrEqual(0);
        expect(after).toEqual(before);
      } finally {
        await tab.close();
      }
    }
  });
});
