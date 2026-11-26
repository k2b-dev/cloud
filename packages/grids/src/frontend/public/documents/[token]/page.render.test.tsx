import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "grids-public-document-page-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { PublicDocumentShare } = await import("./PublicDocumentShare");

describe("public document share page", () => {
  test("uses the shared minimal Cloud root on v2 instead of fixing the page to light mode", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();

    expect(source).toContain('<MinimalLayout c={c} ui="v2">');
    expect(source).not.toContain('c.get("page").theme = "light"');
    expect(source).not.toContain("<LocaleProvider");
  });

  const shared = () =>
    renderToString(() =>
      createComponent(PublicDocumentShare, {
        filename: "charge-statement.pdf",
        mimeType: "application/pdf",
        expiresAt: "2026-08-20T18:00:00.000Z",
        expiresAtLabel: "August 20, 2026 at 8:00 PM",
        downloadHref: "/share/grids/documents/gdl_test/download",
      }),
    );

  test("names the file in the head with its one task and says how long the link lasts", () => {
    const html = shared();
    expect(html).toContain('data-k2-part="Workspace"');
    expect(html).toContain('data-k2-part="RecordHead"');
    expect(html).toContain("charge-statement.pdf");
    expect(html).toContain('href="/share/grids/documents/gdl_test/download"');
    expect(html).toContain("Download file");
    expect(html).toContain("Link expires in");
    expect(html).toContain("August 20, 2026 at 8:00 PM");
    expect(html).toContain("Shared securely through Grids");
    expect(html).toContain('data-name="file-type-pdf"');
    // no v1 card, no application chrome
    expect(html).not.toContain("k2b-paper");
    expect(html).not.toContain("AppWorkspace");
  });

  test("an expired or revoked link says so in one sentence, without a download", () => {
    const html = renderToString(() => createComponent(PublicDocumentShare, {}));
    expect(html).toContain("Link no longer available");
    expect(html).toContain("This document link has expired or was revoked.");
    expect(html).toContain('data-k2-part="Empty"');
    expect(html).not.toContain("Download file");
  });

  test("a non-PDF share names its format", () => {
    const html = renderToString(() =>
      createComponent(PublicDocumentShare, {
        filename: "payments.csv",
        mimeType: "text/csv",
        expiresAt: "2026-08-20T18:00:00.000Z",
        expiresAtLabel: "August 20, 2026 at 8:00 PM",
        downloadHref: "/share/grids/documents/gdl_test/download",
      }),
    );
    expect(html).toContain("payments.csv");
    expect(html).toContain("CSV");
  });
});
