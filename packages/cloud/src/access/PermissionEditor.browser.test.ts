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

const render = (locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(PermissionEditor, {
          initialEntries: entries,
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

const measure = async (width: number, locale: string) => {
  const tab = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await tab.setContent(
      `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"><div style="padding:16px">${render(locale)}</div></body></html>`,
    );
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
