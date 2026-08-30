import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "grids-public-document-page-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { PublicDocumentShare } = await import("./page");

describe("public document share page", () => {
  test("uses the shared minimal Cloud root instead of fixing the page to light mode", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();

    expect(source).toContain("<MinimalLayout c={c}>");
    expect(source).not.toContain('c.get("page").theme = "light"');
    expect(source).not.toContain("<LocaleProvider");
  });

  test("uses shared UI without application chrome and explains expiry", () => {
    const html = renderToString(() =>
      createComponent(PublicDocumentShare, {
        filename: "charge-statement.pdf",
        expiresAt: "2026-08-20T18:00:00.000Z",
        expiresAtLabel: "August 20, 2026 at 8:00 PM",
        downloadHref: "/share/grids/documents/gdl_test/download",
      }),
    );

    expect(html).toContain("k2b-paper");
    expect(html).toContain("k2b-notice-card");
    expect(html).toContain("k2b-button");
    expect(html).toContain("charge-statement.pdf");
    expect(html).toContain("Link expires in");
    expect(html).toContain("August 20, 2026 at 8:00 PM");
    expect(html).toContain("/share/grids/documents/gdl_test/download");
    expect(html).toContain("Shared securely through Grids");
    expect(html).not.toContain("Shared PDF");
    expect(html).not.toContain("A document was shared with you through Grids.");
    expect(html).not.toContain("w-full justify-center");
    expect(html).not.toContain("AppWorkspace");
  });

  test("renders a minimal unavailable state without a download action", () => {
    const html = renderToString(() => createComponent(PublicDocumentShare, {}));

    expect(html).toContain('data-tone="warning"');
    expect(html).toContain("Link no longer available");
    expect(html).toContain("This document link has expired or was revoked.");
    expect(html).not.toContain("charge-statement.pdf");
    expect(html).not.toContain("Download PDF");
  });
});
