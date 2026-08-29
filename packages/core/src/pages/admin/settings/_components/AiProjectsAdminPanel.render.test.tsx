import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-ai-projects-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AiProjectsAdminPanel }] = await Promise.all([
  import("@k2b/ui"),
  import("./AiProjectsAdminPanel.tsx"),
]);

describe("AiProjectsAdminPanel", () => {
  test("renders unmanaged Projects as an immediate recovery surface without a settings save footer", () => {
    const html = renderToString(() =>
      createComponent(AiProjectsAdminPanel, {
        projects: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            shortId: "pRk234",
            appId: "assistant",
            name: "Unclaimed",
            description: "Shared context",
            icon: "ti ti-folders",
            accessCount: 1,
            adminCount: 0,
            createdAt: "2026-08-17T10:00:00.000Z",
            updatedAt: "2026-08-17T10:00:00.000Z",
          },
        ],
        summary: { total: 1, unmanaged: 1, totalAccess: 1 },
        total: 1,
        page: 1,
        perPage: 100,
        search: "",
      }),
    );

    expect(html).toContain("AI Projects");
    expect(html).toContain("Without admins");
    expect(html).toContain("recovery required");
    expect(html).toContain("No admins");
    expect(html).toContain('class="k2b-status-badge');
    expect(html).not.toContain("ti ti-minus");
    expect(html).toContain("Actions for Unclaimed");
    expect(html).toContain("Delete Project");
    expect(html).not.toContain("Save changes");
  });

  test("renders German copy through the inherited request locale", () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return createComponent(AiProjectsAdminPanel, {
            projects: [],
            summary: { total: 0, unmanaged: 0, totalAccess: 0 },
            total: 0,
            page: 1,
            perPage: 100,
            search: "",
          });
        },
      }),
    );

    expect(html).toContain("KI-Projekte");
    expect(html).toContain("Keine KI-Projekte vorhanden.");
    expect(html).toContain('aria-label="KI-Projekte durchsuchen"');
  });
});
