import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MinimalLayoutProps } from "@k2b/cloud/ssr";

const root = mkdtempSync(resolve(tmpdir(), "mail-public-attachment-page-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: PublicAttachmentUnlockPage } = await import("./PublicAttachmentUnlockPage");

const page: { theme?: "light" | "dark" } = {};
const c = {
  get: (key: string) => (key === "page" ? page : {}),
  req: { raw: { headers: new Headers({ Cookie: "theme=dark", "Accept-Language": "de-CH" }), url: "https://cloud.test/share/mail" } },
} as unknown as MinimalLayoutProps["c"];

describe("public attachment unlock page", () => {
  test("uses semantic shared UI and the minimal preference root without leaking a hidden filename", () => {
    const html = renderToString(() =>
      createComponent(PublicAttachmentUnlockPage, {
        byteLength: 2048,
        c,
        error: "Das Passwort ist falsch.",
        filename: null,
        locale: "de-CH",
      }),
    );

    expect(page.theme).toBe("dark");
    expect(html).toContain("<main");
    expect(html).toContain("<section");
    expect(html).toContain("<header");
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="password"');
    expect(html).toContain("2 KB · Gib das Passwort ein");
    expect(html).toContain("minimal-layout-preferences--bottom-right");
    expect(html).toContain("Darstellung und Sprache");
    expect(html).not.toContain("private-name.txt");
    expect(html).not.toContain("<style>");
  });
});
